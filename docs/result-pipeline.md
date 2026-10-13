# Future T3 result pipeline foundation

`scripts/result-pipeline.py` coordinates the private future-only capture journal
with text-first producer delivery and the existing `audio-jobs.py` queue. It is a
coordinator foundation; it does not make future T3 result delivery automatically
active by itself. It never scans message history or archives, processes child
replies as root results, installs a service, invokes a provider except through the
configured audio helper, or delivers progress and child work.

## Private configuration

Store a mode-0600 JSON config in a mode-0700 directory on POSIX. Native private
file checks apply on Windows; the pipeline does not use Windows chmod as a
privacy check. Configuration paths must be absolute and point to private files
or directories. The pipeline config has these required fields:

```json
{
  "captureConfigFile": "/private/t3-capture.json",
  "bridgeConfigFile": "/private/t3-results.json",
  "stateDir": "/private/result-pipeline",
  "decisionHelperArgv": ["/usr/bin/python3", "/private/trusted-classifier.py"],
  "audioDeliveryMode": "on_demand",
  "decisionHelperTimeoutSeconds": 60
}
```

`captureConfigFile` refers to the already initialized future capture adapter.
The pipeline does not call capture `init`, change its activation epoch, or scan
before that epoch. The bridge config supplies the existing producer config and
its allowed audio roots. `audioDeliveryMode` is optional and defaults to
`local` for compatibility. Set it explicitly to `on_demand` for current producer
delivery. Accepted values are `local`, `central` and `on_demand`. Local mode preserves the
existing behavior: `audioHelperConfigFile` supplies the audio job database/media
paths, fixed helper argv/path, non-secret profile reference and timeout in the
shape consumed by `audio-jobs.py`; `voiceProfileSha256` identifies the configured
voice.

On-demand mode needs neither the local helper config nor a voice profile. It
delivers written results and uploads a validated explicitly selected original
MP3 when present. Otherwise it completes the candidate as `text-delivered` with
reason `audio:on-demand`, without calling a speech helper or requesting/polling
central audio. Inbox generation requires an explicit owner action. An existing
spoken adaptation may remain staged but cannot trigger generation by itself.

Central mode needs neither `audioHelperConfigFile` nor `voiceProfileSha256`. The
producer config referenced by the bridge supplies the HTTPS `/api/results`
endpoint and private token file. After a successful text receipt binds a valid
Inbox item ID, the pipeline sends the exact immutable metadata body hash and
spoken adaptation to the same-origin central audio API. The server attaches
generated audio to that existing item. Central mode never opens the local
`AudioJobStore` or invokes Cartesia. See
[`request-result-audio.md`](request-result-audio.md) for endpoint validation,
response validation and retry behavior.

The classifier adapter is trusted local code and is not yet provided or
activated by this module. Its fixed argument vector is invoked with `shell=False`;
only bounded JSON on stdin/stdout is used. No credential belongs in argv. The
request contains only protocol version, exact captured thread/run identity,
final text, and the captured final message's source references. Its strict JSON
response supports `decision` (`meaningful`, `exclude`, or `review`), and for a
meaningful result requires `title` and `resultType` (`research`, `implementation`,
or `report`). Optional `spokenText` is a concise spoken adaptation. Optional
`originalAudio` is exactly `{ "path": absolutePath, "sha256": digest }`. The
recording must be a private regular file under a bridge-configured audio root
and its bytes must match the given hash. The helper cannot set origin, identity,
project, model, delivery ID, URLs, source references, endpoint or commands.
Unknown response fields fail closed.

For a meaningful decision, before decision validation the coordinator also
checks only the captured final text and that final message's captured
`sourceRefs` for explicit local MP3 references. It recognizes bounded Markdown
and HTML link targets, plain absolute MP3 paths, and `url`, `href`, or `path`
values in source-reference entries. One unique referenced recording is
accepted only after absolute-path, no-reparse, allowed-root, current-owner
private-file, 30 MiB, MPEG-frame, and content-hash checks. The computed hash becomes
the trusted `originalAudio` selection; the classifier does not inspect files or
choose the path. A trusted custom helper's own `originalAudio` selection is
preserved and must agree with any captured reference. Multiple, conflicting,
missing, network, URI, traversal, symlink, insecure, or invalid explicit MP3
references go to `review-needed`, preventing audio generation for that result.
Unrelated non-MP3 paths and results with no explicit MP3 reference follow the
normal audio flow. This check does not search files, prior results, archives,
thread history, or any uncaptured messages, and it never fetches a URL.

## Candidate processing and identity

Run one bounded candidate pass explicitly:

```sh
python3 scripts/result-pipeline.py --config /private/result-pipeline.json once --limit 10
```

`--limit` is 1 through 50 for each bounded pass: one cursor-based new-candidate
pass and one independently cursor-based due-retry pass. A page resumes after
its last examined completion timestamp and candidate ID, wraps only at the end,
and filters against the persisted capture activation epoch before paging. Old
pre-epoch rows and candidates with terminal coordinator decisions do not consume
pages or starve later work. Audio attachment retries use their own bounded
cursor in `audio-once`; that command may reconcile up to 50 existing jobs and
claims at most one pending synthesis job. Text and audio retries keep separate
counters and use a capped exponential delay.

