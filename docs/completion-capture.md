# Host-local future completion capture

`scripts/t3-capture.py` is a local discovery adapter for future T3 root-run
completions. It is a separate candidate journal; it does not publish to the
Inbox, decide relevance, inspect audio, read arbitrary artifact paths, change
T3 state, or enumerate historical conversation messages. Explicit staging via
[`t3-delivery.md`](t3-delivery.md) remains the authored delivery path and takes
precedence when the exact thread/run already has an outbox receipt.

## Private configuration and activation

Use a private JSON config outside the checkout. On POSIX it must be mode 0600
and the capture directory is mode 0700; on Windows the native helper checks
owner and protected DACLs instead of relying on mode bits. Paths must be
absolute and cannot contain symlink or reparse-point components. The existing
bridge config must remain private and supplies the local T3
origin/token and explicit-stage outbox path described in `t3-delivery.md`.

```json
{
  "t3DatabaseFile": "/private/path/statev2.sqlite",
  "bridgeConfigFile": "/private/path/t3-results.json",
  "captureDir": "/private/path/t3-capture"
}
```

Initialize once, when the host-local adapter is deliberately activated:

```sh
python3 scripts/t3-capture.py init --config /private/path/t3-capture.json
python3 scripts/t3-capture.py once --config /private/path/t3-capture.json --limit 100
```

`init` persists a UTC activation epoch and never scans earlier completions. It
is idempotent: later `init` calls return the original epoch. `once` processes
at most 500 metadata rows. A coordinator may call it repeatedly; this adapter
does not install a timer or service. Candidates are unique on `(thread_id,
run_id)` with a deterministic SHA-256 candidate ID.

## Metadata adapter and cursor

Adapter schema version 1 uses a read-only SQLite connection to the host's
`statev2.sqlite`. It verifies these installed projection tables and fields before scanning:

- `orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,active_provider_thread_id,created_at,updated_at,archived_at,deleted_at,payload_json,provider_instance_id)`
- `orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_thread_id,status,requested_at,completed_at,payload_json,provider_instance_id)`
- `orchestration_v2_projection_subagents(subagent_id,thread_id,run_id,parent_node_id,provider,provider_thread_id,child_thread_id,origin,status,started_at,completed_at,updated_at,payload_json,driver,provider_instance_id)`

The live schema check on 2026-10-10 confirmed these names and columns using a
read-only, schema-only connection; no production rows were read. The scan reads
run completion fields and thread archived/deleted flags. It does not read thread
titles or `payload_json`, and it does not query any message table. Child identity
comes from `orchestration_v2_projection_subagents.child_thread_id` across the whole
metadata database, including archived/deleted thread records; it is not guessed
from thread ID prefixes. Deleted roots are recorded as excluded. An archived
root remains eligible for a future completion. A completed run without a matching
thread row becomes a hard review candidate and is never sent to HTTP.

The persisted cursor is a binary-ordered `run_id` keyset, not a completion-time
high-water mark. The SQL sweep filters to successful completions from the activation epoch, with
a one-second timestamp overlap and exact UTC validation afterward. Historical
rows cannot consume capture pages. Each bounded page commits its decisions and cursor together.
At end of a pass, the next call resets to the beginning. Repeated full sweeps
allow late updates to an older run row and newly discovered identifiers that
sort before the current cursor to be found, including identical completion
timestamps and after restart. This trades repeated metadata reads for no
timestamp-watermark gap. If a metadata query, schema check or capture-state
transaction fails, the call fails closed and does not commit that page's cursor.
An unavailable or changed local schema needs an adapter update; it is not
treated as an empty result set.

## Candidate decisions and limits

Only rows with `status=completed` and a parseable `completed_at` at or after
the activation epoch are candidates. For a root candidate without a matching
explicit outbox stage, the adapter fetches only that exact thread's existing
HTTP projection using the imported `fetch_snapshot` bridge function. It checks
the thread identity and calls the existing `find_final(projection, run_id)`
completion gate for that exact run. The gate excludes tool/progress messages,
child replies, incomplete roots and streaming assistant messages. The selected
root final assistant text and source references found on that final message
(plus URLs in its text) are stored privately for review; no other projection
message text is copied.

Candidate statuses are `observed`, `staged`, `excluded` and `needs_review`.
The first adapter version records non-staged eligible finals as
`needs_review`, because authored relevance and delivery are decisions for a
later pipeline. Matching outbox rows are recorded as `staged` with the stable
delivery identity and any local receipt. Delegated child threads and deleted
roots receive `excluded` with an audit reason. Missing, changed or unknown
projections, or incomplete exact-run gates, remain `needs_review` with a bounded
reason and no automatic delivery. A snapshot or unsupported metadata interface
failure does not advance capture's metadata cursor when the underlying metadata
read itself failed; an individual projection failure is an auditable review
candidate, not a successful delivery. Unsupported projection shapes and identity
mismatches are hard review cases.

Candidates with missing text after a transient HTTP failure or an incomplete
completion gate receive a diagnostic class, retry count and next-attempt time.
Retries use exponential backoff from 60 seconds up to six hours, stop after 32
attempts, and process at most `min(--limit, 50)` due candidates per invocation.
Only missing-text candidates are retried. Ready text is never fetched again, and
unsupported shapes or source mismatches are not retried. HTTP fetches happen
before the short capture write transaction. Decisions and cursor still commit
together, so remote failures become durable candidates without pinning the cursor
or blocking unrelated rows.

An explicit outbox record can replace an earlier projection-only capture and its
text file while retaining the same candidate ID. The outbox state is copied as-is:
`pending` means queued work and does not mean delivery completed. Existing runs
are checked for a later stage receipt as they recur during full sweeps.

The capture SQLite database and final-text JSON files are private (0600 files,
0700 directory on POSIX, protected current-user ACLs on Windows). SQLite WAL,
SHM and journal artifacts are validated and secured after creation. The T3
metadata database is opened read-only and is not chmodded or ACL-modified.
Snapshot responses retain the existing 5 MiB bridge cap; final
text is capped at 1,000,000 UTF-8 bytes. The adapter stores no raw exception
text, titles, token values, or arbitrary artifact contents. Retries only recover
missing snapshots or completion-gate state; they never publish. Validation here
covers schema-only live metadata and real-shaped fixtures. It does not validate
production initialization, activation, coordinator scheduling, live HTTP behavior,
delivery, or host installation; those remain separate owner-controlled work.
