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
  "audioHelperConfigFile": "/private/audio-helper.json",
  "voiceProfileSha256": "64-lowercase-hex-characters",
  "decisionHelperTimeoutSeconds": 60
}
```

`captureConfigFile` refers to the already initialized future capture adapter.
The pipeline does not call capture `init`, change its activation epoch, or scan
before that epoch. The bridge config supplies the existing producer config and
its allowed audio roots. `audioHelperConfigFile` supplies the existing audio job
database/media paths, fixed helper argv/path, non-secret profile reference and
timeout in the shape consumed by `audio-jobs.py`. `voiceProfileSha256` is the
configured voice identity used by the queue.

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

Text is sent without audio first. When `spokenText` exists, it is enqueued under
the same result identity in `AudioJobStore`; a specifically selected original
MP3 may be reused only after path, allowed-root and exact hash checks. No archive
search or newest-file selection occurs. If there is no spoken adaptation, text
remains delivered. A specifically selected original MP3 is attached after text
with the same delivery ID and without synthesis. Otherwise audio remains
pending for a future reviewed preparation step.
Use `audio-once` to invoke at most one configured `AudioJobStore.run_one` helper
claim in an invocation. The job store's `uncertain` and `blocked` results are
never retried automatically. A ready recording is sent with the same delivery
ID. Its metadata is derived from the immutable text metadata; duration is added
only when the ready audio job supplies a validated positive duration. The
immutable base metadata and its hash remain unchanged. Existing inbox upsert
semantics attach that audio without resetting owner read/archive state. The authored-stage check is repeated
immediately before the audio send, so an explicit recording or authored result
is not replaced by the pipeline.

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