Candidates must exist in the capture journal, have a parseable completion time
at or after its persisted activation epoch, match their deterministic candidate
ID, and use the exact expected `<candidateId>.json` filename in the private
capture directory. A staged capture first consults `t3-capture.py`'s
`staged_receipt(bridge_config, thread_id, run_id)`; that receipt wins even if
the capture text was removed. An excluded capture is not reinterpreted. Before
classification and first publication, the bridge fetches only that candidate's thread projection and calls
`find_final(projection, captured_run_id)`. It checks projection identity and the
captured final text hash; it never calls `current_run` or rebinds an older
candidate to whichever run is latest. An exact-run completion gate that is
still settling becomes a due `review-needed` retry with capped exponential
backoff. Classifier review/exclusion decisions and permanent provenance changes
remain terminal until a reviewed intervention.
No historical message table is read.

The stable delivery ID is the same identity as the authored T3 bridge:

```text
"t3-" + hex(SHA256(b"delivery\0" + f"{thread_id}\0{run_id}".encode()))
```

The Inbox producer host comes from the private producer config. Origin includes
only that host and the captured thread/run IDs. A `t3-thread://v1/ID` link is
included only when the captured thread ID satisfies the existing URL contract.
No project or model metadata is guessed. The captured final body is delivered
verbatim; the classifier does not summarize or replace it. Sources are narrowed
to HTTP(S) URL/title references already found on the captured final message.

Before text delivery and again before audio attachment, the coordinator checks
the existing outbox for a row with the exact thread/run. Any row state, including
pending, takes precedence; it is not treated as proof of delivery and is never
rewritten by this coordinator. The check intentionally runs before candidate
text is needed for staged capture rows.

## Durable processing, audio and recovery

The private pipeline SQLite journal records one row per candidate, immutable
candidate/decision/metadata/spoken hashes, status and capped producer receipt.
Additive `central_audio_job_id` and `central_audio_item_id` columns bind a
central status poll to the item ID from the successful written-send receipt.
Statuses are `candidate-reviewed`, `excluded`, `review-needed`,
`text-delivered`, `audio-pending`, `audio-ready`, `audio-delivered`, and
`blocked`. SQLite writes are short and do not span T3 fetches, classifier
execution, sender calls or audio helper work. A durable global lease prevents
concurrent coordinator instances from classifying or publishing the same batch;
a heartbeat renews it during bounded helper and network operations, and nested
same-owner operations do not release an outer lease early. Audio helper claim
leases exceed the configured helper timeout. A lost text-delivery response is
recovered by resending the immutable metadata with the same delivery ID; the
producer upsert preserves Inbox read/archive state. Metadata and spoken-text
hashes are checked before retry and audio queue use. Ready audio bytes must
match the audio job's recorded media hash. Receipt serialization is bounded as
structured JSON rather than truncating JSON bytes. Candidate failures are
isolated so later candidates in the same batch still run.

Text is sent without audio first. A specifically selected original MP3 is
attached to that same result after checking its allowed root and exact hash; it
always takes precedence over speech generation. No archive search or newest-file
selection occurs. If there is no spoken adaptation, text remains delivered. In
local mode, spoken text is enqueued under the same result identity in
`AudioJobStore`. `audio-once` may claim at most one configured helper job;
uncertain and blocked jobs are never retried automatically. A ready recording
is sent with the same delivery ID, and only a validated positive duration is
added to a derived audio receipt. Existing Inbox upsert semantics preserve
read/archive state.

In central mode, `audio-once` reconciles central jobs through the existing
bounded audio cursor. It does not call the local helper. If the initial POST
response was lost, a due audio pass resubmits the same immutable payload until
it can save the job binding; the backend's deterministic job identity makes
that safe. Pending jobs retain their job and item IDs. `ready` and
`ready_existing` mark audio complete on the same item; `needs_review` and
`superseded` become terminal blocked rows and are not resubmitted. Transient
service errors use the existing capped audio backoff. The exact authored-stage
check runs before each central request/status operation and before an original
recording upload.

In on-demand mode, `audio-once` settles pending synthesis candidates as written
deliveries, even when their old provider backoff has not elapsed. It retains job
identifiers and written receipts for audit, clears candidate audio retry timing,
and never opens a local job store or polls central jobs. Explicit original uploads
keep their normal retry behavior. Switching modes does not cancel previously
submitted provider jobs; stop or drain their worker separately. Blocked/uncertain
requests remain held for review.

```sh
python3 scripts/result-pipeline.py --config /private/result-pipeline.json audio-once
```

## Remaining activation work

This foundation is not proof of end-to-end automatic coverage. The parent-owned
host work still needs to provide and review the trusted classifier/author
adapter, finalize private config and helper protocol values, integrate the
coordinator into the already authorized future capture runtime, and obtain
runtime acceptance on Hephaestus and nixy plus pending Windows runtime
acceptance. No service, scheduler, credentials, network/provider call or paid
audio operation was performed while implementing this module. Historical
archives are deliberately outside scope.
