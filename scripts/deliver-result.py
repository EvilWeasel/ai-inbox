#!/usr/bin/env python3
"""Deliver an explicit final result to a privately configured inbox producer API."""
import argparse
import json
import os
from pathlib import Path
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

MAX_METADATA = 2_000_000
MAX_AUDIO = 30 * 1024 * 1024


def private_file(path):
    path = Path(path).expanduser()
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise ValueError("configuration and token files must be private regular files")
    return path


def deliver(config_path, input_path, audio_path=None):
    config = json.loads(private_file(config_path).read_text())
    endpoint = config["endpoint"]
    parsed = urllib.parse.urlsplit(endpoint)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or parsed.query:
        raise ValueError("producer endpoint must be an HTTPS URL without credentials")
    token = private_file(config["tokenFile"]).read_text().strip()
    if not token or any(ch.isspace() for ch in token):
        raise ValueError("invalid producer token file")
    if input_path != "-":
        path = Path(input_path)
        if not path.is_file() or path.stat().st_size > MAX_METADATA:
            raise ValueError("result metadata is missing or exceeds the size limit")
        with path.open("rb") as source:
            raw = source.read(MAX_METADATA + 1)
    else:
        raw = sys.stdin.buffer.read(MAX_METADATA + 1)
    if len(raw) > MAX_METADATA:
        raise ValueError("result metadata exceeds the size limit")
    metadata = json.loads(raw)
    if not isinstance(metadata, dict) or metadata.get("phase", "final") != "final":
        raise ValueError("only explicit final results can be delivered")
    metadata["phase"] = "final"
    origin = metadata.setdefault("origin", {})
    if not isinstance(origin, dict) or origin.get("host", config["host"]) != config["host"]:
        raise ValueError("result host must match the configured producer")
    origin["host"] = config["host"]
    if not metadata.get("deliveryId"):
        raise ValueError("a stable deliveryId is required for retry-safe delivery")
    body = json.dumps(metadata, ensure_ascii=False).encode()
    if len(body) > MAX_METADATA:
        raise ValueError("result metadata exceeds the size limit")
    content_type = "application/json"
    if audio_path:
        path = Path(audio_path)
        if not path.is_file() or path.stat().st_size > MAX_AUDIO:
            raise ValueError("audio is missing or exceeds the size limit")
        with path.open("rb") as source:
            audio = source.read(MAX_AUDIO + 1)
        if len(audio) > MAX_AUDIO:
            raise ValueError("audio exceeds the size limit")
        boundary = "inbox-" + uuid.uuid4().hex
        body = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n".encode()
            + body + f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"recording.mp3\"\r\nContent-Type: audio/mpeg\r\n\r\n".encode()
            + audio + f"\r\n--{boundary}--\r\n".encode()
        )
        content_type = f"multipart/form-data; boundary={boundary}"
    request = urllib.request.Request(endpoint, data=body, method="POST", headers={
        "Authorization": "Bearer " + token, "Content-Type": content_type,
        "User-Agent": "ai-inbox-producer/1",
    })
    # Do not follow redirects with a bearer credential, even inside the overlay.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=60) as response:
        result = json.load(response)
    item = result.get("item", {})
    return {"delivered": True, "itemId": item.get("id"), "created": result.get("created")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, help="private JSON producer configuration")
    parser.add_argument("--input", required=True, help="final-result metadata JSON file, or - for stdin")
    parser.add_argument("--audio", help="existing MP3 to upload with the result")
    args = parser.parse_args()
    try:
        print(json.dumps(deliver(args.config, args.input, args.audio)))
    except urllib.error.HTTPError as error:
        print(f"Delivery failed: HTTP {error.code}. No automatic retry was made.", file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, urllib.error.URLError):
        print("Delivery failed: check private configuration, input and connection. No automatic retry was made.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
