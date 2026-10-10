# Extension plan

## Current product boundary

A single-owner private inbox for briefings and alerts. SQLite is the source of
truth for content, sources, media references and reading state. Local producers
write validated documents; network readers can only read/search and change
read/archive state. News text is untrusted and has no executable authority.

## Next: assistant with archive recall

Build retrieval first as an internal service returning item IDs, excerpts,
original source URLs and publication dates. Start with existing FTS5; measure
queries before adding embeddings. If semantic retrieval improves measured recall,
introduce a versioned embedding index and incremental jobs that can be rebuilt
from original content. Archive status must not exclude recall unless explicitly
requested. Apply owner access checks before retrieval.

The assistant should stream answers with citations to inbox records and original
sources, explaining when the archive lacks evidence. Keep provider credentials
server-side in the existing private credential store. Model configuration and
cost limits are explicit runtime settings. Inbox tools operate through the same
validated service functions used by the UI; do not let a model issue raw SQL.
Undoable read/archive actions can be tools with receipts. Destructive deletion,
external messages and starting work need explicit user intent and an auditable
confirmation policy. Retrieved documents cannot authorize tool calls.

## Later: agent approvals and inputs

Add a separate request entity with producer identity, external request ID,
capabilities, created/expiry timestamps, status and audit events. Approvals require
authenticated delivery and replay protection. The browser records exactly which
request/version the owner approved; producers consume a signed, idempotent result.
Race and expiry rules must be settled before an agent acts. A news post cannot
be transformed into an approval request by embedded instructions.

Mobile authentication, HTTPS and an explicit owner/session model become release
requirements before handling consequential approvals. Transport access through a
private network remains useful but does not replace agent/request identity.

## Later: starting agent threads

Use a provider adapter for authorized orchestration with durable request IDs and
run references. Show preparation, running, waiting, failed and completed states
from real receipts, and retain cancellation/recovery paths. Treat thread creation,
delegated subtasks and persistent schedules as different operations. Do not claim
any integration exists until its real run and result are verified.

## Shipping practice

Implement one vertical feature at a time: schema and API contract, service logic,
UI, meaningful regression coverage and browser checks, then gated deployment.
Preserve the previous healthy release. Keep observed defects as actionable issues;
planned possibilities must never appear as working controls in the product.
