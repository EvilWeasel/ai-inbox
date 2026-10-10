# Local ingestion

The private producer workspace remains separate from public app code. The local
CLI imports indexed, delivered reports and referenced MP3 files; it retains each
stable item ID, read timestamp and archive timestamp on repeated imports.

```sh
INBOX_DATA_DIR=/absolute/private/data bun run import --source /absolute/private/producer
```

For a new producer use the validated JSON ingestion contract and explicit paths:

```sh
INBOX_DATA_DIR=/absolute/private/data bun run import --json item.json --text body.md --media audio.mp3
```

The `externalId` identifies a producer's report, not a delivery attempt. Reuse it
to update a report. Preserve original timestamps and sources. The item payload
contains `title`, `kind`, `publishedAt`, `body`, optional `edition`, `summary`,
`sources`, `tags`, `audioDuration` and private `provenance`. Consult the schema in
`src/lib/contracts.ts` for validation. Audio is copied into private content
addressed storage, never linked to arbitrary host files by an HTTP endpoint.

For automatic local synchronization install `scripts/ingest-sync.sh` beside the
deployment scripts and the dedicated `deploy/ai-inbox-ingest.*` user units. A
private owner-only mode-0600 `$HOME/.config/ai-inbox/ingestion.conf` supplies
`INBOX_SOURCE_DIR=/absolute/private/producer`. The timer imports once per minute
using the current release and the same deployment lock. It performs no research,
model calls, resynthesis, external notifications or confirmation of news events.
Only the news producers decide what was delivered. Failed imports are retried on
the next run, and systemd retains failure status in the private journal.

The producer should append an edition-specific row to `briefing_history` after
delivery: `at` (UTC timestamp), `date` (local date), `briefing_path`, `audio_path`
and `attachment_id`. Both morning and evening need distinct artifact paths.
Alerts need `alert_path`, `audio_metadata_path`, `alerted_at` and `delivery` in the
alert index. Baseline candidates and deliberately dismissed posts are excluded.
Do not change original historical receipts to make them look current.
