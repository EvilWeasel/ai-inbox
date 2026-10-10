from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parents[2]
WORKER_PATH = ROOT / "scripts" / "central-audio-worker.py"
spec = importlib.util.spec_from_file_location("central_audio_worker", WORKER_PATH)
worker_mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = worker_mod
spec.loader.exec_module(worker_mod)

JOBS_PATH = ROOT / "scripts" / "audio-jobs.py"
jobs_spec = importlib.util.spec_from_file_location("central_audio_job_store", JOBS_PATH)
jobs_mod = importlib.util.module_from_spec(jobs_spec)
sys.modules[jobs_spec.name] = jobs_mod
jobs_spec.loader.exec_module(jobs_mod)

PROFILE = hashlib.sha256(b"fixture Rena profile").hexdigest()
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x64" + b"\x00" * 413


def private_file(path: Path, data: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_bytes(data)
    path.chmod(0o600)
    return path


class FakeBackend:
    def __init__(self, rows):
        self.rows = {row["id"]: dict(row) for row in rows}
        self.attaches = []
        self.fail_update_after_commit = False
        self.fail_update_before_commit = False
        self.fail_attach_after_commit = False
        self.fail_attach_before_commit = False

    def __call__(self, payload):
        if payload["op"] == "list":
            rows = [r.copy() for r in self.rows.values() if r["state"] in {"queued", "generating"}]
            return {"requests": rows[:payload["limit"]]}
        if payload["op"] == "lookup":
            row = self.rows.get(payload["requestId"])
            if row is None:
                return {"request": None}
            return {"request": {**row, "item_has_audio": row.get("item_has_audio", False)}}
        if payload["op"] == "resolve":
            row = self.rows[payload["requestId"]]
            if row["state"] != payload["expectedState"] or row["body_sha256"] != payload["expectedBodySha256"]:
                raise worker_mod.WorkerError("state conflict")
            if payload["state"] == "superseded" and row["item_body_sha256"] == row["body_sha256"] and not row.get("item_has_audio"):
                raise worker_mod.WorkerError("not obsolete")
            row["state"] = payload["state"]
            row["safe_error_code"] = payload["safeErrorCode"]
            return {"state": row["state"]}
        row = self.rows[payload["requestId"]]
        if payload["op"] == "update":
            if self.fail_update_before_commit:
                self.fail_update_before_commit = False
                raise worker_mod.WorkerError("update not committed")
            if row.get("ledger_job_id") and row["ledger_job_id"] != payload["ledgerJobId"]:
                raise worker_mod.WorkerError("binding conflict")
            row["ledger_job_id"] = payload["ledgerJobId"]
            row["state"] = payload["state"]
            row["safe_error_code"] = payload["safeErrorCode"]
            if self.fail_update_after_commit:
                self.fail_update_after_commit = False
                raise worker_mod.WorkerError("reply lost")
            return {"state": row["state"], "ledger_job_id": row["ledger_job_id"]}
        if payload["op"] == "attach":
            self.attaches.append(payload.copy())
            if self.fail_attach_before_commit:
                self.fail_attach_before_commit = False
                raise worker_mod.WorkerError("attachment did not commit")
            row["state"] = "ready"
            if self.fail_attach_after_commit:
                self.fail_attach_after_commit = False
                raise worker_mod.WorkerError("reply lost")
            return {"state": "ready", "itemId": row["item_id"]}
        raise AssertionError(payload)


class CentralAudioWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.private = self.root / "private"
        self.private.mkdir(mode=0o700)
        self.private.chmod(0o700)
        self.state = self.private / "state"
        self.media = self.private / "media"
        self.app_data = self.private / "app-data"
        for directory in (self.state, self.media, self.app_data):
            directory.mkdir(mode=0o700)
        self.deploy_lock = private_file(self.private / "deploy.lock", b"")
        self.cli_lock = private_file(self.private / "cli.lock", b"")
        self.release = self.private / "releases" / "fixture"
        (self.release / "scripts").mkdir(parents=True)
        (self.release / "node_modules" / "tsx" / "dist").mkdir(parents=True)
        private_file(self.release / "scripts" / "central-audio.ts", b"// fixture\n")
        private_file(self.release / "node_modules" / "tsx" / "dist" / "cli.mjs", b"// fixture\n")
        self.current = self.release.parent / "current"
        self.current.symlink_to(self.release, target_is_directory=True)
        self.adapter = private_file(self.private / "cartesia-job.py", b"# fake adapter\n")
        self.renderer_calls = self.private / "renderer-calls"
        renderer = (
            "import json,os,pathlib,sys\n"
            "r=json.load(sys.stdin)\n"
            f"if os.environ.get('CARTESIA_JOB_CONFIG_FILE') != {str(self.private / 'cartesia.json')!r}: raise SystemExit(6)\n"
            f"p=pathlib.Path({str(self.renderer_calls)!r})\n"
            "p.write_text((p.read_text() if p.exists() else '')+'x')\n"
            f"pathlib.Path(r['expectedOutputPath']).write_bytes({MP3!r})\n"
            "pathlib.Path(r['expectedOutputPath']).chmod(0o600)\n"
            "print(json.dumps({'status':'completed','providerReceiptId':'local-fixture-receipt','durationSeconds':4.25}))\n"
        )
        self.renderer = private_file(self.private / "fake-renderer.py", renderer.encode())
        self.adapter_config = private_file(self.private / "cartesia.json", json.dumps({
            "speakHelperPath": str(self.private / "speak.py"),
            "pythonExecutable": str(Path(sys.executable).resolve()),
            "mediaDir": str(self.media), "profileRef": "fixture-rena",
            "voiceProfile": {"voiceId": "fixture", "modelId": "fixture-model",
            "language": "de", "emotion": "calm"}, "timeoutSeconds": 60,
        }).encode())
        private_file(self.private / "speak.py", b"# unused by the provider fixture\n")
        self.config = {
            "appReleaseLink": self.current, "nodeExecutable": Path(shutil.which("node") or sys.executable),
            "appDataDir": self.app_data, "deployLockPath": self.deploy_lock,
            "stateDir": self.state, "mediaDir": self.media,
            "cartesiaAdapterPath": self.renderer, "cartesiaConfigFile": self.adapter_config,
            "voiceProfileSha256": PROFILE, "voiceProfileRef": "fixture-rena", "timeoutSeconds": 120,
            "batchLimit": 10,
        }
        self.jobs = jobs_mod.AudioJobStore(self.state / "jobs.sqlite", self.media)

    def tearDown(self):
        self.temp.cleanup()

    def row(self, suffix="a", *, body="Written final result", spoken="Eine gesprochene Fassung.", state="queued"):
        request_id = hashlib.sha256(suffix.encode()).hexdigest()
        body_hash = hashlib.sha256(body.encode()).hexdigest()
        spoken_hash = hashlib.sha256(spoken.encode()).hexdigest()
        return {"id": request_id, "producer_id": "fixture-producer", "delivery_id": "delivery-" + suffix,
                "item_id": "item-" + suffix, "body_sha256": body_hash, "spoken_sha256": spoken_hash,
                "voice_profile_sha256": PROFILE, "spoken_text": spoken, "state": state,
                "ledger_job_id": None, "title": "Fixture result",
                "external_id": "producer:fixture-producer:delivery:delivery-" + suffix,
                "item_body_sha256": body_hash}

    def setup_worker(self, rows):
        backend = FakeBackend(rows)
        worker = worker_mod.CentralAudioWorker(self.config)
        worker._cli = backend
        return worker, backend

    def test_one_initial_synthesis_and_repeated_pass_do_not_render_again(self):
        worker, backend = self.setup_worker([self.row()])
        first = worker.run_pass()
        self.assertEqual(first, {"attached": 1, "attempted": 1, "review": 0})
        self.assertEqual(self.renderer_calls.read_text(), "x")
        self.assertEqual(len(backend.attaches), 1)
        second = worker.run_pass()
        self.assertEqual(second["attempted"], 0)
        self.assertEqual(self.renderer_calls.read_text(), "x")

    def test_lost_binding_reply_recovers_deterministic_job_without_duplicate_attempt(self):
        worker, backend = self.setup_worker([self.row()])
        backend.fail_update_after_commit = True
        with self.assertRaises(worker_mod.WorkerError):
            worker.run_pass()
        bound = next(iter(backend.rows.values()))["ledger_job_id"]
        self.assertTrue(bound)
        recovered = worker.run_pass()
        self.assertEqual(recovered["attempted"], 1)
        self.assertEqual(self.renderer_calls.read_text(), "x")
        self.assertEqual(backend.attaches[0]["ledgerJobId"], bound)

    def test_crash_after_enqueue_before_binding_recovers_and_binds_before_render(self):
        worker, backend = self.setup_worker([self.row()])
        backend.fail_update_before_commit = True
        with self.assertRaises(worker_mod.WorkerError):
            worker.run_pass()
        self.assertFalse(self.renderer_calls.exists())
        ledger = self.jobs._connect()
        try:
            self.assertEqual(ledger.execute("SELECT count(*) FROM audio_jobs").fetchone()[0], 1)
            self.assertEqual(ledger.execute("SELECT state FROM audio_jobs").fetchone()[0], "pending")
        finally:
            ledger.close()
        worker.run_pass()
        self.assertEqual(self.renderer_calls.read_text(), "x")
        self.assertTrue(next(iter(backend.rows.values()))["ledger_job_id"])

    def test_lost_attach_reply_retries_same_ready_receipt_without_resynthesis(self):
        worker, backend = self.setup_worker([self.row()])
        backend.fail_attach_after_commit = True
        with self.assertRaises(worker_mod.WorkerError):
            worker.run_pass()
        self.assertEqual(self.renderer_calls.read_text(), "x")
        # The backend committed ready despite the lost receipt. There is no
        # queued input on the next pass and the saved ledger receipt is intact.
        self.assertEqual(worker.run_pass()["attempted"], 0)
        self.assertEqual(self.renderer_calls.read_text(), "x")

    def test_failed_attach_retries_saved_ready_file_without_regeneration(self):
        worker, backend = self.setup_worker([self.row()])
        backend.fail_attach_before_commit = True
        with self.assertRaises(worker_mod.WorkerError):
            worker.run_pass()
        self.assertEqual(self.renderer_calls.read_text(), "x")
        result = worker.run_pass()
        self.assertEqual(result["attempted"], 0)
        self.assertEqual(backend.rows[next(iter(backend.rows))]["state"], "ready")
        self.assertEqual(self.renderer_calls.read_text(), "x")

    def test_stale_revision_is_reviewed_without_paid_attempt(self):
        row = self.row()
        row["item_body_sha256"] = hashlib.sha256(b"newer written revision").hexdigest()
        metadata = private_file(self.state / (row["id"] + ".json"), json.dumps({
            "phase": "final", "title": row["title"], "deliveryId": row["delivery_id"],
            "bodySha256": row["body_sha256"]}).encode())
        text = private_file(self.state / (row["id"] + ".txt"), row["spoken_text"].encode())
        job = self.jobs.enqueue(result_identity="central:" + row["id"], metadata_path=metadata,
                                spoken_text_path=text, voice_profile_sha256=PROFILE, meaningful=True)
        row["ledger_job_id"] = job["id"]
        worker, backend = self.setup_worker([row])
        result = worker.run_pass()
        self.assertEqual(result["attempted"], 0)
        self.assertEqual(backend.rows[row["id"]]["state"], "needs_review")
        self.assertEqual(backend.rows[row["id"]]["safe_error_code"], "result_revision_changed")
        self.assertFalse(self.renderer_calls.exists())

    def test_stale_unbound_request_is_superseded_without_enqueue(self):
        row = self.row()
        row["item_body_sha256"] = hashlib.sha256(b"newer written revision").hexdigest()
        worker, backend = self.setup_worker([row])
        worker.run_pass()
        self.assertEqual(backend.rows[row["id"]]["state"], "superseded")
        db = self.jobs._connect()
        try:
            self.assertIsNone(db.execute("SELECT id FROM audio_jobs").fetchone())
        finally:
            db.close()
        self.assertFalse(self.renderer_calls.exists())

    def test_orphaned_oldest_pending_job_is_blocked_and_later_request_runs(self):
        orphan_id = hashlib.sha256(b"missing-backend-request").hexdigest()
        metadata = private_file(self.state / (orphan_id + ".json"), b'{"phase":"final","title":"orphan","deliveryId":"gone","bodySha256":"' + b"a" * 64 + b'"}')
        spoken = private_file(self.state / (orphan_id + ".txt"), b"orphan spoken text")
        orphan = self.jobs.enqueue(result_identity="central:" + orphan_id, metadata_path=metadata,
                                   spoken_text_path=spoken, voice_profile_sha256=PROFILE, meaningful=True)
        worker, _backend = self.setup_worker([self.row("later")])
        result = worker.run_pass()
        self.assertEqual(result["attempted"], 1)
        db = self.jobs._connect()
        try:
            stale = db.execute("SELECT state,last_error_code,claim_count FROM audio_jobs WHERE id=?", (orphan["id"],)).fetchone()
            self.assertEqual((stale["state"], stale["last_error_code"], stale["claim_count"]),
                             ("blocked", "backend_request_obsolete", 0))
        finally:
            db.close()

    def test_original_arriving_during_preparation_is_rechecked_before_paid_claim(self):
        row = self.row()
        worker, backend = self.setup_worker([row])
        original_lookup = backend.__call__
        lookups = 0
        def with_original(payload):
            nonlocal lookups
            if payload["op"] == "lookup":
                lookups += 1
                if lookups >= 1:
                    backend.rows[row["id"]]["item_has_audio"] = True
                    backend.rows[row["id"]]["state"] = "superseded"
            return original_lookup(payload)
        worker._cli = with_original
        result = worker.run_pass()
        self.assertEqual(result["attempted"], 0)
        self.assertFalse(self.renderer_calls.exists())

    def test_adapter_timeout_requires_cleanup_margin_before_backend_work(self):
        worker, _backend = self.setup_worker([self.row()])
        worker.config["timeoutSeconds"] = 89
        with self.assertRaisesRegex(worker_mod.WorkerError, "cleanup margin"):
            worker.run_pass()
        self.assertFalse(self.renderer_calls.exists())
        raw = {key: str(value) if isinstance(value, Path) else value for key, value in self.config.items()}
        raw["nodeExecutable"] = str(Path(sys.executable).resolve())
        raw["timeoutSeconds"] = 89
        config_path = private_file(self.private / "short-worker-timeout.json", json.dumps(raw).encode())
        with self.assertRaisesRegex(worker_mod.WorkerError, "cleanup margin"):
            worker_mod._load_config(config_path)

    def test_ledger_lease_outlives_outer_helper_deadline_by_sixty_seconds(self):
        worker, _backend = self.setup_worker([self.row()])
        original = worker.jobs.run_one
        observed = []
        def check_lease(helper, *, lease_seconds=900):
            self.assertEqual(helper.timeout_seconds, worker.config["timeoutSeconds"])
            self.assertGreaterEqual(lease_seconds, helper.timeout_seconds + 60)
            observed.append(lease_seconds)
            return original(helper, lease_seconds=lease_seconds)
        worker.jobs.run_one = check_lease
        worker.run_pass()
        self.assertEqual(observed, [180])

    def test_uncertain_ledger_job_is_never_reclaimed_automatically(self):
        row = self.row(state="generating")
        metadata = private_file(self.state / (row["id"] + ".json"), json.dumps({
            "phase": "final", "title": row["title"], "deliveryId": row["delivery_id"],
            "bodySha256": row["body_sha256"]}).encode())
        text = private_file(self.state / (row["id"] + ".txt"), row["spoken_text"].encode())
        job = self.jobs.enqueue(result_identity="central:" + row["id"], metadata_path=metadata,
                                spoken_text_path=text, voice_profile_sha256=PROFILE, meaningful=True)
        db = self.jobs._connect()
        try:
            db.execute("UPDATE audio_jobs SET state='uncertain',last_error_code='lease_expired' WHERE id=?", (job["id"],))
        finally:
            db.close()
        row["ledger_job_id"] = job["id"]
        worker, backend = self.setup_worker([row])
        result = worker.run_pass()
        self.assertEqual(result["attempted"], 0)
        self.assertEqual(backend.rows[row["id"]]["state"], "needs_review")
        self.assertFalse(self.renderer_calls.exists())

    def test_multiple_jobs_are_mapped_by_deterministic_identity(self):
        rows = [self.row("first"), self.row("second")]
        worker, backend = self.setup_worker(rows)
        result = worker.run_pass()
        self.assertEqual(result["attempted"], 1)
        ready = [key for key, value in backend.rows.items() if value["state"] == "ready"]
        generating = [key for key, value in backend.rows.items() if value["state"] == "generating"]
        self.assertEqual(len(ready), 1)
        self.assertEqual(len(generating), 1)
        self.assertEqual(backend.attaches[0]["requestId"], ready[0])
        self.assertEqual(backend.attaches[0]["ledgerJobId"], backend.rows[ready[0]]["ledger_job_id"])

    def test_bad_row_is_reviewed_without_poisoning_other_rows_and_release_escape_is_rejected(self):
        row = self.row()
        row["voice_profile_sha256"] = "0" * 64
        good = self.row("good-after-bad")
        worker, backend = self.setup_worker([row, good])
        result = worker.run_pass()
        self.assertEqual(result["attempted"], 1)
        self.assertEqual(backend.rows[row["id"]]["state"], "needs_review")
        self.assertTrue(self.renderer_calls.exists())
        self.assertEqual(backend.rows[good["id"]]["state"], "ready")

    def test_private_config_accepts_only_path_and_nonsecret_contract_fields(self):
        raw = {key: str(value) if isinstance(value, Path) else value for key, value in self.config.items()}
        raw["nodeExecutable"] = str(Path(sys.executable).resolve())
        config_path = private_file(self.private / "worker.json", json.dumps(raw).encode())
        loaded = worker_mod._load_config(config_path)
        self.assertEqual(loaded["voiceProfileRef"], "fixture-rena")
        secret_config = dict(raw, apiKey="never-accepted")
        secret_path = private_file(self.private / "worker-secret.json", json.dumps(secret_config).encode())
        with self.assertRaises(worker_mod.WorkerError):
            worker_mod._load_config(secret_path)
        config_link = self.private / "worker-link.json"
        config_link.symlink_to(config_path)
        with self.assertRaises(ValueError):
            worker_mod._load_config(config_link)
        outside = self.private.parent / "outside-release"
        outside.mkdir()
        self.current.unlink()
        self.current.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(worker_mod.WorkerError):
            worker_mod._resolve_release(self.config)
        self.assertFalse(self.renderer_calls.exists())

    def test_worker_lock_is_exclusive(self):
        lock_path = self.state / "worker.lock"
        with worker_mod._FileLock(lock_path, blocking=False):
            with self.assertRaises(BlockingIOError):
                with worker_mod._FileLock(lock_path, blocking=False):
                    pass

    def test_deployment_lock_wraps_each_cli_operation(self):
        worker, _backend = self.setup_worker([])
        def child(argv, request, **kwargs):
            with self.assertRaises(BlockingIOError):
                with worker_mod._FileLock(self.deploy_lock, blocking=False):
                    pass
            return 0, b'{"requests":[]}', b""
        with patch.object(worker_mod, "_resolve_release", return_value=self.release), \
                patch.object(worker_mod, "_bounded_child", side_effect=child):
            self.assertEqual(worker._cli({"op": "list", "limit": 1}), {"requests": []})

    def test_cli_stdout_and_stderr_are_bounded(self):
        env = os.environ.copy()
        with self.assertRaises(worker_mod.WorkerError):
            worker_mod._bounded_child([sys.executable, "-c", "print('x'*100)"], b"", timeout=5,
                                      env=env, stdout_limit=8, stderr_limit=8)
        with self.assertRaises(worker_mod.WorkerError):
            worker_mod._bounded_child([sys.executable, "-c", "import sys;sys.stderr.write('x'*100)"], b"", timeout=5,
                                      env=env, stdout_limit=8, stderr_limit=8)

    def test_actual_source_cli_list_contract_runs_as_bounded_subprocess(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node is unavailable")
        data = self.private / "cli-data"
        data.mkdir(mode=0o700)
        env_before = os.environ.copy()
        env = env_before.copy()
        env["INBOX_DATA_DIR"] = str(data)
        env["INBOX_AUDIO_WORKER_MEDIA_DIR"] = str(self.media)
        config = dict(self.config)
        config["nodeExecutable"] = Path(node)
        worker = worker_mod.CentralAudioWorker(config)
        with patch.object(worker_mod, "_resolve_release", return_value=ROOT), patch.dict(os.environ, env):
            answer = worker._cli({"op": "list", "limit": 3})
        self.assertEqual(answer, {"requests": []})
        # _cli inherits only the caller environment and sets these two fields;
        # no credential or provider option is serialized into JSON stdin.
        self.assertEqual(json.loads(b'{"op":"list","limit":3}'), {"op": "list", "limit": 3})
        self.assertEqual(os.environ, env_before)


if __name__ == "__main__":
    unittest.main()
