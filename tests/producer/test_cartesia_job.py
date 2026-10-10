import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).parents[2] / "scripts" / "cartesia-job.py"
spec = importlib.util.spec_from_file_location("cartesia_job", MODULE_PATH)
cartesia_job = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = cartesia_job
spec.loader.exec_module(cartesia_job)

# A small MPEG frame fixture for the coordinator's structural check. ffprobe is
# mocked at the validation boundary in portable unit tests.
FIXTURE_MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x64" + b"\x00" * 413
PROFILE = {"voiceId": "rena-fixture-id", "modelId": "sonic-fixture", "language": "de", "emotion": "calm"}


def write_private(path: Path, data: bytes) -> Path:
    path.write_bytes(data)
    path.chmod(0o600)
    return path


class CartesiaJobTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.private = self.root / "private"
        self.private.mkdir(mode=0o700)
        self.private.chmod(0o700)
        self.media = self.private / "media"
        self.media.mkdir(mode=0o700)
        self.media.chmod(0o700)
        self.marker = self.private / "fake-render.json"
        self.fake_speak = self.private / "fake-speak.py"
        self.fake_speak.write_text(textwrap.dedent(f"""\
            import argparse, json, os
            from pathlib import Path
            CONFIG = Path(os.environ['FAKE_SETTINGS'])
            DEFAULTS = {{'voice_id': None, 'model_id': 'sonic-fixture', 'language': 'de', 'emotion': 'calm', 'secret_ref': None}}
            def settings():
                result = DEFAULTS.copy()
                result.update(json.loads(CONFIG.read_text()))
                return result
            def credential_source(config):
                return 'proton-pass' if config.get('secret_ref') else 'missing'
            def split_text(text, limit=3500):
                return [text] if len(text) <= limit else [text[:limit], text[limit:]]
            def main():
                parser = argparse.ArgumentParser()
                sub = parser.add_subparsers(dest='cmd', required=True)
                render = sub.add_parser('render')
                render.add_argument('--input', required=True)
                render.add_argument('--output', required=True)
                render.add_argument('--emotion', required=True)
                args = parser.parse_args()
                source = Path(args.input)
                output = Path(args.output)
                os.umask(0o022)
                output.write_bytes({FIXTURE_MP3!r})
                output.with_suffix('.txt').write_text(source.read_text())
                output.with_suffix('.json').write_text(json.dumps({{
                    'audio_path': str(output), 'transcript_path': str(output.with_suffix('.txt')),
                    'duration_seconds': 1.25, 'characters': len(source.read_text().strip()),
                    'requests': 1, 'voice_id': settings()['voice_id'],
                    'model_id': settings()['model_id'], 'language': settings()['language'],
                    'emotion': args.emotion
                }}))
                Path(os.environ['FAKE_MARKER']).write_text(json.dumps({{
                    'argv': __import__('sys').argv[1:], 'transcript': str(source),
                    'transcript_mode': oct(source.stat().st_mode & 0o777),
                    'transcript_text': source.read_text(), 'emotion': args.emotion,
                    'config_voice': settings()['voice_id'],
                    'api_override_present': 'CARTESIA_API_KEY' in os.environ
                }}))
            if __name__ == '__main__': main()
        """))
        self.fake_speak.chmod(0o600)
        self.settings = write_private(self.private / "fake-settings.json", json.dumps({
            "voice_id": PROFILE["voiceId"], "model_id": PROFILE["modelId"],
            "language": PROFILE["language"], "emotion": PROFILE["emotion"],
            "secret_ref": "pass://fixture/private-reference",
        }).encode())
        self.env = {**os.environ, "FAKE_SETTINGS": str(self.settings), "FAKE_MARKER": str(self.marker)}
        self._original_env = os.environ.copy()
        os.environ.update(self.env)
        self.adapter_config = {
            "speakHelperPath": str(self.fake_speak), "pythonExecutable": sys.executable,
            "mediaDir": str(self.media), "profileRef": "voice-profile-fixture", "voiceProfile": PROFILE,
            "timeoutSeconds": 60,
        }
        self.config_path = write_private(self.private / "adapter.json", json.dumps(self.adapter_config).encode())
        self.module = cartesia_job._load_speak_module(self.fake_speak)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._original_env)
        self.temp.cleanup()

    def request(self, *, text="Eine klare deutsche Zusammenfassung mit einem bestätigten Ergebnis und einer knappen Einordnung.", **updates):
        job_id = "a" * 32
        nonce = "b" * 48
        value = {
            "protocol": 1, "jobId": job_id, "attempt": 1, "attemptNonce": nonce,
            "resultMetadata": {"phase": "final", "title": "Belegtes Ergebnis", "count": 2},
            "spokenAdaptation": text, "voiceProfileRef": "voice-profile-fixture",
            "expectedOutputPath": str(self.media / f"{job_id}-{nonce}.mp3"),
        }
        value.update(updates)
        return value

    def config(self):
        return cartesia_job._load_adapter_config(self.config_path)

    def test_single_render_uses_private_transcript_fixed_argv_and_local_receipt(self):
        self.assertEqual(cartesia_job._check_profile(self.config()).settings()['voice_id'], PROFILE["voiceId"])
        with mock.patch.object(cartesia_job, "_probe_mp3", return_value=1.25):
            receipt = cartesia_job._render(self.config(), self.module, self.request())
        expected_hash = hashlib.sha256(FIXTURE_MP3).hexdigest()
        self.assertEqual(receipt, {"status": "completed", "providerReceiptId": "local-cartesia-" + expected_hash,
                                   "durationSeconds": 1.25})
        observed = json.loads(self.marker.read_text())
        self.assertEqual(observed["argv"], ["render", "--input", observed["transcript"], "--output",
                                              self.request()["expectedOutputPath"], "--emotion", "calm"])
        self.assertEqual(observed["transcript_mode"], "0o600")
        self.assertEqual(observed["transcript_text"], self.request()["spokenAdaptation"] + "\n")
        self.assertFalse(Path(observed["transcript"]).exists())
        output = Path(self.request()["expectedOutputPath"])
        self.assertEqual(output.read_bytes(), FIXTURE_MP3)
        for artifact in [output, output.with_suffix(".txt"), output.with_suffix(".json")]:
            self.assertEqual(artifact.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(output.with_suffix(".json").read_text())["requests"], 1)

    def test_german_unicode_transcript_near_character_limit_is_accepted(self):
        text = "Über Größe und Änderungen. " * 125
        self.assertLessEqual(len(text), cartesia_job.MAX_TEXT)
        self.assertGreater(len((text.strip() + "\n").encode()), cartesia_job.MAX_TEXT + 2)
        with mock.patch.object(cartesia_job, "_probe_mp3", return_value=1.25):
            receipt = cartesia_job._render(self.config(), self.module, self.request(text=text))
        self.assertEqual(receipt["status"], "completed")

    def test_changed_renderer_transcript_is_rejected_after_single_attempt(self):
        self.fake_speak.write_text(self.fake_speak.read_text().replace(
            "output.with_suffix('.txt').write_text(source.read_text())",
            "output.with_suffix('.txt').write_text('Andere Aufnahme\\n')"))
        with mock.patch.object(cartesia_job, "_probe_mp3", return_value=1.25):
            with self.assertRaisesRegex(cartesia_job.JobError, "transcript"):
                cartesia_job._render(self.config(), self.module, self.request())
        self.assertTrue(self.marker.exists())

    def test_bad_identity_foreign_path_sidecar_and_untrusted_text_block_before_render(self):
        cases = [
            self.request(jobId="../bad"),
            self.request(expectedOutputPath=str(self.private / "foreign.mp3")),
            self.request(text="Hier steht https://example.com/ als Adresse."),
            self.request(text="Code: `rm -rf /tmp/example`"),
            self.request(text="Datei liegt unter /var/private/audio/datei.mp3"),
            self.request(text="Ein Satz. " + "weiter " * 1000),
            self.request(resultMetadata={"noteInstructions": "read this aloud"}),
        ]
        with mock.patch.object(cartesia_job, "_probe_mp3", return_value=1.25):
            for request in cases:
                with self.subTest(request=request):
                    with self.assertRaises(cartesia_job.JobError):
                        cartesia_job._render(self.config(), self.module, request)
        self.assertFalse(self.marker.exists())
        self.assertEqual(list(self.media.iterdir()), [])

    def test_existing_output_sidecar_and_symlink_paths_are_rejected(self):
        request = self.request()
        output = Path(request["expectedOutputPath"])
        output.write_bytes(b"existing")
        with self.assertRaises(cartesia_job.JobError):
            cartesia_job._render(self.config(), self.module, request)
        output.unlink()
        output.with_suffix(".json").symlink_to(self.marker)
        with self.assertRaises(cartesia_job.JobError):
            cartesia_job._render(self.config(), self.module, request)
        self.assertFalse(self.marker.exists())

    def test_changed_voice_model_language_or_emotion_blocks_before_renderer(self):
        for field, value in (("voice_id", "other"), ("model_id", "other-model"),
                             ("language", "en"), ("emotion", "content")):
            settings = json.loads(self.settings.read_text())
            settings[field] = value
            write_private(self.settings, json.dumps(settings).encode())
            with self.subTest(field=field):
                with self.assertRaises(cartesia_job.JobError):
                    cartesia_job._check_profile(self.config())
                self.assertFalse(self.marker.exists())
            settings[field] = {"voice_id": PROFILE["voiceId"], "model_id": PROFILE["modelId"],
                               "language": PROFILE["language"], "emotion": PROFILE["emotion"]}[field]
            write_private(self.settings, json.dumps(settings).encode())

    def test_speak_failure_after_start_is_one_attempt_and_has_no_receipt(self):
        self.fake_speak.write_text(self.fake_speak.read_text().replace(
            "    output.write_bytes(",
            "    Path(os.environ['FAKE_MARKER']).write_text('started')\n    raise RuntimeError('private failure')\n    output.write_bytes("))
        request = self.request()
        with self.assertRaises(cartesia_job.JobError):
            cartesia_job._render(self.config(), self.module, request)
        self.assertEqual(self.marker.read_text(), "started")
        self.assertFalse(Path(request["expectedOutputPath"]).exists())
        self.assertFalse(Path(request["expectedOutputPath"]).with_suffix(".json").exists())

    def test_multiple_request_sidecar_is_rejected_without_receipt(self):
        self.fake_speak.write_text(self.fake_speak.read_text().replace("'requests': 1", "'requests': 2"))
        request = self.request()
        with mock.patch.object(cartesia_job, "_probe_mp3", return_value=1.25):
            with self.assertRaises(cartesia_job.JobError):
                cartesia_job._render(self.config(), self.module, request)
        self.assertTrue(self.marker.exists())
        self.assertTrue(Path(request["expectedOutputPath"]).exists())
        self.assertEqual(json.loads(Path(request["expectedOutputPath"]).with_suffix(".json").read_text())["requests"], 2)

    def test_cli_emits_only_compact_receipt_and_masks_diagnostics(self):
        request = self.request()
        run_env = {**self.env, "CARTESIA_API_KEY": "must-not-override-helper"}
        with mock.patch.object(cartesia_job, "_probe_mp3", return_value=1.25):
            # Exercise _main in-process with the real argv parser and fake render
            # process. The external helper never contacts a provider.
            from io import BytesIO, StringIO
            stdin = sys.stdin
            stdout, stderr = sys.stdout, sys.stderr
            try:
                sys.stdin = type("Input", (), {"buffer": BytesIO(json.dumps(request).encode())})()
                sys.stdout, sys.stderr = StringIO(), StringIO()
                with mock.patch.object(sys, "argv", [str(MODULE_PATH), "--config-file", str(self.config_path), "--audio-job-stdin-json"]):
                    with mock.patch.dict(os.environ, run_env):
                        self.assertEqual(cartesia_job._main(), 0)
                result = sys.stdout.getvalue()
                self.assertEqual(set(json.loads(result)), {"status", "providerReceiptId", "durationSeconds"})
                self.assertNotIn("must-not-override-helper", result + sys.stderr.getvalue())
                self.assertEqual(result.count("\n"), 1)
                self.assertFalse(json.loads(self.marker.read_text())["api_override_present"])
            finally:
                sys.stdin, sys.stdout, sys.stderr = stdin, stdout, stderr

    def test_parent_flag_order_uses_private_config_environment(self):
        from io import BytesIO, StringIO
        stdin = sys.stdin
        stdout, stderr = sys.stdout, sys.stderr
        try:
            sys.stdin = type("Input", (), {"buffer": BytesIO(json.dumps(self.request()).encode())})()
            sys.stdout, sys.stderr = StringIO(), StringIO()
            with mock.patch.object(sys, "argv", [str(MODULE_PATH), "--audio-job-stdin-json"]):
                with mock.patch.dict(os.environ, {**self.env, "CARTESIA_JOB_CONFIG_FILE": str(self.config_path)}):
                    with mock.patch.object(cartesia_job, "_probe_mp3", return_value=1.25):
                        self.assertEqual(cartesia_job._main(), 0)
            self.assertEqual(json.loads(sys.stdout.getvalue())["status"], "completed")
        finally:
            sys.stdin, sys.stdout, sys.stderr = stdin, stdout, stderr

    def test_probe_validation_rejects_non_mp3_or_invalid_duration(self):
        invalid_duration = (0, b'{"format":{"duration":"0"},"streams":[{"codec_name":"mp3"}]}', b"")
        with mock.patch.object(cartesia_job, "_run_bounded", return_value=invalid_duration):
            with self.assertRaises(cartesia_job.JobError):
                cartesia_job._probe_mp3(self.media / "fixture.mp3")
        wrong_codec = (0, b'{"format":{"duration":"1.0"},"streams":[{"codec_name":"wav"}]}', b"")
        with mock.patch.object(cartesia_job, "_run_bounded", return_value=wrong_codec):
            with self.assertRaises(cartesia_job.JobError):
                cartesia_job._probe_mp3(self.media / "fixture.mp3")

    def test_subprocess_output_is_bounded_and_never_returned_on_overflow(self):
        command = [sys.executable, "-c",
                   "import sys; sys.stdout.write('x' * 10000); sys.stderr.write('y' * 10000)"]
        with self.assertRaises(cartesia_job.JobError):
            cartesia_job._run_bounded(command, timeout=10, env=os.environ.copy(),
                                      stdout_limit=64, stderr_limit=64)

    def test_real_speak_splitter_accepts_one_chunk_and_rejects_multiple_without_rendering(self):
        real_helper = Path.home() / ".codex/skills/cartesia-audio/scripts/speak.py"
        if not real_helper.is_file():
            self.skipTest("official Cartesia helper is unavailable")
        helper = cartesia_job._load_speak_module(real_helper)
        self.assertEqual(cartesia_job._validate_spoken_text("Ein kurzer deutscher Satz.", helper),
                         "Ein kurzer deutscher Satz.")
        with self.assertRaises(cartesia_job.JobError):
            cartesia_job._validate_spoken_text("Satz eins. " + ("Ein langes Wort " * 350), helper)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg/ffprobe unavailable")
    def test_actual_audio_store_runs_adapter_and_keeps_single_ready_attempt(self):
        fixture = self.private / "ledger-fixture.mp3"
        subprocess.run([shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error",
                        "-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=44100",
                        "-t", "0.15", "-codec:a", "libmp3lame", "-b:a", "64k",
                        "-write_xing", "0", str(fixture)], check=True, timeout=20,
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        duration = cartesia_job._probe_mp3(fixture)
        self.fake_speak.write_text(self.fake_speak.read_text().replace(
            repr(FIXTURE_MP3), repr(fixture.read_bytes())).replace(
            "'duration_seconds': 1.25", "'duration_seconds': " + repr(duration)))
        job_spec = importlib.util.spec_from_file_location("cartesia_test_audio_jobs", MODULE_PATH.with_name("audio-jobs.py"))
        jobs = importlib.util.module_from_spec(job_spec)
        sys.modules[job_spec.name] = jobs
        job_spec.loader.exec_module(jobs)
        store = jobs.AudioJobStore(self.private / "ledger.sqlite", self.media)
        metadata = write_private(self.private / "result.json", b'{"phase":"final","title":"Ergebnis"}')
        spoken = write_private(self.private / "spoken.txt", self.request()["spokenAdaptation"].encode())
        row = store.enqueue(result_identity="fixture-result", metadata_path=metadata,
                            spoken_text_path=spoken, voice_profile_sha256="c" * 64, meaningful=True)
        helper = jobs.HelperConfig((sys.executable,), MODULE_PATH.resolve(), "voice-profile-fixture", 60)
        with mock.patch.dict(os.environ, {"CARTESIA_JOB_CONFIG_FILE": str(self.config_path)}):
            completed = store.run_one(helper, lease_seconds=90)
            self.assertIsNone(store.run_one(helper, lease_seconds=90))
        self.assertEqual(completed["state"], "ready")
        self.assertEqual(completed["id"], row["id"])
        self.assertEqual(completed["media_sha256"], hashlib.sha256(fixture.read_bytes()).hexdigest())
        self.assertEqual(len(store.attempts(row["id"])), 1)
        self.assertAlmostEqual(completed["duration_seconds"], duration)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg/ffprobe unavailable")
    def test_ffprobe_accepts_a_real_synthetic_mp3_fixture(self):
        output = self.private / "synthetic-fixture.mp3"
        result = subprocess.run([
            shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error", "-f", "lavfi",
            "-i", "anullsrc=channel_layout=mono:sample_rate=44100", "-t", "0.15",
            "-codec:a", "libmp3lame", "-b:a", "64k", "-write_xing", "0", str(output),
        ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=20, check=False, shell=False)
        self.assertEqual(result.returncode, 0)
        output.chmod(0o600)
        self.assertGreater(cartesia_job._probe_mp3(output), 0)


if __name__ == "__main__":
    unittest.main()
