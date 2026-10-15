#!/usr/bin/env python3
"""Publish an agent-authored canvas using an existing private Inbox producer.

The input contains the exact registered host/thread/run/attempt and CAS revision.
This client never creates credentials, registers publishers, or retries a conflict.
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


def private_file(filename, limit):
    path = Path(filename)
    if not path.is_absolute():
        raise ValueError("An absolute private file is required")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > limit:
            raise ValueError("A bounded private file is required")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError("Private file exceeds limit")
        return data
    finally:
        os.close(fd)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--producer-config", required=True,
                        help="Existing private result producer configuration")
    parser.add_argument("--input", required=True,
                        help="Private JSON publish action input, including expectedRevision")
    args = parser.parse_args()
    config = json.loads(private_file(args.producer_config, 64 * 1024))
    endpoint = urllib.parse.urlsplit(config["endpoint"])
    if (endpoint.scheme not in ("http", "https") or not endpoint.hostname
            or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment):
        raise ValueError("Invalid producer endpoint")
    if endpoint.scheme == "http" and endpoint.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("HTTPS or loopback is required")
    token = private_file(config["tokenFile"], 4096).decode().strip()
    if not token or "\r" in token or "\n" in token:
        raise ValueError("Invalid private credential")
    payload = private_file(args.input, 256 * 1024)
    value = json.loads(payload)
    if not isinstance(value, dict) or any(key not in value for key in
            ("hostId", "threadId", "runId", "attemptId", "expectedRevision", "canvas")):
        raise ValueError("An exact bound publish action is required")
    url = urllib.parse.urlunsplit((endpoint.scheme, endpoint.netloc,
                                  "/api/observatory/actions/publish", "", ""))
    request = urllib.request.Request(url, data=payload, method="POST", headers={
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "User-Agent": "ai-inbox-observatory/1",
    })
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=45) as response:
            data = response.read(256 * 1024 + 1)
            if len(data) > 256 * 1024:
                raise ValueError("Publish response exceeds limit")
            result = json.loads(data)
            # Keep potentially private agent text out of command output.
            revision = result.get("revision", result)
            number = revision.get("revision") if isinstance(revision, dict) else revision
            print(json.dumps({"published": True, "revision": number,
                              "threadId": value["threadId"], "runId": value["runId"]}))
    except urllib.error.HTTPError as error:
        print(json.dumps({"published": False, "httpStatus": error.code,
                          "conflict": error.code == 409}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, urllib.error.URLError):
        print("Observatory publication failed; inspect private configuration and exact identity.",
              file=sys.stderr)
        sys.exit(1)
