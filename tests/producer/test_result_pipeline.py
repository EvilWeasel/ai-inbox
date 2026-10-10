import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

MODULE_PATH = Path(__file__).parents[2] / "scripts" / "result-pipeline.py"
spec = importlib.util.spec_from_file_location("result_pipeline", MODULE_PATH)
pipeline_module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = pipeline_module
spec.loader.exec_module(pipeline_module)


class FakeBridge:
    def __init__(self, context):
        self.context = context

    def load_config(self, _path):
        return {"producerConfigFile": str(self.context["producer"]), "allowedAudioRoots": [str(self.context["audio_root"])],
                "outboxDir": str(self.context["outbox"])}

    def fetch_snapshot(self, _config, thread_id):
        return {"projection": {"thread": {"id": thread_id}}}

    @staticmethod
    def projection_thread_id(projection):
        return projection["thread"]["id"]

    def find_final(self, _projection, run_id):
        self.context["exact_runs"].append(run_id)
        if run_id != self.context["run_id"]:
            return None, "bound run missing"
        if self.context.get("gate_error"):
            return None, self.context["gate_error"]
        return {"text": self.context["text"]}, ""


class FakeAudioStore:
    def __init__(self, state="pending"):
        self.state = state
        self.jobs = {}
        self.calls = 0

    def enqueue(self, **kwargs):
        self.calls += 1
        state = "ready" if kwargs.get("original_mp3_path") else self.state
        media_path = None
        if state == "ready":
            media_path = str(kwargs.get("original_mp3_path") or (Path(kwargs["metadata_path"]).parent / "fake-ready.mp3"))
            if not Path(media_path).exists():
                Path(media_path).write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x64" + b"\x00" * 413)
                Path(media_path).chmod(0o600)
        job = {"id": "audio-job-1", "state": state, "media_path": media_path,
               "media_sha256": hashlib.sha256(Path(media_path).read_bytes()).hexdigest() if media_path else None,
               "duration_seconds": 1.0 if media_path else None, "result_identity": kwargs["result_identity"]}
        self.jobs[job["id"]] = job
        return job

    def get(self, job_id):
        return self.jobs.get(job_id)


class ResultPipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.private = self.root / "private"
        self.private.mkdir(mode=0o700)
        self.private.chmod(0o700)
        self.audio_root = self.private / "audio"
        self.audio_root.mkdir(mode=0o700)
        self.audio_root.chmod(0o700)
        self.outbox = self.private / "outbox"
        self.outbox.mkdir(mode=0o700)
        self.outbox.chmod(0o700)
        pipeline_module.private_files.create_private_file(self.outbox / "outbox.sqlite3", b"")
        outbox_db = sqlite3.connect(self.outbox / "outbox.sqlite3")
        outbox_db.execute("CREATE TABLE deliveries(delivery_id TEXT,thread_id TEXT,run_id TEXT,state TEXT,receipt_json TEXT,created_at TEXT)")
        outbox_db.commit(); outbox_db.close()
        self.producer = self._private("producer.json", {"endpoint": "https://example.invalid/api/results", "host": "fixture-host", "tokenFile": "/private/token"})
        self.audio_cfg = self._private("audio-config.json", {})
        self.capture_config = self._private("capture.json", {})
        self.bridge_config = self._private("bridge.json", {"outboxDir": str(self.outbox)})
        self.context = {"producer": self.producer, "audio_root": self.audio_root,
                        "outbox": self.outbox, "exact_runs": [], "thread_id": "thread-1", "run_id": "run-7",
                        "text": "Complete result body\n\nWith detail.", "gate_error": None}
        self.row = {"candidate_id": "c" * 64, "thread_id": "thread-1", "run_id": "run-7",
                    "completed_at": "2026-10-10T12:00:00Z", "status": "needs_review"}
        self.captured = {"candidateId": self.row["candidate_id"], "threadId": self.row["thread_id"],
                         "runId": self.row["run_id"], "completedAt": self.row["completed_at"],
                         "text": self.context["text"], "sourceRefs": ["https://example.org/source"]}
        self.store = FakeAudioStore()
        self.store.media_dir = self.private
        self.deliveries = {}
        self.sender_calls = []
        self.sent_metadata = []
        self.fail_next_send = False
        self.fail_next_audio_send = False
        self.config = {"captureConfigFile": str(self.capture_config), "bridgeConfigFile": str(self.bridge_config),
                       "audioHelperConfigFile": str(self.audio_cfg), "stateDir": str(self.private / "state"),
                       "decisionHelperArgv": ["/usr/bin/fake-decision"], "voiceProfileSha256": hashlib.sha256(b"voice").hexdigest(),
                       "decisionHelperTimeoutSeconds": 10}
        Path(self.config["stateDir"]).mkdir(mode=0o700)
        Path(self.config["stateDir"]).chmod(0o700)
        self.decision = self._meaningful_decision()
        self.pipeline = self._pipeline()

    def tearDown(self):
        self.temp.cleanup()

    def _private(self, name, payload):
        path = self.private / name
        path.write_text(json.dumps(payload))
        path.chmod(0o600)
        return path

    def _meaningful_decision(self, **extra):
        result = {"decision": "meaningful", "title": "Finished result", "resultType": "report",
                  "spokenText": "Das fertige Ergebnis in knapper gesprochener Form."}
        result.update(extra)
        return result

    def _runner(self, argv, request, timeout):
        self.assertEqual(argv, ["/usr/bin/fake-decision"])
        self.assertLessEqual(len(request), 1_300_000)
        return json.dumps(self.decision).encode()

    def _sender(self, metadata_path, audio_path):
        metadata = json.loads(Path(metadata_path).read_text())
        self.sender_calls.append((metadata["deliveryId"], audio_path))
        self.sent_metadata.append(metadata)
        if audio_path and self.fail_next_audio_send:
            self.fail_next_audio_send = False
            raise OSError("audio upload response lost")
        if self.fail_next_send:
            self.fail_next_send = False
            # Simulate remote commit with lost response.
            self.deliveries.setdefault(metadata["deliveryId"], {"read": True, "audio": None})
            raise OSError("lost response")
        entry = self.deliveries.setdefault(metadata["deliveryId"], {"read": False, "audio": None})
        if audio_path:
            entry["audio"] = Path(audio_path).read_bytes() if Path(audio_path).exists() else b"same-ready-audio"
        return {"delivered": True, "itemId": "item-1", "created": len(self.sender_calls) == 1}

    def _pipeline(self):
        def capture_reader(_cfg, candidate_id):
            if candidate_id != self.row["candidate_id"] and not candidate_id.startswith("e"):
                raise pipeline_module.PipelineError("candidate is absent from the initialized future capture journal")
            if self.row["thread_id"].startswith("child-"):
                raise pipeline_module.PipelineError("capture excluded delegated child candidate")
            row, captured = dict(self.row), dict(self.captured)
            if candidate_id.startswith("e"):
                row["candidate_id"] = candidate_id
                captured["candidateId"] = candidate_id
            return row, captured, self.private / "capture.json"
        return pipeline_module.ResultPipeline(self.config, decision_runner=self._runner, sender=self._sender,
                 audio_store_factory=lambda: self.store, bridge_module_factory=lambda: FakeBridge(self.context),
                 capture_reader=capture_reader)

    def _stage(self, state="pending"):
        db = sqlite3.connect(self.outbox / "outbox.sqlite3")
        db.execute("INSERT INTO deliveries VALUES(?,?,?,?,?,?)", ("authored", "thread-1", "run-7", state, "{}", "2026-10-10"))
        db.commit(); db.close()

    def test_future_capture_body_is_published_verbatim_and_exact_run_is_rechecked(self):
        result = self.pipeline.process_batch([self.row["candidate_id"]])[0]
        self.assertIn(result["status"], {"audio-pending", "text-delivered"})
        metadata = json.loads(Path(next(self.private.joinpath("state").glob("*.result.json"))).read_text())
        self.assertEqual(metadata["body"], self.context["text"])
        self.assertEqual(metadata["deliveryId"], pipeline_module.stable_delivery_id("thread-1", "run-7"))
        self.assertEqual(self.context["exact_runs"], ["run-7"])

    def _central_mode_pipeline(self, client):
        central = dict(self.config, audioDeliveryMode="central")
        central.pop("audioHelperConfigFile", None)
        central.pop("voiceProfileSha256", None)
        self.config = central
        pipeline = self._pipeline()
        pipeline.config = central
        pipeline._central_audio_module = lambda: client
        return pipeline

    def test_central_mode_uses_written_item_and_never_opens_local_audio_store(self):
        class Client:
            def __init__(self): self.posts = []; self.statuses = []
            def request_audio(_self, _config, metadata_path, spoken_path, item_id):
                _self.posts.append((Path(metadata_path).read_bytes(), Path(spoken_path).read_bytes(), item_id))
                return {"state": "queued", "jobId": "a" * 64, "itemId": item_id}
            def get_audio_status(_self, _config, job_id, item_id):
                _self.statuses.append((job_id, item_id))
                return {"state": "ready", "jobId": job_id, "itemId": item_id,
                        "mediaSha256": "b" * 64, "durationSeconds": 9.25}
        client = Client()
        pipeline = self._central_mode_pipeline(client)
        result = pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "audio-pending")
        self.assertEqual(self.store.calls, 0)
        self.assertEqual(len(client.posts), 1)
        metadata_raw, spoken_raw, item_id = client.posts[0]
        self.assertEqual(item_id, "item-1")
        self.assertEqual(json.loads(metadata_raw)["body"], self.context["text"])
        self.assertEqual(spoken_raw.decode(), self.decision["spokenText"])
        db = pipeline_module._connect(pipeline.config)
        try:
            row = dict(db.execute("SELECT * FROM pipeline_candidates WHERE candidate_id=?",
                                  (self.row["candidate_id"],)).fetchone())
        finally:
            db.close()
        self.assertEqual(row["central_audio_job_id"], "a" * 64)
        self.assertEqual(row["central_audio_item_id"], "item-1")
        db = pipeline_module._connect(pipeline.config)
        try:
            db.execute("UPDATE pipeline_candidates SET next_attempt_at='2000-01-01T00:00:00Z' WHERE candidate_id=?",
                       (self.row["candidate_id"],))
        finally:
            db.close()
        attached = pipeline.attach_ready_audio(self.row["candidate_id"])
        self.assertEqual(attached["status"], "audio-delivered")
        self.assertEqual(client.statuses, [("a" * 64, "item-1")])
        self.assertEqual(self.sender_calls, [(pipeline_module.stable_delivery_id("thread-1", "run-7"), None)])
        self.assertEqual(self.store.calls, 0)

    def test_central_lost_post_reply_retries_identical_payload_and_job_binding(self):
        client_module = pipeline_module.module_from("ai_inbox_test_central_audio", "request-result-audio.py")
        class Client:
            AudioRequestError = client_module.AudioRequestError
            def __init__(self): self.payloads = []
            def request_audio(_self, _config, metadata_path, spoken_path, item_id):
                payload = (Path(metadata_path).read_bytes(), Path(spoken_path).read_bytes(), item_id)
                _self.payloads.append(payload)
                if len(_self.payloads) == 1:
                    raise client_module.AudioRequestError("temporary", transient=True)
                return {"state": "generating", "jobId": "c" * 64, "itemId": item_id}
            def get_audio_status(*_args): raise AssertionError("no job should be polled yet")
        client = Client()
        pipeline = self._central_mode_pipeline(client)
        self.assertEqual(pipeline.process_candidate(self.row["candidate_id"])["status"], "audio-pending")
        db = pipeline_module._connect(pipeline.config)
        try:
            db.execute("UPDATE pipeline_candidates SET next_attempt_at='2000-01-01T00:00:00Z' WHERE candidate_id=?",
                       (self.row["candidate_id"],))
        finally:
            db.close()
        result = pipeline.run_audio_once()
        self.assertEqual(result["reconciled"], 1)
        self.assertEqual(result["results"][0]["status"], "audio-pending")
        self.assertEqual(client.payloads[0], client.payloads[1])
        db = pipeline_module._connect(pipeline.config)
        try:
            row = db.execute("SELECT central_audio_job_id,central_audio_item_id FROM pipeline_candidates WHERE candidate_id=?",
                             (self.row["candidate_id"],)).fetchone()
        finally:
            db.close()
        self.assertEqual(tuple(row), ("c" * 64, "item-1"))

    def test_original_audio_with_spoken_text_uploads_original_and_skips_central_request(self):
        original = self.audio_root / "original-wins.mp3"
        original.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x64" + b"\x00" * 413)
        original.chmod(0o600)
        digest = hashlib.sha256(original.read_bytes()).hexdigest()
        self.decision = self._meaningful_decision(originalAudio={"path": str(original), "sha256": digest})
        class Client:
            calls = 0
            def request_audio(self, *_args): self.calls += 1; raise AssertionError("central synthesis must not be requested")
        client = Client()
        pipeline = self._central_mode_pipeline(client)
        result = pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "audio-delivered")
        self.assertEqual(client.calls, 0)
        self.assertEqual([call[1] for call in self.sender_calls], [None, str(original)])
        self.assertEqual(self.deliveries[pipeline_module.stable_delivery_id("thread-1", "run-7")]["audio"], original.read_bytes())
        self.assertEqual(self.store.calls, 0)

    def test_captured_markdown_mp3_discovery_wins_over_spoken_synthesis(self):
        original = self.audio_root / "captured-original.mp3"
        original.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x64" + b"\x00" * 413)
        original.chmod(0o600)
        self.context["text"] = f"Finished answer.\n\n[Anhören]({original})" + "\n" + "\n".join(f"[Source {i}](https://example.invalid/source/{i})" for i in range(80))
        self.captured["text"] = self.context["text"]
        self.decision = self._meaningful_decision()
        class Client:
            calls = 0
            def request_audio(self, *_args): self.calls += 1; raise AssertionError("must attach original, not synthesize")
        client = Client()
        pipeline = self._central_mode_pipeline(client)
        result = pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "audio-delivered")
        self.assertEqual(client.calls, 0)
        self.assertEqual([call[1] for call in self.sender_calls], [None, str(original)])
        self.assertEqual(Path(original).stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.deliveries[pipeline_module.stable_delivery_id("thread-1", "run-7")]["audio"],
                         original.read_bytes())

    def test_windows_drive_audio_paths_are_parsed_using_native_path_semantics(self):
        from pathlib import PureWindowsPath
        from unittest.mock import patch
        path = r"C:\Users\personal\audio\answer.mp3"
        with patch.object(pipeline_module, "Path", PureWindowsPath):
            self.assertEqual(pipeline_module._audio_reference_path(path), PureWindowsPath(path))
            self.assertEqual(pipeline_module._audio_reference_path("C:/Users/personal/audio/answer.mp3"), PureWindowsPath(path))
        self.assertEqual(pipeline_module._ABSOLUTE_PATH_RE.search(path).group(0), path)

    def test_conflicting_explicit_mp3_references_hold_for_review(self):
        first = self.audio_root / "first.mp3"
        second = self.audio_root / "second.mp3"
        payload = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x64" + b"\x00" * 413
        for path in (first, second):
            path.write_bytes(payload)
            path.chmod(0o600)
        self.context["text"] = f"[first]({first}) and [second]({second})"
        self.captured["text"] = self.context["text"]
        self.decision = self._meaningful_decision()
        result = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "review-needed")
        self.assertEqual(self.sender_calls, [])
        self.assertEqual(self.store.calls, 0)

    def test_missing_explicit_mp3_reference_holds_for_review(self):
        self.context["text"] = f"[Anhören]({self.audio_root / 'missing.mp3'})"
        self.captured["text"] = self.context["text"]
        self.decision = self._meaningful_decision()
        result = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "review-needed")
        self.assertEqual(self.sender_calls, [])
        self.assertEqual(self.store.calls, 0)

    def test_symlinked_mp3_reference_holds_for_review(self):
        outside = self.private / "outside.mp3"
        outside.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x64" + b"\x00" * 413)
        outside.chmod(0o600)
        linked = self.audio_root / "linked.mp3"
        linked.symlink_to(outside)
        self.context["text"] = f"![audio]({linked})"
        self.captured["text"] = self.context["text"]
        self.decision = self._meaningful_decision()
        result = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "review-needed")
        self.assertEqual(self.sender_calls, [])
        self.assertEqual(self.store.calls, 0)

    def test_trusted_helper_selection_must_match_captured_audio_reference(self):
        referenced = self.audio_root / "referenced.mp3"
        selected = self.audio_root / "selected.mp3"
        payload = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x64" + b"\x00" * 413
        for path in (referenced, selected):
            path.write_bytes(payload)
            path.chmod(0o600)
        self.context["text"] = f"[Anhören]({referenced})"
        self.captured["text"] = self.context["text"]
        self.decision = self._meaningful_decision(originalAudio={
            "path": str(selected), "sha256": hashlib.sha256(selected.read_bytes()).hexdigest()})
        result = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "review-needed")
        self.assertEqual(self.sender_calls, [])
        self.assertEqual(self.store.calls, 0)

    def test_insecure_explicit_mp3_file_holds_for_review(self):
        original = self.audio_root / "insecure.mp3"
        original.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x64" + b"\x00" * 413)
        original.chmod(0o644)
        self.context["text"] = f"[Anhören]({original})"
        self.captured["text"] = self.context["text"]
        self.decision = self._meaningful_decision()
        result = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "review-needed")
        self.assertEqual(self.sender_calls, [])
        self.assertEqual(self.store.calls, 0)

    def test_non_audio_body_path_does_not_select_recording(self):
        self.context["text"] = "The report is stored at /tmp/report.txt."
        self.captured["text"] = self.context["text"]
        self.decision = self._meaningful_decision()
        result = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "audio-pending")
        self.assertEqual(self.store.calls, 1)
        self.assertEqual(self.sender_calls[0][1], None)

    def test_network_mp3_reference_is_not_fetched_or_synthesized(self):
        self.context["text"] = "[listen](https://media.example.invalid/original.mp3)"
        self.captured["text"] = self.context["text"]
        self.decision = self._meaningful_decision()
        class Client:
            calls = 0
            def request_audio(self, *_args): self.calls += 1; raise AssertionError("network MP3 is not fetched")
        client = Client()
        pipeline = self._central_mode_pipeline(client)
        result = pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "review-needed")
        self.assertEqual(client.calls, 0)
        self.assertEqual(self.sender_calls, [])

    def test_source_ref_path_is_decoded_and_verified_as_original(self):
        original = self.audio_root / "source recording.mp3"
        original.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x64" + b"\x00" * 413)
        original.chmod(0o600)
        self.captured["sourceRefs"] = [{"title": "Original recording",
                                        "path": str(original).replace(" ", "%20")}]
        self.decision = self._meaningful_decision()
        class Client:
            calls = 0
            def request_audio(self, *_args): self.calls += 1; raise AssertionError("must attach source-ref original")
        client = Client()
        pipeline = self._central_mode_pipeline(client)
        result = pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "audio-delivered")
        self.assertEqual(client.calls, 0)
        self.assertEqual([call[1] for call in self.sender_calls], [None, str(original)])
        self.assertEqual(self.store.calls, 0)

    def test_html_network_audio_reference_is_not_fetched(self):
        self.context["text"] = '<audio src="https://media.example.invalid/original.mp3"></audio>'
        self.captured["text"] = self.context["text"]
        self.decision = self._meaningful_decision()
        class Client:
            calls = 0
            def request_audio(self, *_args): self.calls += 1; raise AssertionError("HTML URL is not fetched")
        client = Client()
        pipeline = self._central_mode_pipeline(client)
        result = pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "review-needed")
        self.assertEqual(client.calls, 0)
        self.assertEqual(self.sender_calls, [])

    def test_central_ready_existing_completes_same_item_without_audio_resend(self):
        class Client:
            def request_audio(_self, _config, _metadata, _spoken, item):
                return {"state": "ready_existing", "itemId": item}
        pipeline = self._central_mode_pipeline(Client())
        result = pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "audio-delivered")
        self.assertEqual(result["itemId"], "item-1")
        self.assertEqual(len(self.sender_calls), 1)
        db = pipeline_module._connect(pipeline.config)
        try:
            row = db.execute("SELECT receipt_json,central_audio_item_id FROM pipeline_candidates WHERE candidate_id=?",
                             (self.row["candidate_id"],)).fetchone()
        finally:
            db.close()
        receipt = json.loads(row["receipt_json"])
        self.assertEqual(receipt["itemId"], "item-1")
        self.assertTrue(receipt["audioDelivered"])
        self.assertEqual(row["central_audio_item_id"], "item-1")
        self.assertNotIn("audioSha256", receipt)

    def test_central_terminal_review_does_not_poll_or_resubmit(self):
        client_module = pipeline_module.module_from("ai_inbox_test_central_audio_2", "request-result-audio.py")
        class Client:
            def __init__(self): self.posts = 0; self.gets = 0
            def request_audio(_self, _config, _metadata, _spoken, item):
                _self.posts += 1
                return {"state": "queued", "jobId": "d" * 64, "itemId": item}
            def get_audio_status(_self, _config, job, item):
                _self.gets += 1
                return {"state": "needs_review", "jobId": job, "itemId": item}
        client = Client()
        pipeline = self._central_mode_pipeline(client)
        pipeline.process_candidate(self.row["candidate_id"])
        db = pipeline_module._connect(pipeline.config)
        try:
            db.execute("UPDATE pipeline_candidates SET next_attempt_at='2000-01-01T00:00:00Z' WHERE candidate_id=?",
                       (self.row["candidate_id"],))
        finally:
            db.close()
        self.assertEqual(pipeline.attach_ready_audio(self.row["candidate_id"])["status"], "blocked")
        self.assertEqual(pipeline.process_candidate(self.row["candidate_id"])["status"], "blocked")
        self.assertEqual((client.posts, client.gets), (1, 1))

    def test_central_audio_once_only_polls_saved_jobs(self):
        class Client:
            AudioRequestError = pipeline_module.module_from("ai_inbox_test_audio_once", "request-result-audio.py").AudioRequestError
            def __init__(self): self.posts = 0; self.gets = 0
            def request_audio(_self, _config, _metadata, _spoken, item):
                _self.posts += 1
                return {"state": "queued", "jobId": "e" * 64, "itemId": item}
            def get_audio_status(_self, _config, job, item):
                _self.gets += 1
                return {"state": "generating", "jobId": job, "itemId": item}
        client = Client()
        pipeline = self._central_mode_pipeline(client)
        self.assertEqual(pipeline.process_candidate(self.row["candidate_id"])["status"], "audio-pending")
        db = pipeline_module._connect(pipeline.config)
        try:
            db.execute("UPDATE pipeline_candidates SET next_attempt_at='2000-01-01T00:00:00Z' WHERE candidate_id=?",
                       (self.row["candidate_id"],))
        finally:
            db.close()
        output = pipeline.run_audio_once()
        self.assertEqual(output["mode"], "central")
        self.assertEqual((client.posts, client.gets), (1, 1))
        self.assertEqual(self.store.calls, 0)

    def test_load_config_allows_central_mode_without_local_audio_settings(self):
        config_path = self._private("central-pipeline.json", {
            "captureConfigFile": str(self.capture_config), "bridgeConfigFile": str(self.bridge_config),
            "stateDir": str(self.private / "central-state"), "decisionHelperArgv": ["/usr/bin/fake-decision"],
            "audioDeliveryMode": "central",
        })
        loaded = pipeline_module.load_config(config_path)
        self.assertEqual(loaded["audioDeliveryMode"], "central")
        self.assertNotIn("audioHelperConfigFile", loaded)
        self.assertNotIn("voiceProfileSha256", loaded)

    def test_sender_false_receipt_never_marks_text_delivered(self):
        self.pipeline.sender = lambda *_args: {"delivered": False, "itemId": "item-1"}
        result = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "review-needed")
        db = pipeline_module._connect(self.config)
        try:
            row = db.execute("SELECT status,receipt_json FROM pipeline_candidates WHERE candidate_id=?",
                             (self.row["candidate_id"],)).fetchone()
        finally:
            db.close()
        self.assertEqual(row["status"], "review-needed")
        self.assertNotIn('"delivered":true', row["receipt_json"] or "")

    def test_exact_run_gate_failure_does_not_publish_or_rebind_to_latest(self):
        self.context["gate_error"] = "exact run incomplete"
        result = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "review-needed")
        self.assertEqual(self.sender_calls, [])
        self.assertEqual(self.context["exact_runs"], ["run-7"])

    def test_transient_exact_run_gate_failure_recovers_when_due(self):
        self.context["gate_error"] = "run still settling"
        first = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(first["status"], "review-needed")
        db = pipeline_module._connect(self.config)
        try:
            db.execute("UPDATE pipeline_candidates SET next_attempt_at='2000-01-01T00:00:00Z' WHERE candidate_id=?",
                       (self.row["candidate_id"],))
        finally:
            db.close()
        self.context["gate_error"] = None
        recovered = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertIn(recovered["status"], {"audio-pending", "text-delivered"})
        self.assertEqual(len(self.sender_calls), 1)

    def test_authored_stage_in_any_state_takes_precedence(self):
        self._stage()
        result = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertTrue(result["authoredStage"])
        self.assertEqual(self.sender_calls, [])
        self.assertEqual(self.store.calls, 0)

    def test_late_authored_stage_prevents_audio_attachment(self):
        result = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "audio-pending")
        self._stage("delivered")
        attached = self.pipeline.attach_ready_audio(self.row["candidate_id"], store=self.store)
        self.assertTrue(attached["authoredStage"])
        self.assertEqual(self.sender_calls, [(pipeline_module.stable_delivery_id("thread-1", "run-7"), None)])

    def test_selected_original_audio_is_hash_checked_and_preferred(self):
        original = self.audio_root / "selected.mp3"
        original.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x64" + b"\x00" * 413)
        original.chmod(0o600)
        digest = hashlib.sha256(original.read_bytes()).hexdigest()
        self.decision = self._meaningful_decision(originalAudio={"path": str(original), "sha256": digest})
        result = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "audio-delivered", result)
        self.assertEqual(self.store.jobs["audio-job-1"]["media_path"], str(original))
        self.assertEqual(self.deliveries[pipeline_module.stable_delivery_id("thread-1", "run-7")]["audio"], original.read_bytes())

    def test_excluded_and_child_candidates_never_reach_helpers_or_sender(self):
        self.decision = {"decision": "exclude"}
        result = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "excluded")
        self.assertEqual(self.sender_calls, [])
        self.row["thread_id"] = "child-thread"
        self.context["thread_id"] = "child-thread"
        result = self.pipeline.process_batch([self.row["candidate_id"]])[0]
        self.assertEqual(result["status"], "review-needed")

    def test_text_then_audio_uses_same_identity_and_preserves_read_state(self):
        result = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "audio-pending")
        db = pipeline_module._connect(self.config)
        try:
            row = dict(db.execute("SELECT * FROM pipeline_candidates WHERE candidate_id=?", (self.row["candidate_id"],)).fetchone())
            db.execute("UPDATE pipeline_candidates SET status='audio-ready',audio_job_id='audio-job-1' WHERE candidate_id=?", (self.row["candidate_id"],))
        finally:
            db.close()
        ready_path = self.private / "ready.mp3"
        ready_path.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x64" + b"\x00" * 413)
        ready_path.chmod(0o600)
        self.store.jobs["audio-job-1"] = {"id": "audio-job-1", "state": "ready", "media_path": str(ready_path),
                                           "media_sha256": hashlib.sha256(ready_path.read_bytes()).hexdigest(),
                                           "duration_seconds": 1.0}
        self.deliveries[row["delivery_id"]] = {"read": True, "audio": None}
        attached = self.pipeline.attach_ready_audio(self.row["candidate_id"], store=self.store)
        self.assertEqual(attached["status"], "audio-delivered")
        self.assertEqual(self.sender_calls[0][0], self.sender_calls[-1][0])
        self.assertTrue(self.deliveries[row["delivery_id"]]["read"])
        self.assertEqual(self.deliveries[row["delivery_id"]]["audio"], ready_path.read_bytes())
        self.assertEqual(self.sent_metadata[-1]["audioDuration"], 1.0)

    def test_publication_failure_recovers_with_same_delivery_id(self):
        self.fail_next_send = True
        first = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(first["status"], "candidate-reviewed")
        second = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(second["status"], "audio-pending")
        self.assertEqual(self.sender_calls[0][0], self.sender_calls[1][0])
        self.assertEqual(len(self.deliveries), 1)

    def test_missing_spoken_audio_keeps_text_delivery(self):
        self.decision = self._meaningful_decision(spokenText=None)
        result = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "text-delivered")
        self.assertEqual(len(self.sender_calls), 1)

    def test_original_audio_without_spoken_adaptation_is_attached_after_text(self):
        original = self.audio_root / "original-only.mp3"
        original.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x64" + b"\x00" * 413)
        original.chmod(0o600)
        self.decision = self._meaningful_decision(spokenText=None, originalAudio={
            "path": str(original), "sha256": hashlib.sha256(original.read_bytes()).hexdigest()})
        result = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "audio-delivered")
        self.assertEqual([call[1] for call in self.sender_calls], [None, str(original)])
        self.assertNotIn("audioDuration", self.sent_metadata[-1])
        self.assertEqual(self.store.calls, 0)

    def test_original_audio_attachment_retries_without_synthesis(self):
        original = self.audio_root / "original-retry.mp3"
        original.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x64" + b"\x00" * 413)
        original.chmod(0o600)
        self.decision = self._meaningful_decision(spokenText=None, originalAudio={
            "path": str(original), "sha256": hashlib.sha256(original.read_bytes()).hexdigest()})
        self.fail_next_audio_send = True
        first = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(first["status"], "text-delivered")
        retry = self.pipeline.attach_ready_audio(self.row["candidate_id"], store=self.store)
        self.assertEqual(retry["status"], "audio-delivered")
        self.assertEqual([call[1] for call in self.sender_calls], [None, str(original), str(original)])
        self.assertEqual(self.store.calls, 0)

    def test_immutable_metadata_and_spoken_text_are_verified_before_audio_retry(self):
        self.decision = self._meaningful_decision()
        result = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "audio-pending")
        db = pipeline_module._connect(self.config)
        try:
            row = dict(db.execute("SELECT * FROM pipeline_candidates WHERE candidate_id=?", (self.row["candidate_id"],)).fetchone())
            saved_receipt = row["receipt_json"]
        finally:
            db.close()
        metadata_original = Path(row["metadata_path"]).read_bytes()
        Path(row["metadata_path"]).write_bytes(metadata_original + b" ")
        tampered = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(tampered["status"], "blocked")
        db = pipeline_module._connect(self.config)
        try:
            self.assertEqual(db.execute("SELECT receipt_json FROM pipeline_candidates WHERE candidate_id=?",
                                         (self.row["candidate_id"],)).fetchone()[0], saved_receipt)
        finally:
            db.close()
        Path(row["metadata_path"]).write_bytes(metadata_original)
        Path(row["spoken_path"]).write_text("tampered spoken text")
        db = pipeline_module._connect(self.config)
        try:
            db.execute("UPDATE pipeline_candidates SET status='audio-pending' WHERE candidate_id=?", (self.row["candidate_id"],))
        finally:
            db.close()
        spoken_tampered = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(spoken_tampered["status"], "blocked")

    def test_ready_audio_media_hash_is_checked_before_attachment(self):
        self.decision = self._meaningful_decision()
        result = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "audio-pending")
        ready = self.private / "ready-tampered.mp3"
        ready.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x64" + b"\x00" * 413)
        ready.chmod(0o600)
        expected = hashlib.sha256(ready.read_bytes()).hexdigest()
        ready.write_bytes(ready.read_bytes() + b"changed")
        self.store.jobs["audio-job-1"] = {"id": "audio-job-1", "state": "ready", "media_path": str(ready),
                                           "media_sha256": expected, "duration_seconds": 1.0}
        db = pipeline_module._connect(self.config)
        try:
            db.execute("UPDATE pipeline_candidates SET status='audio-ready',audio_job_id='audio-job-1' WHERE candidate_id=?",
                       (self.row["candidate_id"],))
        finally:
            db.close()
        attached = self.pipeline.attach_ready_audio(self.row["candidate_id"], store=self.store)
        self.assertEqual(attached["status"], "audio-pending")
        self.assertEqual(len(self.sender_calls), 1)

    def test_hostile_decision_json_and_path_traversal_are_rejected(self):
        self.decision = self._meaningful_decision(untrustedUrl="https://evil.invalid")
        result = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "review-needed")
        self.assertEqual(self.sender_calls, [])
        self.decision = self._meaningful_decision(originalAudio={"path": str(self.root / "outside.mp3"), "sha256": "0" * 64})
        result = self.pipeline.process_candidate("e" * 64)
        self.assertEqual(result["status"], "review-needed")
        self.assertEqual(self.sender_calls, [])

    def test_per_candidate_failure_does_not_block_later_candidate(self):
        results = self.pipeline.process_batch(["missing-candidate", self.row["candidate_id"]])
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]["status"], "review-needed")
        self.assertIn(results[1]["status"], {"audio-pending", "text-delivered"})

    def test_global_lease_prevents_concurrent_classification(self):
        db = pipeline_module._connect(self.config)
        try:
            db.execute("INSERT INTO coordinator_lease(singleton,owner,lease_until) VALUES(1,'other',?)", (9999999999,))
        finally:
            db.close()
        result = self.pipeline.process_candidate(self.row["candidate_id"])
        self.assertEqual(result["status"], "blocked")

    def test_receipt_bound_is_structured_json_not_truncated_bytes(self):
        db = pipeline_module._connect(self.config)
        try:
            self.pipeline._save_simple(db, self.row, self.row["candidate_id"], "0" * 64,
                pipeline_module.stable_delivery_id("thread-1", "run-7"), "candidate-reviewed", "fixture")
            with self.assertRaises(pipeline_module.PipelineError):
                self.pipeline._receipt(db, self.row["candidate_id"], {"delivered": True, "itemId": "x" * 50_000}, "text-delivered")
            stored = db.execute("SELECT receipt_json FROM pipeline_candidates WHERE candidate_id=?",
                                (self.row["candidate_id"],)).fetchone()[0]
            self.assertIsNone(stored)
        finally:
            db.close()

    def test_live_coordinator_lease_renews_and_blocks_second_owner(self):
        first = self.pipeline
        second = self._pipeline()
        db = pipeline_module._connect(self.config)
        with patch.object(pipeline_module, "LEASE_RENEW_INTERVAL", 0.01):
            try:
                self.assertTrue(first._lease(db, lease_seconds=1))
                time.sleep(0.06)
                lease_until = db.execute("SELECT lease_until FROM coordinator_lease WHERE singleton=1").fetchone()[0]
                self.assertGreater(lease_until, time.time() + 100)
                other_db = pipeline_module._connect(self.config)
                try:
                    self.assertFalse(second._lease(other_db))
                finally:
                    other_db.close()
            finally:
                first._release(db)
                db.close()

    def test_candidate_cursor_skips_terminal_pages_and_surfaces_due_retries(self):
        cap = pipeline_module.load_capture_module()
        t3db = self.private / "selection-t3.sqlite3"
        t3db.touch(mode=0o600)
        bridge_path = self._private("selection-bridge.json", {"outboxDir": str(self.outbox)})
        capture_path = self._private("selection-capture.json", {
            "t3DatabaseFile": str(t3db), "bridgeConfigFile": str(bridge_path),
            "captureDir": str(self.private / "selection-capture"),
        })
        cap_cfg = cap.load_config(capture_path)
        capdb = cap.connect_capture(cap_cfg)
        capdb.execute("INSERT INTO capture_state(singleton,activation_epoch,scan_after_run_id,schema_version) VALUES(1,?,?,1)",
                      ("2026-10-10T11:00:00Z", ""))
        candidates = []
        for idx in range(108):
            cid = f"{idx:064x}"
            completed = "2026-10-10T10:00:00Z" if idx == 0 else f"2026-10-10T{11 + idx // 60:02d}:{idx % 60:02d}:00Z"
            candidates.append((cid, completed))
            capdb.execute("INSERT INTO candidates(candidate_id,thread_id,run_id,completed_at,status,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                (cid, f"thread-{idx}", f"run-{idx}", completed, "observed", "fixture", completed, completed))
        capdb.commit(); capdb.close()
        pipe_db = pipeline_module._connect(self.config)
        try:
            for idx, (cid, completed) in enumerate(candidates[1:106], start=1):
                pipe_db.execute("INSERT INTO pipeline_candidates(candidate_id,thread_id,run_id,capture_sha256,delivery_id,status,reason,created_at,updated_at) VALUES(?,?,?,?,?,'excluded','terminal',?,?)",
                    (cid, f"thread-{idx}", f"run-{idx}", "0" * 64, "delivery", completed, completed))
        finally:
            pipe_db.close()
        selection_config = dict(self.config, captureConfigFile=str(capture_path))
        first_page = pipeline_module._candidate_ids(selection_config, 2, "new")
        second_page = pipeline_module._candidate_ids(selection_config, 2, "new")
        self.assertEqual(first_page, [])
        self.assertEqual(second_page, [candidates[106][0], candidates[107][0]])
        pipe_db = pipeline_module._connect(self.config)
        try:
            pipe_db.execute("INSERT INTO pipeline_candidates(candidate_id,thread_id,run_id,capture_sha256,delivery_id,status,reason,retry_attempts,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,'review-needed','retry:exact-run',1,'2000-01-01T00:00:00Z','now','now')",
                (candidates[106][0], "thread-106", "run-106", "0" * 64, "delivery"))
        finally:
            pipe_db.close()
        self.assertEqual(pipeline_module._candidate_ids(selection_config, 2, "retry"), [])
        self.assertEqual(pipeline_module._candidate_ids(selection_config, 2, "retry"), [candidates[106][0]])

    def test_uncertain_audio_job_is_never_called_again_automatically(self):
        audio = pipeline_module.load_audio_module()
        metadata = self._private("uncertain-metadata.json", {"phase": "final", "deliveryId": "same-result"})
        spoken = self.private / "uncertain-spoken.txt"
        spoken.write_text("Eine fertige gesprochene Zusammenfassung."); spoken.chmod(0o600)
        store = audio.AudioJobStore(self.private / "uncertain-jobs.sqlite3", self.private / "uncertain-media")
        job = store.enqueue(result_identity="same-result", metadata_path=metadata,
            spoken_text_path=spoken, voice_profile_sha256=hashlib.sha256(b"voice").hexdigest(), meaningful=True)
        self.assertEqual(job["state"], "pending")
        claimed = store.claim(lease_seconds=10)
        self.assertEqual(claimed["id"], job["id"])
        db = store._connect()
        try:
            db.execute("UPDATE audio_jobs SET lease_until=0 WHERE id=?", (job["id"],))
        finally:
            db.close()
        helper = audio.HelperConfig(("/usr/bin/python3",), Path("/usr/bin/false"), "fixture-profile", 10)
        self.assertIsNone(store.run_one(helper, lease_seconds=40))
        self.assertEqual(store.get(job["id"])["state"], "uncertain")
        self.assertEqual(len(store.attempts(job["id"])), 1)
        self.assertIsNone(store.run_one(helper, lease_seconds=40))
        self.assertEqual(len(store.attempts(job["id"])), 1)

    def test_actual_capture_bridge_and_audio_store_contracts(self):
        capture = pipeline_module.load_capture_module()
        thread_id, run_id = "root-thread-real", "captured-run-real"
        candidate_id = capture.candidate_id(thread_id, run_id)
        t3db = self.private / "t3.sqlite3"
        t3db.touch(mode=0o600)
        token = self._private("t3-token", {"fixture": True})
        token.write_text("fixture-token\n"); token.chmod(0o600)
        producer = self._private("real-producer.json", {"endpoint": "https://example.invalid/api/results",
                                                          "host": "fixture-host", "tokenFile": str(token)})
        bridge_path = self._private("real-bridge.json", {
            "t3Origin": "http://localhost:3773", "t3TokenFile": str(token),
            "producerConfigFile": str(producer), "outboxDir": str(self.outbox),
            "allowedAudioRoots": [str(self.audio_root)],
        })
        capture_path = self._private("real-capture.json", {
            "t3DatabaseFile": str(t3db), "bridgeConfigFile": str(bridge_path),
            "captureDir": str(self.private / "capture-real"),
        })
        cap_cfg = capture.load_config(capture_path)
        captured_text = "A captured, completed root result."
        completed = "2026-10-10T12:00:00Z"
        capture_file = Path(cap_cfg["captureDir"]) / (candidate_id + ".json")
        capture_file.write_text(json.dumps({"candidateId": candidate_id, "threadId": thread_id,
            "runId": run_id, "completedAt": completed, "text": captured_text,
            "sourceRefs": ["https://example.org/source"]}))
        capture_file.chmod(0o600)
        capdb = capture.connect_capture(cap_cfg)
        capdb.execute("INSERT INTO capture_state(singleton,activation_epoch,scan_after_run_id,schema_version) VALUES(1,?,?,1)",
                      ("2026-10-10T11:00:00Z", ""))
        capdb.execute("INSERT INTO candidates(candidate_id,thread_id,run_id,completed_at,status,reason,receipt_json,text_file,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                      (candidate_id, thread_id, run_id, completed, "observed", "verified fixture", None,
                       str(capture_file), completed, completed))
        capdb.commit()
        capdb.close()

        original = self.audio_root / "original.mp3"
        original.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x64" + b"\x00" * 413)
        original.chmod(0o600)
        original_hash = hashlib.sha256(original.read_bytes()).hexdigest()
        audio_cfg_path = self._private("real-audio.json", {
            "databaseFile": str(self.private / "real-audio-jobs.sqlite3"),
            "mediaDir": str(self.private / "real-audio-media"), "helperArgv": ["/usr/bin/false"],
            "helperPath": "/usr/bin/false", "profileRef": "fixture-profile", "timeoutSeconds": 10,
        })
        cfg = {"captureConfigFile": str(capture_path), "bridgeConfigFile": str(bridge_path),
               "audioHelperConfigFile": str(audio_cfg_path), "stateDir": str(self.private / "real-pipeline"),
               "decisionHelperArgv": ["/usr/bin/fake-decision"], "voiceProfileSha256": hashlib.sha256(b"voice").hexdigest(),
               "decisionHelperTimeoutSeconds": 10}
        Path(cfg["stateDir"]).mkdir(mode=0o700)
        run_projection = {"thread": {"id": thread_id}, "runs": [{"id": run_id, "threadId": thread_id,
            "status": "completed", "completedAt": completed, "rootNodeId": "root"}],
            "subagents": [], "nodes": [
                {"id": "root", "kind": "root_turn", "status": "completed", "completedAt": completed},
                {"id": "answer", "kind": "assistant_message", "status": "completed", "completedAt": completed,
                 "parentNodeId": "root", "rootNodeId": "root"}],
            "messages": [{"id": "final", "threadId": thread_id, "runId": run_id, "nodeId": "answer",
                "role": "assistant", "text": captured_text, "streaming": False}],
            "attempts": [], "turnItems": []}
        sender_calls = []
        inbox_state = {"read": True, "archived": True, "audio": None}
        def sender(metadata_path, audio_path):
            metadata = json.loads(Path(metadata_path).read_text())
            sender_calls.append(metadata["deliveryId"])
            if audio_path:
                inbox_state["audio"] = Path(audio_path).read_bytes()
            return {"delivered": True, "itemId": "real-item", "created": len(sender_calls) == 1}
        decision = self._meaningful_decision(originalAudio={"path": str(original), "sha256": original_hash})
        real_bridge = pipeline_module.load_bridge_module()
        with patch.object(real_bridge, "fetch_snapshot", return_value={"projection": run_projection}):
            pipeline = pipeline_module.ResultPipeline(cfg, decision_runner=lambda *_: json.dumps(decision).encode(),
                sender=sender, bridge_module_factory=lambda: real_bridge)
            result = pipeline.process_candidate(candidate_id)
            again = pipeline.process_candidate(candidate_id)
            audio_once = pipeline.run_audio_once()
        self.assertEqual(result["status"], "audio-delivered", result)
        self.assertEqual(again["status"], "audio-delivered")
        self.assertIsNone(audio_once)
        expected_delivery = pipeline_module.stable_delivery_id(thread_id, run_id)
        self.assertEqual(sender_calls, [expected_delivery, expected_delivery])
        self.assertTrue(inbox_state["read"]); self.assertTrue(inbox_state["archived"])
        self.assertTrue(inbox_state["audio"].startswith(b"ID3"))

        capdb = capture.connect_capture(cap_cfg)
        capdb.execute("UPDATE candidates SET status='staged',text_file=NULL WHERE candidate_id=?", (candidate_id,))
        capdb.commit(); capdb.close()
        outbox = sqlite3.connect(self.outbox / "outbox.sqlite3")
        outbox.execute("INSERT INTO deliveries VALUES(?,?,?,?,?,?)", (expected_delivery, thread_id, run_id,
            "pending", "{}", "2026-10-10"))
        outbox.commit(); outbox.close()
        # The capture timer may not yet have observed a newly authored outbox stage.
        capdb = capture.connect_capture(cap_cfg)
        capdb.execute("UPDATE candidates SET status='observed',text_file=? WHERE candidate_id=?",
                      (str(capture_file), candidate_id))
        capdb.commit(); capdb.close()
        capture_file.unlink()
        authored = pipeline.process_candidate(candidate_id)
        self.assertTrue(authored["authoredStage"])
        self.assertEqual(authored["status"], "candidate-reviewed")


if __name__ == "__main__":
    unittest.main()
