# Private audio job foundation

`scripts/audio-jobs.py` is a host-local foundation for future meaningful final
results whose producer metadata and spoken adaptation have already been
prepared. It is not connected to staging, completion capture, Inbox delivery,
live updates, a provider, or a scheduler. It never scans archives or searches for
an existing recording. A caller must select and identify an original MP3
explicitly.

## Store and identity

Create `AudioJobStore` with absolute paths to a private SQLite database and a
private media directory. The store requires `scripts/private-files.py` and uses
its private-file checks/creation plus `ensure_private_sqlite_database` and
`secure_sqlite_artifacts`. On POSIX, strict mode `0600` files and `0700`
directories are required. It has no weaker fallback if the helper is missing.
SQLite uses DELETE journaling; the private parent bounds sidecar creation, and
the native helper validates/hardens the database and any live sidecars at
connection and operation boundaries. Windows activation still depends on the
parent completing the native integration and testing described in
`docs/windows-producer.md`.

Call `enqueue(result_identity=..., metadata_path=..., spoken_text_path=...,
voice_profile_sha256=..., meaningful=True)` only for a future, meaningful,
final result. Both input files must be private. `result_identity` is the stable
producer identity, `content_sha256` is the spoken adaptation's exact UTF-8 byte
hash, and the voice-profile hash is supplied by the configured producer. The
unique identity tuple is producer result identity + content revision + voice
profile. Re-enqueue returns the same job; changing the spoken text creates a
new job. Re-enqueueing the same pending or terminal revision refreshes the
metadata/text file references and hashes; changing metadata while that revision
is running is rejected so the committed attempt request remains stable.
Metadata and spoken text stay in their private input files; the store keeps
their paths and hashes so it can detect later changes.

Pass both `original_mp3_path` and its precomputed `original_mp3_sha256` to reuse a
specifically selected original. The existing regular private MP3 is checked
against that hash and copied byte-for-byte into the private media directory;
the managed copy is checked against the same hash and used by a ready job. There is no
latest-file lookup, archive loop or implicit reuse. A changed content revision
cannot point to that old recording automatically.

## Worker protocol and recovery

The host coordinator supplies `HelperConfig` with a fixed argv prefix, helper
script path, non-secret `profile_ref` and bounded timeout. The subprocess is
invoked without a shell. A compact JSON request is sent over stdin; it contains
the result metadata and spoken text, the profile reference, attempt nonce and
one expected output path. No API credential is loaded by this module, passed in
argv, or written to SQLite. The external helper owns secure provider
configuration, must create its output as a private file, and must return one
small JSON receipt on stdout (the runner drains stdout while retaining at most
one receipt plus one overflow byte):

```json
{"status":"completed","providerReceiptId":"opaque-id","durationSeconds":12.3}
```

Duration is optional. Credential-named receipt fields are rejected. Stderr is
discarded. The attempt row and nonce are committed before starting the helper;
the receipt is committed before media validation. A receipt is evidence from
the helper, not a promise of provider exactly-once behavior. A successful exit,
valid receipt, expected private output path, a complete MPEG audio frame (with
valid header fields and any following frame data consistent), size bound and
computed SHA-256 are all required for `ready`. ID3 tags alone and ID3v1 `TAG`
markers alone are not accepted. This bounded local check does not decode audio
or assess speech quality.

`claim()` uses `BEGIN IMMEDIATE`, records a single attempt nonce and lease, and
enforces one global active claim. Only a pending job can be claimed by the
automatic runner. When another claim observes an expired running lease, it
changes the job to `uncertain`; it never resubmits that request. Timeout,
missing/invalid stdout, invalid/missing output and a nonzero helper exit after
process start are also uncertain. A process-creation error is known not to have
started and becomes `retryable_failure`; changed/missing local input becomes
`blocked`.

An operator must use `resolve()` with a reviewer and recorded evidence to retry,
block or mark reviewed media ready. Retries are explicit, count toward a
three-claim lifetime cap, and do not occur on a timer. `ready` means validated
media is stored; it does not mean the Inbox item was published or audio was
delivered. A separate coordinator must attach the exact job media and publish
audio status idempotently with its own durable delivery receipt. That
coordinator must keep text delivery and audio completion separate and must not
describe an older recording as matching a newer text revision.

## Current limits

- The module has no provider adapter, credentials, production config, service,
  automatic result capture, delivery integration or activation.
- Input metadata/text and generated MP3 are expected to be private local files;
  caller ownership and lifecycle remain with the host coordinator.
- The format check validates MPEG frame structure and size but does not decode
  audio or assess speech quality. The coordinator may add a bounded decoder check.
- The default recovery behavior intentionally favors review over another paid
  request. Operators need authoritative provider evidence before retrying an
  uncertain attempt.
- Windows use still requires tests under the personal producer user. This queue
  calls the native SQLite sidecar ACL helper, but this implementation does not
  claim Windows integration or activation readiness until the parent runs those
  tests.
