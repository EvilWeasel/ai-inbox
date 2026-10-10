# Finished agent results

The inbox accepts explicit final deliveries, in addition to briefings and release
alerts. Research, implementation and report results have distinct icons; audio
is an independent capability. Read/archive state remains owned by the inbox.
The result itself is inert content and never starts commands or agent actions.

## Delivery use cases and acceptance

- A completed research answer appears once with its sources, host/project origin
  and existing spoken MP3. The owner can listen on another authorized device.
- A completed implementation arrives with its concrete outcome and validation.
  Progress messages, tool logs and delegated intermediate replies stay in T3.
- A producer retries the same delivery after a lost response. The stable delivery
  ID prevents duplicates and preserves the owner's read/archive state.
- A delivery arriving while another recording plays updates the inbox through
  the live stream and leaves that recording and position alone.

## Producer contract

A producer uses `POST /api/results` with its own bearer credential. Browser state
writes continue to use their existing same-origin contract; producer credentials
are never delivered to the browser. Runtime producer configuration lives outside
Git at `INBOX_PRODUCERS_FILE` with private file permissions:

```json
{"producers":[{"id":"producer-id","host":"source-label","tokenHash":"SHA256_HEX"}]}
```

Generate a high-entropy token for each producer and store only its SHA-256 hash on
the server. Tokens can be revoked by removing their producer entry. The server
binds the origin host to that credential. Never put token values in chat, URLs,
source code, issues, agent instructions or repository metadata.

A text-only delivery sends JSON. Audio delivery sends multipart form data with
`metadata` containing the same JSON and `audio` containing an existing MP3:

```json
{
  "deliveryId":"stable-thread-run-or-message-id",
  "phase":"final",
  "title":"Concrete result title",
  "body":"The finished Markdown answer",
  "summary":"A useful short summary",
  "publishedAt":"2026-01-01T12:00:00Z",
  "resultType":"research",
  "sources":[],
  "tags":[],
  "origin":{"host":"source-label","project":"Project","threadId":"thread-id","runId":"run-id","model":"model-label"}
}
```

`resultType` is `research`, `implementation` or `report`. Only `phase: final` is
accepted. Optional `origin.threadUrl` can point to the original conversation when
the producer knows a valid HTTP(S) link or `t3-thread://v1/ID` reference; the UI must never turn arbitrary protocols into
an executable link. This endpoint does not fetch remote media or synthesize audio.
The producer explicitly uploads the original MP3. Metadata and uploads have
bounded sizes; invalid or unauthorized deliveries do not create an inbox item.

The server assigns the public item ID. A successful response returns `{item,
created}`. A duplicate delivery updates content and retains its item ID and user
state. The producer should record successful receipt before acknowledging a
watched event. Failed delivery remains pending; retry with the same delivery ID.

## Portable explicit delivery

`scripts/deliver-result.py` uses Python's standard library and sends one explicit
result. Its private JSON configuration is separate from result content:

```json
{"endpoint":"https://inbox.example.test/api/results","host":"source-label","tokenFile":"/private/path/producer-token"}
```

Both configuration and token files must be private regular files with no group
or other permissions. The token file contains the token itself. The script does
not follow redirects with credentials and prints only a delivery receipt or a
bounded error, never the token or result body.

```sh
python3 scripts/deliver-result.py --config /private/path/producer.json \
  --input /private/path/final-result.json --audio /private/path/answer.mp3
```

Omit `--audio` for text-only results. Metadata input can also use `--input -`.
This is an explicit delivery interface. Automatic T3 completion integration must
use verified final-run state, stable source IDs, host-owned credentials and
all future personal T3 threads through a host-level delivery policy. Completed
research, implementation and report deliverables should be staged automatically
with a spoken MP3; the owner should not have to opt in per thread. Existing audio
is reused exactly. If a result has no recording, the producing agent creates a
concise spoken adaptation through the configured audio provider. Ordinary replies,
progress, delegated intermediate work and already delivered news stay out of this
feed. Historical bulk import is separate from ongoing delivery.
