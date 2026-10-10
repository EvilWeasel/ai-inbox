#!/usr/bin/env python3
"""Private one-shot Cartesia adapter for the audio-jobs worker protocol."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import sys
import time
from typing import Any


MAX_CONFIG = 64 * 1024
MAX_REQUEST = 2_100_000
MAX_METADATA = 2_000_000
MAX_TEXT = 3_500
MAX_TRANSCRIPT_BYTES = MAX_TEXT * 4 + 2
MAX_AUDIO = 30 * 1024 * 1024
MAX_HELPER_STDOUT = 32 * 1024
MAX_HELPER_STDERR = 4 * 1024
MAX_FFPROBE_OUTPUT = 16 * 1024
DEFAULT_TIMEOUT = 240
JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")
NONCE_RE = re.compile(r"^[0-9a-f]{48}$")
SAFE_RECEIPT_RE = re.compile(r"^[A-Za-z0-9._:-]{1,200}$")
URL_RE = re.compile(r"(?:https?://|www\.)\S+", re.IGNORECASE)
MARKDOWN_LINK_RE = re.compile(r"\[[^\]]+\]\([^)]*\)")
RAW_PATH_RE = re.compile(r"(?:[A-Za-z]:[\\/]|(?:^|\s|[=(])/(?:[^\s/]+/)+[^\s]*)")
SUSPICIOUS_METADATA_KEY_RE = re.compile(r"(?:command|instruction|prompt|note|directive|shell|argv|script)", re.IGNORECASE)


class JobError(ValueError):
    """A generic adapter policy or validation error."""


def _load_private_files():
    helper = Path(__file__).with_name("private-files.py")
    if helper.is_symlink() or not helper.is_file():
        raise JobError("private-file policy helper unavailable")
    spec = importlib.util.spec_from_file_location("cartesia_job_private_files", helper)
    if not spec or not spec.loader:
        raise JobError("private-file policy helper unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


private_files = _load_private_files()


def _read_bounded_file(path: Path, limit: int, *, private: bool = False) -> bytes:
    try:
        checked = private_files.assert_private_file(path) if private else private_files.assert_regular_file_no_reparse(path)
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(checked, flags)
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
                raise JobError("file is not a bounded regular file")
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise JobError("file exceeds its size bound")
        return data
    except (OSError, ValueError) as exc:
        raise JobError("file is unavailable or violates private-file policy") from exc


def _json_object(raw: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise JobError(f"{label} is invalid") from exc
    if not isinstance(value, dict):
        raise JobError(f"{label} must be an object")
    return value


def _validate_metadata(value: dict[str, Any]) -> None:
    """Bound metadata as inert data; it is never passed to the speech helper."""
    count = 0

    def walk(node: Any, depth: int = 0) -> None:
        nonlocal count
        count += 1
        if count > 20_000 or depth > 12:
            raise JobError("metadata exceeds structural bounds")
        if node is None or isinstance(node, (bool, int, float)):
            if isinstance(node, float) and not math.isfinite(node):
                raise JobError("metadata contains a non-finite number")
            return
        if isinstance(node, str):
            if len(node) > 32_000 or any(ord(char) < 0x20 and char not in "\t\n\r" for char in node):
                raise JobError("metadata contains an invalid string")
            return
        if isinstance(node, list):
            if len(node) > 2_000:
                raise JobError("metadata array exceeds its bound")
            for item in node:
                walk(item, depth + 1)
            return
        if isinstance(node, dict):
            if len(node) > 2_000:
                raise JobError("metadata object exceeds its bound")
            for key, item in node.items():
                if not isinstance(key, str) or len(key) > 256 or SUSPICIOUS_METADATA_KEY_RE.search(key):
                    raise JobError("metadata contains a disallowed field")
                walk(item, depth + 1)
            return
        raise JobError("metadata contains an unsupported value")

    walk(value)


def _validate_spoken_text(value: Any, helper_module) -> str:
    if not isinstance(value, str):
        raise JobError("spoken adaptation must be text")
    text = value.strip()
    if not text or len(text) > MAX_TEXT or "```" in text or "`" in text:
        raise JobError("spoken adaptation is empty or outside the plain-text limit")
    if URL_RE.search(text) or MARKDOWN_LINK_RE.search(text) or RAW_PATH_RE.search(text):
        raise JobError("spoken adaptation contains a URL, Markdown link, or raw path")
    chunks = helper_module.split_text(text)
    if not isinstance(chunks, list) or len(chunks) != 1:
        raise JobError("spoken adaptation must fit one provider request")
    return text


def _load_adapter_config(path: Path) -> dict[str, Any]:
    if not path.is_absolute() or path.is_symlink():
        raise JobError("config file must be an absolute regular private file")
    config = _json_object(_read_bounded_file(path, MAX_CONFIG, private=True), "config")
    required = {"speakHelperPath", "pythonExecutable", "mediaDir", "profileRef", "voiceProfile"}
    allowed = required | {"timeoutSeconds"}
    if set(config) - allowed or not required.issubset(config):
        raise JobError("config fields do not match the adapter contract")
    for field in ("speakHelperPath", "pythonExecutable", "mediaDir", "profileRef"):
        if not isinstance(config[field], str) or not config[field]:
            raise JobError("config field is invalid")
    if len(config["profileRef"]) > 200 or any(ord(ch) < 0x21 or ord(ch) > 0x7e for ch in config["profileRef"]):
        raise JobError("profile reference must be a short non-secret identifier")
    if config["profileRef"].lower().startswith(("pass://", "cartesia://")):
        raise JobError("profile reference must not be a credential reference")

    helper = Path(config["speakHelperPath"])
    python = Path(config["pythonExecutable"])
    media = Path(config["mediaDir"])
    if not helper.is_absolute() or helper.is_symlink() or not helper.is_file():
        raise JobError("speak helper must be an existing absolute file")
    try:
        private_files.assert_regular_file_no_reparse(helper)
    except (OSError, ValueError) as exc:
        raise JobError("speak helper path is invalid") from exc
    if not python.is_absolute() or not python.exists():
        raise JobError("Python executable must be an existing absolute file")
    try:
        python = python.resolve(strict=True)
        private_files.assert_regular_file_no_reparse(python)
        if os.name != "nt" and not os.access(python, os.X_OK):
            raise JobError("Python executable is not executable")
    except (OSError, ValueError) as exc:
        raise JobError("Python executable path is invalid") from exc
    if not media.is_absolute():
        raise JobError("media directory must be absolute")
    try:
        media = private_files.assert_private_directory(media)
        resolved_media = media.resolve(strict=True)
        if media != resolved_media:
            raise JobError("media directory must use its canonical path")
        media = resolved_media
    except (OSError, ValueError) as exc:
        raise JobError("media directory must be private and existing") from exc

    profile = config["voiceProfile"]
    profile_fields = {"voiceId", "modelId", "language", "emotion"}
    if not isinstance(profile, dict) or set(profile) != profile_fields:
        raise JobError("voice profile fields are invalid")
    if any(not isinstance(profile[field], str) or not profile[field] or len(profile[field]) > 200 for field in profile_fields):
        raise JobError("voice profile values are invalid")
    if profile["emotion"] != "calm":
        raise JobError("only the configured calm emotion is accepted")

    timeout = config.get("timeoutSeconds", DEFAULT_TIMEOUT)
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 30 <= timeout <= 1740:
        raise JobError("timeoutSeconds must be between 30 and 1740")
    return {**config, "speakHelperPath": helper, "pythonExecutable": python,
            "mediaDir": media, "timeoutSeconds": timeout}


def _load_speak_module(path: Path):
    spec = importlib.util.spec_from_file_location("cartesia_speak_job_settings", path)
    if not spec or not spec.loader:
        raise JobError("official Cartesia helper could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _check_profile(config: dict[str, Any]):
    module = _load_speak_module(config["speakHelperPath"])
    settings_path = Path(module.CONFIG)
    if settings_path.is_symlink():
        raise JobError("Cartesia helper settings file is invalid")
    if settings_path.exists():
        raw = _read_bounded_file(settings_path, MAX_CONFIG, private=True)
        if not isinstance(_json_object(raw, "Cartesia helper settings"), dict):
            raise JobError("Cartesia helper settings are invalid")
    # Use the official helper's settings API only after bounding and validating
    # its settings file. Never print or persist this object: it may hold a
    # Proton Pass reference.
    current = module.settings()
    expected = config["voiceProfile"]
    actual = {"voiceId": current.get("voice_id"), "modelId": current.get("model_id"),
              "language": current.get("language"), "emotion": current.get("emotion")}
    if actual != expected:
        raise JobError("configured voice profile does not match the official helper settings")
    if not current.get("secret_ref") or module.credential_source(current) != "proton-pass":
        raise JobError("official helper is not configured for Proton Pass credentials")
    return module


def _read_output(path: Path, limit: int) -> bytes:
    try:
        private_files.assert_regular_file_no_reparse(path)
        return _read_bounded_file(path, limit)
    except (OSError, ValueError) as exc:
        raise JobError("rendered artifact is missing or invalid") from exc


def _replace_with_private_file(path: Path, data: bytes) -> None:
    temporary = path.parent / (".cartesia-private-" + os.urandom(16).hex())
    try:
        private_files.create_private_file(temporary, data)
        os.replace(temporary, path)
        private_files.assert_private_file(path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _validate_expected_output(raw: Any, job_id: str, nonce: str, media_dir: Path) -> tuple[Path, list[Path]]:
    if not isinstance(job_id, str) or not JOB_ID_RE.fullmatch(job_id):
        raise JobError("job identity is invalid")
    if not isinstance(nonce, str) or not NONCE_RE.fullmatch(nonce):
        raise JobError("attempt nonce is invalid")
    output = media_dir / f"{job_id}-{nonce}.mp3"
    if not isinstance(raw, str) or raw != str(output) or not Path(raw).is_absolute():
        raise JobError("expected output must be the exact configured media child")
    sidecars = [output.with_suffix(".txt"), output.with_suffix(".json")]
    for target in [output, *sidecars]:
        if target.exists() or target.is_symlink():
            raise JobError("expected output or a sidecar already exists")
    return output, sidecars


def _run_bounded(argv: list[str], *, timeout: int, env: dict[str, str],
                 stdout_limit: int, stderr_limit: int) -> tuple[int, bytes, bytes]:
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, shell=False, env=env,
                               cwd=str(Path(argv[1]).parent) if len(argv) > 1 else None)
    assert process.stdout is not None and process.stderr is not None
    buffers = {process.stdout: bytearray(), process.stderr: bytearray()}
    limits = {process.stdout: stdout_limit, process.stderr: stderr_limit}
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    selector.register(process.stderr, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(argv, timeout)
            for key, _ in selector.select(min(remaining, 0.2)):
                chunk = os.read(key.fd, 4096)
                if not chunk:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                buffer = buffers[key.fileobj]
                limit = limits[key.fileobj]
                if len(buffer) < limit + 1:
                    buffer.extend(chunk[:limit + 1 - len(buffer)])
                if len(buffer) > limit:
                    process.kill()
                    raise JobError("helper output exceeded its bound")
        return_code = process.wait(timeout=max(0.1, deadline - time.monotonic()))
        if return_code != 0:
            raise JobError("helper process failed")
        return return_code, bytes(buffers[process.stdout]), bytes(buffers[process.stderr])
    except (subprocess.TimeoutExpired, JobError):
        process.kill()
        process.wait()
        raise
    finally:
        selector.close()
        for stream in (process.stdout, process.stderr):
            try:
                stream.close()
            except OSError:
                pass


def _probe_mp3(path: Path) -> float:
    argv = ["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_name",
            "-of", "json", str(path)]
    try:
        _return_code, stdout, _stderr = _run_bounded(
            argv, timeout=20, env=os.environ.copy(), stdout_limit=MAX_FFPROBE_OUTPUT,
            stderr_limit=MAX_FFPROBE_OUTPUT)
    except (OSError, subprocess.TimeoutExpired, JobError) as exc:
        raise JobError("MP3 validation failed") from exc
    try:
        value = json.loads(stdout.decode("utf-8"))
        duration = float(value["format"]["duration"])
        codecs = [stream.get("codec_name") for stream in value["streams"]]
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        raise JobError("MP3 validation failed") from exc
    if not math.isfinite(duration) or duration <= 0 or duration > 86_400 or "mp3" not in codecs:
        raise JobError("MP3 validation failed")
    return duration


def _validate_helper_receipt(raw: bytes, *, output: Path, sidecar_text: Path,
                             spoken: str, profile: dict[str, Any],
                             actual_duration: float) -> None:
    receipt = _json_object(raw, "renderer sidecar")
    allowed = {"audio_path", "transcript_path", "duration_seconds", "characters", "requests",
               "voice_id", "voice_name", "model_id", "language", "emotion", "emotion_support",
               "client", "preview_path"}
    if set(receipt) - allowed:
        raise JobError("renderer sidecar contains unsupported fields")
    if (receipt.get("audio_path") != str(output)
            or receipt.get("transcript_path") != str(sidecar_text)
            or receipt.get("requests") != 1
            or receipt.get("characters") != len(spoken)
            or receipt.get("voice_id") != profile["voiceId"]
            or receipt.get("model_id") != profile["modelId"]
            or receipt.get("language") != profile["language"]
            or receipt.get("emotion") != profile["emotion"]):
        raise JobError("renderer sidecar does not match the requested render")
    try:
        recorded_duration = float(receipt["duration_seconds"])
    except (KeyError, TypeError, ValueError) as exc:
        raise JobError("renderer sidecar duration is invalid") from exc
    if (isinstance(receipt.get("duration_seconds"), bool) or not math.isfinite(recorded_duration)
            or recorded_duration <= 0 or abs(recorded_duration - actual_duration) > 1.0):
        raise JobError("renderer sidecar duration does not match ffprobe")


def _render(config: dict[str, Any], helper_module, request: dict[str, Any]) -> dict[str, Any]:
    if set(request) != {"protocol", "jobId", "attempt", "attemptNonce", "resultMetadata",
                        "spokenAdaptation", "voiceProfileRef", "expectedOutputPath"}:
        raise JobError("request fields do not match protocol 1")
    if request["protocol"] != 1 or isinstance(request["protocol"], bool):
        raise JobError("unsupported request protocol")
    if isinstance(request["attempt"], bool) or not isinstance(request["attempt"], int) or not 1 <= request["attempt"] <= 3:
        raise JobError("attempt number is invalid")
    if request["voiceProfileRef"] != config["profileRef"]:
        raise JobError("voice profile reference does not match configuration")
    metadata = request["resultMetadata"]
    if not isinstance(metadata, dict):
        raise JobError("result metadata must be an object")
    _validate_metadata(metadata)
    if len(json.dumps(metadata, ensure_ascii=False).encode("utf-8")) > MAX_METADATA:
        raise JobError("result metadata exceeds its bound")
    spoken = _validate_spoken_text(request["spokenAdaptation"], helper_module)
    output, sidecars = _validate_expected_output(request["expectedOutputPath"], request["jobId"],
                                                  request["attemptNonce"], config["mediaDir"])

    transcript = config["mediaDir"] / f".cartesia-input-{request['jobId']}-{request['attemptNonce']}.txt"
    if transcript.exists() or transcript.is_symlink():
        raise JobError("private transcript path already exists")
    private_files.create_private_file(transcript, (spoken + "\n").encode("utf-8"))
    validated = False
    try:
        env = os.environ.copy()
        # The helper reads its configured Proton Pass reference. Do not allow
        # an inherited key or reference to override that existing resolution.
        env.pop("CARTESIA_API_KEY", None)
        argv = [str(config["pythonExecutable"]), str(config["speakHelperPath"]), "render",
                "--input", str(transcript), "--output", str(output), "--emotion", "calm"]
        _run_bounded(argv, timeout=config["timeoutSeconds"], env=env,
                     stdout_limit=MAX_HELPER_STDOUT, stderr_limit=MAX_HELPER_STDERR)

        # The output directory is private, but renderer artifacts are re-created
        # through the native private-file helper so file permissions/DACLs are
        # explicitly current-user-only. MP3 bytes are copied unchanged.
        media = _read_output(output, MAX_AUDIO)
        if len(media) < 4:
            raise JobError("rendered MP3 is empty")
        sidecar_data = [_read_output(sidecars[0], MAX_TRANSCRIPT_BYTES), _read_output(sidecars[1], MAX_HELPER_STDOUT)]
        if sidecar_data[0] != (spoken + "\n").encode("utf-8"):
            raise JobError("renderer transcript does not match the requested adaptation")
        duration = _probe_mp3(output)
        _validate_helper_receipt(sidecar_data[1], output=output, sidecar_text=sidecars[0],
                                 spoken=spoken, profile=config["voiceProfile"], actual_duration=duration)
        digest = hashlib.sha256(media).hexdigest()
        _replace_with_private_file(output, media)
        for sidecar, data in zip(sidecars, sidecar_data):
            _replace_with_private_file(sidecar, data)
        # Verify privacy and unchanged bytes after the replacement.
        secure_media = _read_bounded_file(output, MAX_AUDIO, private=True)
        if hashlib.sha256(secure_media).hexdigest() != digest:
            raise JobError("rendered MP3 changed during secure storage")
        receipt_id = "local-cartesia-" + digest
        if not SAFE_RECEIPT_RE.fullmatch(receipt_id):
            raise JobError("local receipt identifier is invalid")
        validated = True
        return {"status": "completed", "providerReceiptId": receipt_id,
                "durationSeconds": duration}
    finally:
        if not validated:
            # A renderer can fail after creating a paid result. Retain valid
            # artifacts only after hardening them through the native helper.
            for target, limit in ((output, MAX_AUDIO), (sidecars[0], MAX_TRANSCRIPT_BYTES),
                                  (sidecars[1], MAX_HELPER_STDOUT)):
                try:
                    _replace_with_private_file(target, _read_output(target, limit))
                except (OSError, ValueError, JobError):
                    pass
        try:
            transcript.unlink()
        except FileNotFoundError:
            pass


def _main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config-file", type=Path,
                        help="private adapter config (or CARTESIA_JOB_CONFIG_FILE in the parent worker environment)")
    parser.add_argument("--audio-job-stdin-json", action="store_true", required=True)
    args = parser.parse_args()
    try:
        if os.name == "nt":
            raise JobError("Windows process-pipe support is not implemented")
        # Do this before importing/checking the official helper so a parent
        # environment key can never supersede its configured Proton reference.
        os.environ.pop("CARTESIA_API_KEY", None)
        config_path = args.config_file or (Path(os.environ["CARTESIA_JOB_CONFIG_FILE"])
                                           if os.environ.get("CARTESIA_JOB_CONFIG_FILE") else None)
        if config_path is None:
            raise JobError("adapter config file is required")
        config = _load_adapter_config(config_path)
        helper_module = _check_profile(config)
        raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
        if len(raw) > MAX_REQUEST:
            raise JobError("request exceeds its size bound")
        request = _json_object(raw, "request")
        receipt = _render(config, helper_module, request)
        sys.stdout.write(json.dumps(receipt, separators=(",", ":")) + "\n")
        sys.stdout.flush()
        return 0
    except Exception:
        # Do not expose helper exceptions, paths, settings, stderr, or secrets.
        sys.stderr.write("cartesia-job: failed; attempt outcome may be uncertain\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(_main())
