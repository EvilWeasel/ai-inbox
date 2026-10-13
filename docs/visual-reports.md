# Visual research reports

A final result can include an optional `report` alongside its original Markdown
`body`. The authenticated `POST /api/results` contract and the local result
helper accept the same envelope. Existing producers need no changes.

The exact report schema and TypeScript `ResearchReport` type live in
`src/lib/report.ts`. Version 1 contains `title`, optional `subtitle`, `sections`
and `sources`. Section IDs and source IDs must be unique. Each section includes
`id`, `title`, optional `summary`, and one or more structured blocks:

- `text`: text and source IDs.
- `metrics`: label/value/detail facts with source IDs.
- `comparison`: columns and rows; every row has one cell per column.
- `bars`: nonnegative finite values, unit, labels and source IDs.
- `steps`: title/detail items with source IDs.

Sources include `id`, `title`, HTTP(S) `url`, and optional `publisher`, `date`
and `excerpt`. Credentials in URLs, unsupported URL schemes, unknown source
references, unknown fields, duplicate IDs and mismatched comparison rows are
rejected before writes. HTML, scripts, CSS, iframe URLs and arbitrary component
names are not part of the format. Producer strings remain untrusted data and
must be rendered as text. Source URLs are user-initiated links, never server
fetch targets or automatic browser resource requests.

A report's encoded JSON is bounded to 1 MiB; the final envelope is bounded to
2 MiB, including its Markdown body. Section/block/item limits also apply through
the schema. Storage uses a nullable `report_json` column introduced in forward
migration 5. It preserves identity, owner reading/archive state, provenance,
existing media and full-text search. Omitting `report` on reimport preserves an
existing report; explicitly supplying a valid report replaces it. Null is not a
report removal operation. Reimport with the same producer/delivery identity
updates the same Inbox item.

`GET /api/items/:id` returns `item.report` (null when absent) and
`item.reportAvailable`. `GET /api/items` returns `reportAvailable` but omits the
report payload. Legacy item fields, private host checks and producer
authentication remain in force. Updating a report advances the existing Inbox
revision so live clients refresh it. The original Markdown remains readable and
searchable independently of the visual report.

## Local helper

The helper runs on trusted local storage, needs no producer token, does not
synthesize audio, and prints only the item ID, whether it was created, and report
availability. Use the existing producer ID and delivery ID to attach a report
to an already delivered item. Run it from the integrated release/check-out with
its installed dependencies and private data configuration.

All local writers must hold the same deployment lock documented in
[operations](operations.md). Resolve the lock/data paths privately, then:

```sh
flock "$DEPLOY_ROOT/deploy.lock" \
  bun x tsx scripts/ingest-report.ts \
  --envelope "$FINAL_ENVELOPE" --report "$REPORT_JSON" \
  --producer-id "$PRODUCER_ID" --data-dir "$INBOX_DATA_DIR"
```

Alternatively include `report` directly in the final envelope and omit
`--report`. The envelope retains the existing required fields: `deliveryId`,
`title`, `body`, `resultType`, `origin`, `publishedAt`, and `phase: "final"`.
`summary`, `sources`, and `tags` remain optional. This local helper assumes the
caller holds the lock; it does not acquire a second lock internally. Source
files and receipts belong in private artifact storage, never in Git.

## Reader UI

The reader uses real `@openai/apps-sdk-ui` Button and Badge components, pinned
at 0.2.2. Its published package is MIT licensed and targets React 18/19 and
Tailwind 4, matching this app. It builds locally without a ChatGPT host bridge,
ChatKit session, model call, remote script, or external font. Official OpenAI
[UI guidelines](https://developers.openai.com/plugins/concepts/ui-guidelines)
identify it as the optional ChatGPT design-system component library.

The existing Inbox shell continues to use its shadcn components. Report-specific
layout supplies section navigation, fact typography, comparison tables that
adapt to the reader's container width, proportional bars, sequential steps and
source drilldowns. Original text is a separate reader view. Citation controls
focus the source region; closing it returns focus to the trigger. System/light/
dark appearance is shared with the Inbox, and reduced-motion preferences apply
to source scrolling. The report renderer validates the payload again and falls
back to the original text if it cannot render a valid report.

ChatKit is an agentic chat integration and would add an unnecessary runtime for
this stored report reader. The structured format deliberately accepts no
producer HTML or generated executable component trees. Rendering uses trusted
application code and escaped untrusted text, preserving the app's existing CSP
and private routes.
