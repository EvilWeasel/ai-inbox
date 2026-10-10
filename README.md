# AI Inbox

A self-hosted inbox for source-linked AI briefings, alerts and finished agent results. Read or listen,
keep your reading state across devices, search previous reports and archive
items without losing them. Built for one owner on a private network.

Next.js App Router, React, TypeScript, Tailwind CSS, shadcn/ui, Drizzle and SQLite
with FTS5. Bun manages dependencies and scripts; production runs on Node.
No Vercel deployment or hosted database is required.

## Development

Install Node 24 and the Bun version pinned by CI, then:

```sh
bun install --frozen-lockfile
bun run dev
```

Set `INBOX_DATA_DIR` to a private directory outside the checkout to retain data.
Use the local ingestion CLI to populate it with actual reports. There is no
production demo feed. Authenticated final-result delivery is documented in
`docs/agent-results.md`. API contracts are documented
in `docs/implementation-contract.md`.

```sh
bun run typecheck
bun run test
bun run build
bun run test:shutdown
```

## Private operation

See [operations](docs/operations.md) for private interface binding, persistent
storage, immutable releases, deployment gates, rollback and backups. Repository
code may be public; content, audio, data directories, credentials and runtime
configuration must stay private. Network membership is the initial access
boundary; restrict allowed peers with your network ACLs.

The app accepts existing and newly produced briefings through a local importer.
Reading and archive state belongs to the database and survives reimport and
release changes. Markdown renders without raw HTML. Audio is served by item ID
with seek support; it never plays automatically. A persistent player keeps the
current recording and position while navigating, searching or opening another
item. Choose Play on another recording to switch. The bottom player provides
pause/resume, seeking, playback speed, volume/mute and a link back to the playing
item. Volume and speed are device preferences; opening mobile volume controls
does not mute playback. Type filters are directly selectable and appearance
menus support keyboard navigation.

A same-origin server event stream updates the list, selected report and reading
counts automatically after committed changes. Reconnection resynchronizes state;
loaded content stays usable while the connection recovers. See
[live updates](docs/live-updates.md) for the revision protocol and storage behavior.

## Extension direction

The first release focuses on a durable news inbox. Future work can add an
assistant with cited archive retrieval, inbox tools, and explicit confirmation
for consequential operations. Agent approvals need their own authenticated
producer contract, lifecycle, audit trail and idempotent delivery; they must not
be implemented as executable instructions inside news text. Starting agent
threads requires a separate authorized orchestration integration.

These are planned extensions, not capabilities claimed by this release. Keep
news ingestion, reading state, retrieval, assistant tools and approval handling
as separate modules so each can be shipped and tested independently.
