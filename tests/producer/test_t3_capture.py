import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parents[2]
spec = importlib.util.spec_from_file_location("t3_capture", ROOT / "scripts" / "t3-capture.py")
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


def projection(thread_id, run_id, text="Final answer https://example.test/source"):
    return {
        "thread": {"id": thread_id},
        "runs": [{"id": run_id, "threadId": thread_id, "ordinal": 1, "status": "completed",
                   "completedAt": "2026-10-10T12:00:00Z", "rootNodeId": "root"}],
        "nodes": [
            {"id": "root", "kind": "root_turn", "status": "completed", "completedAt": "2026-10-10T12:00:00Z"},
            {"id": "answer", "kind": "assistant_message", "status": "completed", "completedAt": "2026-10-10T12:00:00Z",
             "parentNodeId": "root", "rootNodeId": "root"},
        ],
        "subagents": [],
        "messages": [{"id": "final-message", "threadId": thread_id, "runId": run_id, "nodeId": "answer",
                      "role": "assistant", "text": text, "streaming": False}],
        "attempts": [], "turnItems": [],
    }


class T3CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.t3db = self.root / "statev2.sqlite"
        self.capture_dir = self.root / "capture"
        self.outbox = self.root / "outbox"
        self.token = self.private("token", b"fixture-token")
        self.producer = self.private("producer.json", b"{}")
        self.bridge_config = self.private("bridge.json", json.dumps({
            "t3Origin": "http://localhost:3773", "t3TokenFile": str(self.token),
            "producerConfigFile": str(self.producer), "outboxDir": str(self.outbox),
            "allowedAudioRoots": [str(self.root)],
        }).encode())
        self.config_path = self.private("capture.json", json.dumps({
            "t3DatabaseFile": str(self.t3db), "bridgeConfigFile": str(self.bridge_config),
            "captureDir": str(self.capture_dir),
        }).encode())
        self.create_metadata_db()
        self.config = capture.load_config(self.config_path)
        with patch.object(capture, "utc_now", return_value="2026-10-10T11:00:00.000000Z"):
            self.assertTrue(capture.init(self.config)["initialized"])

    def tearDown(self):
        self.temp.cleanup()

    def private(self, name, content):
        path = self.root / name
        path.write_bytes(content)
        path.chmod(0o600)
        return path

    def create_metadata_db(self):
        db = sqlite3.connect(self.t3db)
        db.executescript("""
            CREATE TABLE orchestration_v2_projection_threads(
                thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, default_provider TEXT,
                runtime_mode TEXT, interaction_mode TEXT, active_provider_thread_id TEXT,
                created_at TEXT, updated_at TEXT, archived_at TEXT, deleted_at TEXT,
                payload_json TEXT, provider_instance_id TEXT
            );
            CREATE TABLE orchestration_v2_projection_runs(
                run_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER, provider TEXT, provider_thread_id TEXT,
                status TEXT, requested_at TEXT, completed_at TEXT, payload_json TEXT, provider_instance_id TEXT
            );
            CREATE TABLE orchestration_v2_projection_subagents(
                subagent_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, parent_node_id TEXT, provider TEXT,
                provider_thread_id TEXT, child_thread_id TEXT, origin TEXT, status TEXT, started_at TEXT,
                completed_at TEXT, updated_at TEXT, payload_json TEXT, driver TEXT, provider_instance_id TEXT
            );
        """)
        db.commit()
        db.close()

    def add_thread_run(self, thread, run, completed="2026-10-10T12:00:00Z", status="completed", archived=None, deleted=None):
        db = sqlite3.connect(self.t3db)
        db.execute("INSERT OR IGNORE INTO orchestration_v2_projection_threads(thread_id,title,archived_at,deleted_at) VALUES(?,?,?,?)",
                   (thread, "private title", archived, deleted))
        db.execute("INSERT OR REPLACE INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,status,completed_at) VALUES(?,?,?,?,?)",
                   (run, thread, 1, status, completed))
        db.commit()
        db.close()

    def once(self, limit=100):
        return capture.process(self.config, limit)

    def drain(self, limit=100):
        for _ in range(20):
            result = self.once(limit)
            if result["cursorReset"]:
                return
        self.fail("metadata scan did not reach a sweep boundary")

    def candidate_rows(self):
        db = capture.connect_capture(self.config)
        try:
            return db.execute("SELECT * FROM candidates ORDER BY run_id").fetchall()
        finally:
            db.close()

    def test_init_epoch_excludes_old_history_but_captures_future_completion_in_old_thread(self):
        self.add_thread_run("thread-old-history", "run-a-history", "2026-10-10T10:59:59Z")
        self.add_thread_run("thread-opened-before-init", "run-b-future", "2026-10-10T11:00:01Z", archived="2026-10-10T10:30:00Z")
        fake = self.fake_bridge()
        fake.fetch_snapshot = unittest.mock.Mock(side_effect=lambda cfg, tid: {"projection": projection(tid, "run-b-future")})
        with patch.object(capture, "bridge_module", return_value=fake):
            self.drain()
        rows = self.candidate_rows()
        self.assertEqual([(r["thread_id"], r["run_id"], r["status"]) for r in rows],
                         [("thread-opened-before-init", "run-b-future", "needs_review")])
        fake.fetch_snapshot.assert_called_once()
        self.assertEqual(Path(rows[0]["text_file"]).stat().st_mode & 0o777, 0o600)
        self.assertEqual(Path(self.config["captureDir"]).stat().st_mode & 0o777, 0o700)

    def test_identical_completion_timestamps_are_not_lost_across_small_pages(self):
        for name in ("a", "b", "c"):
            self.add_thread_run("thread-" + name, "run-" + name)
        with patch.object(capture, "bridge_module", return_value=self.fake_bridge()):
            self.drain(limit=1)
            self.drain(limit=1)
        self.assertEqual({r["run_id"] for r in self.candidate_rows()}, {"run-a", "run-b", "run-c"})

    def test_delayed_completion_older_than_current_sweep_is_found_on_next_cycle(self):
        self.add_thread_run("thread-late", "run-z-late", None, status="running")
        with patch.object(capture, "bridge_module", return_value=self.fake_bridge()):
            self.drain()
            self.add_thread_run("thread-late", "run-z-late", "2026-10-10T11:01:00Z", status="completed")
            self.drain()  # wraps cursor to the start
            self.drain()  # discovers the late completion despite its old key position
        self.assertEqual([(r["run_id"], r["status"]) for r in self.candidate_rows()], [("run-z-late", "needs_review")])

    def test_true_child_thread_is_excluded_using_metadata_not_a_name_prefix(self):
        self.add_thread_run("opaque-child-id", "run-child")
        db = sqlite3.connect(self.t3db)
        db.execute("INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,run_id,child_thread_id,status) VALUES('agent','parent','parent-run','opaque-child-id','completed')")
        db.commit()
        db.close()
        fake = self.fake_bridge()
        with patch.object(capture, "bridge_module", return_value=fake):
            self.drain()
        self.assertEqual(self.candidate_rows()[0]["status"], "excluded")
        fake.fetch_snapshot.assert_not_called()

    def test_missing_or_unknown_projection_is_kept_for_review_without_private_exception_text(self):
        self.add_thread_run("thread-missing", "run-missing")
        self.add_thread_run("thread-unknown", "run-unknown")
        fake = self.fake_bridge()
        fake.fetch_snapshot = lambda cfg, tid: (_ for _ in ()).throw(RuntimeError("private title/body/token")) if tid == "thread-missing" else {"projection": projection(tid, "wrong-run")}
        with patch.object(capture, "bridge_module", return_value=fake):
            self.drain()
        reasons = {r["run_id"]: r["reason"] for r in self.candidate_rows()}
        self.assertIn("RuntimeError", reasons["run-missing"])
        self.assertNotIn("private", reasons["run-missing"])
        self.assertIn("absent from current T3 snapshot", reasons["run-unknown"])

    def test_restart_and_repeated_sweeps_are_deduplicated(self):
        self.add_thread_run("thread-repeat", "run-repeat")
        with patch.object(capture, "bridge_module", return_value=self.fake_bridge()):
            self.drain()
            self.drain()
        # Reopening the process state preserves activation and the unique source identity.
        reopened = capture.load_config(self.config_path)
        self.assertFalse(capture.init(reopened)["initialized"])
        with patch.object(capture, "bridge_module", return_value=self.fake_bridge()):
            self.drain()
        self.assertEqual(len(self.candidate_rows()), 1)

    def test_matching_outbox_stage_receipt_is_preferred_over_projection_capture(self):
        self.add_thread_run("thread-staged", "run-staged")
        self.outbox.mkdir(mode=0o700)
        outbox_db = sqlite3.connect(self.outbox / "outbox.sqlite3")
        outbox_db.execute("CREATE TABLE deliveries(stage_id TEXT,thread_id TEXT,run_id TEXT,delivery_id TEXT,state TEXT,receipt_json TEXT,created_at REAL)")
        outbox_db.execute("INSERT INTO deliveries VALUES('s','thread-staged','run-staged','delivery-1','delivered','{\"itemId\":\"inbox-1\"}',1)")
        outbox_db.commit()
        outbox_db.close()
        (self.outbox / "outbox.sqlite3").chmod(0o600)
        fake = self.fake_bridge()
        with patch.object(capture, "bridge_module", return_value=fake):
            self.drain()
        row = self.candidate_rows()[0]
        self.assertEqual(row["status"], "staged")
        self.assertIsNone(row["text_file"])
        self.assertEqual(json.loads(row["receipt_json"])["deliveryId"], "delivery-1")
        fake.fetch_snapshot.assert_not_called()

    def test_metadata_interface_failure_does_not_advance_scan_cursor(self):
        state_db = capture.connect_capture(self.config)
        try:
            before = state_db.execute("SELECT scan_after_run_id FROM capture_state WHERE singleton=1").fetchone()[0]
        finally:
            state_db.close()
        broken = self.root / "broken.sqlite"
        sqlite3.connect(broken).close()
        bad_config = {**self.config, "t3DatabaseFile": str(broken)}
        with patch.object(capture, "bridge_module", return_value=self.fake_bridge()):
            with self.assertRaises(capture.CaptureError):
                capture.process(bad_config)
        state_db = capture.connect_capture(self.config)
        try:
            after = state_db.execute("SELECT scan_after_run_id FROM capture_state WHERE singleton=1").fetchone()[0]
        finally:
            state_db.close()
        self.assertEqual(after, before)

    def test_retryable_snapshot_failure_recovers_with_same_candidate_id(self):
        self.add_thread_run("thread-retry", "run-retry")
        fake = self.fake_bridge()
        fake.fetch_snapshot = unittest.mock.Mock(side_effect=[RuntimeError("private body token"),
            {"projection": projection("thread-retry", "run-retry")}])
        with patch.object(capture, "bridge_module", return_value=fake), patch.object(capture, "utc_now", side_effect=[
                "2026-10-10T11:00:00.000000Z", "2026-10-10T11:00:00.000000Z", "2026-10-10T11:00:00.000000Z"]):
            self.once()
        initial = self.candidate_rows()[0]
        self.assertIsNone(initial["text_file"])
        self.assertEqual(initial["retry_attempts"], 1)
        self.assertEqual(initial["diagnostic_class"], "transient_fetch")
        db = capture.connect_capture(self.config)
        db.execute("UPDATE candidates SET next_attempt_at='2026-10-10T10:59:00Z' WHERE run_id='run-retry'")
        db.commit()
        db.close()
        with patch.object(capture, "bridge_module", return_value=fake):
            self.once()
        recovered = self.candidate_rows()[0]
        self.assertEqual(recovered["candidate_id"], capture.candidate_id("thread-retry", "run-retry"))
        self.assertIsNotNone(recovered["text_file"])
        self.assertEqual(recovered["retry_attempts"], 2)
        self.assertEqual(fake.fetch_snapshot.call_count, 2)

    def test_incomplete_delegated_gate_retries_until_child_settles(self):
        self.add_thread_run("thread-parent", "run-parent")
        fake = self.fake_bridge()
        fake.find_final = unittest.mock.Mock(side_effect=[(None, "live child task remains unsettled"),
            ({"text": "settled root answer", "sources": []}, "")])
        fake.fetch_snapshot = unittest.mock.Mock(return_value={"projection": projection("thread-parent", "run-parent")})
        with patch.object(capture, "bridge_module", return_value=fake):
            self.once()
        row = self.candidate_rows()[0]
        self.assertEqual(row["diagnostic_class"], "incomplete_completion_gate")
        db = capture.connect_capture(self.config)
        db.execute("UPDATE candidates SET next_attempt_at='2026-10-10T10:59:00Z' WHERE run_id='run-parent'")
        db.commit()
        db.close()
        with patch.object(capture, "bridge_module", return_value=fake):
            self.once()
        row = self.candidate_rows()[0]
        self.assertIsNotNone(row["text_file"])
        self.assertEqual(row["candidate_id"], capture.candidate_id("thread-parent", "run-parent"))
        self.assertEqual(fake.fetch_snapshot.call_count, 2)

    def test_ready_text_is_not_refetched_on_later_sweeps(self):
        self.add_thread_run("thread-ready", "run-ready")
        fake = self.fake_bridge()
        with patch.object(capture, "bridge_module", return_value=fake):
            self.drain()
            self.drain()
        fake.fetch_snapshot.assert_called_once()

    def test_later_stage_refreshes_candidate_receipt_and_removes_projection_text(self):
        self.add_thread_run("thread-later-stage", "run-later-stage")
        fake = self.fake_bridge()
        with patch.object(capture, "bridge_module", return_value=fake):
            self.drain()
        first = self.candidate_rows()[0]
        saved_text = Path(first["text_file"])
        self.assertTrue(saved_text.exists())
        self.outbox.mkdir(mode=0o700)
        outbox_db = sqlite3.connect(self.outbox / "outbox.sqlite3")
        outbox_db.execute("CREATE TABLE deliveries(stage_id TEXT,thread_id TEXT,run_id TEXT,delivery_id TEXT,state TEXT,receipt_json TEXT,created_at REAL)")
        outbox_db.execute("INSERT INTO deliveries VALUES('s','thread-later-stage','run-later-stage','delivery-pending','pending','{\"queued\":true}',1)")
        outbox_db.commit()
        outbox_db.close()
        (self.outbox / "outbox.sqlite3").chmod(0o600)
        with patch.object(capture, "bridge_module", return_value=fake):
            self.drain()
        later = self.candidate_rows()[0]
        self.assertEqual(later["candidate_id"], first["candidate_id"])
        self.assertEqual(later["status"], "staged")
        self.assertEqual(json.loads(later["receipt_json"])["state"], "pending")
        self.assertIn("state: pending", later["reason"])
        self.assertIsNone(later["text_file"])
        self.assertFalse(saved_text.exists())
        fake.fetch_snapshot.assert_called_once()

    def test_missing_thread_join_fails_closed_without_http_fetch(self):
        db = sqlite3.connect(self.t3db)
        db.execute("INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,status,completed_at) VALUES('run-orphan','missing-thread',1,'completed','2026-10-10T12:00:00Z')")
        db.commit()
        db.close()
        fake = self.fake_bridge()
        with patch.object(capture, "bridge_module", return_value=fake):
            self.drain()
        row = self.candidate_rows()[0]
        self.assertEqual(row["reason"], "source thread metadata is missing")
        self.assertEqual(row["diagnostic_class"], "unsupported_or_source_mismatch")
        self.assertIsNone(row["text_file"])
        fake.fetch_snapshot.assert_not_called()

    def fake_bridge(self):
        class Bridge:
            @staticmethod
            def load_config(path):
                return {"outboxDir": str(Path(json.loads(Path(path).read_text())["outboxDir"]))}

            @staticmethod
            def projection_thread_id(p):
                return p.get("thread", {}).get("id")

            @staticmethod
            def find_final(p, run_id):
                result = next((r for r in p["runs"] if r["id"] == run_id), None)
                if not result:
                    return None, "bound run is absent from current T3 snapshot"
                return p["messages"][0], ""

            fetch_snapshot = unittest.mock.Mock(side_effect=lambda cfg, tid: {"projection": projection(tid, "run-" + tid.removeprefix("thread-"))})
        return Bridge


if __name__ == "__main__":
    unittest.main()
