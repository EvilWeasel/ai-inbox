import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading
import unittest

MODULE_PATH = Path(__file__).parents[2] / "scripts" / "audio-jobs.py"
spec = importlib.util.spec_from_file_location("audio_jobs", MODULE_PATH)
audio_jobs = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = audio_jobs
spec.loader.exec_module(audio_jobs)


# Empty ID3v2 header followed by one complete MPEG-1 Layer III 128 kbps frame.
FIXTURE_MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x64" + b"\x00" * 413
VOICE_HASH = hashlib.sha256(b"Rena profile fixture").hexdigest()


def private_file(path: Path, data: bytes) -> Path:
    path.write_bytes(data)
    path.chmod(0o600)
    return path


class AudioJobTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.private = self.root / "private"
        self.private.mkdir(mode=0o700)
        self.private.chmod(0o700)
        self.metadata = private_file(self.private / "metadata.json", json.dumps({
            "phase": "final", "meaningful": True, "title": "Fixture result",
            "body": "A new implementation outcome.", "deliveryId": "fixture-result-1",
        }).encode())
        self.text = private_file(self.private / "spoken.txt", "Eine neue Umsetzung ist fertig.".encode())
        self.store = audio_jobs.AudioJobStore(self.private / "jobs.sqlite3", self.private / "media")

    def tearDown(self):
        self.temp.cleanup()

    def enqueue(self, **overrides):
        values = dict(result_identity="t3:thread-1:run-1", metadata_path=self.metadata,
                      spoken_text_path=self.text, voice_profile_sha256=VOICE_HASH, meaningful=True)
        values.update(overrides)
        return self.store.enqueue(**values)

    def test_enqueue_is_idempotent_and_new_spoken_revision_is_new_job(self):
        first = self.enqueue()
        again = self.enqueue()
        self.assertEqual(first["id"], again["id"])
        self.assertEqual(first["state"], "pending")
        private_file(self.text, "Eine präzisierte neue Umsetzung ist fertig.".encode())
        revised = self.enqueue()
        self.assertNotEqual(first["id"], revised["id"])
        self.assertNotEqual(first["content_sha256"], revised["content_sha256"])

    def test_same_spoken_revision_refreshes_metadata_only_before_an_attempt(self):
        first = self.enqueue()
        replacement_metadata = private_file(self.private / "metadata-v2.json", json.dumps({
            "phase": "final", "meaningful": True, "title": "Updated title",
            "body": "Updated context, same spoken adaptation.", "deliveryId": "fixture-result-1",
        }).encode())
        refreshed = self.enqueue(metadata_path=replacement_metadata)
        self.assertEqual(first["id"], refreshed["id"])
        self.assertEqual(refreshed["metadata_sha256"], hashlib.sha256(replacement_metadata.read_bytes()).hexdigest())
        claim = self.store.claim()
        self.assertEqual(self.store.get(first["id"])["metadata_path"], str(replacement_metadata))
        changed_again = private_file(self.private / "metadata-v3.json", b'{"phase":"final"}')
        with self.assertRaises(audio_jobs.AudioJobError):
            self.enqueue(metadata_path=changed_again)

    def test_concurrent_claims_only_return_one_job(self):
        self.enqueue()
        claims = []
        barrier = threading.Barrier(3)

        def claim():
            barrier.wait()
            claims.append(self.store.claim())

        workers = [threading.Thread(target=claim) for _ in range(2)]
        for worker in workers:
            worker.start()
        barrier.wait()
        for worker in workers:
            worker.join()
        self.assertEqual(sum(item is not None for item in claims), 1)

    def test_expired_running_lease_becomes_uncertain_and_is_not_reclaimed(self):
        job = self.enqueue()
        claim = self.store.claim(lease_seconds=10)
        db = self.store._connect()
        try:
            db.execute("UPDATE audio_jobs SET lease_until=0 WHERE id=?", (job["id"],))
        finally:
            db.close()
        self.assertIsNone(self.store.claim())
        self.assertEqual(self.store.get(job["id"])["state"], "uncertain")
        self.assertIsNone(self.store.claim())
        self.assertEqual(self.store.attempts(job["id"])[0]["state"], "uncertain")

    def test_expired_lease_recovers_ready_only_with_saved_receipt_and_validated_hash(self):
        job = self.enqueue()
        claim = self.store.claim(lease_seconds=10)
        media = self.store.media_dir / f"{job['id']}-{claim['attempt_nonce']}.mp3"
        private_file(media, FIXTURE_MP3)
        digest = hashlib.sha256(FIXTURE_MP3).hexdigest()
        self.store._update_attempt(claim, provider_receipt_json=json.dumps({
            "status": "completed", "providerReceiptId": "fixture-receipt-1", "durationSeconds": 2.5,
        }))
        self.store._update_attempt(claim, media_sha256=digest)
        db = self.store._connect()
        try:
            db.execute("UPDATE audio_jobs SET lease_until=0 WHERE id=?", (job["id"],))
        finally:
            db.close()
        self.assertIsNone(self.store.claim())
        recovered = self.store.get(job["id"])
        self.assertEqual(recovered["state"], "ready")
        self.assertEqual(recovered["media_sha256"], digest)
        self.assertEqual(recovered["duration_seconds"], 2.5)

    def test_selected_original_recording_is_reused_by_exact_hash(self):
        original = private_file(self.private / "original.mp3", FIXTURE_MP3)
        digest = hashlib.sha256(FIXTURE_MP3).hexdigest()
        job = self.enqueue(original_mp3_path=original, original_mp3_sha256=digest)
        self.assertEqual(job["state"], "ready")
        self.assertEqual(Path(job["media_path"]).parent, self.store.media_dir)
        self.assertEqual(Path(job["media_path"]).read_bytes(), original.read_bytes())
        self.assertEqual(job["media_sha256"], digest)
        self.assertIsNone(self.store.claim())

    def test_later_explicit_original_selection_promotes_pending_job_without_a_claim(self):
        pending = self.enqueue()
        original = private_file(self.private / "selected-later.mp3", FIXTURE_MP3)
        digest = hashlib.sha256(FIXTURE_MP3).hexdigest()
        reused = self.enqueue(original_mp3_path=original, original_mp3_sha256=digest)
        self.assertEqual(reused["id"], pending["id"])
        self.assertEqual(reused["state"], "ready")
        self.assertEqual(Path(reused["media_path"]).read_bytes(), original.read_bytes())
        self.assertIsNone(self.store.claim())

    def test_missing_or_non_meaningful_inputs_are_blocked_before_enqueue(self):
        with self.assertRaises(audio_jobs.AudioJobError):
            self.enqueue(metadata_path=self.private / "missing.json")
        with self.assertRaises(audio_jobs.AudioJobError):
            self.enqueue(meaningful=False)

    def _helper(self, *, behavior="success", counter=False):
        helper = self.root / "fixture_helper.py"
        counter_path = self.root / f"invocations-{behavior}"
        helper_code = (
            "import json, pathlib, sys\n"
            "request=json.load(sys.stdin)\n"
            + (f"pathlib.Path({str(counter_path)!r}).open('a').write('x\\n')\n" if counter else "")
            + ("pathlib.Path(request['expectedOutputPath']).write_bytes(" + repr(FIXTURE_MP3) + ")\n"
               "pathlib.Path(request['expectedOutputPath']).chmod(0o600)\n"
               if behavior != "lost" else "")
            + ("print(json.dumps({'status':'completed','providerReceiptId':'fixture-receipt-1','durationSeconds':2.5}))\n"
               if behavior not in {"lost", "no-receipt"} else "")
            + ("print('x' * 20000)\n" if behavior == "oversized" else "")
            + ("raise SystemExit(4)\n" if behavior == "nonzero" else "")
        )
        private_file(helper, helper_code.encode())
        return audio_jobs.HelperConfig((sys.executable,), helper, "voice-profile-fixture", timeout_seconds=10), counter_path

    def test_runner_writes_valid_receipt_and_exact_output_hash(self):
        job = self.enqueue()
        helper, _ = self._helper()
        result = self.store.run_one(helper)
        self.assertEqual(result["id"], job["id"])
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["media_sha256"], hashlib.sha256(FIXTURE_MP3).hexdigest())
        self.assertEqual(result["duration_seconds"], 2.5)
        attempt = self.store.attempts(job["id"])[0]
        self.assertEqual(json.loads(attempt["provider_receipt_json"])["providerReceiptId"], "fixture-receipt-1")
        self.assertEqual(attempt["state"], "ready")

    def test_uncertain_nonzero_and_lost_stdout_do_not_blindly_retry(self):
        for behavior in ("nonzero", "lost", "no-receipt"):
            with self.subTest(behavior=behavior):
                text = private_file(self.private / "spoken.txt", f"Result {behavior}".encode())
                job = self.enqueue(result_identity=f"t3:thread:{behavior}", spoken_text_path=text)
                helper, counter = self._helper(behavior=behavior, counter=True)
                result = self.store.run_one(helper)
                self.assertEqual(result["state"], "uncertain")
                self.assertEqual(counter.read_text().count("x"), 1)
                self.assertIsNone(self.store.run_one(helper))
                self.assertEqual(counter.read_text().count("x"), 1)
                self.assertEqual(self.store.get(job["id"])["claim_count"], 1)

    def test_provider_receipt_credential_fields_are_not_persisted(self):
        helper = self.root / "bad_receipt.py"
        private_file(helper, (
            "import json, pathlib, sys\nrequest=json.load(sys.stdin)\n"
            f"pathlib.Path(request['expectedOutputPath']).write_bytes({FIXTURE_MP3!r})\n"
            "pathlib.Path(request['expectedOutputPath']).chmod(0o600)\n"
            "print(json.dumps({'status':'completed','providerReceiptId':'fixture','apiKey':'do-not-store'}))\n"
        ).encode())
        job = self.enqueue()
        result = self.store.run_one(audio_jobs.HelperConfig((sys.executable,), helper, "fixture"))
        self.assertEqual(result["state"], "uncertain")
        self.assertNotIn("do-not-store", json.dumps(self.store.attempts(job["id"])))

    def test_stdout_receipt_capture_is_bounded(self):
        job = self.enqueue()
        helper, _counter = self._helper(behavior="oversized")
        result = self.store.run_one(helper)
        self.assertEqual(result["state"], "uncertain")
        self.assertEqual(result["last_error_code"], "receipt_too_large")
        self.assertIsNone(self.store.attempts(job["id"])[0]["provider_receipt_json"])

    def test_symlink_and_oversize_media_are_rejected(self):
        target = private_file(self.private / "target.mp3", FIXTURE_MP3)
        link = self.private / "linked.mp3"
        link.symlink_to(target)
        with self.assertRaises(audio_jobs.AudioJobError):
            self.enqueue(original_mp3_path=link, original_mp3_sha256=hashlib.sha256(FIXTURE_MP3).hexdigest())
        huge = private_file(self.private / "huge.mp3", b"ID3\x00" + b"x" * (audio_jobs.MAX_AUDIO + 1))
        with self.assertRaises(audio_jobs.AudioJobError):
            audio_jobs._valid_mp3(huge)

    def test_id3_or_id3v1_tag_without_complete_mpeg_frame_is_rejected(self):
        tag_only = private_file(self.private / "tag-only.mp3", b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"x" * 20)
        with self.assertRaises(audio_jobs.AudioJobError):
            audio_jobs._valid_mp3(tag_only)
        trailing_tag_only = private_file(self.private / "trailing-tag.mp3", b"x" * 128 + b"TAG" + b"x" * 125)
        with self.assertRaises(audio_jobs.AudioJobError):
            audio_jobs._valid_mp3(trailing_tag_only)

    def test_uncertain_retry_requires_review_and_is_bounded(self):
        job = self.enqueue()
        claim = self.store.claim()
        result = self.store._finish(claim, "uncertain", error_code="simulated_lost_response")
        with self.assertRaises(audio_jobs.AudioJobError):
            self.store.resolve(job["id"], decision="retry", reviewer="", evidence="review")
        result = self.store.resolve(job["id"], decision="retry", reviewer="operator", evidence="provider dashboard confirms no request")
        self.assertEqual(result["state"], "pending")
        # Claims are globally serialized and attempt count is durable.
        second = self.store.claim()
        self.assertEqual(second["claim_count"], 2)


if __name__ == "__main__":
    unittest.main()
