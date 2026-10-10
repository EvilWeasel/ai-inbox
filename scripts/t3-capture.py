#!/usr/bin/env python3
"""Capture future T3 root completions for private review; never publishes."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sqlite3
import sys

_PRIVATE_FILES_SPEC = importlib.util.spec_from_file_location(
    "ai_inbox_private_files_capture", Path(__file__).with_name("private-files.py"))
if _PRIVATE_FILES_SPEC is None or _PRIVATE_FILES_SPEC.loader is None:
    raise RuntimeError("private file policy helper is unavailable")
private_files = importlib.util.module_from_spec(_PRIVATE_FILES_SPEC)
_PRIVATE_FILES_SPEC.loader.exec_module(private_files)

MAX_CONFIG = 64 * 1024
MAX_FINAL_TEXT = 1_000_000
MAX_RECEIPT = 256 * 1024
MAX_CAPTURE_FILE = MAX_FINAL_TEXT + MAX_RECEIPT
DEFAULT_BATCH = 100
MAX_BATCH = 500
MAX_RETRY_BATCH = 50
MAX_RETRY_DELAY_SECONDS = 6 * 60 * 60


class CaptureError(ValueError):
    pass


def private_file(value: str | Path, label: str = "private file") -> Path:
    try:
        return private_files.assert_private_file(value)
    except private_files.PrivateFileError as exc:
        raise CaptureError(f"{label} must be a regular private file") from exc


def secure_dir(value: str | Path) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise CaptureError("captureDir must be an absolute path")
    try:
        return private_files.ensure_private_directory(path)
    except private_files.PrivateFileError as exc:
        raise CaptureError("captureDir must be a private directory") from exc


def check_no_symlinks(path: Path) -> None:
    try:
        private_files._check_no_reparse_components(path)
    except private_files.PrivateFileError as exc:
        raise CaptureError("reparse-point paths are not allowed") from exc


def load_config(path: str | Path) -> dict:
    source = private_file(path, "capture config")
    if source.stat().st_size > MAX_CONFIG:
        raise CaptureError("capture config exceeds the size limit")
    try:
        config = json.loads(source.read_text(encoding="utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise CaptureError("invalid capture config") from exc
    if not isinstance(config, dict) or not {"t3DatabaseFile", "bridgeConfigFile", "captureDir"}.issubset(config):
        raise CaptureError("capture config is missing required fields")
    database = Path(config["t3DatabaseFile"]).expanduser()
    if not database.is_absolute():
        raise CaptureError("t3DatabaseFile must be absolute")
    try:
        private_files.assert_regular_file_no_reparse(database)
    except private_files.PrivateFileError as exc:
        raise CaptureError("t3DatabaseFile must be a regular file without reparse points") from exc
    config["t3DatabaseFile"] = str(database)
    config["bridgeConfigFile"] = str(private_file(config["bridgeConfigFile"], "bridge config"))
    config["captureDir"] = str(secure_dir(config["captureDir"]))
    return config


def connect_capture(config: dict) -> sqlite3.Connection:
    path = Path(config["captureDir"]) / "capture.sqlite3"
    try:
        private_files.ensure_private_sqlite_database(path)
    except private_files.PrivateFileError as exc:
        raise CaptureError("capture database must be a regular private file") from exc
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    private_files.secure_sqlite_artifacts(path)
    db.execute("PRAGMA synchronous=FULL")
    db.execute("""CREATE TABLE IF NOT EXISTS capture_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), activation_epoch TEXT NOT NULL,
        scan_after_run_id TEXT NOT NULL DEFAULT '', schema_version INTEGER NOT NULL
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS candidates (
        candidate_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT NOT NULL,
        completed_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('observed','staged','excluded','needs_review')),
        reason TEXT NOT NULL, receipt_json TEXT, text_file TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, retry_attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT, diagnostic_class TEXT, UNIQUE(thread_id,run_id)
    )""")
    candidate_columns = {row[1] for row in db.execute("PRAGMA table_info(candidates)")}
    for name, declaration in (("retry_attempts", "INTEGER NOT NULL DEFAULT 0"),
                              ("next_attempt_at", "TEXT"), ("diagnostic_class", "TEXT")):
        if name not in candidate_columns:
            db.execute(f"ALTER TABLE candidates ADD COLUMN {name} {declaration}")
    db.execute("CREATE INDEX IF NOT EXISTS candidates_status ON candidates(status,completed_at)")
    private_files.secure_sqlite_artifacts(path)
    return db


def secure_capture_artifacts(config: dict) -> None:
    private_files.secure_sqlite_artifacts(Path(config["captureDir"]) / "capture.sqlite3")


def metadata_connection(path: str | Path) -> sqlite3.Connection:
    source = Path(path).expanduser()
    try:
        private_files.assert_regular_file_no_reparse(source)
    except private_files.PrivateFileError as exc:
        raise CaptureError("T3 metadata database path is not a regular local file") from exc
    uri = source.resolve(strict=True).as_uri() + "?mode=ro"
    db = sqlite3.connect(uri, uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    required = {
        "orchestration_v2_projection_threads": {"thread_id", "project_id", "title", "default_provider", "runtime_mode", "interaction_mode", "active_provider_thread_id", "created_at", "updated_at", "archived_at", "deleted_at", "payload_json", "provider_instance_id"},
        "orchestration_v2_projection_runs": {"run_id", "thread_id", "ordinal", "status", "requested_at", "completed_at", "payload_json", "provider", "provider_thread_id", "provider_instance_id"},
        "orchestration_v2_projection_subagents": {"child_thread_id", "subagent_id", "thread_id", "run_id", "parent_node_id", "provider", "provider_thread_id", "origin", "status", "started_at", "completed_at", "updated_at", "payload_json", "driver", "provider_instance_id"},
    }
    for table, columns in required.items():
        actual = {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}
        if not columns.issubset(actual):
            db.close()
            raise CaptureError("local T3 completion metadata schema is unavailable or unsupported")
    return db


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def parse_time(value: str) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def init(config: dict) -> dict:
    db = connect_capture(config)
    try:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT activation_epoch FROM capture_state WHERE singleton=1").fetchone()
        if row:
            db.commit()
            return {"initialized": False, "activationEpoch": row["activation_epoch"]}
        epoch = utc_now()
        db.execute("INSERT INTO capture_state(singleton,activation_epoch,scan_after_run_id,schema_version) VALUES(1,?,'',1)", (epoch,))
        db.commit()
        return {"initialized": True, "activationEpoch": epoch}
    except Exception:
        db.rollback()
        raise
    finally:
        secure_capture_artifacts(config)
        db.close()


def bridge_module():
    script = Path(__file__).with_name("t3-results.py")
    spec = importlib.util.spec_from_file_location("ai_inbox_t3_results_capture", script)
    if spec is None or spec.loader is None:
        raise CaptureError("T3 bridge module is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def staged_receipt(bridge_config: dict, thread_id: str, run_id: str) -> dict | None:
    root = Path(bridge_config["outboxDir"]).expanduser()
    if not root.is_absolute():
        raise CaptureError("bridge outbox path is invalid")
    if not root.exists() and not root.is_symlink():
        return None
    try:
        private_files.assert_private_directory(root)
    except private_files.PrivateFileError as exc:
        raise CaptureError("bridge outbox is not a private directory") from exc
    db_path = root / "outbox.sqlite3"
    if not db_path.exists():
        return None
    try:
        private_files.assert_private_file(db_path)
    except private_files.PrivateFileError as exc:
        raise CaptureError("outbox receipt store is unavailable") from exc
    private_files.secure_sqlite_artifacts(db_path)
    uri = db_path.resolve(strict=True).as_uri() + "?mode=ro"
    db = sqlite3.connect(uri, uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    try:
        tables = {r["name"] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "deliveries" not in tables:
            raise CaptureError("outbox receipt store has an unsupported schema")
        row = db.execute("SELECT delivery_id,state,receipt_json FROM deliveries WHERE thread_id=? AND run_id=? ORDER BY created_at DESC LIMIT 1",
                         (thread_id, run_id)).fetchone()
        if not row:
            return None
        receipt = None
        if row["receipt_json"]:
            if len(row["receipt_json"].encode("utf-8")) > MAX_RECEIPT:
                receipt = {"receiptAvailable": True}
            else:
                try:
                    receipt = json.loads(row["receipt_json"])
                except json.JSONDecodeError:
                    receipt = {"receiptAvailable": True}
        return {"deliveryId": row["delivery_id"], "state": row["state"], "receipt": receipt}
    finally:
        db.close()


def candidate_id(thread_id: str, run_id: str) -> str:
    return hashlib.sha256((thread_id + "\0" + run_id).encode()).hexdigest()


def atomic_private(path: Path, content: bytes) -> None:
    if len(content) > MAX_CAPTURE_FILE:
        raise CaptureError("candidate receipt exceeds the size limit")
    try:
        private_files.atomic_write_private(path, content)
    except private_files.PrivateFileError as exc:
        raise CaptureError("private candidate write failed") from exc


def source_refs(message: dict, final_text: str) -> list[dict | str]:
    refs = []
    for key in ("sources", "sourceRefs", "citations"):
        value = message.get(key)
        if isinstance(value, list):
            refs.extend(item for item in value if isinstance(item, (str, dict)))
    for url in re.findall(r"https?://[^\s)\]>]+", final_text):
        if all(not (isinstance(ref, str) and ref == url) for ref in refs):
            refs.append(url)
    return refs[:500]


def save_candidate(db: sqlite3.Connection, config: dict, item: dict) -> None:
    now = utc_now()
    cid = candidate_id(item["threadId"], item["runId"])
    text_file = None
    if isinstance(item.get("text"), str):
        text_file = str(Path(config["captureDir"]) / (cid + ".json"))
        payload = {"candidateId": cid, "threadId": item["threadId"], "runId": item["runId"],
                   "completedAt": item["completedAt"], "text": item["text"], "sourceRefs": item.get("sourceRefs", [])}
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_CAPTURE_FILE:
            item = {**item, "status": "needs_review", "reason": "final capture exceeds configured text limit"}
            text_file = None
        else:
            atomic_private(Path(text_file), encoded)
    receipt_json = json.dumps(item.get("receipt"), ensure_ascii=False, separators=(",", ":")) if item.get("receipt") is not None else None
    if receipt_json and len(receipt_json.encode("utf-8")) > MAX_RECEIPT:
        receipt_json = json.dumps({"receiptAvailable": True}, separators=(",", ":"))
    existing = db.execute("SELECT candidate_id,text_file,status,receipt_json FROM candidates WHERE thread_id=? AND run_id=?",
                          (item["threadId"], item["runId"])).fetchone()
    if existing:
        # A later authored stage takes precedence over an earlier projection capture.
        if item.get("status") == "staged":
            db.execute("UPDATE candidates SET candidate_id=?,completed_at=?,status='staged',reason=?,receipt_json=?,text_file=NULL,updated_at=?,next_attempt_at=NULL,diagnostic_class=NULL WHERE thread_id=? AND run_id=?",
                       (cid, item["completedAt"], item["reason"], receipt_json, now, item["threadId"], item["runId"]))
            if existing["text_file"]:
                expected_text = Path(config["captureDir"]) / (cid + ".json")
                stored_text = Path(existing["text_file"])
                if stored_text != expected_text:
                    raise CaptureError("stored candidate path does not match its private identity")
                if stored_text.exists() or stored_text.is_symlink():
                    try:
                        private_files.assert_private_file(stored_text)
                    except private_files.PrivateFileError as exc:
                        raise CaptureError("stored candidate file is not private") from exc
                    stored_text.unlink()
        elif existing["text_file"] is None and text_file is not None:
            db.execute("UPDATE candidates SET text_file=?,status=?,reason=?,updated_at=?,next_attempt_at=NULL,diagnostic_class=NULL WHERE thread_id=? AND run_id=?",
                       (text_file, item["status"], item["reason"], now, item["threadId"], item["runId"]))
        return
    db.execute("""INSERT INTO candidates(candidate_id,thread_id,run_id,completed_at,status,reason,receipt_json,text_file,created_at,updated_at,retry_attempts,next_attempt_at,diagnostic_class)
                  VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?)""",
               (cid, item["threadId"], item["runId"], item["completedAt"], item["status"], item["reason"], receipt_json, text_file, now, now,
                item.get("nextAttemptAt"), item.get("diagnosticClass")))


def retry_time(attempts: int, now: str) -> str:
    delay = min(60 * (2 ** min(max(attempts - 1, 0), 16)), MAX_RETRY_DELAY_SECONDS)
    target = datetime.fromisoformat(now.replace("Z", "+00:00")).timestamp() + delay
    return datetime.fromtimestamp(target, timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def classify_gate(reason: str) -> tuple[str, bool]:
    hard = ("identity mismatch", "unknown", "unsupported", "ambiguous", "invalid")
    if any(word in reason.lower() for word in hard):
        return "unsupported_or_source_mismatch", False
    return "incomplete_completion_gate", True


def fetch_decision(bridge, bridge_config: dict, row: dict) -> dict:
    base = {"threadId": row["thread_id"], "runId": row["run_id"], "completedAt": row["completed_at"]}
    try:
        snapshot = bridge.fetch_snapshot(bridge_config, row["thread_id"])
        projection = snapshot["projection"]
        if bridge.projection_thread_id(projection) != row["thread_id"]:
            return {**base, "status": "needs_review", "reason": "snapshot identity mismatch",
                    "diagnosticClass": "unsupported_or_source_mismatch", "retryable": False}
        message, reason = bridge.find_final(projection, row["run_id"])
        if reason or not message:
            diagnostic, retryable = classify_gate(reason or "final message unavailable")
            return {**base, "status": "needs_review", "reason": reason or "final message is unavailable",
                    "diagnosticClass": diagnostic, "retryable": retryable}
        final_text = message.get("text")
        if not isinstance(final_text, str) or len(final_text.encode("utf-8")) > MAX_FINAL_TEXT:
            return {**base, "status": "needs_review", "reason": "final text exceeds configured size limit",
                    "diagnosticClass": "unsupported_or_source_mismatch", "retryable": False}
        return {**base, "status": "needs_review", "reason": "awaiting authored relevance and delivery review",
                "text": final_text, "sourceRefs": source_refs(message, final_text)}
    except Exception as exc:
        # Persist the class only. The message can contain private content or credentials.
        kind = type(exc).__name__
        detail = str(exc).lower()
        unsupported = any(token in detail for token in ("invalid snapshot", "does not match the verified projection shape", "snapshot identity mismatch"))
        return {**base, "status": "needs_review", "reason": "projection unavailable (" + kind + ")",
                "diagnosticClass": "unsupported_or_source_mismatch" if unsupported else "transient_fetch",
                "retryable": not unsupported}


def process(config: dict, limit: int = DEFAULT_BATCH) -> dict:
    if isinstance(limit, bool) or not 1 <= limit <= MAX_BATCH:
        raise CaptureError(f"limit must be between 1 and {MAX_BATCH}")
    meta = metadata_connection(config["t3DatabaseFile"])
    bridge = bridge_module()
    bridge_config = bridge.load_config(config["bridgeConfigFile"])
    db = connect_capture(config)
    counts = {"observed": 0, "staged": 0, "excluded": 0, "needs_review": 0, "retried": 0}
    try:
        state = db.execute("SELECT activation_epoch,scan_after_run_id FROM capture_state WHERE singleton=1").fetchone()
        if not state:
            raise CaptureError("capture is not initialized; run init first")
        epoch = parse_time(state["activation_epoch"])
        if epoch is None:
            raise CaptureError("activation epoch is invalid")
        rows = meta.execute("""SELECT r.run_id,r.thread_id,r.status,r.completed_at,t.thread_id AS matched_thread_id,t.archived_at,t.deleted_at
            FROM orchestration_v2_projection_runs r LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id=r.thread_id
            WHERE r.run_id > ? AND r.status='completed'
              AND julianday(r.completed_at) >= julianday(?) - (1.0 / 86400)
            ORDER BY r.run_id COLLATE BINARY LIMIT ?""",
            (state["scan_after_run_id"], state["activation_epoch"], limit)).fetchall()
        before_cursor = state["scan_after_run_id"]
        decisions: list[tuple[dict, bool, int]] = []
        now = utc_now()
        for row in rows:
            run_id, thread_id, status, completed_at = row["run_id"], row["thread_id"], row["status"], row["completed_at"]
            if not isinstance(run_id, str) or not run_id or not isinstance(thread_id, str) or not thread_id:
                raise CaptureError("local completion metadata contains an invalid source identity")
            if status != "completed" or not completed_at:
                continue
            completed = parse_time(completed_at)
            if completed is None or completed < epoch:
                continue
            existing = db.execute("SELECT * FROM candidates WHERE thread_id=? AND run_id=?", (thread_id, run_id)).fetchone()
            if existing:
                stage = staged_receipt(bridge_config, thread_id, run_id)
                if stage:
                    decisions.append(({"threadId": thread_id, "runId": run_id, "completedAt": completed_at,
                        "status": "staged", "reason": "matching explicit outbox stage exists (state: " + str(stage.get("state", "unknown")) + ")", "receipt": stage}, False, 0))
                continue
            if row["deleted_at"] is not None:
                decisions.append(({"threadId": thread_id, "runId": run_id, "completedAt": completed_at, "status": "excluded", "reason": "source thread is deleted"}, True, 0))
                continue
            if row["matched_thread_id"] is None:
                decisions.append(({"threadId": thread_id, "runId": run_id, "completedAt": completed_at,
                    "status": "needs_review", "reason": "source thread metadata is missing",
                    "diagnosticClass": "unsupported_or_source_mismatch"}, True, 0))
                continue
            child = meta.execute("SELECT 1 FROM orchestration_v2_projection_subagents WHERE child_thread_id=? LIMIT 1", (thread_id,)).fetchone()
            if child:
                decisions.append(({"threadId": thread_id, "runId": run_id, "completedAt": completed_at,
                    "status": "excluded", "reason": "thread is a delegated child thread"}, True, 0))
                continue
            staged = staged_receipt(bridge_config, thread_id, run_id)
            if staged:
                decisions.append(({"threadId": thread_id, "runId": run_id, "completedAt": completed_at,
                    "status": "staged", "reason": "matching explicit outbox stage exists (state: " + str(staged.get("state", "unknown")) + ")", "receipt": staged}, True, 0))
                continue
            decisions.append((fetch_decision(bridge, bridge_config, dict(row)), True, 0))

        retry_rows = db.execute("""SELECT candidate_id,thread_id,run_id,completed_at,retry_attempts,next_attempt_at
            FROM candidates WHERE status='needs_review' AND text_file IS NULL AND next_attempt_at IS NOT NULL
            AND retry_attempts < 32 ORDER BY next_attempt_at,created_at LIMIT ?""", (min(limit, MAX_RETRY_BATCH),)).fetchall()
        current = parse_time(now)
        for retry in retry_rows:
            due = parse_time(retry["next_attempt_at"])
            if not due or not current or due > current:
                continue
            staged = staged_receipt(bridge_config, retry["thread_id"], retry["run_id"])
            if staged:
                item = {"threadId": retry["thread_id"], "runId": retry["run_id"], "completedAt": retry["completed_at"],
                        "status": "staged", "reason": "matching explicit outbox stage exists (state: " + str(staged.get("state", "unknown")) + ")", "receipt": staged}
            else:
                item = fetch_decision(bridge, bridge_config, dict(retry))
                counts["retried"] += 1
            decisions.append((item, False, retry["retry_attempts"] + 1))

        # HTTP fetches and outbox reads finish before this short transaction. Decisions and
        # cursor still commit atomically, so a crash replays the same deterministic identities.
        db.execute("BEGIN IMMEDIATE")
        for item, is_new_capture, attempts in decisions:
            save_candidate(db, config, item)
            if attempts:
                if item.get("retryable"):
                    db.execute("UPDATE candidates SET retry_attempts=?,next_attempt_at=?,diagnostic_class=?,reason=?,updated_at=? WHERE thread_id=? AND run_id=? AND text_file IS NULL",
                        (attempts, retry_time(attempts, utc_now()), item.get("diagnosticClass", "transient_fetch"), item["reason"], utc_now(), item["threadId"], item["runId"]))
                elif item["status"] == "staged":
                    pass
                else:
                    db.execute("UPDATE candidates SET retry_attempts=?,next_attempt_at=NULL,diagnostic_class=?,reason=?,updated_at=? WHERE thread_id=? AND run_id=? AND text_file IS NULL",
                        (attempts, item.get("diagnosticClass"), item["reason"], utc_now(), item["threadId"], item["runId"]))
                    if item["status"] == "needs_review" and item.get("text") is not None:
                        db.execute("UPDATE candidates SET retry_attempts=?,next_attempt_at=NULL,diagnostic_class=NULL,updated_at=? WHERE thread_id=? AND run_id=? AND text_file IS NOT NULL",
                            (attempts, utc_now(), item["threadId"], item["runId"]))
            counts[item["status"]] = counts.get(item["status"], 0) + 1
        for item, is_new_capture, _attempts in decisions:
            if is_new_capture and item.get("retryable"):
                db.execute("UPDATE candidates SET retry_attempts=1,next_attempt_at=?,diagnostic_class=?,updated_at=? WHERE thread_id=? AND run_id=? AND text_file IS NULL",
                    (retry_time(1, now), item.get("diagnosticClass", "transient_fetch"), now, item["threadId"], item["runId"]))
        if rows:
            next_cursor = rows[-1]["run_id"]
        else:
            next_cursor = ""
        changed = db.execute("UPDATE capture_state SET scan_after_run_id=? WHERE singleton=1 AND scan_after_run_id=?", (next_cursor, before_cursor)).rowcount
        if changed != 1:
            raise CaptureError("capture cursor changed during scan; retry the bounded page")
        db.commit()
        return {"scanned": len(rows), "cursorReset": not rows, "candidates": counts}
    except Exception:
        db.rollback()
        raise
    finally:
        secure_capture_artifacts(config)
        db.close()
        meta.close()


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    for command in ("init", "once"):
        item = commands.add_parser(command)
        item.add_argument("--config", required=True)
        if command == "once":
            item.add_argument("--limit", type=int, default=DEFAULT_BATCH)
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        config = load_config(args.config)
        result = init(config) if args.command == "init" else process(config, args.limit)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, sqlite3.Error, CaptureError, KeyError, TypeError, ValueError):
        print("T3 completion capture failed; check private configuration and local metadata availability.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
