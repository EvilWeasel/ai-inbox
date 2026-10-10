#!/usr/bin/env python3
"""Private single-consumer bridge from central Inbox requests to AudioJobStore.

No provider credentials or speech settings are accepted by this worker. Its only
provider path is the preconfigured Cartesia adapter used by audio-jobs.py.
"""
from __future__ import annotations

import fcntl
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import selectors
import sqlite3
import stat
import subprocess
import sys
import time
from typing import Any

MAX_CONFIG = 64 * 1024
MAX_CLI_INPUT = 64 * 1024
MAX_CLI_STDOUT = 4 * 1024 * 1024
MAX_CLI_STDERR = 8 * 1024
MAX_CARTESIA_CONFIG = 64 * 1024
HEX = re.compile(r"^[a-f0-9]{64}$")
REQUEST_ID = HEX
SAFE_ERROR = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class WorkerError(ValueError):
    """A bounded worker contract or local-state error."""


def _load_private_files():
    helper = Path(__file__).with_name("private-files.py")
    spec = importlib.util.spec_from_file_location("central_audio_private_files", helper)
    if not spec or not spec.loader:
        raise WorkerError("private path policy helper unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


private_files = _load_private_files()


def _read_private(path: Path, limit: int) -> bytes:
    checked = private_files.assert_private_file(path)
    with checked.open("rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise WorkerError("private configuration exceeds its size bound")
    return data


def _json_object(data: bytes, message: str) -> dict[str, Any]:
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise WorkerError(message) from exc
    if not isinstance(value, dict):
        raise WorkerError(message)
    return value


def _load_config(path: Path) -> dict[str, Any]:
    config = _json_object(_read_private(path, MAX_CONFIG), "invalid worker configuration")
    required = {"appReleaseLink", "nodeExecutable", "appDataDir", "deployLockPath",
                "stateDir", "mediaDir", "cartesiaAdapterPath", "cartesiaConfigFile",
                "voiceProfileSha256", "voiceProfileRef", "timeoutSeconds"}
    allowed = required | {"batchLimit"}
    if set(config) - allowed or not required <= set(config):
        raise WorkerError("worker configuration fields do not match the contract")
    for key in ("appReleaseLink", "nodeExecutable", "appDataDir", "deployLockPath",
                "stateDir", "mediaDir", "cartesiaAdapterPath", "cartesiaConfigFile"):
        if not isinstance(config[key], str) or not config[key] or not Path(config[key]).is_absolute():
            raise WorkerError("worker path configuration is invalid")
        config[key] = Path(config[key])
    if not HEX.fullmatch(config["voiceProfileSha256"]):
        raise WorkerError("voice profile identity is invalid")
    ref = config["voiceProfileRef"]
    if (not isinstance(ref, str) or not ref or len(ref) > 200
            or any(ord(char) < 0x21 or ord(char) > 0x7e for char in ref)
            or ref.lower().startswith(("pass://", "cartesia://"))):
        raise WorkerError("voice profile reference is invalid")
    timeout = config["timeoutSeconds"]
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 30 <= timeout <= 1800:
        raise WorkerError("worker timeout is invalid")
    batch = config.get("batchLimit", 10)
    if isinstance(batch, bool) or not isinstance(batch, int) or not 1 <= batch <= 10:
        raise WorkerError("worker batch limit is invalid")
    config["batchLimit"] = batch
    for key in ("nodeExecutable", "cartesiaAdapterPath"):
        checked = private_files.assert_regular_file_no_reparse(config[key])
        if os.name != "nt" and key == "nodeExecutable" and not os.access(checked, os.X_OK):
            raise WorkerError("Node executable is not executable")
    for key in ("appDataDir", "stateDir", "mediaDir"):
        config[key] = private_files.assert_private_directory(config[key])
    dirs = [config[key].resolve(strict=True) for key in ("appDataDir", "stateDir", "mediaDir")]
    for index, left in enumerate(dirs):
        for right in dirs[index + 1:]:
            if left == right or left in right.parents or right in left.parents:
                raise WorkerError("application, ledger and media directories must be disjoint")
    private_files.assert_private_file(config["cartesiaConfigFile"])
    private_files.assert_private_file(config["deployLockPath"])
    link_info = config["appReleaseLink"].lstat()
    if not stat.S_ISLNK(link_info.st_mode) or (os.name != "nt" and link_info.st_uid != os.geteuid()):
        raise WorkerError("current release selector must be a symlink")
    worker_lock = config["stateDir"] / "worker.lock"
    if worker_lock.exists() or worker_lock.is_symlink():
        private_files.assert_regular_file_no_reparse(worker_lock)
    adapter_timeout = _preflight_cartesia(config)
    if timeout < adapter_timeout + 60:
        raise WorkerError("worker timeout leaves insufficient adapter cleanup margin")
    return config


def _preflight_cartesia(config: dict[str, Any]) -> int:
    """Check only bounded, private, non-secret adapter settings; never resolve credentials."""
    adapter = _json_object(_read_private(config["cartesiaConfigFile"], MAX_CARTESIA_CONFIG),
                           "Cartesia adapter configuration is invalid")
    needed = {"speakHelperPath", "pythonExecutable", "mediaDir", "profileRef", "voiceProfile"}
    if not needed <= set(adapter) or set(adapter) - (needed | {"timeoutSeconds"}):
        raise WorkerError("Cartesia adapter configuration fields are invalid")
    for key in ("speakHelperPath", "pythonExecutable", "mediaDir", "profileRef"):
        if not isinstance(adapter[key], str) or not adapter[key]:
            raise WorkerError("Cartesia adapter configuration value is invalid")
    speak_helper = Path(adapter["speakHelperPath"])
    python = Path(adapter["pythonExecutable"])
    media = Path(adapter["mediaDir"])
    if not speak_helper.is_absolute() or not python.is_absolute() or not media.is_absolute():
        raise WorkerError("Cartesia adapter paths must be absolute")
    private_files.assert_regular_file_no_reparse(speak_helper)
    private_files.assert_regular_file_no_reparse(python)
    if os.name != "nt" and not os.access(python, os.X_OK):
        raise WorkerError("Cartesia Python executable is not executable")
    private_files.assert_private_directory(media)
    if (adapter["profileRef"] != config["voiceProfileRef"]
            or Path(adapter["mediaDir"]) != config["mediaDir"]):
        raise WorkerError("Cartesia adapter profile or media directory does not match")
    voice = adapter["voiceProfile"]
    fields = {"voiceId", "modelId", "language", "emotion"}
    if (not isinstance(voice, dict) or set(voice) != fields
            or any(not isinstance(voice[field], str) or not voice[field] for field in fields)
            or voice["emotion"] != "calm"):
        raise WorkerError("Cartesia voice profile is invalid")
    timeout = adapter.get("timeoutSeconds", 240)
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 30 <= timeout <= 1740:
        raise WorkerError("Cartesia timeout is invalid")
    return timeout


class _FileLock:
    def __init__(self, path: Path, *, blocking: bool):
        self.path, self.blocking, self.fd = path, blocking, None

    def __enter__(self):
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
        self.fd = os.open(self.path, flags, 0o600)
        info = os.fstat(self.fd)
        if not stat.S_ISREG(info.st_mode) or (os.name != "nt" and info.st_uid != os.geteuid()):
            os.close(self.fd)
            self.fd = None
            raise WorkerError("lock file violates private ownership policy")
        private_files.assert_regular_file_no_reparse(self.path)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | (0 if self.blocking else fcntl.LOCK_NB))
        except Exception:
            os.close(self.fd)
            self.fd = None
            raise
        return self

    def __exit__(self, *_):
        if self.fd is not None:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None


def _resolve_release(config: dict[str, Any]) -> Path:
    """Resolve the single permitted current symlink while deployment is excluded."""
    link = config["appReleaseLink"]
    deployment_root = link.parent
    private_files.assert_directory_no_reparse(deployment_root)
    if not link.is_symlink():
        raise WorkerError("current release selector changed")
    raw_target = os.readlink(link)
    candidate = (link.parent / raw_target) if not Path(raw_target).is_absolute() else Path(raw_target)
    candidate = Path(os.path.abspath(candidate))
    try:
        candidate.relative_to(deployment_root)
    except ValueError as exc:
        raise WorkerError("current release target is outside deployment root") from exc
    # The symlink at current is the sole permitted reparse point.
    private_files.assert_directory_no_reparse(candidate)
    resolved = candidate.resolve(strict=True)
    if resolved != candidate or resolved.parent != deployment_root.resolve(strict=True):
        raise WorkerError("current release target is not a direct immutable release")
    for component in [deployment_root, resolved]:
        if component.is_symlink():
            raise WorkerError("release path contains an unexpected symlink")
    return resolved


def _bounded_child(argv: list[str], request: bytes, *, timeout: int, env: dict[str, str],
                   stdout_limit: int, stderr_limit: int) -> tuple[int, bytes, bytes]:
    process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, shell=False, env=env,
                               cwd=str(Path(argv[-1]).parent) if argv else None)
    assert process.stdin and process.stdout and process.stderr
    process.stdin.write(request)
    process.stdin.close()
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
            for key, _ in selector.select(min(remaining, .2)):
                chunk = os.read(key.fd, 4096)
                if not chunk:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                buf, limit = buffers[key.fileobj], limits[key.fileobj]
                if len(buf) < limit + 1:
                    buf.extend(chunk[:limit + 1 - len(buf)])
                if len(buf) > limit:
                    process.kill()
                    raise WorkerError("child output exceeded its bound")
        code = process.wait(timeout=max(.1, deadline - time.monotonic()))
        return code, bytes(buffers[process.stdout]), bytes(buffers[process.stderr])
    except (subprocess.TimeoutExpired, WorkerError):
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


