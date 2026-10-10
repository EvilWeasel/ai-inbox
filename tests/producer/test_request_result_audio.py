import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

MODULE_PATH = Path(__file__).parents[2] / "scripts" / "request-result-audio.py"
spec = importlib.util.spec_from_file_location("request_result_audio", MODULE_PATH)
audio_module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = audio_module
spec.loader.exec_module(audio_module)


class Response:
    def __init__(self, value):
        self.raw = value if isinstance(value, bytes) else json.dumps(value).encode()
    def __enter__(self): return self
    def __exit__(self, *_args): return False
    def read(self, size=-1): return self.raw[:size]


class Opener:
    def __init__(self, response): self.response, self.requests = (response if hasattr(response, "__enter__") else Response(response)), []
    def open(self, request, timeout):
        self.requests.append((request, timeout))
        return self.response


class RequestResultAudioTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.token = self.root / "token"
        self.token.write_text("secret-token\n")
        self.token.chmod(0o600)
        self.config = self.root / "producer.json"
        self.config.write_text(json.dumps({"endpoint": "https://inbox.example.test/api/results",
                                           "tokenFile": str(self.token)}))
        self.config.chmod(0o600)
        self.metadata = self.root / "metadata.json"
        self.body = "Original result body\nwith exact bytes."
        self.metadata.write_text(json.dumps({"deliveryId": "delivery-1", "body": self.body}))
        self.metadata.chmod(0o600)
        self.spoken = self.root / "spoken.txt"
        self.spoken_text = "Die knappe gesprochene Fassung des Ergebnisses."
        self.spoken.write_text(self.spoken_text)
        self.spoken.chmod(0o600)
        self.item = "inbox-item-1"
        self.job = hashlib.sha256(b"job").hexdigest()

    def tearDown(self): self.temp.cleanup()

    def test_post_uses_exact_hashes_strict_payload_and_expected_item(self):
        opener = Opener({"state": "queued", "jobId": self.job, "itemId": self.item})
        result = audio_module.request_audio(self.config, self.metadata, self.spoken, self.item, opener=opener)
        self.assertEqual(result, {"state": "queued", "jobId": self.job, "itemId": self.item})
        request, timeout = opener.requests[0]
        payload = json.loads(request.data)
        spoken_bytes = self.spoken_text.encode("utf-8")
        self.assertEqual(payload, {"protocol": 1, "deliveryId": "delivery-1",
            "bodySha256": hashlib.sha256(self.body.encode()).hexdigest(),
            "spokenText": self.spoken_text, "spokenSha256": hashlib.sha256(spoken_bytes).hexdigest()})
        self.assertEqual(request.full_url, "https://inbox.example.test/api/results/audio-jobs")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret-token")
        self.assertLessEqual(timeout, 20)

    def test_post_ready_existing_and_status_ready_are_validated(self):
        existing = Opener({"state": "ready_existing", "itemId": self.item})
        self.assertEqual(audio_module.request_audio(self.config, self.metadata, self.spoken,
                         self.item, opener=existing), {"state": "ready_existing", "itemId": self.item})
        ready = Opener({"jobId": self.job, "itemId": self.item, "state": "ready",
                        "mediaSha256": "a" * 64, "duration": 8.5})
        self.assertEqual(audio_module.get_audio_status(self.config, self.job, self.item, opener=ready),
                         {"state": "ready", "jobId": self.job, "itemId": self.item,
                          "mediaSha256": "a" * 64, "durationSeconds": 8.5})
        request, _ = ready.requests[0]
        self.assertEqual(request.full_url, f"https://inbox.example.test/api/results/audio-jobs/{self.job}")

    def test_foreign_item_and_job_and_invalid_duration_are_rejected(self):
        foreign = Opener({"state": "queued", "jobId": self.job, "itemId": "somebody-else"})
        with self.assertRaises(audio_module.AudioRequestError):
            audio_module.request_audio(self.config, self.metadata, self.spoken, self.item, opener=foreign)
        foreign_job = Opener({"state": "ready", "jobId": "b" * 64, "itemId": self.item})
        with self.assertRaises(audio_module.AudioRequestError):
            audio_module.get_audio_status(self.config, self.job, self.item, opener=foreign_job)
        bad_duration = Opener({"state": "ready", "jobId": self.job, "itemId": self.item,
                               "duration": float("nan")})
        with self.assertRaises(audio_module.AudioRequestError):
            audio_module.get_audio_status(self.config, self.job, self.item, opener=bad_duration)

    def test_ready_requires_both_media_hash_and_positive_duration(self):
        base = {"state": "ready", "jobId": self.job, "itemId": self.item,
                "mediaSha256": "a" * 64, "duration": 8.5}
        for field in ("mediaSha256", "duration"):
            missing = dict(base)
            del missing[field]
            with self.subTest(field=field), self.assertRaises(audio_module.AudioRequestError):
                audio_module.get_audio_status(self.config, self.job, self.item, opener=Opener(missing))

    def test_endpoint_redirect_response_and_token_are_bounded_and_private(self):
        for endpoint in ("http://inbox.example.test/api/results", "https://user:pw@inbox.example.test/api/results",
                         "https://inbox.example.test/api/results?x=1", "https://inbox.example.test/other"):
            self.config.write_text(json.dumps({"endpoint": endpoint, "tokenFile": str(self.token)}))
            self.config.chmod(0o600)
            with self.assertRaises(audio_module.AudioRequestError):
                audio_module.request_audio(self.config, self.metadata, self.spoken, self.item, opener=Opener({}))
        self.config.write_text(json.dumps({"endpoint": "https://inbox.example.test/api/results",
                                           "tokenFile": str(self.token)})); self.config.chmod(0o600)
        class Redirect:
            def __init__(self): self.requests = []
            def open(_self, request, timeout):
                _self.requests.append(request)
                import urllib.error
                raise urllib.error.HTTPError(request.full_url, 302, "Found",
                    {"Location": "https://other.example.test/steal"}, None)
        redirected = Redirect()
        with self.assertRaises(audio_module.AudioRequestError):
            audio_module.request_audio(self.config, self.metadata, self.spoken, self.item, opener=redirected)
        self.assertEqual(len(redirected.requests), 1)
        self.assertEqual(redirected.requests[0].get_header("Authorization"), "Bearer secret-token")
        redirect = Opener(Response(b"x" * (audio_module.MAX_RESPONSE + 1)))
        # An oversized successful body is rejected before JSON parsing.
        with self.assertRaises(audio_module.AudioRequestError):
            audio_module.request_audio(self.config, self.metadata, self.spoken, self.item, opener=redirect)
        self.token.chmod(0o644)
        with self.assertRaises(audio_module.AudioRequestError):
            audio_module.request_audio(self.config, self.metadata, self.spoken, self.item, opener=Opener({}))
        self.assertNotIn("secret-token", str(audio_module.AudioRequestError("safe diagnostic")))
