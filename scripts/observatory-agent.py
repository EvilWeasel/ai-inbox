#!/usr/bin/env python3
"""Opt in this verified T3 thread and publish a private structured canvas once.

Uses existing private bridge/producer credentials. No key creation, audio,
background instrumentation, redirect following, or automatic conflict retry.
"""
import argparse
import json
import os
from pathlib import Path
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_RESPONSE = 16 * 1024 * 1024
ACTIVE = {"running", "waiting"}


class AgentError(ValueError):
    pass


class ActionError(AgentError):
    def __init__(self, status):
        self.status = status
        super().__init__("Observatory action failed")


def private_file(filename, limit=64 * 1024):
    path = Path(filename)
    if not path.is_absolute():
        raise AgentError("An absolute private file is required")
    # Reject symlink ancestors as well as the final component.
    for component in (path, *path.parents):
        if component.is_symlink():
            raise AgentError("Private files cannot use symlinks")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077
                or info.st_uid != os.getuid() or info.st_size > limit):
            raise AgentError("A bounded owner-only file is required")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            value = stream.read(limit + 1)
        if len(value) > limit:
            raise AgentError("Private file exceeds limit")
        return value
    finally:
        os.close(fd)


def private_json(filename, limit=64 * 1024):
    value = json.loads(private_file(filename, limit))
    if not isinstance(value, dict):
        raise AgentError("Private JSON object required")
    return value


def origin(value, allow_path=False):
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or not allow_path and parsed.path not in {"", "/"}):
        raise AgentError("Invalid private origin")
    if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise AgentError("HTTPS or loopback is required")
    if parsed.port is not None and not 1 <= parsed.port <= 65535:
        raise AgentError("Invalid private port")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


