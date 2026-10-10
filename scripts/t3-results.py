#!/usr/bin/env python3
"""Stage explicitly selected T3 results and deliver them after run completion."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

MAX_SNAPSHOT = 5 * 1024 * 1024
MAX_METADATA = 2_000_000
MAX_AUDIO = 30 * 1024 * 1024
ACTIVE = {"preparing", "queued", "starting", "running", "waiting", "pending", "idle"}
FAILURES = {"failed", "interrupted", "cancelled", "rolled_back"}
SETTLED = {"completed", "failed", "interrupted", "cancelled", "rolled_back", "stopped", "delivered", "observed", "acknowledged"}


class BridgeError(ValueError):
    pass


def private_file(value: str | Path) -> Path:
    path = Path(value).expanduser()
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
        raise BridgeError("private configuration and token files must be regular mode-0600 files")
    return path


def read_json_file(path: str | Path, limit: int = MAX_METADATA) -> dict:
    source = private_file(path)
    if source.stat().st_size > limit:
        raise BridgeError("input exceeds the configured size limit")
    try:
        result = json.loads(source.read_text(encoding="utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise BridgeError("invalid JSON input") from exc
    if not isinstance(result, dict):
        raise BridgeError("JSON input must be an object")
    return result


def load_config(path: str | Path) -> dict:
    config = read_json_file(path)
    required = {"t3Origin", "t3TokenFile", "producerConfigFile", "outboxDir", "allowedAudioRoots"}
    if not required.issubset(config):
        raise BridgeError("private bridge configuration is missing required fields")
    origin = urllib.parse.urlsplit(config["t3Origin"])
    if origin.scheme not in {"http", "https"} or not origin.hostname or origin.username or origin.password or origin.query or origin.fragment or origin.path not in {"", "/"}:
        raise BridgeError("T3 origin must be an HTTPS or loopback HTTP origin")
    if origin.scheme == "http" and not is_loopback(origin.hostname):
        raise BridgeError("plain HTTP is allowed only for a loopback T3 origin")
    if origin.scheme == "https" and origin.port is not None and not (1 <= origin.port <= 65535):
        raise BridgeError("invalid T3 origin port")
    config["t3Origin"] = urllib.parse.urlunsplit((origin.scheme, origin.netloc, "", "", "")).rstrip("/")
    config["t3TokenFile"] = str(private_file(config["t3TokenFile"]))
    config["producerConfigFile"] = str(private_file(config["producerConfigFile"]))
    if not isinstance(config["allowedAudioRoots"], list) or not config["allowedAudioRoots"]:
        raise BridgeError("allowedAudioRoots must be a non-empty list")
    config["allowedAudioRoots"] = [canonical_root(root) for root in config["allowedAudioRoots"]]
    if not isinstance(config.get("pollIntervalSeconds", 5), (int, float)) or not 1 <= config.get("pollIntervalSeconds", 5) <= 3600:
        raise BridgeError("pollIntervalSeconds must be between 1 and 3600")
    return config


def is_loopback(host: str) -> bool:
    try:
        return ipaddress_loopback(host)
    except ValueError:
        return host.lower() == "localhost"


def ipaddress_loopback(host: str) -> bool:
    import ipaddress
    return ipaddress.ip_address(host).is_loopback


def canonical_root(value: str) -> Path:
    root = Path(value).expanduser()
    if not root.is_absolute():
        raise BridgeError("audio roots must be absolute paths")
    check_no_symlink_components(root)
    resolved = root.resolve(strict=True)
    if not resolved.is_dir():
        raise BridgeError("audio roots must be directories")
    return resolved


def check_no_symlink_components(path: Path) -> None:
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError as exc:
            raise BridgeError("path does not exist") from exc
        if stat.S_ISLNK(info.st_mode):
            raise BridgeError("symlink paths are not allowed")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_opener():
    return urllib.request.build_opener(NoRedirect())


def token_from(path: str | Path) -> str:
    token = private_file(path).read_text(encoding="utf-8").strip()
    if not token or any(ch.isspace() for ch in token):
        raise BridgeError("invalid private T3 token file")
    return token


def fetch_snapshot(config: dict, thread_id: str) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,500}", thread_id):
        raise BridgeError("invalid thread ID")
    url = config["t3Origin"] + "/api/orchestration/threads/" + urllib.parse.quote(thread_id, safe="")
    request = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + token_from(config["t3TokenFile"]),
        "x-t3-orchestration-protocol": "2",
        "Accept": "application/json",
        "User-Agent": "ai-inbox-t3-results/1",
    })
    try:
        with http_opener().open(request, timeout=15) as response:
            raw = response.read(MAX_SNAPSHOT + 1)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise BridgeError("T3 snapshot request failed") from exc
    if len(raw) > MAX_SNAPSHOT:
        raise BridgeError("T3 snapshot exceeds the 5 MiB safety bound")
    try:
        snapshot = json.loads(raw)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise BridgeError("T3 returned an invalid snapshot") from exc
    projection = snapshot.get("projection") if isinstance(snapshot, dict) else None
    required_arrays = ("runs", "attempts", "nodes", "subagents", "messages", "turnItems")
    if not isinstance(projection, dict) or not isinstance(projection.get("thread"), dict) or any(not isinstance(projection.get(key), list) for key in required_arrays):
        raise BridgeError("T3 snapshot does not match the verified projection shape")
    return snapshot


def projection_thread_id(projection: dict) -> str | None:
    thread = projection.get("thread")
    return thread.get("id") if isinstance(thread, dict) else None


def current_run(projection: dict) -> dict | None:
    runs = projection.get("runs")
    thread = projection.get("thread")
    if not isinstance(runs, list) or not isinstance(thread, dict):
        return None
    thread_id = thread.get("id")
    if not isinstance(thread_id, str) or not thread_id:
        return None
    candidates = [run for run in runs if isinstance(run, dict) and run.get("threadId") == thread_id]
    if not candidates or any(not isinstance(run.get("id"), str) or not run["id"] or
                             isinstance(run.get("ordinal"), bool) or not isinstance(run.get("ordinal"), int) or run["ordinal"] < 0
                             for run in candidates):
        return None
    ordinals = [run["ordinal"] for run in candidates]
    run_ids = [run["id"] for run in candidates]
    if len(set(ordinals)) != len(ordinals) or len(set(run_ids)) != len(run_ids):
        return None
    return max(candidates, key=lambda run: run["ordinal"])


def outbox_path(config: dict) -> Path:
    path = Path(config["outboxDir"]).expanduser()
    if not path.is_absolute():
        raise BridgeError("outboxDir must be an absolute path")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    check_no_symlink_components(path)
    if path.is_symlink() or not path.is_dir():
        raise BridgeError("outbox must be a real private directory")
    path.chmod(0o700)
    return path.resolve(strict=True)


def connect_db(config: dict) -> sqlite3.Connection:
    path = outbox_path(config) / "outbox.sqlite3"
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    os.chmod(path, 0o600)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    db.execute("""CREATE TABLE IF NOT EXISTS deliveries (
        stage_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL UNIQUE, stage_dir TEXT NOT NULL, audio_file TEXT,
        payload_hash TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt REAL NOT NULL DEFAULT 0, receipt_json TEXT, diagnostic TEXT,
        created_at REAL NOT NULL, updated_at REAL NOT NULL
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries(state,next_attempt,created_at)")
    return db


def validate_audio(source: str | Path, roots: list[Path]) -> Path:
    candidate = Path(source).expanduser()
    if not candidate.is_absolute():
        raise BridgeError("audio path must be absolute")
    check_no_symlink_components(candidate)
    resolved = candidate.resolve(strict=True)
    if not resolved.is_file():
        raise BridgeError("audio must be a regular file")
    if not any(resolved.is_relative_to(root) for root in roots):
        raise BridgeError("audio path is outside configured allowedAudioRoots")
    info = resolved.stat()
    if info.st_size < 1 or info.st_size > MAX_AUDIO:
        raise BridgeError("audio is empty or exceeds the 30 MiB limit")
    return resolved


def stage(config_path: str | Path, thread_id: str, input_path: str | Path, audio_path: str | Path | None, meaningful: bool) -> dict:
    if not meaningful:
        raise BridgeError("stage requires explicit --meaningful acknowledgement")
    config = load_config(config_path)
    metadata = read_json_file(input_path)
    if metadata.get("phase", "final") != "final":
        raise BridgeError("only explicitly final result metadata can be staged")
    metadata["phase"] = "final"
    if not isinstance(metadata.get("title"), str) or not metadata["title"].strip() or not isinstance(metadata.get("body"), str) or not metadata["body"].strip():
        raise BridgeError("a concrete title and finished body are required")
    snapshot = fetch_snapshot(config, thread_id)
    projection = snapshot["projection"]
    if projection_thread_id(projection) != thread_id:
        raise BridgeError("T3 returned a snapshot for a different thread")
    run = current_run(projection)
    if not run or not isinstance(run.get("id"), str):
        raise BridgeError("thread has no authoritative current run to bind")
    metadata.setdefault("origin", {})
    if not isinstance(metadata["origin"], dict):
        raise BridgeError("origin must be an object")
    metadata["origin"]["threadId"] = thread_id
    metadata["origin"]["runId"] = run["id"]
    encoded = json.dumps(metadata, ensure_ascii=False, separators=(",", ":")).encode()
    if len(encoded) > MAX_METADATA:
        raise BridgeError("staged metadata exceeds the 2 MB limit")
    audio = validate_audio(audio_path, config["allowedAudioRoots"]) if audio_path else None
    identity = f"{thread_id}\0{run['id']}".encode()
    stage_id = hashlib.sha256(identity).hexdigest()
    delivery_id = "t3-" + hashlib.sha256(b"delivery\0" + identity).hexdigest()
    root = outbox_path(config)
    stage_dir = root / stage_id
    stage_dir.mkdir(mode=0o700, exist_ok=True)
    os.chmod(stage_dir, 0o700)
    fsync_dir(root)
    metadata_file = stage_dir / "result.json"
    audio_file = stage_dir / ("original-" + hashlib.sha256(audio.read_bytes()).hexdigest() + ".mp3") if audio else None
    if audio:
        if not audio_file.exists():
            copy_private(audio, audio_file)
    digest = hashlib.sha256(encoded + (audio_file.read_bytes() if audio_file else b"")).hexdigest()
    db = connect_db(config)
    try:
        now = time.time()
        # Serialize concurrent retries before deciding whether this is a new row or a revision.
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute("SELECT * FROM deliveries WHERE thread_id=? AND run_id=? ORDER BY created_at DESC", (thread_id, run["id"])).fetchall()
        if existing:
            row = existing[0]
            if row["payload_hash"] == digest:
                db.commit()
                return stage_receipt(row)
            write_atomic_private(metadata_file, encoded)
            db.execute("UPDATE deliveries SET stage_dir=?,audio_file=?,payload_hash=?,state='pending',next_attempt=0,receipt_json=NULL,diagnostic=NULL,updated_at=? WHERE stage_id=?",
                       (str(stage_dir), str(audio_file) if audio_file else None, digest, now, row["stage_id"]))
            # Collapse rows created by older random-ID versions to the retained stable delivery.
            for duplicate in existing[1:]:
                db.execute("DELETE FROM deliveries WHERE stage_id=?", (duplicate["stage_id"],))
            db.commit()
            return {"staged": True, "updated": True, "stageId": row["stage_id"], "threadId": thread_id,
                    "runId": run["id"], "deliveryId": row["delivery_id"], "audio": bool(audio)}
        if stage_id != hashlib.sha256(identity).hexdigest():
            raise BridgeError("invalid deterministic stage identity")
        write_atomic_private(metadata_file, encoded)
        fsync_dir(stage_dir)
        db.execute("INSERT INTO deliveries(stage_id,thread_id,run_id,delivery_id,stage_dir,audio_file,payload_hash,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                   (stage_id, thread_id, run["id"], delivery_id, str(stage_dir), str(audio_file) if audio_file else None, digest, "pending", now, now))
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
    return {"staged": True, "stageId": stage_id, "threadId": thread_id, "runId": run["id"], "deliveryId": delivery_id, "audio": bool(audio)}


def stage_receipt(row: sqlite3.Row) -> dict:
    return {"staged": True, "updated": False, "stageId": row["stage_id"], "threadId": row["thread_id"],
            "runId": row["run_id"], "deliveryId": row["delivery_id"], "audio": bool(row["audio_file"]),
            "state": row["state"], "receipt": json.loads(row["receipt_json"]) if row["receipt_json"] else None}


def write_private(path: Path, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as target:
        target.write(data)
        target.flush()
        os.fsync(target.fileno())


def fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def copy_private(source: Path, target: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(source, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_AUDIO:
            raise BridgeError("audio changed or exceeds the 30 MiB limit")
        out_fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "rb", closefd=False) as src, os.fdopen(out_fd, "wb") as dst:
            remaining = MAX_AUDIO + 1
            while remaining:
                block = src.read(min(1024 * 1024, remaining))
                if not block: break
                dst.write(block)
                remaining -= len(block)
            dst.flush()
            os.fsync(dst.fileno())
            if remaining == 0 and src.read(1):
                raise BridgeError("audio exceeds the 30 MiB limit")
    finally:
        os.close(fd)


def find_final(projection: dict, run_id: str) -> tuple[dict | None, str]:
    thread_id = projection_thread_id(projection)
    runs = projection.get("runs")
    if not thread_id or not isinstance(runs, list):
        return None, "thread or run state is missing from projection"
    matched = [r for r in runs if isinstance(r, dict) and r.get("threadId") == thread_id and r.get("id") == run_id]
    if len(matched) > 1:
        return None, "bound run identity is ambiguous in T3 snapshot"
    run = matched[0] if matched else None
    if not run:
        return None, "bound run is absent from current T3 snapshot"
    if run.get("status") in FAILURES:
        return None, "bound run ended with status " + str(run.get("status"))
    if run.get("status") != "completed" or not run.get("completedAt"):
        return None, "bound run has not reached authoritative completed status"
    subagents = projection.get("subagents")
    if not isinstance(subagents, list):
        return None, "subagent completion state is missing from projection"
    for child in subagents:
        if not isinstance(child, dict) or child.get("runId") != run_id:
            continue
        status = child.get("status")
        if not isinstance(status, str) or status not in ACTIVE | SETTLED:
            return None, "child task completion state is unknown"
        if status in ACTIVE:
            return None, "live child task remains unsettled"
        # completionWake is a policy enum, not an execution/completion state.
        if child.get("completionWake") not in (None, "always", "settled_only"):
            return None, "delegated child wake policy is unknown"
        delivery = child.get("completionDelivery")
        if delivery is not None:
            if not isinstance(delivery, dict) or delivery.get("state") not in ("pending", "claimed", "acknowledged", "delivered", "disposed"):
                return None, "delegated child completion state is unknown"
            if delivery["state"] in {"pending", "claimed"}:
                return None, "delegated child result has not been incorporated"
    cohort = run.get("delegatedCompletion")
    if cohort is not None:
        if not isinstance(cohort, dict) or cohort.get("disposition") not in ("open", "stopped", "disposed"):
            return None, "delegated completion cohort state is unknown"
        # Open permits further delegation; it does not mean child work is active.
        # The installed DTO's delivery is a generation/message/task reference,
        # not an object with a state/status field. Child delivery states gate it.
        delivery = cohort.get("delivery")
        if delivery is not None:
            if not isinstance(delivery, dict) or not isinstance(delivery.get("generation"), int) or isinstance(delivery.get("generation"), bool) or delivery["generation"] < 1 or not isinstance(delivery.get("messageId"), str) or not delivery["messageId"] or not isinstance(delivery.get("taskIds"), list):
                return None, "delegated completion delivery state is unknown"
            children = {child.get("id"): child for child in subagents if isinstance(child, dict) and child.get("runId") == run_id}
            for task_id in delivery["taskIds"]:
                if not isinstance(task_id, str) or task_id not in children:
                    return None, "delegated completion task reference is unknown"
                state = children[task_id].get("completionDelivery")
                if not isinstance(state, dict) or state.get("state") not in ("acknowledged", "delivered", "disposed"):
                    return None, "delegated completion cohort remains unsettled"
    root_id = run.get("rootNodeId")
    nodes = projection.get("nodes")
    if not isinstance(nodes, list):
        return None, "execution node state is missing from projection"
    root = next((n for n in nodes if isinstance(n, dict) and n.get("id") == root_id), None)
    if not root or root.get("kind") != "root_turn" or root.get("status") != "completed" or not root.get("completedAt"):
        return None, "root turn completion node is missing or incomplete"
    for node in nodes:
        if not isinstance(node, dict) or (node.get("runId") != run_id and node.get("rootNodeId") != root_id and node.get("id") != root_id):
            continue
        # A todo list describes ongoing project scope, not executing background work.
        if node.get("kind") == "todo_list":
            continue
        status = node.get("status")
        if not isinstance(status, str) or status not in ACTIVE | SETTLED:
            return None, "execution node completion state is unknown"
        if status in ACTIVE:
            return None, "run still has active execution nodes"
    node_map = {n.get("id"): n for n in nodes if isinstance(n, dict)}
    eligible = []
    messages = projection.get("messages")
    if not isinstance(messages, list):
        return None, "assistant message state is missing from projection"
    for message in messages:
        if not isinstance(message, dict) or message.get("runId") != run_id or message.get("role") != "assistant" or message.get("streaming") is not False or not isinstance(message.get("text"), str) or not message["text"].strip():
            continue
        node = node_map.get(message.get("nodeId"))
        if not node or node.get("kind") != "assistant_message" or node.get("status") != "completed" or not node.get("completedAt"):
            continue
        parent = node_map.get(node.get("parentNodeId"))
        if node.get("rootNodeId") != root_id or (node.get("parentNodeId") != root_id and (not parent or parent.get("rootNodeId") != root_id)):
            continue
        eligible.append(message)
    if not eligible:
        return None, "no non-streaming completed root assistant result is present"
    eligible.sort(key=lambda m: (m.get("updatedAt", ""), m.get("createdAt", ""), m.get("id", "")))
    return eligible[-1], ""


def bounded_diagnostic(message: str) -> str:
    return message[:400]


def deliver_row(config: dict, row: sqlite3.Row, force: bool = False) -> str:
    try:
        snapshot = fetch_snapshot(config, row["thread_id"])
    except Exception as exc:
        # A transient failure on one thread must not prevent unrelated staged rows from progressing.
        return defer_row(config, row, type(exc).__name__)
    projection = snapshot["projection"]
    if projection_thread_id(projection) != row["thread_id"]:
        db = connect_db(config)
        try:
            with db:
                db.execute("UPDATE deliveries SET state='blocked',diagnostic=?,updated_at=? WHERE stage_id=?",
                           ("T3 snapshot thread identity mismatch", time.time(), row["stage_id"]))
        finally:
            db.close()
        return "blocked"
    _, reason = find_final(projection, row["run_id"])
    db = connect_db(config)
    try:
        if reason:
            state = "blocked" if "ended with status" in reason else "pending"
            with db:
                db.execute("UPDATE deliveries SET state=?,diagnostic=?,updated_at=? WHERE stage_id=?", (state, bounded_diagnostic(reason), time.time(), row["stage_id"]))
            return state
        metadata_path = Path(row["stage_dir"]) / "result.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata["deliveryId"] = row["delivery_id"]
        metadata["origin"]["threadId"] = row["thread_id"]
        metadata["origin"]["runId"] = row["run_id"]
        # The verified T3 result gates delivery; staged authored text remains the published artifact.
        tmp = Path(row["stage_dir"]) / "delivery.json"
        write_atomic_private(tmp, json.dumps(metadata, ensure_ascii=False).encode())
        sender = load_sender()
        try:
            receipt = sender.deliver(config["producerConfigFile"], tmp, row["audio_file"])
        except Exception as exc:
            return defer_row(config, row, type(exc).__name__)
        with db:
            db.execute("UPDATE deliveries SET state='delivered',attempts=attempts+1,next_attempt=0,receipt_json=?,diagnostic=NULL,updated_at=? WHERE stage_id=?",
                       (json.dumps(receipt, separators=(",", ":")), time.time(), row["stage_id"]))
        return "delivered"
    finally:
        db.close()


def defer_row(config: dict, row: sqlite3.Row, diagnostic: str) -> str:
    attempts = row["attempts"] + 1
    delay = min(3600, 5 * (2 ** min(attempts - 1, 10)))
    db = connect_db(config)
    try:
        with db:
            db.execute("UPDATE deliveries SET state='pending',attempts=?,next_attempt=?,diagnostic=?,updated_at=? WHERE stage_id=?",
                       (attempts, time.time() + delay, bounded_diagnostic(diagnostic), time.time(), row["stage_id"]))
    finally:
        db.close()
    return "pending"


def write_atomic_private(path: Path, data: bytes) -> None:
    fd, name = tempfile.mkstemp(prefix=".delivery-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as target:
            target.write(data)
            target.flush()
            os.fsync(target.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)


def load_sender():
    script = Path(__file__).with_name("deliver-result.py")
    spec = importlib.util.spec_from_file_location("ai_inbox_result_sender", script)
    if spec is None or spec.loader is None:
        raise BridgeError("result sender is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def process(config: dict, limit: int = 100, force: bool = False) -> dict:
    if not 1 <= limit <= 1000:
        raise BridgeError("limit must be between 1 and 1000")
    db = connect_db(config)
    try:
        now = time.time()
        condition = "state IN ('pending','blocked')" if force else "state='pending' AND next_attempt<=?"
        params = (limit,) if force else (now, limit)
        rows = db.execute(f"SELECT * FROM deliveries WHERE {condition} ORDER BY created_at LIMIT ?", params).fetchall()
    finally:
        db.close()
    counts = {"delivered": 0, "pending": 0, "blocked": 0}
    for row in rows:
        try:
            state = deliver_row(config, row, force)
        except Exception as exc:
            # Persist only a bounded class-name diagnostic; never log exception text or remote content.
            try:
                state = defer_row(config, row, type(exc).__name__)
            except Exception:
                state = "pending"
        counts[state] += 1
    return counts


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    stage_parser = commands.add_parser("stage", help="stage one explicitly selected finished result")
    stage_parser.add_argument("--config", required=True)
    stage_parser.add_argument("--thread-id", required=True)
    stage_parser.add_argument("--input", required=True, help="private JSON envelope for the final result")
    stage_parser.add_argument("--audio", help="explicit existing MP3 path; never auto-selected")
    stage_parser.add_argument("--meaningful", action="store_true", help="confirm this is the finished personal deliverable")
    for name in ("once", "retry", "watch"):
        cmd = commands.add_parser(name)
        cmd.add_argument("--config", required=True)
        cmd.add_argument("--limit", type=int, default=100)
        if name == "watch": cmd.add_argument("--interval", type=float)
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "stage":
            result = stage(args.config, args.thread_id, args.input, args.audio, args.meaningful)
            print(json.dumps(result))
            return 0
        config = load_config(args.config)
        if args.command == "watch":
            interval = args.interval if args.interval is not None else config.get("pollIntervalSeconds", 5)
            if not 1 <= interval <= 3600: raise BridgeError("watch interval must be between 1 and 3600 seconds")
            while True:
                print(json.dumps(process(config, args.limit)), flush=True)
                time.sleep(interval)
        else:
            print(json.dumps(process(config, args.limit, force=args.command == "retry")))
        return 0
    except (OSError, sqlite3.Error, BridgeError, KeyError, TypeError, ValueError):
        print("T3 result bridge failed; inspect private configuration and bounded outbox diagnostics.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
