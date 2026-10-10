# Central result audio producer client

`scripts/request-result-audio.py` is the bounded HTTPS client used by the
future result pipeline. It requests speech for an Inbox result that has already
been written and confirmed by the ordinary result sender. It never downloads
the generated MP3: the central worker attaches audio to that same item.

## Producer configuration

The client receives the existing private producer config through the T3 bridge.
It reads only `endpoint` and `tokenFile` from that file:

```json
{
  "endpoint": "https://private-inbox.example/api/results",
  "tokenFile": "/private/producer-token"
}
```

The endpoint must be HTTPS with the exact `/api/results` path, without user
information, query, or fragment. The audio route is constructed on the same
origin as `/api/results/audio-jobs`; clients cannot provide another API URL.
The config and token must pass the existing native private-file checks. The
bearer token is read from the token file and used only in the HTTP authorization
header. It is never accepted in arguments, logged, or placed in environment
variables. Normal certificate validation stays enabled. Redirects are refused
without forwarding credentials.

The Python entrypoints are:

```python
request_audio(config_path, metadata_path, spoken_path, expected_item_id)
get_audio_status(config_path, job_id, expected_item_id)
```

The client accepts private immutable metadata and spoken-text files rather than
arbitrary URLs, paths, commands, voice settings, or provider options. Before a
POST it verifies that metadata contains the stable `deliveryId` and exact body,
then calculates SHA-256 over the body's UTF-8 bytes and spoken file bytes. It
sends the spoken text verbatim. The adaptation is limited to 3,500 Unicode
characters. The full request object is the strict protocol 1 shape:

```json
{
  "protocol": 1,
  "deliveryId": "stable-result-id",
  "bodySha256": "64-lowercase-hex-characters",
  "spokenText": "A concise spoken adaptation.",
  "spokenSha256": "64-lowercase-hex-characters"
}
```

The API call happens only after the result sender returned `{ "delivered":
true, "itemId": "…" }`. The response item ID must exactly match that receipt.
Normal jobs must have a 64-character lowercase hexadecimal job ID. The
`ready_existing` response contains the existing item ID and no job ID. A lost
POST response is retried with the same immutable file contents; the backend
derives a deterministic job ID for that exact delivery, body, adaptation, and
voice profile.

## Status and failure handling

Status reads use only the fixed `GET /api/results/audio-jobs/<hex-job-id>` path
and require both the saved job ID and original written item ID to match. Safe
states are `queued`, `generating`, `ready`, `needs_review`, `superseded`, and
`ready_existing` (POST only). Ready responses may include `mediaSha256` and
`duration`; the client validates a lowercase SHA-256 and a finite positive
duration before returning normalized fields. It never accepts or returns media
paths.

Each request has a timeout no greater than 20 seconds and reads at most 16 KiB
of response data. Redirects, foreign item/job identities, malformed hashes,
invalid durations and authentication/provenance errors fail closed for review.
Temporary HTTP/service/network failures and unknown response shapes are marked
transient so the pipeline can use its capped audio retry cursor. API failures do
not undo a successfully written text result. Pending status checks retain the
central job/item binding. `needs_review` and `superseded` are terminal; the
pipeline does not submit a replacement request or overwrite the existing item.

The module has no CLI that takes secrets or starts synthesis. Its tests use a
mocked HTTP transport and private temporary files; they do not call the Inbox,
Cartesia, or any external service.
