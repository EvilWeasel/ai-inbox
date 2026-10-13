#!/usr/bin/env python3
"""Coordinate future T3 capture candidates into text-first Inbox results and audio jobs."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
MAX_CONFIG = 64 * 1024
MAX_CAPTURE = 1_250_000
MAX_DECISION = 64 * 1024
MAX_METADATA = 2_000_000
MAX_SPOKEN = 250_000
MAX_ORIGINAL_AUDIO_BYTES = 30 * 1024 * 1024
MAX_ORIGINAL_AUDIO_REFS = 32
MAX_BATCH = 50
MAX_TOTAL_BATCH = MAX_BATCH * 2
MAX_LEASE = 3600
LEASE_RENEW_INTERVAL = 30
SHA_RE = re.compile(r"^[0-9a-f]{64}$")


class PipelineError(ValueError):
    pass


class ExactRunPending(PipelineError):
    pass


def module_from(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    if spec is None or spec.loader is None:
        raise PipelineError("required local producer module is unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(name, module)
    spec.loader.exec_module(module)
    return module


private_files = module_from("ai_inbox_pipeline_private_files", "private-files.py")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def read_private(path: str | Path, limit: int) -> bytes:
    try:
        source = private_files.assert_private_file(path)
        if source.stat().st_size > limit:
            raise PipelineError("private input exceeds the size limit")
        raw = source.read_bytes()
    except (OSError, private_files.PrivateFileError) as exc:
        raise PipelineError("private input is unavailable") from exc
    if len(raw) > limit:
        raise PipelineError("private input exceeds the size limit")
    return raw


def read_json(path: str | Path, limit: int = MAX_CONFIG) -> dict:
    try:
        value = json.loads(read_private(path, limit))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise PipelineError("private JSON input is invalid") from exc
    if not isinstance(value, dict):
        raise PipelineError("private JSON input must be an object")
    return value


def private_path(value: Any, label: str) -> Path:
    if not isinstance(value, (str, Path)) or not str(value):
        raise PipelineError(f"{label} is missing")
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise PipelineError(f"{label} must be absolute")
    return path


def _assert_current_private_file(path: str | Path) -> Path:
    target = private_files.assert_private_file(path)
    if os.name != "nt" and target.lstat().st_uid != os.geteuid():
        raise private_files.PrivateFileError("private file is owned by another user")
    return target


def load_config(path: str | Path) -> dict:
    config = read_json(path)
    required = {"captureConfigFile", "bridgeConfigFile", "stateDir", "decisionHelperArgv"}
    if not required.issubset(config):
        raise PipelineError("pipeline config is missing required fields")
    for key in ("captureConfigFile", "bridgeConfigFile"):
        config[key] = str(private_files.assert_private_file(private_path(config[key], key)))
    mode = config.get("audioDeliveryMode", "local")
    if not isinstance(mode, str) or mode not in {"local", "central", "on_demand"}:
        raise PipelineError("audioDeliveryMode must be local, central or on_demand")
    config["audioDeliveryMode"] = mode
    if mode == "local":
        if not config.get("audioHelperConfigFile") or not config.get("voiceProfileSha256"):
            raise PipelineError("local audio mode requires its helper config and voice profile")
        config["audioHelperConfigFile"] = str(private_files.assert_private_file(
            private_path(config["audioHelperConfigFile"], "audioHelperConfigFile")))
        if not SHA_RE.fullmatch(str(config["voiceProfileSha256"])):
            raise PipelineError("voiceProfileSha256 must be a SHA-256 digest")
    else:
        config.pop("audioHelperConfigFile", None)
        profile = config.get("voiceProfileSha256")
        if profile is not None and not SHA_RE.fullmatch(str(profile)):
            raise PipelineError("voiceProfileSha256 must be a SHA-256 digest")
    state = private_path(config["stateDir"], "stateDir")
    config["stateDir"] = str(private_files.ensure_private_directory(state))
    argv = config["decisionHelperArgv"]
    if (not isinstance(argv, list) or not argv or len(argv) > 64
            or any(not isinstance(arg, str) or not arg or len(arg) > 4096 for arg in argv)):
        raise PipelineError("decisionHelperArgv must be a fixed non-empty argument vector")
    timeout = config.get("decisionHelperTimeoutSeconds", 60)
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= 300:
        raise PipelineError("decision helper timeout must be between 1 and 300 seconds")
    config["decisionHelperTimeoutSeconds"] = timeout
    return config


def stable_delivery_id(thread_id: str, run_id: str) -> str:
    identity = f"{thread_id}\0{run_id}".encode()
    return "t3-" + hashlib.sha256(b"delivery\0" + identity).hexdigest()


def load_capture_module():
    return module_from("ai_inbox_pipeline_capture", "t3-capture.py")


def load_bridge_module():
    return module_from("ai_inbox_pipeline_bridge", "t3-results.py")


def load_audio_module():
    return module_from("ai_inbox_pipeline_audio_jobs", "audio-jobs.py")


def load_sender_module():
    return module_from("ai_inbox_pipeline_sender", "deliver-result.py")


def _connect(config: dict) -> sqlite3.Connection:
    db_path = Path(config["stateDir"]) / "result-pipeline.sqlite3"
    try:
        private_files.ensure_private_sqlite_database(db_path)
    except private_files.PrivateFileError as exc:
        raise PipelineError("pipeline database is not private") from exc
    db = sqlite3.connect(db_path, timeout=15, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=DELETE")
    db.execute("PRAGMA synchronous=FULL")
    private_files.secure_sqlite_artifacts(db_path)
    db.executescript("""
        CREATE TABLE IF NOT EXISTS pipeline_candidates(
          candidate_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT NOT NULL,
          capture_sha256 TEXT NOT NULL, decision_sha256 TEXT, delivery_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('candidate-reviewed','excluded','review-needed','text-delivered','audio-pending','audio-ready','audio-delivered','blocked')),
          metadata_path TEXT, metadata_sha256 TEXT, spoken_path TEXT, spoken_sha256 TEXT,
          original_audio_path TEXT, original_audio_sha256 TEXT, audio_job_id TEXT,
          central_audio_job_id TEXT, central_audio_item_id TEXT,
          receipt_json TEXT, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          retry_attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
          audio_retry_attempts INTEGER NOT NULL DEFAULT 0,
          UNIQUE(thread_id,run_id)
        );
        CREATE TABLE IF NOT EXISTS coordinator_lease(
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner TEXT NOT NULL, lease_until REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS candidate_cursors(
          pass_name TEXT PRIMARY KEY, activation_epoch TEXT NOT NULL,
          last_completed_at TEXT NOT NULL, last_candidate_id TEXT NOT NULL
        );
    """)
    columns = {row[1] for row in db.execute("PRAGMA table_info(pipeline_candidates)")}
    for name, declaration in (("retry_attempts", "INTEGER NOT NULL DEFAULT 0"), ("next_attempt_at", "TEXT"),
                              ("audio_retry_attempts", "INTEGER NOT NULL DEFAULT 0"),
                              ("central_audio_job_id", "TEXT"), ("central_audio_item_id", "TEXT")):
        if name not in columns:
            db.execute(f"ALTER TABLE pipeline_candidates ADD COLUMN {name} {declaration}")
    private_files.secure_sqlite_artifacts(db_path)
    return db


def _capture_row(config: dict, candidate_id: str) -> tuple[dict, dict, Path]:
    cap = load_capture_module()
    cap_config = cap.load_config(config["captureConfigFile"])
    db = cap.connect_capture(cap_config)
    try:
        state = db.execute("SELECT activation_epoch FROM capture_state WHERE singleton=1").fetchone()
        row = db.execute("SELECT * FROM candidates WHERE candidate_id=?", (candidate_id,)).fetchone()
        if not state or not row:
            raise PipelineError("candidate is absent from the initialized future capture journal")
        epoch = cap.parse_time(state["activation_epoch"])
        completed = cap.parse_time(row["completed_at"])
        if epoch is None or completed is None or completed < epoch:
            raise PipelineError("candidate is outside the capture activation epoch")
        if row["status"] == "excluded":
            raise PipelineError("capture excluded this candidate")
        expected_id = cap.candidate_id(row["thread_id"], row["run_id"])
        if (row["candidate_id"] != expected_id
                or not isinstance(row["thread_id"], str) or not row["thread_id"] or len(row["thread_id"]) > 500
                or not isinstance(row["run_id"], str) or not row["run_id"] or len(row["run_id"]) > 500):
            raise PipelineError("candidate identity is invalid")
        expected = Path(cap_config["captureDir"]) / (expected_id + ".json")
        bridge_config = load_bridge_module().load_config(config["bridgeConfigFile"])
        authored = cap.staged_receipt(bridge_config, row["thread_id"], row["run_id"])
        if authored or row["status"] == "staged":
            # The authored outbox receipt wins even when capture text was later removed.
            return dict(row), {}, expected
        stored = Path(row["text_file"]) if row["text_file"] else None
        if stored != expected:
            raise PipelineError("candidate filename does not match its exact identity")
        raw = read_private(expected, MAX_CAPTURE)
        payload = json.loads(raw)
        if (not isinstance(payload, dict) or payload.get("candidateId") != expected_id
                or payload.get("threadId") != row["thread_id"] or payload.get("runId") != row["run_id"]
                or not isinstance(payload.get("text"), str) or not payload["text"].strip()
                or not isinstance(payload.get("sourceRefs"), list)):
            raise PipelineError("captured candidate provenance is invalid")
        return dict(row), payload, expected
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise PipelineError("captured candidate JSON is invalid") from exc
    finally:
        cap.secure_capture_artifacts(cap_config)
        db.close()


def _source_refs(value: Any) -> list[dict]:
    if not isinstance(value, list) or len(value) > 500:
        raise PipelineError("captured source references are invalid")
    result = []
    for item in value:
        if isinstance(item, str):
            title, url = "", item
        elif isinstance(item, dict):
            # Preserve only URL/title evidence from the captured final message.
            url = item.get("url") or item.get("href")
            title = item.get("title") or item.get("name") or ""
        else:
            continue
        if not isinstance(url, str) or len(url) > 4096:
            continue
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname
                or parsed.username or parsed.password):
            continue
        if not isinstance(title, str):
            title = ""
        result.append({"title": title[:1000], "url": url})
    return result


def _invoke_decision(argv: list[str], request: bytes, timeout: int) -> bytes:
    try:
        process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, shell=False)
    except OSError as exc:
        raise PipelineError("decision helper did not complete") from exc
    output = bytearray()
    overflow = threading.Event()

    def drain():
        assert process.stdout is not None
        while True:
            chunk = process.stdout.read(4096)
            if not chunk:
                return
            if len(output) < MAX_DECISION + 1:
                output.extend(chunk[:MAX_DECISION + 1 - len(output)])
            if len(output) > MAX_DECISION:
                overflow.set()

    def send():
        assert process.stdin is not None
        try:
            process.stdin.write(request)
            process.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        finally:
            try:
                process.stdin.close()
            except OSError:
                pass

    reader = threading.Thread(target=drain, daemon=True)
    writer = threading.Thread(target=send, daemon=True)
    reader.start(); writer.start()
    try:
        return_code = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        process.kill(); process.wait()
        writer.join(timeout=1); reader.join(timeout=1)
        raise PipelineError("decision helper timed out") from exc
    writer.join(timeout=1); reader.join(timeout=1)
    if process.stdout:
        process.stdout.close()
    if overflow.is_set() or len(output) > MAX_DECISION or return_code != 0:
        raise PipelineError("decision helper returned an invalid response")
    return bytes(output)


def _validate_decision(raw: bytes, captured: dict, row: dict, allowed_roots: list[Path]) -> dict:
    try:
        decision = json.loads(raw)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise PipelineError("decision helper JSON is invalid") from exc
    allowed = {"decision", "title", "resultType", "spokenText", "originalAudio"}
    if not isinstance(decision, dict) or set(decision) - allowed:
        raise PipelineError("decision helper fields are unsupported")
    kind = decision.get("decision")
    if kind not in {"meaningful", "exclude", "review"}:
        raise PipelineError("decision helper outcome is invalid")
    if kind != "meaningful":
        if set(decision) != {"decision"}:
            raise PipelineError("non-meaningful decision contains unsupported fields")
        return {"decision": kind}
    title, result_type = decision.get("title"), decision.get("resultType")
    if not isinstance(title, str) or not title.strip() or len(title) > 2000:
        raise PipelineError("decision title is invalid")
    if result_type not in {"research", "implementation", "report"}:
        raise PipelineError("decision result type is invalid")
    spoken = decision.get("spokenText")
    if spoken is not None and (not isinstance(spoken, str) or not spoken.strip() or len(spoken.encode("utf-8")) > MAX_SPOKEN):
        raise PipelineError("spoken adaptation is invalid")
    original = decision.get("originalAudio")
    original_path = None
    original_hash = None
    if original is not None:
        if not isinstance(original, dict) or set(original) != {"path", "sha256"}:
            raise PipelineError("selected original audio reference is invalid")
        if not isinstance(original["sha256"], str) or not SHA_RE.fullmatch(original["sha256"]):
            raise PipelineError("selected original audio hash is invalid")
        path = private_path(original["path"], "original audio path")
        try:
            _assert_current_private_file(path)
            resolved = path.resolve(strict=True)
            if not any(resolved == root or root in resolved.parents for root in allowed_roots):
                raise PipelineError("selected original audio is outside allowed roots")
            raw_audio = read_private(path, MAX_ORIGINAL_AUDIO_BYTES)
        except (OSError, private_files.PrivateFileError) as exc:
            raise PipelineError("selected original audio is unavailable") from exc
        try:
            load_audio_module()._valid_mp3(path, original["sha256"])
        except Exception as exc:
            raise PipelineError("selected original recording is not a validated MP3") from exc
        if sha(raw_audio) != original["sha256"]:
            raise PipelineError("selected original audio hash does not match")
        original_path, original_hash = str(path), original["sha256"]
    return {"decision": kind, "title": title.strip(), "resultType": result_type,
            "spokenText": spoken, "originalAudioPath": original_path,
            "originalAudioSha256": original_hash}


_MARKDOWN_LINK_RE = re.compile(r"!?\[[^\]\r\n]{0,500}\]\(\s*(<[^>]{1,4096}>|[^\s)]{1,4096})")
_HTML_AUDIO_LINK_RE = re.compile(r"""(?i)\b(?:src|href)\s*=\s*(?:"([^"]{1,4096})"|'([^']{1,4096})'|([^\s>]{1,4096}))""")
_ABSOLUTE_PATH_RE = re.compile(r"(?<![A-Za-z0-9_])(?:[A-Za-z]:[\\/]|/)(?:[^\s<>\"'`()\[\]{}]{1,4095})")


