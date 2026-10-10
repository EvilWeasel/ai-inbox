#!/usr/bin/env python3
"""Request and inspect central audio for an already-written Inbox result."""
from __future__ import annotations

import hashlib
import http.client
import importlib.util
import json
import math
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request

MAX_CONFIG = 64 * 1024
MAX_METADATA = 2_000_000
MAX_RESPONSE = 16 * 1024
MAX_TIMEOUT = 20
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
JOB_RE = SHA_RE
ITEM_RE = re.compile(r"^[A-Za-z0-9_-]{1,200}$")
STATES = {"queued", "generating", "ready", "needs_review", "superseded", "ready_existing"}

_spec = importlib.util.spec_from_file_location(
    "ai_inbox_request_result_audio_private_files", Path(__file__).with_name("private-files.py"))
if _spec is None or _spec.loader is None:
    raise RuntimeError("private file policy helper is unavailable")
private_files = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(private_files)


class AudioRequestError(ValueError):
    def __init__(self, message: str, *, transient: bool = False):
        super().__init__(message)
        self.transient = transient


def _private_bytes(path, limit):
    try:
        file = private_files.assert_private_file(path)
        if file.stat().st_size > limit:
            raise AudioRequestError("private input exceeds limit")
        data = file.read_bytes()
    except (OSError, private_files.PrivateFileError) as exc:
        raise AudioRequestError("private input is unavailable") from exc
    if len(data) > limit:
        raise AudioRequestError("private input exceeds limit")
    return data


def _config(config_path):
    try:
        config = json.loads(_private_bytes(config_path, MAX_CONFIG))
        if not isinstance(config, dict) or not isinstance(config.get("endpoint"), str):
            raise ValueError
        parsed = urllib.parse.urlsplit(config["endpoint"])
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment or parsed.path.rstrip("/") != "/api/results"
                or parsed.path != "/api/results" or parsed.port not in (None, 443)):
            raise ValueError
        token_data = _private_bytes(config["tokenFile"], 16 * 1024)
        token = token_data.decode("utf-8").strip()
        if not token or any(ch.isspace() for ch in token):
            raise ValueError
        endpoint = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/api/results/audio-jobs", "", ""))
        return endpoint, token
    except (KeyError, TypeError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        if isinstance(exc, AudioRequestError):
            raise
        raise AudioRequestError("private producer configuration is invalid") from exc


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _transport(method, url, token, payload=None, *, opener=None, timeout=MAX_TIMEOUT):
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0 < timeout <= MAX_TIMEOUT:
        raise AudioRequestError("request timeout is invalid")
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/json",
        **({"Content-Type": "application/json"} if data is not None else {}),
        "User-Agent": "ai-inbox-result-audio/1",
    })
    opener = opener or urllib.request.build_opener(_NoRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read(MAX_RESPONSE + 1)
            if len(raw) > MAX_RESPONSE:
                raise AudioRequestError("central audio response exceeds limit", transient=True)
    except urllib.error.HTTPError as exc:
        exc.close()
        if 300 <= exc.code < 400:
            raise AudioRequestError("central audio redirect refused") from exc
        if exc.code >= 500 or exc.code in (408, 429) or (method == "GET" and exc.code == 404):
            raise AudioRequestError("central audio service is temporarily unavailable", transient=True) from exc
        raise AudioRequestError("central audio request was rejected") from exc
    except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException) as exc:
        raise AudioRequestError("central audio service is temporarily unavailable", transient=True) from exc
    try:
        result = json.loads(raw)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise AudioRequestError("central audio response is invalid", transient=True) from exc
    if not isinstance(result, dict):
        raise AudioRequestError("central audio response is invalid", transient=True)
    return result


def _validate(result, expected_item_id, *, expected_job_id=None, allow_existing=False):
    item_id = result.get("itemId")
    if not isinstance(item_id, str) or not ITEM_RE.fullmatch(item_id) or item_id != expected_item_id:
        raise AudioRequestError("central audio item provenance mismatch")
    state = result.get("state")
    if state not in STATES or (state == "ready_existing" and not allow_existing):
        raise AudioRequestError("central audio returned an unsupported state", transient=True)
    job_id = result.get("jobId")
    if state == "ready_existing":
        if job_id is not None:
            raise AudioRequestError("existing audio response contains a job identity")
    else:
        if not isinstance(job_id, str) or not JOB_RE.fullmatch(job_id):
            raise AudioRequestError("central audio job identity is invalid")
        if expected_job_id is not None and job_id != expected_job_id:
            raise AudioRequestError("central audio job provenance mismatch")
    safe = {"state": state, "itemId": item_id}
    if job_id is not None:
        safe["jobId"] = job_id
    if state == "ready":
        digest = result.get("mediaSha256", result.get("audioSha256"))
        duration = result.get("duration", result.get("durationSeconds", result.get("audioDuration")))
        if not isinstance(digest, str) or not SHA_RE.fullmatch(digest):
            raise AudioRequestError("central audio hash is invalid")
        safe["mediaSha256"] = digest
        if (isinstance(duration, bool) or not isinstance(duration, (int, float))
                or not math.isfinite(duration) or duration <= 0 or duration > 86400):
            raise AudioRequestError("central audio duration is invalid")
        safe["durationSeconds"] = duration
    return safe


def request_audio(config_path, metadata_path, spoken_path, expected_item_id, *, opener=None):
    endpoint, token = _config(config_path)
    try:
        raw_metadata = _private_bytes(metadata_path, MAX_METADATA)
        metadata = json.loads(raw_metadata)
        spoken_raw = _private_bytes(spoken_path, 1_000_000)
        spoken = spoken_raw.decode("utf-8")
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise AudioRequestError("immutable audio request input is invalid") from exc
    if (not isinstance(metadata, dict) or not isinstance(metadata.get("deliveryId"), str)
            or not metadata["deliveryId"] or not isinstance(metadata.get("body"), str)):
        raise AudioRequestError("immutable result metadata is invalid")
    body_hash = hashlib.sha256(metadata["body"].encode("utf-8")).hexdigest()
    spoken_hash = hashlib.sha256(spoken_raw).hexdigest()
    if not spoken.strip() or len(spoken) > 3500 or any(ord(ch) < 32 and ch not in "\n\t" for ch in spoken):
        raise AudioRequestError("spoken adaptation is invalid")
    payload = {"protocol": 1, "deliveryId": metadata["deliveryId"], "bodySha256": body_hash,
               "spokenText": spoken, "spokenSha256": spoken_hash}
    result = _transport("POST", endpoint, token, payload, opener=opener)
    return _validate(result, expected_item_id, allow_existing=True)


def get_audio_status(config_path, job_id, expected_item_id, *, opener=None):
    if not isinstance(job_id, str) or not JOB_RE.fullmatch(job_id):
        raise AudioRequestError("central audio job identity is invalid")
    endpoint, token = _config(config_path)
    result = _transport("GET", endpoint + "/" + job_id, token, opener=opener)
    return _validate(result, expected_item_id, expected_job_id=job_id)
