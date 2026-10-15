import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("observatory_agent", Path(__file__).parents[2] / "scripts/observatory-agent.py")
agent = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent)


class ObservatoryAgentTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.calls = []
        self.native_token = "native-credential-DO-NOT-PRINT"
        self.producer_token = "producer-credential-DO-NOT-PRINT"
        self.environment = "environment"
        self.mode = "normal"
        self.revision = 3
        self.attempt = "attempt"
        self.run = "run"
        self.ordinal = 1
        self.native_pointer = "/credential/token"
        test = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                self.respond()

            def do_POST(self):
                self.respond()

            def respond(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"]))) if self.command == "POST" else None
                test.calls.append((self.command, self.path, self.headers.get("Authorization"), body))
                if self.path == "/.well-known/t3/environment":
                    if test.mode == "redirect":
                        self.send_response(302)
                        self.send_header("Location", test.base + "/redirect-target")
                        self.end_headers()
                        return
                    result = {"environmentId": test.environment, "orchestrationProtocolVersion": 2}
                elif self.path.endswith("/bounded"):
                    result = test.snapshot()
                elif self.path.endswith("/register"):
                    result = {**body, "producerId": "producer", "expiresAt": "2030-01-01T00:00:00Z"}
                elif "/actions/read?" in self.path:
                    result = {"canvases": [{**test.identity(), "revision": test.revision}]} if test.revision else {"canvases": []}
                elif self.path.endswith("/publish"):
                    if test.mode == "conflict":
                        self.send_response(409)
                        self.end_headers()
                        self.wfile.write(test.producer_token.encode())
                        return
                    if test.mode == "publish-redirect":
                        self.send_response(307)
                        self.send_header("Location", test.base + "/redirect-target")
                        self.end_headers()
                        return
                    result = {**body, "revision": body["expectedRevision"] + 1}
                else:
                    self.send_response(500)
                    self.end_headers()
                    return
                data = json.dumps(result).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.token_path = self.write("native.json", {"credential": {"token": self.native_token}})
        self.producer_token_path = self.write("producer-token", self.producer_token, raw=True)
        self.producer = self.write("producer.json", {"endpoint": self.base + "/api/results", "tokenFile": str(self.producer_token_path)})
        self.bridge = self.write("bridge.json", {"t3Origin": self.base, "t3TokenFile": str(self.token_path), "t3TokenJsonPointer": self.native_pointer,
                                                  "producerConfigFile": str(self.producer), "environmentId": "environment"})
        self.canvas = self.write("canvas.json", {"title": "Private canvas-DO-NOT-PRINT", "summary": "private"})

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def write(self, name, value, raw=False):
        path = self.root / name
        path.write_text(value if raw else json.dumps(value))
        path.chmod(0o600)
        return path

    def identity(self):
        return {"hostId": "host-key", "threadId": "verified-thread", "runId": self.run, "attemptId": self.attempt}

    def snapshot(self):
        return {"projection": {"thread": {"id": "verified-thread"}, "runs": [
            {"id": "old", "ordinal": 0, "activeAttemptId": "old-attempt", "status": "completed"},
            {"id": self.run, "ordinal": self.ordinal, "activeAttemptId": self.attempt, "status": "running"}],
            "attempts": [{"id": self.attempt, "runId": self.run}]}}

    def invoke(self, *extra):
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            code = agent.main(["--bridge-config", str(self.bridge), "--host-id", "host-key", "--thread-id", "verified-thread",
                               "--environment-id", "environment", "--canvas", str(self.canvas), *extra])
        text = output.getvalue() + errors.getvalue()
        for secret in [self.native_token, self.producer_token, "canvas-DO-NOT-PRINT"]:
            self.assertNotIn(secret, text)
        return code, output.getvalue(), errors.getvalue()

    def test_register_read_publish_uses_current_identity_and_explicit_cas(self):
        code, out, _ = self.invoke("--expected-revision", "3")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["revision"], 4)
        self.assertEqual(len(self.calls), 5)
        self.assertIsNone(self.calls[0][2], "descriptor receives no credential")
        self.assertEqual(self.calls[1][2], "Bearer " + self.native_token)
        for call in self.calls[2:]:
            self.assertEqual(call[2], "Bearer " + self.producer_token)
        self.assertEqual(self.calls[2][3], self.identity())
        self.assertEqual(self.calls[4][3]["expectedRevision"], 3)

    def test_fresh_attempt_run_and_no_previous_canvas_start_revision_zero(self):
        self.run, self.attempt, self.ordinal, self.revision = "new-run", "new-attempt", 2, 0
        code, out, _ = self.invoke()
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["runId"], "new-run")
        self.assertEqual(self.calls[4][3]["expectedRevision"], 0)

    def test_conflict_is_one_attempt_with_no_body_or_credential_logging(self):
        self.mode = "conflict"
        code, _, err = self.invoke()
        self.assertEqual(code, 1)
        self.assertTrue(json.loads(err)["conflict"])
        self.assertEqual(sum(c[1].endswith("/publish") for c in self.calls), 1)

    def test_explicit_cas_mismatch_stops_before_publish(self):
        code, _, _ = self.invoke("--expected-revision", "2")
        self.assertEqual(code, 1)
        self.assertFalse(any(c[1].endswith("/publish") for c in self.calls))

    def test_descriptor_mismatch_sends_no_native_or_producer_bearer(self):
        self.environment = "other-environment"
        self.assertEqual(self.invoke()[0], 1)
        self.assertEqual(len(self.calls), 1)
        self.assertIsNone(self.calls[0][2])

    def test_config_environment_mismatch_makes_no_requests(self):
        value = json.loads(self.bridge.read_text());value["environmentId"] = "different"
        self.write("bridge.json", value)
        self.assertEqual(self.invoke()[0], 1)
        self.assertEqual(self.calls, [])

    def test_environment_argument_required_even_if_bridge_has_no_binding(self):
        value = json.loads(self.bridge.read_text());del value["environmentId"]
        self.write("bridge.json", value)
        self.assertEqual(self.invoke()[0], 0, "explicit environment argument binds the descriptor")

    def test_descriptor_redirect_never_followed(self):
        self.mode = "redirect"
        self.assertEqual(self.invoke()[0], 1)
        self.assertEqual(len(self.calls), 1)

    def test_authenticated_publish_redirect_never_followed(self):
        self.mode = "publish-redirect"
        self.assertEqual(self.invoke()[0], 1)
        self.assertEqual(len(self.calls), 5)
        self.assertFalse(any(c[1] == "/redirect-target" for c in self.calls))

    def test_private_credentials_reject_loose_mode_and_symlinks(self):
        self.producer_token_path.chmod(0o644)
        self.assertEqual(self.invoke()[0], 1)
        self.assertFalse(any("/actions/" in c[1] for c in self.calls))
        self.producer_token_path.chmod(0o600)
        link = self.root / "symlink";link.symlink_to(self.producer_token_path)
        with self.assertRaises(agent.AgentError):
            agent.credential(link)

    def test_private_http_requires_explicit_opt_in_and_private_ip(self):
        self.assertEqual(agent.origin("http://100.64.1.2:1234", allow_private_http=True), "http://100.64.1.2:1234")
        for value in ["http://8.8.8.8", "http://example.test"]:
            with self.assertRaises(agent.AgentError):
                agent.origin(value, allow_private_http=True)
        self.assertEqual(agent.credential(self.token_path, ["credential", "token"]), self.native_token)

    def test_raw_token_and_json_pointer_escape_are_supported_without_copying(self):
        self.assertEqual(agent.credential(self.producer_token_path), self.producer_token)
        escaped = self.write("escaped.json", {"a/b": {"~token": self.native_token}})
        self.assertEqual(agent.credential(escaped, "/a~1b/~0token"), self.native_token)
        with self.assertRaises(agent.AgentError):
            agent.credential(escaped, "/a~2b")

    def test_run_ambiguity_wrong_thread_old_run_and_wrong_attempt_fail_closed(self):
        snapshot = self.snapshot()
        with self.assertRaises(agent.AgentError):
            agent.current_identity(snapshot, "host", "provider-session-uuid")
        snapshot["projection"]["runs"][1]["ordinal"] = 0
        with self.assertRaises(agent.AgentError):
            agent.current_identity(snapshot, "host", "verified-thread")
        snapshot = self.snapshot();snapshot["projection"]["runs"][1]["status"] = "completed"
        with self.assertRaises(agent.AgentError):
            agent.current_identity(snapshot, "host", "verified-thread")
        snapshot = self.snapshot();snapshot["projection"]["attempts"][0]["runId"] = "old"
        with self.assertRaises(agent.AgentError):
            agent.current_identity(snapshot, "host", "verified-thread")

    def test_remote_plain_http_and_arbitrary_origin_paths_rejected(self):
        for value in ["http://remote.example.test", "https://user:pass@example.test", "https://example.test/path", "https://example.test?token=x"]:
            with self.assertRaises(agent.AgentError):
                agent.origin(value)

    def test_response_limit_is_enforced(self):
        with self.assertRaises(agent.AgentError):
            agent.request_json(self.base, "/.well-known/t3/environment", limit=10)

    def test_no_environment_proxies_are_installed(self):
        with patch.object(agent.urllib.request.ProxyHandler, "__init__", return_value=None) as handler:
            # Inspect construction independently of urllib's isinstance checks.
            with patch.object(agent.urllib.request, "build_opener", side_effect=agent.AgentError("stop")):
                with self.assertRaises(agent.AgentError):
                    agent.request_json(self.base, "/.well-known/t3/environment")
            handler.assert_called_once_with({})



if __name__ == "__main__":
    unittest.main()
