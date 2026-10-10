#!/usr/bin/env python3
"""Private, durable queue for future spoken-result audio.

This module does not publish Inbox items and does not contain provider credentials.
The external helper protocol is JSON on stdin and one small JSON receipt on stdout.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import subprocess
import sys
import threading
import time
from typing import Any, Sequence

MAX_METADATA = 2_000_000
MAX_SPOKEN_TEXT = 250_000
MAX_AUDIO = 30 * 1024 * 1024
MAX_RECEIPT = 16_384
MAX_ATTEMPTS = 3  # one automatic initial claim; up to two reviewed retries
STATES = {"pending", "running", "ready", "retryable_failure", "uncertain", "blocked"}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class AudioJobError(ValueError):
    """Input, state, or privacy policy violation."""


def _load_private_files():
    helper = Path(__file__).with_name("private-files.py")
    if not helper.is_file():
        raise AudioJobError("scripts/private-files.py is required")
    spec = importlib.util.spec_from_file_location("audio_jobs_private_files", helper)
    if not spec or not spec.loader:
        raise AudioJobError("scripts/private-files.py could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


private_files = _load_private_files()


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _private_bytes(path: str | os.PathLike[str], limit: int) -> tuple[Path, bytes]:
    try:
        target = private_files.assert_private_file(path)
    except (OSError, ValueError) as exc:
        raise AudioJobError("private input is missing or violates file policy") from exc
    with target.open("rb") as stream:
        value = stream.read(limit + 1)
    if len(value) > limit:
        raise AudioJobError("private input exceeds its size limit")
    return target, value


def _json_object(raw: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AudioJobError(f"{label} must be UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise AudioJobError(f"{label} must be a JSON object")
    return value


def _valid_mp3(path: Path, expected_hash: str | None = None) -> tuple[str, int]:
    try:
        path = private_files.assert_private_file(path)
    except (OSError, ValueError) as exc:
        raise AudioJobError("MP3 is missing or violates private-file policy") from exc
    size = path.stat().st_size
    if size < 4 or size > MAX_AUDIO:
        raise AudioJobError("MP3 is empty or exceeds the media size limit")
    def mpeg_frame_length(header: bytes) -> int | None:
        if len(header) != 4 or header[0] != 0xFF or header[1] & 0xE0 != 0xE0:
            return None
        version = (header[1] >> 3) & 0x03
        layer = (header[1] >> 1) & 0x03
        bitrate_index = (header[2] >> 4) & 0x0F
        sample_index = (header[2] >> 2) & 0x03
        if version == 1 or layer != 1 or bitrate_index in (0, 15) or sample_index == 3 or header[3] & 0x03 == 0x02:
            return None
        # Layer III uses the standard MPEG-1 and MPEG-2/2.5 bitrate tables.
        mpeg1_bitrates = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320)
        mpeg2_bitrates = (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160)
        bitrate = (mpeg1_bitrates if version == 3 else mpeg2_bitrates)[bitrate_index] * 1000
        base_rate = (44100, 48000, 32000)[sample_index]
        sample_rate = base_rate if version == 3 else base_rate // (2 if version == 2 else 4)
        padding = (header[2] >> 1) & 1
        return (144 * bitrate // sample_rate if version == 3 else 72 * bitrate // sample_rate) + padding

    with path.open("rb") as stream:
        start = 0
        header = stream.read(10)
        if header[:3] == b"ID3":
            # ID3v2 size is syncsafe; reject malformed sizes instead of scanning the tag.
            if len(header) != 10 or any(byte & 0x80 for byte in header[6:10]):
                raise AudioJobError("MP3 has a malformed ID3 header")
            tag_size = ((header[6] << 21) | (header[7] << 14) | (header[8] << 7) | header[9])
            start = 10 + tag_size
        stream.seek(start)
        frame_header = stream.read(4)
        frame_length = mpeg_frame_length(frame_header)
        if frame_length is None or frame_length < 4 or start + frame_length > size:
            raise AudioJobError("media does not contain a complete MPEG audio frame")
        # Require a following compatible frame when bytes remain after this frame;
        # this rejects isolated false syncs while allowing a valid single-frame file.
        next_offset = start + frame_length
        if next_offset < size:
            stream.seek(next_offset)
            next_length = mpeg_frame_length(stream.read(4))
            if next_length is None or next_offset + next_length > size:
                # ID3v1 tags may follow audio, but cannot serve as audio evidence.
                stream.seek(next_offset)
                trailing = stream.read()
                if not (len(trailing) == 128 and trailing[:3] == b"TAG"):
                    raise AudioJobError("media has invalid MPEG frame data")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    actual = digest.hexdigest()
    if expected_hash is not None and actual != expected_hash:
        raise AudioJobError("MP3 hash does not match the selected recording")
    return actual, size


def _invoke_helper(argv: Sequence[str], request: bytes, timeout_seconds: int):
    """Run the fixed argv while retaining at most one receipt plus one byte."""
    process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, shell=False)
    captured = bytearray()
    overflow = threading.Event()

    def drain_stdout():
        assert process.stdout is not None
        while True:
            chunk = process.stdout.read(4096)
            if not chunk:
                break
            if len(captured) < MAX_RECEIPT + 1:
                captured.extend(chunk[:MAX_RECEIPT + 1 - len(captured)])
            if len(captured) > MAX_RECEIPT:
                overflow.set()

    def send_request():
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

    reader = threading.Thread(target=drain_stdout, name="audio-job-receipt", daemon=True)
    writer = threading.Thread(target=send_request, name="audio-job-request", daemon=True)
    reader.start()
    writer.start()
    try:
        return_code = process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        writer.join(timeout=1)
        reader.join(timeout=1)
        try:
            process.stdout.close()
        except OSError:
            pass
        return None, bytes(captured), overflow.is_set(), True
    writer.join(timeout=1)
    reader.join(timeout=1)
    if reader.is_alive():
        # A detached helper child retained stdout; stop retaining its pipe.
        try:
            process.stdout.close()
        except OSError:
            pass
    else:
        process.stdout.close()
    return return_code, bytes(captured), overflow.is_set(), False


@dataclass(frozen=True)
class HelperConfig:
    """Non-secret helper configuration. argv_prefix is a fixed argv, never a shell string."""
    argv_prefix: tuple[str, ...]
    helper_path: Path
    profile_ref: str
    timeout_seconds: int = 300

    def validate(self) -> tuple[str, ...]:
        helper = Path(self.helper_path).expanduser()
        if not helper.is_absolute() or helper.is_symlink() or not helper.is_file():
            raise AudioJobError("configured helper must be an existing absolute regular file")
        if not self.argv_prefix or any(not isinstance(arg, str) or not arg for arg in self.argv_prefix):
            raise AudioJobError("helper argv must be a non-empty argument vector")
        if not self.profile_ref or len(self.profile_ref) > 200:
            raise AudioJobError("a non-secret voice profile reference is required")
        if not 1 <= self.timeout_seconds <= 1800:
            raise AudioJobError("helper timeout must be between 1 and 1800 seconds")
        # The fixed helper location is appended as argv data; no shell parses it.
        return (*self.argv_prefix, str(helper), "--audio-job-stdin-json")


class AudioJobStore:
    def __init__(self, db_path: str | os.PathLike[str], media_dir: str | os.PathLike[str]):
        self.db_path = Path(db_path).expanduser()
        self.media_dir = Path(media_dir).expanduser()
        if not self.db_path.is_absolute() or not self.media_dir.is_absolute():
            raise AudioJobError("audio job paths must be absolute")
        private_files.ensure_private_directory(self.db_path.parent)
        private_files.ensure_private_directory(self.media_dir)
        private_files.ensure_private_sqlite_database(self.db_path)
        self._initialize()

    def _connect(self):
        private_files.ensure_private_sqlite_database(self.db_path)
        self._assert_sqlite_artifacts_owned()
        db = sqlite3.connect(self.db_path, timeout=15, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("PRAGMA journal_mode=DELETE")
            db.execute("PRAGMA synchronous=FULL")
            self._secure_database_artifacts()
        except Exception:
            db.close()
            raise
        return db

    def _initialize(self):
        db = self._connect()
        try:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS audio_jobs (
                    id TEXT PRIMARY KEY,
                    result_identity TEXT NOT NULL,
                    content_sha256 TEXT NOT NULL,
                    voice_profile_sha256 TEXT NOT NULL,
                    metadata_path TEXT NOT NULL,
                    metadata_sha256 TEXT NOT NULL,
                    spoken_text_path TEXT NOT NULL,
                    spoken_text_sha256 TEXT NOT NULL,
                    state TEXT NOT NULL CHECK(state IN ('pending','running','ready','retryable_failure','uncertain','blocked')),
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    claim_count INTEGER NOT NULL DEFAULT 0,
                    attempt_nonce TEXT,
                    lease_until REAL,
                    media_path TEXT,
                    media_sha256 TEXT,
                    duration_seconds REAL,
                    last_error_code TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS audio_jobs_identity
                    ON audio_jobs(result_identity, content_sha256, voice_profile_sha256);
                CREATE INDEX IF NOT EXISTS audio_jobs_state_created ON audio_jobs(state, created_at);
                CREATE TABLE IF NOT EXISTS audio_attempts (
                    job_id TEXT NOT NULL REFERENCES audio_jobs(id),
                    attempt_no INTEGER NOT NULL,
                    nonce TEXT NOT NULL UNIQUE,
                    state TEXT NOT NULL,
                    started_at REAL NOT NULL,
                    finished_at REAL,
                    request_sha256 TEXT NOT NULL,
                    provider_receipt_json TEXT,
                    media_sha256 TEXT,
                    error_code TEXT,
                    resolution_json TEXT,
                    PRIMARY KEY(job_id, attempt_no)
                );
            """)
        finally:
            db.close()
        self._secure_database_artifacts()

    def _secure_database_artifacts(self):
        try:
            self._assert_sqlite_artifacts_owned()
            private_files.secure_sqlite_artifacts(self.db_path)
        except (OSError, ValueError) as exc:
            raise AudioJobError("SQLite database or sidecar violates private-file policy") from exc

    def _assert_sqlite_artifacts_owned(self):
        if os.name == "nt":
            return
        for artifact in (self.db_path, Path(str(self.db_path) + "-journal"),
                         Path(str(self.db_path) + "-wal"), Path(str(self.db_path) + "-shm")):
            if not artifact.exists() and not artifact.is_symlink():
                continue
            private_files.assert_regular_file_no_reparse(artifact)
            if artifact.lstat().st_uid != os.geteuid():
                raise AudioJobError("SQLite artifacts owned by another user are not modified")

    def enqueue(self, *, result_identity: str, metadata_path: str | os.PathLike[str],
                spoken_text_path: str | os.PathLike[str], voice_profile_sha256: str,
                meaningful: bool, original_mp3_path: str | os.PathLike[str] | None = None,
                original_mp3_sha256: str | None = None) -> dict[str, Any]:
        if meaningful is not True:
            raise AudioJobError("only explicitly meaningful future results can be queued")
        if not isinstance(result_identity, str) or not result_identity.strip() or len(result_identity) > 500:
            raise AudioJobError("stable producer result identity is required")
        if not SHA256_RE.fullmatch(voice_profile_sha256):
            raise AudioJobError("voice profile identity must be a SHA-256 hex digest")
        metadata_file, metadata_raw = _private_bytes(metadata_path, MAX_METADATA)
        metadata = _json_object(metadata_raw, "result metadata")
        if metadata.get("phase", "final") != "final":
            raise AudioJobError("only final result metadata is eligible for audio")
        text_file, text_raw = _private_bytes(spoken_text_path, MAX_SPOKEN_TEXT)
        try:
            spoken_text = text_raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise AudioJobError("spoken adaptation must be UTF-8") from exc
        if not spoken_text.strip():
            raise AudioJobError("spoken adaptation is empty")
        content_hash = _sha(text_raw)
        existing_media = None
        existing_media_path = None
        existing_hash = None
        if original_mp3_path is not None:
            if not original_mp3_sha256 or not SHA256_RE.fullmatch(original_mp3_sha256):
                raise AudioJobError("selected original recording requires its SHA-256")
            source = Path(original_mp3_path).expanduser()
            source_hash, _size = _valid_mp3(source, original_mp3_sha256)
            source_raw = source.read_bytes()
            if len(source_raw) > MAX_AUDIO or _sha(source_raw) != source_hash:
                raise AudioJobError("selected original changed while it was being copied")
            existing_media_path = self.media_dir / f"original-{source_hash}.mp3"
            if existing_media_path.exists() or existing_media_path.is_symlink():
                existing_media, _size = _valid_mp3(existing_media_path, source_hash)
            else:
                try:
                    private_files.create_private_file(existing_media_path, source_raw)
                except FileExistsError:
                    # Another enqueue may have installed the same hash-named
                    # copy concurrently. Validate it; never overwrite it.
                    pass
                existing_media, _size = _valid_mp3(existing_media_path, source_hash)
            existing_hash = original_mp3_sha256
        elif original_mp3_sha256 is not None:
            raise AudioJobError("an original recording hash requires its selected path")

        now = time.time()
        job_id = secrets.token_hex(16)
        state = "ready" if existing_media else "pending"
        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM audio_jobs WHERE result_identity=? AND content_sha256=? AND voice_profile_sha256=?",
                             (result_identity, content_hash, voice_profile_sha256)).fetchone()
            if row:
                metadata_hash = _sha(metadata_raw)
                if row["state"] == "running" and row["metadata_sha256"] != metadata_hash:
                    raise AudioJobError("result metadata changed while its audio attempt is running")
                if row["state"] != "running":
                    db.execute("UPDATE audio_jobs SET metadata_path=?,metadata_sha256=?,spoken_text_path=?,spoken_text_sha256=?,updated_at=? WHERE id=?",
                               (str(metadata_file), metadata_hash, str(text_file), content_hash, now, row["id"]))
                    row = db.execute("SELECT * FROM audio_jobs WHERE id=?", (row["id"],)).fetchone()
                if existing_media_path and row["state"] == "pending":
                    db.execute("UPDATE audio_jobs SET state='ready',updated_at=?,media_path=?,media_sha256=? WHERE id=? AND state='pending'",
                               (now, str(existing_media_path), existing_hash, row["id"]))
                    row = db.execute("SELECT * FROM audio_jobs WHERE id=?", (row["id"],)).fetchone()
                db.execute("COMMIT")
                return dict(row)
            db.execute("""INSERT INTO audio_jobs
                (id,result_identity,content_sha256,voice_profile_sha256,metadata_path,metadata_sha256,
                 spoken_text_path,spoken_text_sha256,state,created_at,updated_at,media_path,media_sha256)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                       (job_id, result_identity, content_hash, voice_profile_sha256,
                        str(metadata_file), _sha(metadata_raw), str(text_file), _sha(text_raw), state,
                        now, now, str(existing_media_path) if existing_media_path else None, existing_hash))
            db.execute("COMMIT")
            row = db.execute("SELECT * FROM audio_jobs WHERE id=?", (job_id,)).fetchone()
            return dict(row)
        except sqlite3.IntegrityError:
            db.execute("ROLLBACK")
            row = db.execute("SELECT * FROM audio_jobs WHERE result_identity=? AND content_sha256=? AND voice_profile_sha256=?",
                             (result_identity, content_hash, voice_profile_sha256)).fetchone()
            if row:
                return dict(row)
            raise
        finally:
            db.close()
            self._secure_database_artifacts()

    def _recover_expired(self, db, now: float):
        rows = db.execute("SELECT id,attempt_nonce FROM audio_jobs WHERE state='running' AND lease_until<=?", (now,)).fetchall()
        for row in rows:
            attempt = db.execute("SELECT * FROM audio_attempts WHERE job_id=? AND nonce=?", (row["id"], row["attempt_nonce"])).fetchone()
            recovered = None
            duration = None
            if attempt and attempt["provider_receipt_json"] and attempt["media_sha256"]:
                try:
                    receipt = _json_object(attempt["provider_receipt_json"].encode(), "saved provider receipt")
                    _reject_secret_fields(receipt)
                    if receipt.get("status") == "completed" and isinstance(receipt.get("providerReceiptId"), str):
                        candidate = self.media_dir / f"{row['id']}-{row['attempt_nonce']}.mp3"
                        digest, _size = _valid_mp3(candidate, attempt["media_sha256"])
                        recovered = (candidate, digest)
                        duration = receipt.get("durationSeconds")
                except (OSError, AudioJobError, ValueError):
                    recovered = None
            if recovered:
                db.execute("UPDATE audio_jobs SET state='ready',updated_at=?,lease_until=NULL,last_error_code=NULL,media_path=?,media_sha256=?,duration_seconds=? WHERE id=? AND state='running'",
                           (now, str(recovered[0]), recovered[1], duration, row["id"]))
                db.execute("UPDATE audio_attempts SET state='ready',finished_at=?,error_code=NULL WHERE job_id=? AND nonce=?",
                           (now, row["id"], row["attempt_nonce"]))
            else:
                db.execute("UPDATE audio_jobs SET state='uncertain',updated_at=?,lease_until=NULL,last_error_code='lease_expired' WHERE id=? AND state='running'",
                           (now, row["id"]))
                db.execute("UPDATE audio_attempts SET state='uncertain',finished_at=?,error_code='lease_expired' WHERE job_id=? AND nonce=? AND state='started'",
                           (now, row["id"], row["attempt_nonce"]))

    def claim(self, *, lease_seconds: int = 900) -> dict[str, Any] | None:
        if not 10 <= lease_seconds <= 3600:
            raise AudioJobError("lease must be between 10 and 3600 seconds")
        now = time.time()
        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            self._recover_expired(db, now)
            active = db.execute("SELECT 1 FROM audio_jobs WHERE state='running' LIMIT 1").fetchone()
            if active:
                db.execute("COMMIT")
                return None
            row = db.execute("SELECT * FROM audio_jobs WHERE state='pending' ORDER BY created_at,id LIMIT 1").fetchone()
            if not row:
                db.execute("COMMIT")
                return None
            if row["claim_count"] >= MAX_ATTEMPTS:
                db.execute("UPDATE audio_jobs SET state='blocked',updated_at=?,last_error_code='attempt_limit' WHERE id=?", (now, row["id"]))
                db.execute("COMMIT")
                return None
            nonce = secrets.token_hex(24)
            attempt_no = row["claim_count"] + 1
            request_digest = _sha((row["id"] + row["spoken_text_sha256"] + nonce).encode())
            db.execute("UPDATE audio_jobs SET state='running',updated_at=?,claim_count=?,attempt_nonce=?,lease_until=? WHERE id=?",
                       (now, attempt_no, nonce, now + lease_seconds, row["id"]))
            db.execute("INSERT INTO audio_attempts(job_id,attempt_no,nonce,state,started_at,request_sha256) VALUES(?,?,?,'started',?,?)",
                       (row["id"], attempt_no, nonce, now, request_digest))
            db.execute("COMMIT")
            result = dict(row)
            result.update(state="running", claim_count=attempt_no, attempt_nonce=nonce,
                          lease_until=now + lease_seconds, attempt_no=attempt_no)
            return result
        finally:
            db.close()
            self._secure_database_artifacts()

    def run_one(self, helper: HelperConfig, *, lease_seconds: int = 900) -> dict[str, Any] | None:
        job = self.claim(lease_seconds=lease_seconds)
        if not job:
            return None
        try:
            argv = helper.validate()
        except (OSError, AudioJobError):
            return self._finish(job, "blocked", error_code="helper_setup_invalid")
        try:
            metadata_path, metadata_raw = _private_bytes(job["metadata_path"], MAX_METADATA)
            text_path, text_raw = _private_bytes(job["spoken_text_path"], MAX_SPOKEN_TEXT)
            if _sha(metadata_raw) != job["metadata_sha256"] or _sha(text_raw) != job["spoken_text_sha256"]:
                return self._finish(job, "blocked", error_code="input_changed")
            metadata = _json_object(metadata_raw, "result metadata")
            text = text_raw.decode("utf-8")
            output = self.media_dir / f"{job['id']}-{job['attempt_nonce']}.mp3"
            if output.exists() or output.is_symlink():
                return self._finish(job, "uncertain", error_code="output_collision")
            request = {
                "protocol": 1,
                "jobId": job["id"],
                "attempt": job["attempt_no"],
                "attemptNonce": job["attempt_nonce"],
                "resultMetadata": metadata,
                "spokenAdaptation": text,
                "voiceProfileRef": helper.profile_ref,
                "expectedOutputPath": str(output),
            }
            request_raw = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if len(request_raw) > MAX_METADATA + MAX_SPOKEN_TEXT + 64_000:
                return self._finish(job, "blocked", error_code="request_too_large")
            self._update_attempt(job, request_sha256=_sha(request_raw))
        except (OSError, AudioJobError, UnicodeDecodeError):
            return self._finish(job, "blocked", error_code="input_unavailable")

        try:
            return_code, receipt_raw, receipt_overflow, timed_out = _invoke_helper(
                argv, request_raw, helper.timeout_seconds)
        except OSError:
            # Process creation failed, so the provider helper was not started.
            return self._finish(job, "retryable_failure", error_code="helper_not_started")
        if timed_out:
            return self._finish(job, "uncertain", error_code="helper_timeout")

        if receipt_overflow or len(receipt_raw) > MAX_RECEIPT:
            return self._finish(job, "uncertain", error_code="receipt_too_large")
        receipt = None
        try:
            receipt = _json_object(receipt_raw, "provider receipt")
            _reject_secret_fields(receipt)
            receipt_id = receipt.get("providerReceiptId")
            if (set(receipt) - {"status", "providerReceiptId", "durationSeconds"}
                    or receipt.get("status") != "completed"
                    or not isinstance(receipt_id, str)
                    or not re.fullmatch(r"[A-Za-z0-9._:-]{1,200}", receipt_id)):
                raise AudioJobError("invalid provider receipt")
            duration = receipt.get("durationSeconds")
            if duration is not None and (isinstance(duration, bool)
                    or not isinstance(duration, (int, float)) or duration <= 0 or duration > 86_400):
                raise AudioJobError("invalid receipt duration")
            self._update_attempt(job, provider_receipt_json=json.dumps({
                "status": "completed", "providerReceiptId": receipt_id,
                **({"durationSeconds": duration} if duration is not None else {}),
            }, separators=(",", ":")))
        except AudioJobError:
            receipt = None
        if return_code != 0:
            return self._finish(job, "uncertain", error_code="helper_failed_after_start")
        if receipt is None:
            return self._finish(job, "uncertain", error_code="receipt_missing_or_invalid")
        try:
            digest, _size = _valid_mp3(output)
        except (OSError, AudioJobError):
            return self._finish(job, "uncertain", error_code="output_missing_or_invalid")
        self._update_attempt(job, media_sha256=digest)
        return self._finish(job, "ready", media_path=str(output), media_sha256=digest,
                            duration_seconds=float(duration) if duration is not None else None)

    def _update_attempt(self, job, **fields):
        allowed = {"request_sha256", "provider_receipt_json", "media_sha256"}
        if not set(fields) <= allowed:
            raise AudioJobError("unsupported attempt update")
        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            values = ",".join(f"{key}=?" for key in fields)
            db.execute(f"UPDATE audio_attempts SET {values} WHERE job_id=? AND nonce=?", (*fields.values(), job["id"], job["attempt_nonce"]))
            db.execute("COMMIT")
        finally:
            db.close()
            self._secure_database_artifacts()

    def _finish(self, job, state: str, *, error_code: str | None = None,
                media_path: str | None = None, media_sha256: str | None = None,
                duration_seconds: float | None = None) -> dict[str, Any]:
        if state not in STATES - {"pending", "running"}:
            raise AudioJobError("invalid terminal state")
        now = time.time()
        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT state,attempt_nonce FROM audio_jobs WHERE id=?", (job["id"],)).fetchone()
            if not row or row["state"] != "running" or row["attempt_nonce"] != job["attempt_nonce"]:
                db.execute("COMMIT")
                return self.get(job["id"])
            db.execute("UPDATE audio_jobs SET state=?,updated_at=?,lease_until=NULL,last_error_code=?,media_path=?,media_sha256=?,duration_seconds=? WHERE id=?",
                       (state, now, error_code, media_path, media_sha256, duration_seconds, job["id"]))
            db.execute("UPDATE audio_attempts SET state=?,finished_at=?,media_sha256=?,error_code=? WHERE job_id=? AND nonce=?",
                       (state, now, media_sha256, error_code, job["id"], job["attempt_nonce"]))
            db.execute("COMMIT")
        finally:
            db.close()
            self._secure_database_artifacts()
        return self.get(job["id"])

    def get(self, job_id: str) -> dict[str, Any]:
        db = self._connect()
        try:
            row = db.execute("SELECT * FROM audio_jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                raise AudioJobError("audio job not found")
            return dict(row)
        finally:
            db.close()
            self._secure_database_artifacts()

    def resolve(self, job_id: str, *, decision: str, reviewer: str, evidence: str,
                media_path: str | os.PathLike[str] | None = None,
                media_sha256: str | None = None, duration_seconds: float | None = None) -> dict[str, Any]:
        """Record an explicit human review of uncertain/retryable work."""
        if decision not in {"retry", "blocked", "ready"} or not reviewer.strip() or not evidence.strip():
            raise AudioJobError("resolution needs a supported decision, reviewer and evidence")
        if len(reviewer) > 200 or len(evidence) > 4000:
            raise AudioJobError("resolution metadata exceeds its limit")
        verified_media = None
        if decision == "ready":
            if media_path is None or not media_sha256 or not SHA256_RE.fullmatch(media_sha256):
                raise AudioJobError("ready resolution requires reviewed media path and SHA-256")
            verified_media, _size = _valid_mp3(Path(media_path), media_sha256)
            if duration_seconds is not None and (isinstance(duration_seconds, bool)
                    or not isinstance(duration_seconds, (int, float))
                    or duration_seconds <= 0 or duration_seconds > 86_400):
                raise AudioJobError("invalid duration")
        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM audio_jobs WHERE id=?", (job_id,)).fetchone()
            if not row or row["state"] not in {"uncertain", "retryable_failure", "blocked"}:
                raise AudioJobError("only reviewable terminal jobs can be resolved")
            if decision == "retry":
                if row["claim_count"] >= MAX_ATTEMPTS:
                    raise AudioJobError("reviewed retry limit reached")
                new_state, path, digest, duration = "pending", None, None, None
            elif decision == "blocked":
                new_state, path, digest, duration = "blocked", None, None, None
            else:
                new_state, path, digest, duration = "ready", str(verified_media), media_sha256, duration_seconds
            resolution = json.dumps({"decision": decision, "reviewer": reviewer,
                                     "evidence": evidence, "resolvedAt": time.time()}, ensure_ascii=False)
            db.execute("UPDATE audio_jobs SET state=?,updated_at=?,attempt_nonce=NULL,lease_until=NULL,last_error_code=NULL,media_path=?,media_sha256=?,duration_seconds=? WHERE id=?",
                       (new_state, time.time(), path, digest, duration, job_id))
            db.execute("UPDATE audio_attempts SET resolution_json=? WHERE job_id=? AND attempt_no=(SELECT max(attempt_no) FROM audio_attempts WHERE job_id=?)",
                       (resolution, job_id, job_id))
            db.execute("COMMIT")
        except Exception:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise
        finally:
            db.close()
            self._secure_database_artifacts()
        return self.get(job_id)

    def attempts(self, job_id: str) -> list[dict[str, Any]]:
        db = self._connect()
        try:
            return [dict(row) for row in db.execute("SELECT * FROM audio_attempts WHERE job_id=? ORDER BY attempt_no", (job_id,))]
        finally:
            db.close()
            self._secure_database_artifacts()


def _reject_secret_fields(value: Any):
    forbidden = re.compile(r"(secret|token|api.?key|authorization|password|credential)", re.I)
    if isinstance(value, dict):
        for key, child in value.items():
            if forbidden.search(str(key)):
                raise AudioJobError("provider receipt contains a prohibited credential field")
            _reject_secret_fields(child)
    elif isinstance(value, list):
        for child in value:
            _reject_secret_fields(child)


__all__ = ["AudioJobError", "AudioJobStore", "HelperConfig", "MAX_ATTEMPTS", "STATES"]
