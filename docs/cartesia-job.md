# Private Cartesia audio-job adapter

`scripts/cartesia-job.py` implements protocol 1 for the private
`scripts/audio-jobs.py` coordinator. It accepts one JSON request on stdin and
returns one compact JSON receipt on stdout. It is a local adapter only: it does
not enqueue or deliver Inbox items, inspect archives, reuse prior recordings,
activate a service, or retry a synthesis.

## Private configuration

For direct invocation, pass `--config-file /absolute/private/path/cartesia-job.json`
before `--audio-job-stdin-json`. The coordinator contract only appends that
protocol flag after the helper path, so its fixed argv prefix remains just the
configured Python executable. In that worker environment, set
`CARTESIA_JOB_CONFIG_FILE` to the private config path. The file must be
owned/private under
`scripts/private-files.py` policy (POSIX mode `0600`; on Windows a protected
current-user ACL). Its JSON shape is:

```json
{
  "speakHelperPath": "/absolute/path/to/speak.py",
  "pythonExecutable": "/absolute/path/to/python3",
  "mediaDir": "/absolute/path/to/private/media",
  "profileRef": "stable-non-secret-profile-id",
  "voiceProfile": {
    "voiceId": "configured-voice-id",
    "modelId": "configured-model-id",
    "language": "de",
    "emotion": "calm"
  },
  "timeoutSeconds": 240
}
```

The adapter config contains no Cartesia credential, Proton Pass reference, API
key, or runtime identity. Keep it in a private runtime directory outside the
public repository. The helper path and Python executable must be absolute and
existing; `mediaDir` must already exist and pass private directory checks. The
adapter does not create or loosen that directory.

The configured `speak.py` remains the sole credential resolver. Before a render,
the adapter bounds and validates the helper's settings file, loads its official
settings API, and requires an exact match for voice ID, model ID, language, and
calm emotion plus a configured Proton Pass reference. A mismatch blocks the
render. It does not configure or reset the helper profile. At launch it removes
an inherited `CARTESIA_API_KEY` override, so the child resolves the configured
reference through the existing `pass-cli run` path. No secret value is read or
printed by this adapter.

The runtime context must have `pass-cli`, the configured Proton Secret Service
D-Bus session unlocked and reachable, and `ffmpeg` plus `ffprobe` available to
the official helper. A missing or locked Secret Service, missing binaries, or
helper failure causes a nonzero exit with a short generic diagnostic and no
receipt. Production service-context readiness and Windows activation still
require validation by the parent; this adapter currently fails closed on
Windows because bounded subprocess-pipe handling is POSIX-only. It does not
claim Windows activation or target-host testing. It does not install a private
credential file or copy a Proton reference into another config.

## Request and render limits

Set the parent coordinator timeout at least 60 seconds above this adapter
timeout so output validation and private-file hardening can finish before the
outer lease times out. A timeout at either layer is uncertain and must not be
retried automatically.

The request must have exactly the coordinator protocol fields: protocol 1,
32-character lowercase hex `jobId`, attempt 1 through 3, 48-character lowercase
hex `attemptNonce`, result metadata, spoken adaptation, matching profile
reference, and the exact expected media child named
`jobId-attemptNonce.mp3`. Output, `.txt`, and `.json` sidecars must all be absent
before render. Symlinks/reparse paths, foreign destinations, malformed IDs,
oversized input, changed profiles, or existing artifacts fail closed.

Metadata is bounded and checked as inert JSON; it is never passed to the speech
helper. Command, instruction, prompt, note, script, shell, and argv-like metadata
fields are rejected. Only the spoken adaptation becomes renderer input. It must
be plain text, at most 3,500 characters, have no Markdown links, URLs, code
markers, or raw filesystem paths, and `speak.py`'s `split_text()` must return
exactly one chunk. A 100-to-350-word adaptation is a useful editorial target,
not a protocol requirement.

There is exactly one fixed-argv `python speak.py render --input ... --output
... --emotion calm` child launch. The transcript is a private per-attempt file
and is removed after the attempt. Child stdout and stderr are drained under
fixed caps, never echoed, and never treated as proof of a provider request ID.
A timeout, nonzero child result, invalid sidecar, invalid MP3, or failed
post-render validation returns no receipt. Since the remote request may already
have been billed, the coordinator must classify a started helper failure as
uncertain; this adapter never retries it.

On successful helper return, `ffprobe` must report a finite positive duration
and an MP3 stream. The helper's JSON sidecar must report exactly one request and
match the expected paths, text length, voice, model, language, emotion, and
duration within one second of ffprobe. The media bytes are SHA-256 hashed and
copied without re-encoding into a native-helper-created current-user-only file.
The generated transcript and JSON sidecars are likewise re-created under native
private-file policy and retained privately beside the media. The adapter returns:

```json
{"status":"completed","providerReceiptId":"local-cartesia-<sha256>","durationSeconds":12.3}
```

`providerReceiptId` is a local validation receipt derived from the exact
validated media bytes. The official helper does not expose a Cartesia request
ID, so this value is not a remote provider ID and makes no exactly-once claim.
The coordinator independently checks the media path, MP3 frame structure, size,
and digest before marking the job ready. Ready media is not Inbox delivery.

## Local validation

The producer tests use a fake speech helper and fixture bytes; they do not make
Cartesia, Proton Pass, network, or model calls. `ffprobe` behavior is tested at
the subprocess boundary. The parent still owns host service activation,
credential-session validation, target-host checks, and any end-to-end production
verification.