class CentralAudioWorker:
    def __init__(self, config: dict[str, Any], *, store_module=None):
        self.config = config
        if store_module is None:
            script = Path(__file__).with_name("audio-jobs.py")
            spec = importlib.util.spec_from_file_location("central_audio_jobs", script)
            if not spec or not spec.loader:
                raise WorkerError("audio job store is unavailable")
            store_module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = store_module
            spec.loader.exec_module(store_module)
        self.jobs = store_module.AudioJobStore(config["stateDir"] / "jobs.sqlite", config["mediaDir"])
        self._valid_media = store_module._valid_mp3
        self.HelperConfig = store_module.HelperConfig
        self.helper = self.HelperConfig(argv_prefix=(str(Path(sys.executable).resolve(strict=True)),),
                                        helper_path=config["cartesiaAdapterPath"],
                                        profile_ref=config["voiceProfileRef"],
                                        timeout_seconds=config["timeoutSeconds"])

    def _cli(self, operation: dict[str, Any]) -> dict[str, Any]:
        raw = json.dumps(operation, ensure_ascii=False, separators=(",", ":")).encode()
        if len(raw) > MAX_CLI_INPUT:
            raise WorkerError("central CLI request exceeds its bound")
        with _FileLock(self.config["deployLockPath"], blocking=True):
            release = _resolve_release(self.config)
            cli = release / "scripts" / "central-audio.ts"
            tsx = release / "node_modules" / "tsx" / "dist" / "cli.mjs"
            for path in (cli, tsx):
                private_files.assert_regular_file_no_reparse(path)
            env = os.environ.copy()
            env["INBOX_DATA_DIR"] = str(self.config["appDataDir"])
            env["INBOX_AUDIO_WORKER_MEDIA_DIR"] = str(self.config["mediaDir"])
            argv = [str(self.config["nodeExecutable"]), str(tsx), str(cli)]
            code, stdout, _stderr = _bounded_child(argv, raw, timeout=60, env=env,
                                                    stdout_limit=MAX_CLI_STDOUT,
                                                    stderr_limit=MAX_CLI_STDERR)
        if code:
            raise WorkerError("central CLI operation failed")
        response = _json_object(stdout, "central CLI response is invalid")
        return response

    def _list(self) -> list[dict[str, Any]]:
        result = self._cli({"op": "list", "limit": self.config["batchLimit"]})
        rows = result.get("requests")
        if not isinstance(rows, list) or len(rows) > self.config["batchLimit"]:
            raise WorkerError("central CLI request list is invalid")
        valid_rows = []
        for row in rows:
            required = {"id", "producer_id", "delivery_id", "item_id", "body_sha256",
                        "spoken_sha256", "voice_profile_sha256", "spoken_text", "state",
                        "ledger_job_id", "title", "external_id", "item_body_sha256"}
            valid = isinstance(row, dict) and required <= row.keys()
            if valid:
                valid = (REQUEST_ID.fullmatch(str(row["id"])) is not None
                         and row["state"] in {"queued", "generating"}
                         and HEX.fullmatch(str(row["body_sha256"])) is not None
                         and HEX.fullmatch(str(row["spoken_sha256"])) is not None
                         and HEX.fullmatch(str(row["item_body_sha256"])) is not None
                         and all(isinstance(row[field], str) and row[field]
                                 for field in ("producer_id", "delivery_id", "item_id", "title", "external_id"))
                         and row["external_id"] == f"producer:{row['producer_id']}:delivery:{row['delivery_id']}"
                         and isinstance(row["spoken_text"], str)
                         and hashlib.sha256(row["spoken_text"].encode("utf-8")).hexdigest() == row["spoken_sha256"]
                         and row["voice_profile_sha256"] == self.config["voiceProfileSha256"])
            if not valid:
                if (isinstance(row, dict) and REQUEST_ID.fullmatch(str(row.get("id", "")))
                        and row.get("state") in {"queued", "generating"}
                        and HEX.fullmatch(str(row.get("body_sha256", "")))):
                    self._resolve(row, "needs_review", "invalid_backend_request")
                continue
            valid_rows.append(row)
        return valid_rows

    def _lookup(self, request_id: str) -> dict[str, Any] | None:
        result = self._cli({"op": "lookup", "requestId": request_id})
        row = result.get("request")
        if row is not None and not isinstance(row, dict):
            raise WorkerError("central CLI lookup response is invalid")
        return row

    def _resolve(self, row: dict[str, Any], state: str, code: str | None) -> None:
        self._cli({"op": "resolve", "requestId": row["id"],
                   "expectedState": row["state"], "expectedBodySha256": row["body_sha256"],
                   "state": state, "safeErrorCode": code})

    def _obsolete_pending(self, ledger_id: str) -> bool:
        """Block only a never-claimed central ledger row whose backend is terminal/missing."""
        db = self.jobs._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM audio_jobs WHERE id=?", (ledger_id,)).fetchone()
            if not row or row["state"] != "pending" or row["claim_count"] != 0 or row["attempt_nonce"] is not None:
                db.execute("ROLLBACK")
                return False
            started = db.execute("SELECT 1 FROM audio_attempts WHERE job_id=? AND state='started' LIMIT 1",
                                 (ledger_id,)).fetchone()
            if started:
                db.execute("ROLLBACK")
                return False
            db.execute("UPDATE audio_jobs SET state='blocked',updated_at=?,last_error_code='backend_request_obsolete' WHERE id=? AND state='pending' AND claim_count=0",
                       (time.time(), ledger_id))
            db.execute("COMMIT")
            return True
        except Exception:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise
        finally:
            db.close()
            self.jobs._secure_database_artifacts()

    def _reconcile_pending_backlog(self, row_by_request: dict[str, dict[str, Any]]) -> None:
        db = self.jobs._connect()
        try:
            pending = db.execute("SELECT id,result_identity FROM audio_jobs WHERE state='pending' ORDER BY created_at,id LIMIT 100").fetchall()
        finally:
            db.close()
            self.jobs._secure_database_artifacts()
        for job in pending:
            match = re.fullmatch(r"central:([a-f0-9]{64})", job["result_identity"])
            if not match:
                continue
            request_id = match.group(1)
            backend = self._lookup(request_id)  # Fail closed on backend failure.
            if backend and backend.get("state") in {"queued", "generating"}:
                row_by_request[request_id] = backend
            elif backend is None or backend.get("state") in {"ready", "needs_review", "superseded"}:
                self._obsolete_pending(job["id"])

    def _ledger_job(self, request_id: str) -> dict[str, Any] | None:
        db = self.jobs._connect()
        try:
            row = db.execute("SELECT * FROM audio_jobs WHERE result_identity=? AND voice_profile_sha256=?",
                             ("central:" + request_id, self.config["voiceProfileSha256"])).fetchone()
            return dict(row) if row else None
        finally:
            db.close()
            self.jobs._secure_database_artifacts()

    def _private_inputs(self, row: dict[str, Any]) -> tuple[Path, Path]:
        identity = "central:" + row["id"]
        metadata_path = self.config["stateDir"] / (row["id"] + ".json")
        text_path = self.config["stateDir"] / (row["id"] + ".txt")
        metadata = {"phase": "final", "title": row["title"], "deliveryId": row["delivery_id"],
                    "bodySha256": row["body_sha256"]}
        for path, content in ((metadata_path, json.dumps(metadata, ensure_ascii=False,
                                                          separators=(",", ":")).encode()),
                              (text_path, row["spoken_text"].encode("utf-8"))):
            if path.exists() or path.is_symlink():
                private_files.assert_private_file(path)
                if path.read_bytes() != content:
                    raise WorkerError("durable audio input differs from its request")
            else:
                private_files.create_private_file(path, content)
        del identity
        if hashlib.sha256(text_path.read_bytes()).hexdigest() != row["spoken_sha256"]:
            raise WorkerError("spoken adaptation hash changed")
        return metadata_path, text_path

    def _ensure_binding(self, row: dict[str, Any]) -> str:
        job = self._ledger_job(row["id"])
        metadata, text = self._private_inputs(row)
        queued = self.jobs.enqueue(result_identity="central:" + row["id"], metadata_path=metadata,
                                    spoken_text_path=text,
                                    voice_profile_sha256=self.config["voiceProfileSha256"], meaningful=True)
        if job and queued["id"] != job["id"]:
            raise WorkerError("deterministic ledger job identity conflict")
        if (queued["content_sha256"] != row["spoken_sha256"]
                or queued["voice_profile_sha256"] != row["voice_profile_sha256"]):
            raise WorkerError("ledger job does not match central request hashes")
        ledger_id = queued["id"]
        if row["ledger_job_id"] and row["ledger_job_id"] != ledger_id:
            raise WorkerError("central request has a different ledger binding")
        # Persist the binding before any paid helper can start. If this reply is
        # lost, the deterministic store identity recovers the same job on retry.
        self._cli({"op": "update", "requestId": row["id"], "ledgerJobId": ledger_id,
                   "state": "generating", "safeErrorCode": None})
        return ledger_id

    def _mark_review(self, row: dict[str, Any], ledger_id: str, code: str) -> None:
        if not SAFE_ERROR.fullmatch(code):
            code = "audio_review_required"
        self._cli({"op": "update", "requestId": row["id"], "ledgerJobId": ledger_id,
                   "state": "needs_review", "safeErrorCode": code})

    def _attach(self, row: dict[str, Any], job: dict[str, Any]) -> None:
        if job["state"] != "ready" or not job.get("media_path") or not HEX.fullmatch(job.get("media_sha256") or ""):
            return
        duration = job.get("duration_seconds")
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= 86400:
            raise WorkerError("ready ledger media duration is invalid")
        media = Path(job["media_path"])
        digest, _size = self._valid_media(media, job["media_sha256"])
        row_job = row["ledger_job_id"] or job["id"]
        self._cli({"op": "attach", "requestId": row["id"], "ledgerJobId": row_job,
                   "bodySha256": row["body_sha256"], "source": str(media),
                   "mediaSha256": digest, "duration": float(duration)})

    def run_pass(self) -> dict[str, int]:
        cartesia_timeout = _preflight_cartesia(self.config)
        # The worker's outer helper deadline must outlive the adapter's own
        # deadline so it can observe completion and run private cleanup.
        if self.config["timeoutSeconds"] < cartesia_timeout + 60:
            raise WorkerError("worker timeout leaves insufficient adapter cleanup margin")
        self.helper = self.HelperConfig(argv_prefix=(str(Path(sys.executable).resolve(strict=True)),),
                                        helper_path=self.config["cartesiaAdapterPath"],
                                        profile_ref=self.config["voiceProfileRef"],
                                        timeout_seconds=self.config["timeoutSeconds"])
        lease = self.config["timeoutSeconds"] + 60
        counts = {"attached": 0, "attempted": 0, "review": 0}
        rows = self._list()
        row_by_request = {row["id"]: row for row in rows}
        self._reconcile_pending_backlog(row_by_request)
        rows = list(row_by_request.values())
        bindings: dict[str, str] = {}
        reconciled: set[str] = set()

        # Run the store's existing crash recovery before we enqueue any newly
        # listed request. It converts expired jobs to ready (saved receipt) or
        # uncertain (no receipt); it never claims a new job.
        db = self.jobs._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            self.jobs._recover_expired(db, time.time())
            db.execute("COMMIT")
        finally:
            db.close()
            self.jobs._secure_database_artifacts()

        # Reconcile backend-generating work and any saved ready receipt before
        # adding a new claim. This makes an older receipt immune to queue churn.
        for row in sorted(rows, key=lambda item: (item["state"] != "generating", item["id"])):
            ledger = self._ledger_job(row["id"])
            if ledger is None and row["ledger_job_id"]:
                raise WorkerError("central ledger binding has no deterministic job")
            if ledger:
                if row["ledger_job_id"] and row["ledger_job_id"] != ledger["id"]:
                    raise WorkerError("central ledger binding does not match deterministic job")
                if ledger["state"] in {"uncertain", "retryable_failure", "blocked"}:
                    self._mark_review(row, ledger["id"], ledger.get("last_error_code") or "audio_review_required")
                    counts["review"] += 1
                    reconciled.add(row["id"])
                    continue
                if row["state"] == "queued" or not row["ledger_job_id"]:
                    self._cli({"op": "update", "requestId": row["id"], "ledgerJobId": ledger["id"],
                               "state": "generating", "safeErrorCode": None})
                bindings[row["id"]] = ledger["id"]
                if ledger["state"] == "ready":
                    self._attach(row, ledger)
                    counts["attached"] += 1
                    reconciled.add(row["id"])

        for row in rows:
            if row["id"] in bindings or row["id"] in reconciled:
                continue
            if row["state"] in {"queued", "generating"} and row["voice_profile_sha256"] == self.config["voiceProfileSha256"]:
                if row["item_body_sha256"] != row["body_sha256"]:
                    self._resolve(row, "superseded", None)
                    reconciled.add(row["id"])
                    continue
                ledger_id = self._ensure_binding(row)
                bindings[row["id"]] = ledger_id

        # A prior ready attachment may have committed while its CLI reply was
        # lost. Reattaching the same request/job is idempotent and cannot render.
        for request_id, ledger_id in list(bindings.items()):
            row = row_by_request[request_id]
            ledger = self.jobs.get(ledger_id)
            if row["item_body_sha256"] != row["body_sha256"]:
                self._mark_review(row, ledger_id, "result_revision_changed")
                counts["review"] += 1
                bindings.pop(request_id, None)
                continue
            if ledger["state"] == "ready":
                self._attach(row, ledger)
                counts["attached"] += 1
                bindings.pop(request_id, None)
        if not bindings:
            return counts

        # AudioJobStore.run_one claims its globally oldest pending row. Inspect
        # that exact candidate first and proceed only when it maps to this pass.
        db = self.jobs._connect()
        try:
            active = db.execute("SELECT 1 FROM audio_jobs WHERE state='running' LIMIT 1").fetchone()
            candidate = db.execute("SELECT * FROM audio_jobs WHERE state='pending' ORDER BY created_at,id LIMIT 1").fetchone()
            candidate = dict(candidate) if candidate else None
        finally:
            db.close()
            self.jobs._secure_database_artifacts()
        if active or not candidate:
            return counts
        match = next((request_id for request_id, ledger_id in bindings.items()
                      if ledger_id == candidate["id"] and candidate["result_identity"] == "central:" + request_id), None)
        if match is None:
            return counts
        # Re-read this exact request at the last safe point before the paid
        # claim. The list used above may be stale because the original upload
        # or a new written revision can arrive during queue preparation.
        current = self._lookup(match)
        if (not current or current.get("state") not in {"queued", "generating"}
                or current.get("item_body_sha256") != current.get("body_sha256")
                or current.get("item_has_audio") is True):
            self._obsolete_pending(candidate["id"])
            return counts
        config_env = "CARTESIA_JOB_CONFIG_FILE"
        previous_config = os.environ.get(config_env)
        os.environ[config_env] = str(self.config["cartesiaConfigFile"])
        try:
            result = self.jobs.run_one(self.helper, lease_seconds=lease)
        finally:
            if previous_config is None:
                os.environ.pop(config_env, None)
            else:
                os.environ[config_env] = previous_config
        counts["attempted"] = 1
        if not result or result["id"] != candidate["id"]:
            # Never attribute a global claim by assumption; the durable state
            # remains available for deterministic reconciliation next pass.
            return counts
        row = row_by_request[match]
        ledger = self.jobs.get(result["id"])
        if ledger["state"] == "ready":
            self._attach(row, ledger)
            counts["attached"] += 1
        else:
            self._mark_review(row, result["id"], result.get("last_error_code") or "audio_review_required")
            counts["review"] += 1
        return counts

    def run(self) -> dict[str, int]:
        lock = self.config["stateDir"] / "worker.lock"
        private_files.ensure_private_directory(self.config["stateDir"])
        with _FileLock(lock, blocking=False):
            return self.run_pass()


def main(argv: list[str] | None = None) -> int:
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config-file", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        config = _load_config(args.config_file)
        summary = CentralAudioWorker(config).run()
        sys.stdout.write(json.dumps(summary, separators=(",", ":")) + "\n")
        return 0
    except Exception:
        # Diagnostics intentionally omit exception text, paths, data and stderr.
        sys.stderr.write("central-audio-worker: failed; no private details emitted\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