def _audio_reference_path(value: str) -> Path | None:
    """Return a safe decoded absolute MP3 path, or None for a non-MP3 reference.

    This only parses explicitly supplied values; it never searches a directory or
    resolves URLs. A suspicious MP3-shaped reference is rejected by the caller.
    """
    candidate = value.strip()
    if candidate.startswith("<") and candidate.endswith(">"):
        candidate = candidate[1:-1]
    if not candidate or len(candidate) > 4096:
        return None
    # A URL or URI that ends in .mp3 is an explicit reference, but is never a
    # local recording candidate.
    parsed = urllib.parse.urlsplit(candidate)
    windows_drive = bool(re.match(r"^[A-Za-z]:[\\/]", candidate))
    if not windows_drive and parsed.scheme and re.fullmatch(r"[A-Za-z][A-Za-z0-9+.-]*", parsed.scheme):
        decoded_url_path = urllib.parse.unquote(parsed.path, errors="strict")
        if decoded_url_path.lower().endswith(".mp3"):
            raise PipelineError("explicit MP3 reference is not a local path")
        return None
    decoded = urllib.parse.unquote(candidate, errors="strict")
    if not decoded.lower().endswith(".mp3"):
        return None
    if not Path(decoded).is_absolute() or "\x00" in decoded:
        raise PipelineError("explicit MP3 reference is not an absolute local path")
    if any(part in {".", ".."} for part in Path(decoded).parts):
        raise PipelineError("explicit MP3 reference contains path traversal")
    return Path(decoded)