def credential(filename, pointer=None):
    raw = private_file(filename, 64 * 1024).decode("utf-8")
    if pointer is None:
        value = raw.strip()
    else:
        if not isinstance(pointer, str) or pointer != "" and not pointer.startswith("/"):
            raise AgentError("RFC 6901 token pointer required")
        value = json.loads(raw)
        for key in (pointer[1:].split("/") if pointer else []):
            # Reject malformed escapes instead of silently choosing another field.
            if "~" in key.replace("~0", "").replace("~1", ""):
                raise AgentError("Invalid token pointer")
            key = key.replace("~1", "/").replace("~0", "~")
            if isinstance(value, dict) and key in value:
                value = value[key]
            elif isinstance(value, list) and key.isascii() and key.isdigit() and str(int(key)) == key and int(key) < len(value):
                value = value[int(key)]
            else:
                raise AgentError("Token pointer is unavailable")
    if not isinstance(value, str) or not value or len(value) > 4096 or any(c.isspace() for c in value):
        raise AgentError("Invalid existing credential")
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_json(base, path, token=None, body=None, native=False, limit=MAX_RESPONSE):
    headers = {"Accept": "application/json", "User-Agent": "ai-inbox-observatory-agent/1"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if native:
        headers["x-t3-orchestration-protocol"] = "2"
    data = None
    if body is not None:
        data = json.dumps(body, allow_nan=False).encode()
        if len(data) > 128 * 1024:
            raise AgentError("Action input exceeds limit")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(base + path, data=data, headers=headers,
                                     method="POST" if body is not None else "GET")
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(
                request, timeout=12) as response:
            raw = response.read(limit + 1)
    except urllib.error.HTTPError as error:
        error.close()
        raise ActionError(error.code) from None
    if len(raw) > limit:
        raise AgentError("Response exceeds limit")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise AgentError("JSON response object required")
    return value


def checked_id(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 300 or any(ord(c) < 32 for c in value):
        raise AgentError("Exact native identity required")
    return value


def current_identity(snapshot, host_id, thread_id):
    projection = snapshot.get("projection", {})
    if not isinstance(projection, dict) or projection.get("thread", {}).get("id") != thread_id:
        raise AgentError("Native thread mismatch")
    runs = projection.get("runs")
    if not isinstance(runs, list) or not runs:
        raise AgentError("Current run unavailable")
    for run in runs:
        if (not isinstance(run, dict) or type(run.get("ordinal")) is not int
                or not 0 <= run["ordinal"] <= 2**53-1
                or run.get("threadId", thread_id) != thread_id):
            raise AgentError("Native run metadata is ambiguous")
        checked_id(run.get("id"))
    if len({r["ordinal"] for r in runs}) != len(runs) or len({r["id"] for r in runs}) != len(runs):
        raise AgentError("Native run metadata is ambiguous")
    run = max(runs, key=lambda r: r["ordinal"])
    if run.get("status") not in ACTIVE:
        raise AgentError("Latest native run is not active")
    attempt = checked_id(run.get("activeAttemptId"))
    attempts = projection.get("attempts")
    if attempts is not None:
        if not isinstance(attempts, list):
            raise AgentError("Invalid native attempts")
        matches = [a for a in attempts if isinstance(a, dict) and a.get("id") == attempt]
        if (len(matches) != 1 or matches[0].get("runId") != run["id"]
                or matches[0].get("threadId", thread_id) != thread_id):
            raise AgentError("Native attempt mismatch")
    return {"hostId": host_id, "threadId": thread_id, "runId": run["id"], "attemptId": attempt}


def publish_agent(args):
    bridge = private_json(args.bridge_config)
    producer = private_json(args.producer_config or bridge["producerConfigFile"])
    expected_environment = checked_id(args.environment_id)
    for key in ("environmentId", "t3EnvironmentId", "expectedEnvironmentId"):
        if key in bridge and bridge[key] != expected_environment:
            raise AgentError("Bridge environment mismatch")
    host_id, thread_id = checked_id(args.host_id), checked_id(args.thread_id)
    native_origin = origin(bridge["t3Origin"])
    inbox_origin = origin(producer["endpoint"], allow_path=True)
    # Bind the requested environment before sending the native read credential.
    descriptor = request_json(native_origin, "/.well-known/t3/environment")
    if (descriptor.get("environmentId") != expected_environment
            or descriptor.get("orchestrationProtocolVersion") != 2):
        raise AgentError("Native environment descriptor mismatch")
    pointer = bridge.get("t3TokenJsonPointer", bridge.get("t3TokenPointer"))
    native_token = credential(bridge["t3TokenFile"], pointer)
    snapshot = request_json(native_origin, "/api/orchestration/threads/" +
                            urllib.parse.quote(thread_id, safe="") + "/bounded", native_token, native=True)
    identity = current_identity(snapshot, host_id, thread_id)
    canvas = private_json(args.canvas, 128 * 1024)
    producer_token = credential(producer["tokenFile"])
    registration = request_json(inbox_origin, "/api/observatory/actions/register", producer_token,
                                identity, limit=256 * 1024)
    if any(registration.get(k) != v for k, v in identity.items()):
        raise AgentError("Registration identity mismatch")
    query = urllib.parse.urlencode({"hostId": host_id, "threadId": thread_id})
    state = request_json(inbox_origin, "/api/observatory/actions/read?" + query, producer_token)
    canvases = state.get("canvases")
    if not isinstance(canvases, list):
        raise AgentError("Canvas state unavailable")
    matches = [c for c in canvases if isinstance(c, dict) and all(c.get(k) == v for k, v in identity.items())]
    if len(matches) > 1:
        raise AgentError("Canvas revision is ambiguous")
    revision = matches[0].get("revision") if matches else 0
    if type(revision) is not int or revision < 0:
        raise AgentError("Invalid canvas revision")
    if args.expected_revision is not None and args.expected_revision != revision:
        raise AgentError("Expected revision differs from current canvas; review before publishing")
    result = request_json(inbox_origin, "/api/observatory/actions/publish", producer_token,
                          {**identity, "expectedRevision": revision, "canvas": canvas}, limit=256 * 1024)
    if (any(result.get(k) != v for k, v in identity.items())
            or type(result.get("revision")) is not int or result["revision"] != revision + 1):
        raise AgentError("Publish acknowledgement mismatch; inspect before retrying")
    return {"published": True, **identity, "revision": result["revision"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bridge-config", required=True)
    parser.add_argument("--producer-config", help="Defaults to existing bridge producerConfigFile")
    parser.add_argument("--environment-id", required=True, help="Expected configured native environment")
    parser.add_argument("--host-id", required=True, help="Configured Observatory host ID")
    parser.add_argument("--thread-id", required=True, help="Verified T3 thread ID, never a provider session UUID")
    parser.add_argument("--canvas", required=True, help="Private structured canvas JSON file")
    parser.add_argument("--expected-revision", type=int, help="Optional explicit CAS assertion; otherwise use the focused read")
    args = parser.parse_args(argv)
    try:
        if args.expected_revision is not None and args.expected_revision < 0:
            raise AgentError("Nonnegative expected revision required")
        print(json.dumps(publish_agent(args)))
        return 0
    except ActionError as error:
        print(json.dumps({"published": False, "httpStatus": error.status,
                          "conflict": error.status == 409, "retried": False}), file=sys.stderr)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, urllib.error.URLError):
        print("Observatory agent publication failed; inspect private configuration and current identity.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
