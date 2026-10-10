# Central audio API and worker boundary

These routes are backend foundations. They do not start a worker, call a speech
provider, or enable central audio on a host. Written final results still arrive
through the authenticated `/api/results` endpoint. Producers then request speech
for the existing delivery and receive generated audio on that same Inbox item.

## Producer request

`POST /api/results/audio-jobs` accepts at most 24 KiB of JSON and requires the
same configured producer bearer token, trusted host, producer rate limit, and
optional same-origin validation as `/api/results`.

```json
{
  "protocol": 1,
  "deliveryId": "final-result-123",
  "bodySha256": "<64 lowercase hex characters>",
  "spokenText": "Eine knappe, natürliche deutsche Fassung des fertigen Berichts.",
  "spokenSha256": "<SHA-256 of the exact UTF-8 spokenText bytes>"
}
```

The object is strict: extra keys are rejected. The spoken adaptation must contain
1–3500 Unicode characters and may not contain control bytes. The exact body hash
must match the UTF-8 bytes of the existing result body. A missing delivery or a
delivery belonging to another producer returns 404; a body revision mismatch or
another adaptation already active for that body and voice profile returns 409.
The server obtains the producer identity only from bearer authentication. The
client cannot select a voice, provider, executable, or path.

The deterministic job key is SHA-256 of compact canonical JSON for
`[producerId, deliveryId, bodySha256, spokenSha256, voiceProfileSha256]`. The
server voice profile hash comes from `INBOX_AUDIO_PROFILE_SHA256` and must be
64 lowercase hex characters. It is required only when a new job is needed. An
item with existing original audio returns `{ "state": "ready_existing",
"itemId": "…" }` without creating a job. Identical retries return the same
`jobId`; a changed spoken adaptation for the same result revision and profile is
held for explicit review instead of creating another job.

## Status and media

`GET /api/results/audio-jobs/:id` requires the owning producer's bearer token.
It returns `jobId`, `itemId`, a safe state, and—only when ready—the media hash and
duration. A configured safe error code may be returned for `needs_review`. No
spoken text, provider details, or filesystem path is exposed. Normal owner Inbox
item reads include an `audioStatus` value while generation is pending or needs
review.

`GET /api/results/audio-jobs/:id/audio` is scoped to the same producer and only
serves ready audio while the item still has the exact written body revision and
the expected attached content-hash media name. It uses the Inbox media handler's
MP3 path validation, private cache headers, and byte-range support. No remote URL
is fetched.

## Local worker JSON protocol

The private worker invokes `scripts/central-audio.ts` with a static executable
and argument vector, `shell=false`, and exactly one JSON object on stdin. It
does not provide HTTP bearer tokens. The caller must hold the application
deployment lock for every CLI operation: even `list` can commit `superseded`
when a queued request's written body changed or an original recording arrived.

List at most ten queued or already-generating jobs. The worker reserves equal
discovery capacity for each state, so a growing queue cannot hide all active
requests:

```json
{"op":"list","limit":10}
```

The JSON result contains the trusted job fields, prepared speech text, expected
hashes, result title/identity, the current item body hash, and a boolean showing
whether audio is already attached. The worker must compare body hashes and stop
before generation when they differ or `item_has_audio` is true. Needs-review jobs
are excluded from the queue.

The worker can look up one deterministic request by ID when reconciling an older
local ledger job that falls outside the bounded list:

```json
{"op":"lookup","requestId":"<64 lowercase hex characters>"}
```

This operation returns that exact request and current item state, or `null` if
the backend request no longer exists. A stale body or newly attached original
audio atomically moves a queued/generating request to `superseded`. Backend
errors stop reconciliation before any local ledger claim.

An invalid row or unbound request can be resolved conditionally without a paid
ledger ID:

```json
{"op":"resolve","requestId":"<job id>","expectedState":"queued",
 "expectedBodySha256":"<body hash>","state":"needs_review",
 "safeErrorCode":"invalid_backend_request"}
```

Only queued/generating rows can move to `needs_review` or `superseded`; the
request ID, expected state and body hash must still match. `superseded` also
requires the current item body or audio to prove obsolescence. These conditional
operations cannot revive a ready or superseded request.

A reviewed recovery of a request already in `needs_review` uses the local-only
`review-retry` operation after `AudioJobStore.resolve(decision="retry", ...)`
has recorded the reviewer and evidence against the exact bound ledger job:

```json
{"op":"review-retry","requestId":"<job id>","ledgerJobId":"<bound ledger id>","expectedBodySha256":"<body hash>"}
```

This operation requires the request to remain `needs_review`, its ledger binding
and body hash to match, and the associated result to retain that exact body with
no attached audio. It atomically returns the request to `queued`, clears its
safe error code and increments the normal inbox revision. It does not make a
provider call. The worker still owns the attempt and applies the ledger's
claim limit; a failed or uncertain attempt returns to `needs_review` and is
never retried automatically. Use this only for one specifically reviewed
request at a time, and do not infer that a historical provider call did not
occur from a missing local receipt.

Bind a job to the existing durable Python ledger before progressing it:

```json
{"op":"update","requestId":"<job id>","ledgerJobId":"<ledger id>","state":"generating","safeErrorCode":null}
```

The only accepted update states are `generating` and `needs_review`. A request's
ledger binding cannot be changed after first assignment. A needs-review request
is not made queueable by this operation.

Attach one validated MP3 after the existing Python ledger reports it ready:

```json
{"op":"attach","requestId":"<job id>","ledgerJobId":"<ledger id>","bodySha256":"<expected result hash>","source":"<absolute private MP3 path>","mediaSha256":"<MP3 SHA-256>","duration":12.3}
```

The source must be a regular current-owner file under the configured
`INBOX_AUDIO_WORKER_MEDIA_DIR`, with no symlink/reparse ancestors, and no larger
than 30 MiB. The script reads and validates an actual MPEG audio frame, checks
the supplied content hash, and atomically copies to content-hash media storage.
The transaction then rechecks producer/delivery identity, exact written body
hash, ledger binding, and whether original audio has appeared. A stale result or
new original audio marks the request superseded and never overwrites the item.
Successful attachment changes only `audio_file` and `audio_duration` on the item
and marks the request ready in that same transaction. It does not change written
content, read state, archive state, or item ID. Retrying the same successful
attachment is idempotent; another ledger or media binding conflicts.

CLI stdout is a single JSON result. Errors contain only a safe status code; the
script does not print input content, provider credentials, or raw exception
details. The durable paid-attempt ledger and Cartesia adapter remain in the
existing Python worker and are intentionally outside these routes.