def _discover_original_audio(captured: dict, allowed_roots: list[Path]) -> dict | None:
    """Prove a single original MP3 named by this exact captured final result.

    The bounded parser considers Markdown targets, plain absolute paths, and
    captured sourceRefs' url/href/path values. It does not inspect history or
    directories. One unique, private, in-root file is required when MP3 refs
    appear; ambiguity or a missing/unsafe target fails closed.
    """
    text = captured.get("text")
    source_refs = captured.get("sourceRefs")
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_CAPTURE:
        raise PipelineError("captured final text is invalid for audio discovery")
    if not isinstance(source_refs, list) or len(source_refs) > 500:
        raise PipelineError("captured source references are invalid for audio discovery")

    values: list[str] = []

    def add_reference(value: str) -> None:
        candidate = value.strip().removeprefix("<").removesuffix(">")
        parsed = urllib.parse.urlsplit(candidate)
        target = urllib.parse.unquote(parsed.path if parsed.scheme else candidate, errors="strict")
        if target.lower().endswith(".mp3"):
            values.append(value)
            if len(values) > MAX_ORIGINAL_AUDIO_REFS:
                raise PipelineError("too many explicit audio references")
    # Markdown links/images are explicit references, including non-local URLs
    # that must cause review rather than silently falling through to synthesis.
    for match in _MARKDOWN_LINK_RE.finditer(text):
        add_reference(match.group(1))
    for match in _HTML_AUDIO_LINK_RE.finditer(text):
        add_reference(next((group for group in match.groups() if group is not None), ""))
    # Support prose that directly names an absolute private MP3 path. Markdown
    # target duplicates are collapsed after path validation below.
    for match in _ABSOLUTE_PATH_RE.finditer(text):
        token = match.group(0).rstrip(".,;:!?")
        if token.lower().endswith(".mp3"):
            values.append(token)
            if len(values) > MAX_ORIGINAL_AUDIO_REFS:
                raise PipelineError("too many explicit audio references")
    for item in source_refs:
        candidates = [item] if isinstance(item, str) else (
            [item.get(key) for key in ("url", "href", "path") if isinstance(item.get(key), str)]
            if isinstance(item, dict) else [])
        for candidate in candidates:
            if len(candidate) <= 4096:
                parsed = urllib.parse.urlsplit(candidate)
                path_part = urllib.parse.unquote(parsed.path if parsed.scheme else candidate, errors="strict")
                if path_part.lower().endswith(".mp3"):
                    values.append(candidate)
                    if len(values) > MAX_ORIGINAL_AUDIO_REFS:
                        raise PipelineError("too many explicit audio references")

    unique: dict[str, Path] = {}
    for value in values:
        path = _audio_reference_path(value)
        if path is None:
            continue
        # Lexical normalization deduplicates the same explicit path repeated in
        # a Markdown link, raw text, or sourceRefs without following symlinks.
        key = os.path.normpath(str(path))
        unique[key] = path
    if not unique:
        return None
    if len(unique) != 1:
        raise PipelineError("captured result has conflicting explicit MP3 references")

    path = next(iter(unique.values()))
    try:
        _assert_current_private_file(path)
        resolved = path.resolve(strict=True)
        if not any(resolved == root or root in resolved.parents for root in allowed_roots):
            raise PipelineError("captured MP3 reference is outside allowed roots")
        raw_audio = read_private(path, MAX_ORIGINAL_AUDIO_BYTES)
        audio_module = load_audio_module()
        digest, _size = audio_module._valid_mp3(path)
    except PipelineError:
        raise
    except Exception as exc:
        raise PipelineError("captured MP3 reference is unavailable or not private") from exc
    if sha(raw_audio) != digest:
        raise PipelineError("captured MP3 changed while it was being validated")
    return {"path": str(path), "sha256": digest}


def _thread_url(thread_id: str) -> str | None:
    return "t3-thread://v1/" + thread_id if re.fullmatch(r"[A-Za-z0-9_-]+", thread_id) else None


