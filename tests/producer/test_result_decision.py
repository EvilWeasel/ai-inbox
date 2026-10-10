import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

MODULE_PATH = Path(__file__).parents[2] / "scripts" / "result-decision.py"
spec = importlib.util.spec_from_file_location("result_decision", MODULE_PATH)
decision_module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = decision_module
spec.loader.exec_module(decision_module)


HELP_OPTIONS = "--ignore-user-config --ephemeral --ignore-rules --skip-git-repo-check --output-schema --json --output-last-message --sandbox --model -c [PROMPT]"


def spoken_fixture():
    sentences = [
        "Das Ergebnis fasst die abgeschlossene Arbeit verständlich zusammen und ordnet die wichtigsten Belege ein.",
        "Es beschreibt den erreichten Stand, die getroffenen Entscheidungen und die noch offenen Unsicherheiten.",
        "Die Darstellung bleibt beim vorhandenen Material und ergänzt keine unbelegten Aussagen oder Zusagen.",
        "Für die weitere Einordnung sind die genannten Quellen und der konkrete Projektkontext maßgeblich.",
        "So lässt sich der fertige Beitrag anhören, ohne technische Pfade, Links oder Code vorlesen zu müssen.",
    ]
    return " ".join(sentences * 4)


class ResultDecisionAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.private = self.root / "private"
        self.private.mkdir(mode=0o700)
        self.private.chmod(0o700)
        self.cache = self.private / "cache"
        self.cache.mkdir(mode=0o700)
        self.cache.chmod(0o700)
        self.calls = self.private / "calls.jsonl"
        self.codex = self.private / "fake-codex"
        self.codex.write_text("#!/usr/bin/env python3\nprint('fake')\n")
        self.codex.chmod(0o700)
        self.config_path = self.private / "adapter.json"
        self.config = {"codexExecutable": str(self.codex), "cacheDir": str(self.cache), "timeoutSeconds": 3}
        self._write_adapter_config()
        self.request = {"protocol": 1, "identity": {"threadId": "thread-1", "runId": "run-1"},
                        "capturedFinalText": "Ein abgeschlossenes Ergebnis mit einer verbleibenden Unsicherheit.",
                        "sourceRefs": [{"title": "Quelle", "url": "https://example.test/source"}]}
        self.response = {"decision": "meaningful", "title": "Abgeschlossene Auswertung",
                         "resultType": "research", "spokenText": spoken_fixture()}

    def tearDown(self):
        self.temp.cleanup()

    def _write_adapter_config(self):
        self.config_path.write_text(json.dumps(self.config))
        self.config_path.chmod(0o600)

    def _fake_codex(self, *, result=None, events=None, help_options=HELP_OPTIONS,
                    sleep_seconds=0, stdout_flood=0, stderr_flood=0, failure=None):
        response = self.response if result is None else result
        events = events if events is not None else [
            {"type": "thread.started", "thread_id": "fixture"},
            {"type": "turn.started"},
            {"type": "item.completed", "item": {"type": "agent_message", "text": "structured result"}},
            {"type": "turn.completed"},
        ]
        script = f'''#!/usr/bin/env python3
import json, pathlib, sys, time
args = sys.argv[1:]
if "--help" in args:
    print({help_options!r})
    raise SystemExit(0)
stdin_payload = sys.stdin.buffer.read()
with open({str(self.calls)!r}, "a", encoding="utf-8") as f:
    f.write(json.dumps({{"args": args, "has_mcp": any("MCP" in k.upper() or k.upper().startswith("T3_") for k in __import__("os").environ), "has_secret": any("API_KEY" in k.upper() or "TOKEN" in k.upper() or "SECRET" in k.upper() for k in __import__("os").environ), "has_request": b'"capturedFinalText"' in stdin_payload and b'Ein abgeschlossenes Ergebnis' in stdin_payload}}) + "\\n")
time.sleep({sleep_seconds!r})
sys.stdout.write("x" * {stdout_flood} + "\\n")
sys.stderr.write("y" * {stderr_flood})
if {failure!r} is not None:
    sys.stderr.write({failure!r})
    raise SystemExit(2)
events = {json.dumps(events)!r}
for event in json.loads(events): print(json.dumps(event))
if "--output-last-message" in args:
    pathlib.Path(args[args.index("--output-last-message") + 1]).write_text({json.dumps(response, ensure_ascii=False)!r})
'''
        self.codex.write_text(script)
        self.codex.chmod(0o700)

    def _run(self, request=None):
        config = decision_module.load_config(self.config_path)
        raw = json.dumps(request or self.request, ensure_ascii=False, separators=(",", ":")).encode()
        return decision_module._invoke(raw, config)

    def test_meaningful_result_is_strict_german_output_with_required_argv_and_environment(self):
        self._fake_codex()
        old = {key: os.environ.get(key) for key in ("T3_ACP_MCP_NODE", "T3_PRIVATE_ENDPOINT", "OPENAI_API_KEY")}
        os.environ["T3_ACP_MCP_NODE"] = "/private/test-mcp"
        os.environ["T3_PRIVATE_ENDPOINT"] = "https://private.test"
        os.environ["OPENAI_API_KEY"] = "fixture-secret"
        try:
            result = json.loads(self._run())
        finally:
            for key, value in old.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        self.assertEqual(set(result), {"decision", "title", "resultType", "spokenText"})
        self.assertEqual(result["decision"], "meaningful")
        self.assertEqual(result["resultType"], "research")
        self.assertGreaterEqual(len(result["spokenText"].split()), 100)
        call = json.loads(self.calls.read_text().splitlines()[0])
        args = call["args"]
        self.assertFalse(call["has_mcp"])
        self.assertFalse(call["has_secret"])
        self.assertEqual(args[-1], "-")
        self.assertNotIn("Ein abgeschlossenes Ergebnis", args)
        self.assertTrue(call["has_request"])
        self.assertIn("--ignore-user-config", args)
        self.assertIn("--ephemeral", args)
        self.assertIn("--ignore-rules", args)
        self.assertEqual(args[args.index("--sandbox") + 1], "read-only")
        self.assertIn("--output-schema", args)
        self.assertIn("--json", args)
        self.assertIn("--model", args)
        self.assertEqual(args[args.index("-c") + 1], 'model_reasoning_effort="low"')
        self.assertIn('service_tier="default"', args)
        self.assertTrue(any(value == "features.shell_tool=false" for value in args))
        self.assertTrue(any(value == "features.unified_exec=false" for value in args))
        self.assertTrue(any(value == "features.code_mode=false" for value in args))
        self.assertTrue(any(value == 'web_search="disabled"' for value in args))
        self.assertTrue(any(value == "features.plugins=false" for value in args))
        self.assertTrue(any(value == "project_doc_max_bytes=0" for value in args))

    def test_exclude_and_review_are_normalized_to_pipeline_exact_keys(self):
        for outcome in ("exclude", "review"):
            with self.subTest(outcome=outcome):
                self._fake_codex(result={"decision": outcome, "title": None, "resultType": None, "spokenText": None})
                self.assertEqual(json.loads(self._run(dict(self.request, capturedFinalText=outcome))), {"decision": outcome})

    def test_cache_is_idempotent_for_same_request_and_invalidates_on_text_identity_or_config(self):
        self._fake_codex()
        self._run()
        self._run()
        self.assertEqual(len(self.calls.read_text().splitlines()), 1)
        changed = dict(self.request, capturedFinalText="Ein anderer fertiger Beitrag.")
        self._run(changed)
        changed_identity = dict(self.request, identity={"threadId": "thread-2", "runId": "run-1"})
        self._run(changed_identity)
        self.assertEqual(len(self.calls.read_text().splitlines()), 3)
        self.config["model"] = "gpt-6-sol"
        self._write_adapter_config()
        self._run()
        self.assertEqual(len(self.calls.read_text().splitlines()), 4)
        self.assertEqual(len(list(self.cache.glob("*.json"))), 4)

    def test_oversized_input_is_rejected_before_codex_runs(self):
        self._fake_codex()
        raw = b"{" + b" " * decision_module.MAX_REQUEST + b"}"
        with self.assertRaisesRegex(decision_module.DecisionError, "1.25 MiB"):
            decision_module._invoke(raw, decision_module.load_config(self.config_path))
        self.assertFalse(self.calls.exists())

    def test_output_and_stderr_are_drained_with_bounded_capture(self):
        self._fake_codex(stdout_flood=decision_module.MAX_STDOUT + 1,
                         stderr_flood=decision_module.MAX_STDERR + 1)
        with self.assertRaisesRegex(decision_module.DecisionError, "output limits"):
            self._run()

    def test_timeout_kills_codex_without_logging_candidate_content(self):
        self.config["timeoutSeconds"] = 1
        self._write_adapter_config()
        self._fake_codex(sleep_seconds=4)
        with self.assertRaisesRegex(decision_module.DecisionError, "timed out"):
            self._run()
        self.assertNotIn(self.request["capturedFinalText"], self.calls.read_text())

    def test_tool_or_command_attempt_fails_closed_without_cache(self):
        self._fake_codex(events=[{"type": "item.completed", "item": {"type": "command_execution", "command": "ignored"}}])
        with self.assertRaisesRegex(decision_module.DecisionError, "tool, command"):
            self._run()
        self.assertEqual(list(self.cache.glob("*.json")), [])

    def test_error_failed_and_incomplete_turn_events_fail_closed(self):
        for events in ([{"type": "error", "message": "failed"}],
                       [{"type": "turn.started"}, {"type": "turn.failed"}],
                       [{"type": "thread.started"}, {"type": "turn.started"}],
                       [{"type": "turn.started"}, {"type": "turn.completed", "is_error": True}]):
            with self.subTest(events=events):
                self._fake_codex(events=events)
                with self.assertRaises(decision_module.DecisionError):
                    self._run()
        self.assertEqual(list(self.cache.glob("*.json")), [])

    def test_exclude_and_review_cache_entries_are_reusable(self):
        for outcome in ("exclude", "review"):
            with self.subTest(outcome=outcome):
                self._fake_codex(result={"decision": outcome, "title": None, "resultType": None, "spokenText": None})
                request = dict(self.request, capturedFinalText=outcome)
                self.assertEqual(json.loads(self._run(request)), {"decision": outcome})
                self.assertEqual(json.loads(self._run(request)), {"decision": outcome})
        self.assertEqual(len(self.calls.read_text().splitlines()), 2)

    def test_malformed_or_unsupported_result_never_enters_cache(self):
        for result in (
            {"decision": "meaningful", "title": "Done", "resultType": "report", "spokenText": "Zu kurz."},
            {"decision": "meaningful", "title": "Result", "resultType": "report", "spokenText": spoken_fixture(), "identity": "fake"},
            {"decision": "exclude", "title": "should be absent", "resultType": None, "spokenText": None},
        ):
            with self.subTest(result=result["decision"]):
                self._fake_codex(result=result)
                with self.assertRaises(decision_module.DecisionError):
                    self._run()
        self.assertEqual(list(self.cache.glob("*.json")), [])

    def test_unsupported_cli_options_are_reported_before_any_inference(self):
        self._fake_codex(help_options="--ignore-user-config --ephemeral --json")
        with self.assertRaisesRegex(decision_module.DecisionError, "lacks required options: --ignore-rules"):
            self._run()
        self.assertFalse(self.calls.exists())

    def test_unknown_private_config_or_disabled_feature_is_reported_without_raw_diagnostics(self):
        self._fake_codex(failure="unknown config key features.unified_exec")
        with self.assertRaisesRegex(decision_module.DecisionError, "disabled-feature setting; tool-free mode is not established") as error:
            self._run()
        self.assertNotIn("unified_exec", str(error.exception))
        self.assertEqual(list(self.cache.glob("*.json")), [])

    def test_invalid_paths_or_legacy_config_fields_fail_closed(self):
        self._fake_codex()
        self.config["codexExecutable"] = "codex"
        self._write_adapter_config()
        with self.assertRaisesRegex(decision_module.DecisionError, "absolute path"):
            decision_module.load_config(self.config_path)
        self.config["codexExecutable"] = str(self.codex)
        self.config["codexConfigFile"] = "/private/legacy-codex.toml"
        self._write_adapter_config()
        with self.assertRaisesRegex(decision_module.DecisionError, "adapter config fields are invalid"):
            decision_module.load_config(self.config_path)
        self.assertFalse(self.calls.exists())


if __name__ == "__main__":
    unittest.main()
