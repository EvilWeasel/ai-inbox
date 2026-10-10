# Backend integration

Backend owns `src/server/**`, `src/app/api/**`, `src/lib/contracts.ts`, `scripts/import.ts`, `tests/backend/**` and `drizzle.config.ts`. Please add these to the frontend-owned package manifest:

- runtime: `better-sqlite3`, `drizzle-orm`, `zod`
- development: `@types/better-sqlite3`, `tsx`, `drizzle-kit`, `@types/node`
- scripts: `"test:backend": "tsx --test tests/backend/*.test.ts"`, `"import": "tsx scripts/import.ts"`

Use Node to execute production and importer code (Bun is the package manager). Next's server must externalize `better-sqlite3` (supported by Next's default server external package list). No remote ingestion route exists. The server requires `INBOX_DATA_DIR`; no machine-specific default is embedded. It initializes versioned schema, WAL, indexes and FTS triggers independently of the importer and Drizzle Kit. `drizzle.config.ts` is for schema inspection/generation; do not push schema over the runtime migration without reviewing FTS triggers.

List counts are global across all kinds/search terms: inbox = unarchived; unread = unread and unarchived; archive = archived. `total` counts the active view/kind/search before cursor. Search treats input as literal Unicode terms ANDed through FTS5, never as executable FTS syntax. A cursor is bound to its filters; page size 1–100 (default 30). Invalid parameters/cursor return 400. All API responses are private/no-store.

PATCH requires an Origin identical to the request origin; `Sec-Fetch-Site`, when supplied, must be same-origin or none. Missing Origin is rejected. Invalid/empty/unknown patch fields return 400. JSON body limit 4096 bytes. Health exposes only ready/not-ready.

CLI bulk import: `bun run import -- --source /path/to/project-or-ai-briefing --data-dir /private/data` (or `INBOX_DATA_DIR`). CLI explicit local ingestion: `bun run import -- --json /path/to/item.json --text /path/to/body.md --media /path/to/audio.mp3`. JSON metadata uses `externalId,title,kind,edition,publishedAt,body,summary,sources,tags,audioDuration,provenance`; required: externalId,title,kind,publishedAt,body (body may be supplied by --text). Optional --media must be an explicit MP3 path. No glob selection. Reimport changes content but preserves ID/read/archive. Media is copied using content hashes before the atomic DB transaction; failed transactions can leave harmless unreferenced media. Complete records are validated before any DB writes. Provenance is stored privately and omitted from API responses.

Bulk import only uses indexed briefing history and indexed delivered alert paths (including nested updates). Alerts sharing one delivered document become one item with all event provenance. No feed snapshots, candidate/dismissal records, setup audio, or arbitrary research files are ingested. Historical scratch paths are mapped using their `.t3-artifacts` suffix into the explicit source project. Audio must be the explicit index/metadata reference and inside the source audio root, including after symlink resolution. Missing audio yields text-only with an import warning; missing body is skipped with a warning. Historical migrated records and historical test editions are labeled with tags.

Documentation consulted using Parallel (receipts in `/tmp/ai-inbox-backend-docs.json` and `/tmp/ai-inbox-drizzle-docs.json`): [Next route handlers](https://nextjs.org/docs/14/app/building-your-application/routing/route-handlers), [Drizzle SQLite](https://orm.drizzle.team/docs/sqlite/get-started-sqlite), [SQLite FTS5](https://sqlite.org/fts5.html).

The installed better-sqlite3 13 release bundles its native prebuild (verified under Node 24). Bun attempts a redundant node-gyp build unless lifecycle trust is explicit. The manifest trusts esbuild/sharp only, so better-sqlite3 uses its supplied prebuild without requiring a compiler toolchain. Keep this setting in frozen installs. For ingestion after deployment, wrap the CLI in `flock "$DEPLOY_ROOT/deploy.lock" ...` as required by operations; the CLI does not read or execute private shell configuration.