class ResultPipeline:
    """Durable coordinator; dependencies are replaceable for deterministic tests."""
    def __init__(self, config: dict, *, decision_runner: Callable | None = None,
                 sender: Callable | None = None, audio_store_factory: Callable | None = None,
                 bridge_module_factory: Callable | None = None, capture_reader: Callable | None = None):
        self.config = config
        self.decision_runner = decision_runner or _invoke_decision
        self.sender = sender
        self.audio_store_factory = audio_store_factory
        self.bridge_factory = bridge_module_factory or load_bridge_module
        self.capture_reader = capture_reader or _capture_row
        self.owner = f"{os.getpid()}-{os.urandom(12).hex()}"
        self.state = Path(config["stateDir"])
        self._lease_lock = threading.RLock()
        self._lease_depth = 0
        self._lease_stop = None
        self._lease_thread = None
        self._lease_lost = threading.Event()

    def _lease(self, db: sqlite3.Connection, now: float | None = None, lease_seconds: int = 600) -> bool:
        now = time.time() if now is None else now
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT owner,lease_until FROM coordinator_lease WHERE singleton=1").fetchone()
        if row and row["lease_until"] > now and row["owner"] != self.owner:
            db.execute("ROLLBACK")
            return False
        db.execute("INSERT INTO coordinator_lease(singleton,owner,lease_until) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner,lease_until=excluded.lease_until",
                   (self.owner, now + lease_seconds))
        db.execute("COMMIT")
        with self._lease_lock:
            self._lease_depth += 1
            if self._lease_depth == 1:
                self._lease_lost.clear()
                self._lease_stop = threading.Event()
                self._lease_thread = threading.Thread(target=self._renew_lease, daemon=True)
                self._lease_thread.start()
        return True

    def _renew_lease(self):
        while self._lease_stop and not self._lease_stop.wait(LEASE_RENEW_INTERVAL):
            try:
                db = _connect(self.config)
                try:
                    changed = db.execute("UPDATE coordinator_lease SET lease_until=? WHERE singleton=1 AND owner=?",
                                         (time.time() + MAX_LEASE, self.owner)).rowcount
                    if changed != 1:
                        self._lease_lost.set()
                        return
                finally:
                    db.close()
            except Exception:
                self._lease_lost.set()
                return

    def _assert_lease(self):
        if self._lease_lost.is_set():
            raise PipelineError("coordinator lease was lost")

    def _release(self, db):
        with self._lease_lock:
            if self._lease_depth > 1:
                self._lease_depth -= 1
                return
            if self._lease_depth == 1:
                self._lease_depth = 0
                if self._lease_stop:
                    self._lease_stop.set()
                thread = self._lease_thread
                self._lease_thread = None
                self._lease_stop = None
            else:
                thread = None
        if thread:
            thread.join(timeout=1)
        db.execute("DELETE FROM coordinator_lease WHERE singleton=1 AND owner=?", (self.owner,))

    def _authored_stage(self, row: dict) -> dict | None:
        bridge = self.bridge_factory()
        bridge_config = bridge.load_config(self.config["bridgeConfigFile"])
        return load_capture_module().staged_receipt(bridge_config, row["thread_id"], row["run_id"])

    def _recheck_exact(self, row: dict, captured: dict):
        bridge = self.bridge_factory()
        bridge_config = bridge.load_config(self.config["bridgeConfigFile"])
        try:
            snapshot = bridge.fetch_snapshot(bridge_config, row["thread_id"])
        except Exception as exc:
            raise ExactRunPending("exact-run snapshot is temporarily unavailable") from exc
        projection = snapshot.get("projection")
        if bridge.projection_thread_id(projection) != row["thread_id"]:
            raise PipelineError("current T3 projection identity mismatch")
        message, reason = bridge.find_final(projection, row["run_id"])
        if reason or not message:
            if isinstance(reason, str) and reason.startswith("bound run ended with status "):
                raise PipelineError("exact captured run ended unsuccessfully")
            raise ExactRunPending("exact captured run is not currently final")
        final_text = message.get("text")
        if not isinstance(final_text, str) or sha(final_text.encode("utf-8")) != sha(captured["text"].encode("utf-8")):
            raise PipelineError("exact-run final text changed since capture")
        # Never derive identity from current_run: only find_final(exact run_id) is accepted.

    def _prepare(self, row: dict, captured: dict) -> tuple[dict, bytes]:
        allowed_roots = []
        bridge = self.bridge_factory()
        bridge_config = bridge.load_config(self.config["bridgeConfigFile"])
        for root in bridge_config.get("allowedAudioRoots", []):
            path = private_path(root, "allowedAudioRoot")
            private_files.assert_directory_no_reparse(path)
            allowed_roots.append(path.resolve(strict=True))
        refs = _source_refs(captured["sourceRefs"])
        request = {"protocol": 1, "identity": {"threadId": row["thread_id"], "runId": row["run_id"]},
                   "capturedFinalText": captured["text"], "sourceRefs": captured["sourceRefs"]}
        request_raw = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode()
        if len(request_raw) > MAX_CAPTURE + 64 * 1024:
            raise PipelineError("decision request exceeds the size limit")
        raw_decision = self.decision_runner(self.config["decisionHelperArgv"],
                    request_raw, self.config["decisionHelperTimeoutSeconds"])
        # The ordinary classifier has no original-audio selection field. Discover
        # only a recording explicitly named by this captured final result, and
        # attach the trusted path/hash before the strict decision validator runs.
        try:
            decision_object = json.loads(raw_decision)
        except (UnicodeError, json.JSONDecodeError):
            decision_object = None
        if isinstance(decision_object, dict) and decision_object.get("decision") == "meaningful":
            discovered = _discover_original_audio(captured, allowed_roots)
            selected = decision_object.get("originalAudio")
            if discovered is not None:
                if selected is not None:
                    if (not isinstance(selected, dict) or set(selected) != {"path", "sha256"}
                            or not isinstance(selected.get("path"), str)
                            or not Path(selected["path"]).is_absolute()
                            or os.path.normpath(selected["path"]) != os.path.normpath(discovered["path"])):
                        raise PipelineError("classifier audio selection conflicts with captured MP3 reference")
                else:
                    decision_object["originalAudio"] = discovered
                raw_decision = json.dumps(decision_object, ensure_ascii=False,
                                          separators=(",", ":")).encode("utf-8")
        decision = _validate_decision(raw_decision, captured, row, allowed_roots)
        decision["sources"] = refs
        return decision, raw_decision

    def _metadata(self, row: dict, decision: dict, producer: dict) -> dict:
        host = producer.get("host")
        if not isinstance(host, str) or not host.strip() or len(host) > 255:
            raise PipelineError("producer host label is invalid")
        origin = {"host": host, "threadId": row["thread_id"], "runId": row["run_id"]}
        thread_url = _thread_url(row["thread_id"])
        if thread_url:
            origin["threadUrl"] = thread_url
        return {"deliveryId": stable_delivery_id(row["thread_id"], row["run_id"]),
                "phase": "final", "title": decision["title"], "body": None,
                "summary": decision["title"], "publishedAt": utc_now(),
                "resultType": decision["resultType"], "sources": decision["sources"],
                "tags": [], "origin": origin}

    def process_candidate(self, candidate_id: str) -> dict:
        row, captured, _path = self.capture_reader(self.config, candidate_id)
        delivery_id = stable_delivery_id(row["thread_id"], row["run_id"])
        db = _connect(self.config)
        try:
            if not self._lease(db):
                return {"candidateId": candidate_id, "status": "blocked", "reason": "coordinator lease held"}
            existing = db.execute("SELECT * FROM pipeline_candidates WHERE candidate_id=?", (candidate_id,)).fetchone()
            authored = self._authored_stage(row)
            if authored:
                capture_hash = existing["capture_sha256"] if existing else sha(b"authored-stage")
                status = "text-delivered" if authored.get("state") == "delivered" else "candidate-reviewed"
                db.execute("INSERT INTO pipeline_candidates(candidate_id,thread_id,run_id,capture_sha256,delivery_id,status,receipt_json,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET status=excluded.status,receipt_json=excluded.receipt_json,reason='authored outbox stage takes precedence',updated_at=excluded.updated_at",
                           (candidate_id,row["thread_id"],row["run_id"],capture_hash,delivery_id,status,
                            json.dumps(authored,separators=(",",":")),"authored outbox stage takes precedence",utc_now(),utc_now()))
                return {"candidateId": candidate_id, "status": status, "authoredStage": True}
            if not captured:
                raise PipelineError("captured text is unavailable and no authored stage exists")
            raw_capture = json.dumps(captured, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
            capture_hash = sha(raw_capture)
            if captured.get("completedAt") != row.get("completed_at"):
                raise PipelineError("captured completion time does not match capture journal")
            if existing and existing["capture_sha256"] != capture_hash:
                raise PipelineError("captured candidate changed after review")
            # Recover a text send whose remote commit succeeded before its local
            # receipt was saved. The immutable metadata and delivery ID are reused.
            if existing and existing["status"] == "candidate-reviewed" and existing["metadata_path"]:
                try:
                    self._verify_immutable_files(dict(existing))
                    self._assert_lease()
                    if self._authored_stage(row):
                        return {"candidateId": candidate_id, "status": "candidate-reviewed", "authoredStage": True}
                    receipt = self._send(existing["metadata_path"], None)
                except Exception:
                    db.execute("UPDATE pipeline_candidates SET retry_attempts=retry_attempts+1,next_attempt_at=?,updated_at=? WHERE candidate_id=?",
                               (datetime.fromtimestamp(time.time() + 60, timezone.utc).isoformat().replace("+00:00", "Z"),utc_now(),candidate_id))
                    return {"candidateId": candidate_id, "status": "candidate-reviewed", "reason": "text publication remains retryable"}
                self._receipt(db, candidate_id, receipt, "text-delivered")
                refreshed = db.execute("SELECT * FROM pipeline_candidates WHERE candidate_id=?", (candidate_id,)).fetchone()
                return self._advance_audio(db, dict(refreshed))
            if existing and existing["status"] in {"excluded", "review-needed", "blocked", "audio-delivered", "audio-ready", "audio-pending", "text-delivered"}:
                retry_due = (existing["status"] == "review-needed" and existing["reason"] == "retry:exact-run"
                             and existing["next_attempt_at"] and existing["next_attempt_at"] <= utc_now())
                if not retry_due:
                    return self._advance_audio(db, dict(existing)) if existing["status"] in {"audio-pending", "audio-ready", "text-delivered"} else {"candidateId": candidate_id, "status": existing["status"]}
            self._recheck_exact(row, captured)
            self._assert_lease()
            decision, decision_raw = self._prepare(row, captured)
            if decision["decision"] == "exclude":
                self._save_simple(db, row, candidate_id, capture_hash, delivery_id, "excluded", "classifier excluded result", sha(decision_raw))
                return {"candidateId": candidate_id, "status": "excluded"}
            if decision["decision"] == "review":
                self._save_simple(db, row, candidate_id, capture_hash, delivery_id, "review-needed", "classifier requested review", sha(decision_raw))
                return {"candidateId": candidate_id, "status": "review-needed"}
            # The audio helper config is separate; producer config path is explicit in bridge config.
            bridge = self.bridge_factory()
            bridge_config = bridge.load_config(self.config["bridgeConfigFile"])
            producer_config_path = bridge_config.get("producerConfigFile")
            producer = read_json(producer_config_path)
            metadata = self._metadata(row, decision, producer)
            metadata["body"] = captured["text"]  # Preserve the complete final response verbatim.
            metadata_raw = json.dumps(metadata, ensure_ascii=False, separators=(",", ":")).encode()
            if len(metadata_raw) > MAX_METADATA:
                raise PipelineError("result metadata exceeds the producer size limit")
            metadata_path = self.state / (candidate_id + ".result.json")
            private_files.atomic_write_private(metadata_path, metadata_raw)
            spoken_path = None
            if decision["spokenText"]:
                spoken_path = self.state / (candidate_id + ".spoken.txt")
                private_files.atomic_write_private(spoken_path, decision["spokenText"].encode())
            db.execute("INSERT INTO pipeline_candidates(candidate_id,thread_id,run_id,capture_sha256,decision_sha256,delivery_id,status,metadata_path,metadata_sha256,spoken_path,spoken_sha256,original_audio_path,original_audio_sha256,reason,created_at,updated_at) VALUES(?,?,?,?,?,?, 'candidate-reviewed',?,?,?,?,?,?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET decision_sha256=excluded.decision_sha256,status='candidate-reviewed',metadata_path=excluded.metadata_path,metadata_sha256=excluded.metadata_sha256,spoken_path=excluded.spoken_path,spoken_sha256=excluded.spoken_sha256,original_audio_path=excluded.original_audio_path,original_audio_sha256=excluded.original_audio_sha256,reason=NULL,updated_at=excluded.updated_at",
                       (candidate_id,row["thread_id"],row["run_id"],capture_hash,sha(decision_raw),delivery_id,
                        str(metadata_path),sha(metadata_raw),str(spoken_path) if spoken_path else None,
                        sha(decision["spokenText"].encode()) if decision["spokenText"] else None,
                        decision["originalAudioPath"],decision["originalAudioSha256"],None,utc_now(),utc_now()))
            db.execute("UPDATE pipeline_candidates SET next_attempt_at=? WHERE candidate_id=?",
                       (datetime.fromtimestamp(time.time() + 60, timezone.utc).isoformat().replace("+00:00", "Z"),candidate_id))
            db.commit()
            # Sending occurs outside any transaction. Stable ID makes response-loss recovery safe.
            try:
                self._verify_immutable_files({"metadata_path": str(metadata_path), "metadata_sha256": sha(metadata_raw),
                                              "spoken_path": str(spoken_path) if spoken_path else None,
                                              "spoken_sha256": sha(decision["spokenText"].encode()) if decision["spokenText"] else None,
                                              "original_audio_path": decision["originalAudioPath"],
                                              "original_audio_sha256": decision["originalAudioSha256"]})
                self._assert_lease()
                if self._authored_stage(row):
                    self._receipt(db, candidate_id, {"authoredStage": True}, "candidate-reviewed")
                    return {"candidateId": candidate_id, "status": "candidate-reviewed", "authoredStage": True}
                receipt = self._send(str(metadata_path), None)
            except Exception:
                db.execute("UPDATE pipeline_candidates SET retry_attempts=retry_attempts+1,next_attempt_at=?,updated_at=? WHERE candidate_id=?",
                           (datetime.fromtimestamp(time.time() + 60, timezone.utc).isoformat().replace("+00:00", "Z"),utc_now(),candidate_id))
                return {"candidateId": candidate_id, "status": "candidate-reviewed", "reason": "text publication remains retryable"}
            self._receipt(db, candidate_id, receipt, "text-delivered")
            refreshed = db.execute("SELECT * FROM pipeline_candidates WHERE candidate_id=?", (candidate_id,)).fetchone()
            return self._advance_audio(db, dict(refreshed))
        except Exception as exc:
            rowinfo = locals().get("row")
            if rowinfo and "candidate_id" in locals():
                try:
                    if isinstance(exc, ExactRunPending):
                        self._schedule_retry(db, candidate_id, rowinfo, locals().get("capture_hash", "0" * 64), delivery_id)
                    else:
                        self._save_simple(db, rowinfo, candidate_id, locals().get("capture_hash", "0" * 64), delivery_id,
                                          "review-needed", type(exc).__name__)
                except Exception:
                    pass
            return {"candidateId": candidate_id, "status": "review-needed", "reason": type(exc).__name__}
        finally:
            self._release(db)
            db.close()

    def _save_simple(self, db, row, cid, capture_hash, delivery_id, status, reason, decision_hash=None):
        now = utc_now()
        db.execute("INSERT INTO pipeline_candidates(candidate_id,thread_id,run_id,capture_sha256,decision_sha256,delivery_id,status,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,decision_sha256=COALESCE(excluded.decision_sha256,pipeline_candidates.decision_sha256),updated_at=excluded.updated_at",
                   (cid,row["thread_id"],row["run_id"],capture_hash,decision_hash,delivery_id,status,reason,now,now))

    def _schedule_retry(self, db, cid, row, capture_hash, delivery_id):
        prior = db.execute("SELECT retry_attempts FROM pipeline_candidates WHERE candidate_id=?", (cid,)).fetchone()
        attempts = (prior["retry_attempts"] if prior else 0) + 1
        delay = min(6 * 60 * 60, 60 * (2 ** min(attempts - 1, 8)))
        next_at = datetime.fromtimestamp(time.time() + delay, timezone.utc).isoformat().replace("+00:00", "Z")
        now = utc_now()
        db.execute("INSERT INTO pipeline_candidates(candidate_id,thread_id,run_id,capture_sha256,delivery_id,status,reason,retry_attempts,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,'review-needed','retry:exact-run',?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET status='review-needed',reason='retry:exact-run',retry_attempts=excluded.retry_attempts,next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at",
                   (cid,row["thread_id"],row["run_id"],capture_hash,delivery_id,attempts,next_at,now,now))

    def _schedule_audio_retry(self, db, cid):
        prior = db.execute("SELECT audio_retry_attempts FROM pipeline_candidates WHERE candidate_id=?", (cid,)).fetchone()
        attempts = (prior["audio_retry_attempts"] if prior else 0) + 1
        delay = min(6 * 60 * 60, 60 * (2 ** min(attempts - 1, 8)))
        next_at = datetime.fromtimestamp(time.time() + delay, timezone.utc).isoformat().replace("+00:00", "Z")
        db.execute("UPDATE pipeline_candidates SET audio_retry_attempts=?,next_attempt_at=?,updated_at=? WHERE candidate_id=?",
                   (attempts,next_at,utc_now(),cid))

    def _verify_immutable_files(self, row):
        metadata = read_private(row["metadata_path"], MAX_METADATA)
        if sha(metadata) != row["metadata_sha256"]:
            raise PipelineError("immutable result metadata changed")
        if row.get("spoken_path"):
            spoken = read_private(row["spoken_path"], MAX_SPOKEN)
            if sha(spoken) != row["spoken_sha256"]:
                raise PipelineError("immutable spoken adaptation changed")
        elif row.get("spoken_sha256"):
            raise PipelineError("spoken adaptation path is missing")
        if row.get("original_audio_path"):
            original = read_private(row["original_audio_path"], 30 * 1024 * 1024)
            if sha(original) != row["original_audio_sha256"]:
                raise PipelineError("selected original recording changed")

    def _send(self, metadata_path: str, audio_path: str | None):
        if self.sender:
            return self.sender(metadata_path, audio_path)
        bridge = self.bridge_factory()
        cfg = bridge.load_config(self.config["bridgeConfigFile"])
        return load_sender_module().deliver(cfg["producerConfigFile"], metadata_path, audio_path)

    def _receipt(self, db, cid, receipt, status):
        if not isinstance(receipt, dict):
            raise PipelineError("result sender returned an invalid receipt")
        authored = receipt.get("authoredStage") is True
        if not authored and (receipt.get("delivered") is not True
                             or not isinstance(receipt.get("itemId"), str)
                             or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", receipt["itemId"])):
            raise PipelineError("result sender did not confirm a written Inbox item")
        safe = {key: value for key, value in receipt.items()
                if key in {"delivered", "itemId", "created", "authoredStage", "audioDelivered", "audioSha256", "audioDuration"}
                and (value is None or isinstance(value, bool)
                     or (isinstance(value, int) and value.bit_length() <= 64)
                     or (isinstance(value, float) and math.isfinite(value))
                     or (isinstance(value, str) and len(value) <= 4096))}
        encoded = json.dumps(safe, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > 16_000:
            encoded = '{"stored":false,"reason":"receipt_too_large"}'
        db.execute("UPDATE pipeline_candidates SET status=?,receipt_json=?,updated_at=? WHERE candidate_id=?",
                   (status,encoded,utc_now(),cid))
        if receipt.get("delivered") is True and self.config.get("audioDeliveryMode", "local") == "central":
            db.execute("UPDATE pipeline_candidates SET central_audio_item_id=COALESCE(central_audio_item_id,?) WHERE candidate_id=?",
                       (receipt["itemId"], cid))
        db.execute("UPDATE pipeline_candidates SET next_attempt_at=NULL WHERE candidate_id=?", (cid,))

    def _advance_audio(self, db, row):
        if row["status"] == "audio-delivered":
            return {"candidateId": row["candidate_id"], "status": "audio-delivered"}
        metadata_path = row["metadata_path"]
        if not metadata_path:
            return {"candidateId": row["candidate_id"], "status": row["status"]}
        # Recheck authored stage before any audio attachment. Any extant stage wins.
        capture_row = {"thread_id": row["thread_id"], "run_id": row["run_id"]}
        if self._authored_stage(capture_row):
            self._receipt(db, row["candidate_id"], {"authoredStage": True}, "text-delivered")
            return {"candidateId": row["candidate_id"], "status": "text-delivered", "authoredStage": True}
        if row["original_audio_path"] and self.config.get("audioDeliveryMode", "local") in {"central", "on_demand"}:
            try:
                self._verify_immutable_files(row)
                self._assert_lease()
                if self._authored_stage(capture_row):
                    return {"candidateId": row["candidate_id"], "status": "text-delivered", "authoredStage": True}
                receipt = self._send(metadata_path, row["original_audio_path"])
                if self._written_item_id(row) != receipt.get("itemId"):
                    raise PipelineError("original audio sender changed the written item identity")
                self._receipt(db, row["candidate_id"], receipt, "audio-delivered")
                return {"candidateId": row["candidate_id"], "status": "audio-delivered", "receipt": receipt}
            except Exception as exc:
                db.execute("UPDATE pipeline_candidates SET reason='retry:audio',next_attempt_at=?,updated_at=? WHERE candidate_id=?",
                           (datetime.fromtimestamp(time.time() + 60, timezone.utc).isoformat().replace("+00:00", "Z"),utc_now(),row["candidate_id"]))
                return {"candidateId": row["candidate_id"], "status": "text-delivered", "audio": "retryable", "reason": type(exc).__name__}
        if self.config.get("audioDeliveryMode", "local") == "on_demand":
            # Keep the delivery receipt and job bindings for audit/recovery. Producer
            # delivery is complete; only an explicit Inbox action may request speech.
            self._written_item_id(row)
            db.execute("UPDATE pipeline_candidates SET status='text-delivered',reason='audio:on-demand',next_attempt_at=NULL,updated_at=? WHERE candidate_id=?",
                       (utc_now(), row["candidate_id"]))
            return {"candidateId": row["candidate_id"], "status": "text-delivered", "audio": "on-demand"}
        if not row["spoken_path"]:
            if row["original_audio_path"]:
                try:
                    self._verify_immutable_files(row)
                    self._assert_lease()
                    if self._authored_stage(capture_row):
                        return {"candidateId": row["candidate_id"], "status": "text-delivered", "authoredStage": True}
                    receipt = self._send(metadata_path, row["original_audio_path"])
                    if self._written_item_id(row) != receipt.get("itemId"):
                        raise PipelineError("original audio sender changed the written item identity")
                    self._receipt(db, row["candidate_id"], receipt, "audio-delivered")
                    return {"candidateId": row["candidate_id"], "status": "audio-delivered", "receipt": receipt}
                except Exception as exc:
                    db.execute("UPDATE pipeline_candidates SET reason='retry:audio',next_attempt_at=?,updated_at=? WHERE candidate_id=?",
                               (datetime.fromtimestamp(time.time() + 60, timezone.utc).isoformat().replace("+00:00", "Z"),utc_now(),row["candidate_id"]))
                    return {"candidateId": row["candidate_id"], "status": "text-delivered", "audio": "retryable", "reason": type(exc).__name__}
            return {"candidateId": row["candidate_id"], "status": "text-delivered", "audio": "pending-spoken-adaptation"}
        if self.config.get("audioDeliveryMode", "local") == "central":
            return self._request_or_poll_central(db, row)
        try:
            self._verify_immutable_files(row)
            store = self._audio_store()
            job = store.enqueue(result_identity=row["delivery_id"], metadata_path=metadata_path,
                spoken_text_path=row["spoken_path"], voice_profile_sha256=self.config["voiceProfileSha256"],
                meaningful=True, original_mp3_path=row["original_audio_path"], original_mp3_sha256=row["original_audio_sha256"])
        except Exception as exc:
            db.execute("UPDATE pipeline_candidates SET status='blocked',reason=?,updated_at=? WHERE candidate_id=?",
                       (type(exc).__name__,utc_now(),row["candidate_id"]))
            return {"candidateId": row["candidate_id"], "status": "blocked", "reason": type(exc).__name__}
        status = "audio-ready" if job["state"] == "ready" else "audio-pending"
        db.execute("UPDATE pipeline_candidates SET status=?,audio_job_id=?,updated_at=? WHERE candidate_id=?",
                   (status,job["id"],utc_now(),row["candidate_id"]))
        if job["state"] == "pending":
            self._schedule_audio_retry(db, row["candidate_id"])
            return {"candidateId": row["candidate_id"], "status": status, "audioJobId": job["id"]}
        return self.attach_ready_audio(row["candidate_id"], store=store)

    def _audio_store(self):
        if self.audio_store_factory:
            return self.audio_store_factory()
        cfg = read_json(self.config["audioHelperConfigFile"])
        store = load_audio_module().AudioJobStore(cfg["databaseFile"], cfg["mediaDir"])
        return store

    def _producer_config_path(self):
        bridge = self.bridge_factory()
        bridge_config = bridge.load_config(self.config["bridgeConfigFile"])
        return bridge_config["producerConfigFile"]

    def _central_audio_module(self):
        return module_from("ai_inbox_pipeline_central_audio", "request-result-audio.py")

    def _written_item_id(self, row):
        try:
            receipt = json.loads(row["receipt_json"] or "{}")
        except (TypeError, json.JSONDecodeError) as exc:
            raise PipelineError("written result receipt is invalid") from exc
        item_id = receipt.get("itemId") if isinstance(receipt, dict) else None
        if (not isinstance(receipt, dict) or receipt.get("delivered") is not True
                or not isinstance(item_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", item_id)):
            raise PipelineError("written result receipt is not confirmed")
        return item_id

    def _central_audio_result(self, db, row, result):
        state = result["state"]
        item_id = result["itemId"]
        if state in {"ready", "ready_existing"}:
            receipt = {"delivered": True, "itemId": item_id, "audioDelivered": True}
            if result.get("mediaSha256"):
                receipt["audioSha256"] = result["mediaSha256"]
            if result.get("durationSeconds"):
                receipt["audioDuration"] = result["durationSeconds"]
            self._receipt(db, row["candidate_id"], receipt, "audio-delivered")
            return {"candidateId": row["candidate_id"], "status": "audio-delivered", "itemId": item_id}
        if state in {"needs_review", "superseded"}:
            db.execute("UPDATE pipeline_candidates SET status='blocked',central_audio_job_id=?,central_audio_item_id=?,reason=?,updated_at=? WHERE candidate_id=?",
                       (result.get("jobId"), item_id, "central-audio:" + state, utc_now(), row["candidate_id"]))
            return {"candidateId": row["candidate_id"], "status": "blocked", "reason": "central-audio:" + state}
        db.execute("UPDATE pipeline_candidates SET status='audio-pending',central_audio_job_id=?,central_audio_item_id=?,updated_at=? WHERE candidate_id=?",
                   (result["jobId"], item_id, utc_now(), row["candidate_id"]))
        self._schedule_audio_retry(db, row["candidate_id"])
        return {"candidateId": row["candidate_id"], "status": "audio-pending", "centralAudioJobId": result["jobId"]}

    def _request_or_poll_central(self, db, row):
        capture_row = {"thread_id": row["thread_id"], "run_id": row["run_id"]}
        if row.get("next_attempt_at") and row["next_attempt_at"] > utc_now():
            return {"candidateId": row["candidate_id"], "status": "audio-pending", "reason": "central-audio-backoff"}
        try:
            self._verify_immutable_files(row)
            item_id = self._written_item_id(row)
            if row.get("central_audio_item_id") and row["central_audio_item_id"] != item_id:
                raise PipelineError("central audio item binding changed")
            self._assert_lease()
            if self._authored_stage(capture_row):
                self._receipt(db, row["candidate_id"], {"authoredStage": True}, "text-delivered")
                return {"candidateId": row["candidate_id"], "status": "text-delivered", "authoredStage": True}
            audio_client = self._central_audio_module()
            if row.get("central_audio_job_id"):
                result = audio_client.get_audio_status(self._producer_config_path(), row["central_audio_job_id"], item_id)
            else:
                result = audio_client.request_audio(self._producer_config_path(), row["metadata_path"],
                                                   row["spoken_path"], item_id)
            if self._authored_stage(capture_row):
                self._receipt(db, row["candidate_id"], {"authoredStage": True}, "text-delivered")
                return {"candidateId": row["candidate_id"], "status": "text-delivered", "authoredStage": True}
            return self._central_audio_result(db, row, result)
        except Exception as exc:
            client = self._central_audio_module()
            transient = isinstance(exc, client.AudioRequestError) and exc.transient
            if transient:
                db.execute("UPDATE pipeline_candidates SET status='audio-pending',central_audio_item_id=COALESCE(central_audio_item_id,?),updated_at=? WHERE candidate_id=?",
                           (row.get("central_audio_item_id") or self._written_item_id(row), utc_now(), row["candidate_id"]))
                self._schedule_audio_retry(db, row["candidate_id"])
                return {"candidateId": row["candidate_id"], "status": "audio-pending", "reason": "central-audio-temporary"}
            db.execute("UPDATE pipeline_candidates SET status='blocked',reason=?,updated_at=? WHERE candidate_id=?",
                       ("central-audio-review:" + type(exc).__name__, utc_now(), row["candidate_id"]))
            return {"candidateId": row["candidate_id"], "status": "blocked", "reason": "central-audio-review"}

    def attach_ready_audio(self, candidate_id: str, *, store=None) -> dict:
        db = _connect(self.config)
        try:
            if not self._lease(db):
                return {"candidateId": candidate_id, "status": "blocked", "reason": "coordinator lease held"}
            row = db.execute("SELECT * FROM pipeline_candidates WHERE candidate_id=?", (candidate_id,)).fetchone()
            if not row or row["status"] not in {"audio-ready", "audio-pending", "text-delivered"}:
                return {"candidateId": candidate_id, "status": row["status"] if row else "blocked"}
            # Same late authored-stage gate immediately before attaching.
            if self._authored_stage(dict(row)):
                self._receipt(db, candidate_id, {"authoredStage": True}, "text-delivered")
                return {"candidateId": candidate_id, "status": "text-delivered", "authoredStage": True}
            if self.config.get("audioDeliveryMode", "local") == "on_demand":
                return self._advance_audio(db, dict(row))
            if self.config.get("audioDeliveryMode", "local") == "central" and row["original_audio_path"]:
                self._verify_immutable_files(dict(row))
                if self._authored_stage(dict(row)):
                    self._receipt(db, candidate_id, {"authoredStage": True}, "text-delivered")
                    return {"candidateId": candidate_id, "status": "text-delivered", "authoredStage": True}
                receipt = self._send(row["metadata_path"], row["original_audio_path"])
                if self._written_item_id(dict(row)) != receipt.get("itemId"):
                    raise PipelineError("original audio sender changed the written item identity")
                self._receipt(db, candidate_id, receipt, "audio-delivered")
                return {"candidateId": candidate_id, "status": "audio-delivered", "receipt": receipt}
            if self.config.get("audioDeliveryMode", "local") == "central":
                return self._request_or_poll_central(db, dict(row))
            if not row["audio_job_id"] and row["original_audio_path"] and not row["spoken_path"]:
                self._verify_immutable_files(dict(row))
                self._assert_lease()
                if self._authored_stage(dict(row)):
                    self._receipt(db, candidate_id, {"authoredStage": True}, "text-delivered")
                    return {"candidateId": candidate_id, "status": "text-delivered", "authoredStage": True}
                receipt = self._send(row["metadata_path"], row["original_audio_path"])
                self._receipt(db, candidate_id, receipt, "audio-delivered")
                return {"candidateId": candidate_id, "status": "audio-delivered", "receipt": receipt}
            store = store or self._audio_store()
            job = store.get(row["audio_job_id"]) if hasattr(store, "get") and row["audio_job_id"] else None
            if not job or job["state"] != "ready" or not job.get("media_path"):
                state = "audio-pending" if not job or job["state"] in {"pending", "running"} else "blocked"
                db.execute("UPDATE pipeline_candidates SET status=?,updated_at=? WHERE candidate_id=?", (state,utc_now(),candidate_id))
                if state == "audio-pending":
                    self._schedule_audio_retry(db, candidate_id)
                return {"candidateId": candidate_id, "status": state}
            self._verify_immutable_files(dict(row))
            media_root = getattr(store, "media_dir", None)
            if media_root is None:
                audio_config = read_json(self.config["audioHelperConfigFile"])
                media_root = private_path(audio_config.get("mediaDir"), "audio mediaDir")
            media_root = Path(media_root).resolve(strict=True)
            media_file = Path(job["media_path"]).resolve(strict=True)
            if media_file != media_root and media_root not in media_file.parents:
                raise PipelineError("ready audio media is outside the private job media directory")
            media = read_private(job["media_path"], 30 * 1024 * 1024)
            if not job.get("media_sha256") or sha(media) != job["media_sha256"]:
                raise PipelineError("ready audio media hash does not match its job receipt")
            load_audio_module()._valid_mp3(Path(job["media_path"]), job["media_sha256"])
            metadata_raw = read_private(row["metadata_path"], MAX_METADATA)
            metadata = json.loads(metadata_raw)
            if job.get("duration_seconds") is not None:
                duration = job["duration_seconds"]
                if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0 or duration > 86400:
                    raise PipelineError("ready audio duration is invalid")
                metadata["audioDuration"] = duration
            attachment_path = self.state / (candidate_id + ".audio-result.json")
            private_files.atomic_write_private(attachment_path, json.dumps(metadata, ensure_ascii=False, separators=(",", ":")).encode())
            self._assert_lease()
            if self._authored_stage(dict(row)):
                self._receipt(db, candidate_id, {"authoredStage": True}, "text-delivered")
                return {"candidateId": candidate_id, "status": "text-delivered", "authoredStage": True}
            receipt = self._send(str(attachment_path), job["media_path"])
            self._receipt(db, candidate_id, receipt, "audio-delivered")
            return {"candidateId": candidate_id, "status": "audio-delivered", "receipt": receipt}
        except Exception as exc:
            try:
                self._schedule_audio_retry(db, candidate_id)
            except sqlite3.Error:
                pass
            return {"candidateId": candidate_id, "status": "audio-pending", "reason": type(exc).__name__}
        finally:
            self._release(db)
            db.close()

    def run_audio_once(self) -> dict | None:
        """Reconcile central status or claim at most one local synthesis job."""
        if self.config.get("audioDeliveryMode", "local") in {"central", "on_demand"}:
            completed = []
            for candidate_id in _audio_candidate_ids(self.config, 10):
                completed.append(self.attach_ready_audio(candidate_id))
            return {"mode": self.config["audioDeliveryMode"], "reconciled": len(completed), "results": completed}
        lease_db = _connect(self.config)
        if not self._lease(lease_db, lease_seconds=MAX_LEASE):
            lease_db.close()
            return {"state": "blocked", "reason": "coordinator lease held"}
        try:
            return self._run_audio_under_lease()
        finally:
            self._release(lease_db)
            lease_db.close()

    def _run_audio_under_lease(self) -> dict | None:
        store = self._audio_store()
        for candidate_id in _audio_candidate_ids(self.config, 50):
            self.attach_ready_audio(candidate_id, store=store)
        cfg = read_json(self.config["audioHelperConfigFile"])
        helper = load_audio_module().HelperConfig(tuple(cfg["helperArgv"]), Path(cfg["helperPath"]),
                    cfg["profileRef"], int(cfg.get("timeoutSeconds", 300)))
        lease_seconds = min(3600, max(10, helper.timeout_seconds + 30))
        result = store.run_one(helper, lease_seconds=lease_seconds)
        if result is None:
            return None
        state = result.get("state")
        if state in {"ready", "uncertain", "blocked", "retryable_failure"}:
            db = _connect(self.config)
            try:
                row = db.execute("SELECT candidate_id FROM pipeline_candidates WHERE audio_job_id=?", (result["id"],)).fetchone()
            finally:
                db.close()
            if row and state == "ready":
                self.attach_ready_audio(row["candidate_id"], store=store)
        return result

    def process_batch(self, candidate_ids: list[str]) -> list[dict]:
        if len(candidate_ids) > MAX_TOTAL_BATCH:
            raise PipelineError(f"batch size must be at most {MAX_TOTAL_BATCH}")
        output = []
        for cid in candidate_ids:
            try:
                output.append(self.process_candidate(cid))
            except Exception as exc:
                output.append({"candidateId": cid, "status": "review-needed", "reason": type(exc).__name__})
        return output


def _audio_candidate_ids(config: dict, limit: int) -> list[str]:
    db = _connect(config)
    try:
        cursor = db.execute("SELECT * FROM candidate_cursors WHERE pass_name='audio'").fetchone()
        last_time, last_id = (cursor["last_completed_at"], cursor["last_candidate_id"]) if cursor else ("", "")
        if not cursor:
            db.execute("INSERT INTO candidate_cursors(pass_name,activation_epoch,last_completed_at,last_candidate_id) VALUES('audio','audio-v1','','')")
        now = utc_now()
        eligible_sql = "SELECT candidate_id,updated_at FROM pipeline_candidates WHERE (status='audio-ready' OR (status='audio-pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?)) OR (status='text-delivered' AND reason='retry:audio' AND next_attempt_at<=?))"
        if config.get("audioDeliveryMode", "local") == "on_demand":
            # Policy changes settle queued synthesis immediately, even if its old
            # provider backoff is still active. Retain backoff for original uploads.
            eligible_sql = "SELECT candidate_id,updated_at FROM pipeline_candidates WHERE (status='audio-ready' OR (status='audio-pending' AND (original_audio_path IS NULL OR next_attempt_at IS NULL OR next_attempt_at<=?)) OR (status='text-delivered' AND reason='retry:audio' AND next_attempt_at<=?))"
        scan_limit = max(100, limit * 20)
        if last_time:
            rows = db.execute(eligible_sql + " AND (updated_at>? OR (updated_at=? AND candidate_id>?)) ORDER BY updated_at,candidate_id LIMIT ?",
                              (now,now,last_time,last_time,last_id,scan_limit)).fetchall()
        else:
            rows = db.execute(eligible_sql + " ORDER BY updated_at,candidate_id LIMIT ?", (now,now,scan_limit)).fetchall()
        if not rows and last_time:
            last_time, last_id = "", ""
            db.execute("UPDATE candidate_cursors SET last_completed_at='',last_candidate_id='' WHERE pass_name='audio'")
            rows = db.execute(eligible_sql + " ORDER BY updated_at,candidate_id LIMIT ?", (now,now,scan_limit)).fetchall()
        selected = rows[:limit]
        if selected:
            final = selected[-1]
            db.execute("UPDATE candidate_cursors SET last_completed_at=?,last_candidate_id=? WHERE pass_name='audio'",
                       (final["updated_at"], final["candidate_id"]))
            if len(rows) < scan_limit and len(selected) == len(rows):
                db.execute("UPDATE candidate_cursors SET last_completed_at='',last_candidate_id='' WHERE pass_name='audio'")
        elif not rows:
            db.execute("UPDATE candidate_cursors SET last_completed_at='',last_candidate_id='' WHERE pass_name='audio'")
        return [row["candidate_id"] for row in selected]
    finally:
        db.close()

def _candidate_ids(config: dict, limit: int, pass_name: str = "new") -> list[str]:
    cap = load_capture_module()
    cap_config = cap.load_config(config["captureConfigFile"])
    db = cap.connect_capture(cap_config)
    pipeline_db = _connect(config)
    try:
        state = db.execute("SELECT activation_epoch FROM capture_state WHERE singleton=1").fetchone()
        if not state:
            raise PipelineError("capture journal is not initialized")
        epoch = cap.parse_time(state["activation_epoch"])
        if not epoch:
            return []
        epoch_text = state["activation_epoch"]
        cursor = pipeline_db.execute("SELECT * FROM candidate_cursors WHERE pass_name=?", (pass_name,)).fetchone()
        if not cursor or cursor["activation_epoch"] != epoch_text:
            last_time, last_id = "", ""
            pipeline_db.execute("INSERT INTO candidate_cursors(pass_name,activation_epoch,last_completed_at,last_candidate_id) VALUES(?,?,?,?) ON CONFLICT(pass_name) DO UPDATE SET activation_epoch=excluded.activation_epoch,last_completed_at='',last_candidate_id=''",
                                (pass_name, epoch_text, "", ""))
        else:
            last_time, last_id = cursor["last_completed_at"], cursor["last_candidate_id"]
        scan_limit = max(100, limit * 20)
        select_sql = "SELECT candidate_id,completed_at,status FROM candidates WHERE completed_at>=? AND status IN ('needs_review','observed') AND text_file IS NOT NULL"
        if last_time:
            rows = db.execute(select_sql + " AND (completed_at>? OR (completed_at=? AND candidate_id>?)) ORDER BY completed_at,candidate_id LIMIT ?",
                              (epoch_text,last_time,last_time,last_id,scan_limit)).fetchall()
        else:
            rows = db.execute(select_sql + " ORDER BY completed_at,candidate_id LIMIT ?", (epoch_text,scan_limit)).fetchall()
        if not rows and last_time:
            last_time, last_id = "", ""
            db.execute("UPDATE candidate_cursors SET last_completed_at='',last_candidate_id='' WHERE pass_name=?", (pass_name,))
            rows = db.execute(select_sql + " ORDER BY completed_at,candidate_id LIMIT ?", (epoch_text,scan_limit)).fetchall()
        rows = [r for r in rows if cap.parse_time(r["completed_at"]) and cap.parse_time(r["completed_at"]) >= epoch]
        ordered = rows
        selected, scanned = [], None
        for item in ordered:
            scanned = item
            state_row = pipeline_db.execute("SELECT status,reason,next_attempt_at,metadata_path FROM pipeline_candidates WHERE candidate_id=?",
                                            (item["candidate_id"],)).fetchone()
            is_retry = bool(state_row and (
                (state_row["reason"] == "retry:exact-run" and state_row["next_attempt_at"] and state_row["next_attempt_at"] <= utc_now())
                or (state_row["status"] == "candidate-reviewed" and state_row["metadata_path"]
                    and state_row["next_attempt_at"] and state_row["next_attempt_at"] <= utc_now())))
            if pass_name == "retry":
                if is_retry:
                    selected.append(item["candidate_id"])
            elif not state_row:
                selected.append(item["candidate_id"])
            if len(selected) >= limit:
                break
        if scanned:
            pipeline_db.execute("UPDATE candidate_cursors SET last_completed_at=?,last_candidate_id=? WHERE pass_name=?",
                                (scanned["completed_at"], scanned["candidate_id"], pass_name))
        if (scanned and rows and len(rows) < scan_limit
                and (scanned["completed_at"], scanned["candidate_id"]) == (rows[-1]["completed_at"], rows[-1]["candidate_id"])):
            pipeline_db.execute("UPDATE candidate_cursors SET last_completed_at='',last_candidate_id='' WHERE pass_name=?", (pass_name,))
        return selected
    finally:
        pipeline_db.close()
        cap.secure_capture_artifacts(cap_config)
        db.close()


def parser():
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--config", required=True)
    sub = root.add_subparsers(dest="command", required=True)
    once = sub.add_parser("once")
    once.add_argument("--limit", type=int, default=10)
    sub.add_parser("audio-once")
    return root


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "once" and not 1 <= args.limit <= MAX_BATCH:
            raise PipelineError(f"limit must be between 1 and {MAX_BATCH}")
        config = load_config(args.config)
        pipeline = ResultPipeline(config)
        if args.command == "audio-once":
            result = pipeline.run_audio_once()
            print(json.dumps(result, ensure_ascii=False))
        else:
            fresh = _candidate_ids(config, args.limit, "new")
            retries = _candidate_ids(config, args.limit, "retry")
            ids = list(dict.fromkeys(fresh + retries))
            print(json.dumps(pipeline.process_batch(ids), ensure_ascii=False))
        return 0
    except Exception as exc:
        print("Result pipeline failed: " + type(exc).__name__, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
