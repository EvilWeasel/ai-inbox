# Agent Observatory

`/observatory` is an independent private Inbox feature. Select a connected agent
in the searchable list or parent/child graph to give its dashboard the remaining
viewport. On desktop, current work, completed and next tasks, current/recent tools,
pending approvals and explicit stops share a constrained grid with independently
scrollable, keyboard-focusable panes. Mobile uses readable stacked panes and
section navigation. Identity, history and raw chat are separate disclosures. Raw chat is collapsed by default. The route does not start, resume,
approve, cancel or execute an agent or command.

## Data and authority

The actual Builder.io framework dependency is pinned to `@agent-native/core`
0.209.1. `src/server/observatory/actions/{read,register,publish}.ts` use
`defineAction` from `@agent-native/core/action`. A small Next.js compatibility
transport invokes the framework's validated and authorized action boundary;
browser UI and external agent HTTP requests use the same actions and storage.
This integrates actions into the existing Next application, rather than running
the Agent-Native Vite server, chat harness or automatic MCP registration.
Reference: https://www.agent-native.com/docs/actions-overview and
https://github.com/BuilderIO/agent-native. The motivating reference video is
`7GD0cehQx90`, “Introducing Agent-Native: the framework for agentic apps”,
Steve / Builder.io. Source evidence was checked against the official action API.

Native inventory, tools, messages, plans, runtime requests and context markers
are an **automatic native evidence feed**. A separately labeled **agent-authored
canvas** requires an explicit authenticated publish. A missing canvas never
becomes a fabricated plan or claimed intentional stop. Completed steps and the
in-progress native todo step are shown as native provenance when available.
Only explicit published checkpoints establish a reported intentional stop;
waiting, quiet output and run completion do not establish a user stop.

Private server configuration is selected with `INBOX_OBSERVATORY_CONFIG`, an
absolute, owner-only JSON file outside the checkout. No runtime configuration,
host addresses, tokens, account metadata or content belongs in Git.

```json
{
  "hosts": [{
    "id": "environment-key", "label": "Workstation",
    "environmentId": "expected-native-environment-id",
    "origin": "https://private-origin.example.test",
    "credentialFile": "/private/existing-peer-packet.json",
    "credentialPath": ["credential", "token"]
  }],
  "publishers": [{
    "producerId": "existing-producer-id", "hostId": "environment-key",
    "threadId": "thread-id", "runId": "run-id", "attemptId": "attempt-id"
  }]
}
```

Host origins come only from that file, never HTTP input. Redirects are rejected.
The expected descriptor environment and orchestration protocol 2 are checked
before native authenticated reads. Existing credential files are resolved only
server-side; no browser bearer is installed. Publisher authentication reuses
`INBOX_PRODUCERS_FILE`; a read credential alone grants no publish authority.
A static producer binding or an opted-in host registration must match host,
thread, run and attempt, and a fresh native read must confirm the latest unique
ordinal run and active attempt before writes.
The publish check and commit cannot be atomic with a remote host run transition;
a transition immediately after verification remains a distributed race.

## Shared actions

- `GET /api/observatory/actions/read` returns `{hosts,threads,canvases,observedAt}`.
- `GET /api/observatory/actions/read?hostId=…&threadId=…` returns focused native
  `{hostId,snapshotSequence,projection,canvases,history,observedAt}`.
- Focused reads use the native `/api/orchestration/threads/:id/bounded` endpoint,
  with complete control-plane arrays and a recent timeline window. They add
  `coverage:{historyCursor,hasMoreHistory,latestLocalTurnOrdinal,payloadBudgetExceeded}`.
  No compact-turn-items opt-in is sent.
- Add `&cursor=…` for a native `/api/orchestration/threads/:id/history?cursor=…` page.
  The cursor is opaque and encoded without parsing. Response:
  `{hostId,threadId,snapshotSequence,items,nextCursor,hasMoreHistory,observedAt}`.
  Each item preserves `position`, `visibility`, `sourceThreadId`, `sourceItemId`
  and its nested native `item`, including compaction/context markers.
- Add `&itemId=…` to retrieve one actual persisted tool item, including output
  omitted from the projection. This uses scoped native WebSocket RPC
  `orchestration.getTurnItem`, verifies thread/item identity and closes the socket.
- `POST /api/observatory/actions/publish` accepts an existing producer Bearer,
  JSON content type and the following structured input. UI and agent clients
  reach the same action. A browser does not receive a credential to impersonate
  an agent; the first UI is an observer.

```json
{
  "hostId": "environment-key", "threadId": "thread-id",
  "runId": "run-id", "attemptId": "attempt-id", "expectedRevision": 0,
  "canvas": {
    "title": "My current work", "summary": "Agent-supplied explanation",
    "status": "working", "currentStep": "Validate the implementation",
    "plan": [{"id":"verify","text":"Validate behavior","status":"active"}],
    "checkpoints": [{"id":"review","reason":"User requested review before release",
      "requestedBy":"user","status":"planned","reachedAt":null,"evidence":""}],
    "layout": {"columns":2,"panels":["summary","plan","activity","history"],"accent":"blue"}
  }
}
```

Canvas status: `working|waiting|blocked|complete|unknown`. Plan status:
`pending|active|complete|blocked`. Checkpoints: `planned|reached`; reached requires
an ISO timestamp and nonempty evidence. This records a publisher assertion with
provenance, not independent proof of compliance. Layout is constrained panels,
columns 1–3 and `blue|green|amber|violet`; no arbitrary HTML, JavaScript, URLs,
styles or executable controls. Plain text is rendered by React escaping.

Successful publish returns the persisted revision (201). Stale CAS returns 409;
re-read before deciding whether to republish. There are no automatic retries.
Each `(host,thread,run,attempt)` identity starts at revision 1; a compaction that
retains that identity retains its counter. A new attempt gets a new counter,
and previous identities remain visible in history. History returns the latest
100 revisions per retained identity; inventory returns the latest 2000 identity
canvases. SQLite writes use immediate transactions with primary-key enforcement.
The generic `scripts/observatory-publish.py` helper reads existing private
producer configuration and private JSON input without printing credentials.

## Freshness and limits

All configured hosts remain in inventory, including unavailable hosts. Unknown
configuration has an explicit empty state. Native shell reads include active and
archived arrays returned by the source, deduplicate by thread ID, and include
parent thread identities. Selection loads only that thread; it does not fetch
every thread projection. Host reads run concurrently. HTTP reads are bounded to
16 MiB and 12 seconds; individual tool RPC results are bounded to 4 MiB with
closed-socket cleanup. Known bearer values and credential-shaped fields are
redacted. Free-form tool input/output can still contain other sensitive content;
this is not a guarantee that arbitrary provider text is completely redacted.
Keep this endpoint behind the existing private access boundary.

Native data caches for up to five seconds. UI inventory refresh starts 15 seconds
after each read; detail refresh starts eight seconds after each read. Streams do
not overlap themselves. Agent selection aborts and ignores prior responses.
Unavailable detail retains the last successful selected-agent evidence with an
explicit stale warning and timestamp. Offline hosts do not invent thread lists.
The node view draws parent-to-child edges only for authoritative `parentThreadId`
links with matching host identity. It shows the currently loaded inventory slice
(60 more per action); missing or filtered parents are labeled outside the view.
Tab/Enter selects nodes; arrow keys move focus between parent, child and adjacent
nodes. No inferred cross-host edges or continuous animation is used.

Recent 40 actual tool events plus active events in the bounded window are rendered
with explicit counts, actual tool names or bounded first command lines. Native
reads and history pages retain the same 16 MiB/12 second bounds and five-second
cache. Older history loads explicitly and sequentially, retaining at most ten
pages in the browser. It never merges older run records into live control state;
current run/attempt selection continues to use the maximum run ordinal from the
latest bounded control-plane projection. Page failures preserve loaded evidence
and the retry cursor. Selection changes abort history reads. Live refreshes retain the loaded historical
cursor chain instead of resetting pages when the source snapshot sequence changes.
An explicit restart action clears loaded pages and begins at the newest coverage
cursor; request-generation guards ignore responses from an abandoned chain.
Native compaction markers and inherited source identities remain visible.

Coverage is shown separately from tool counts. Unknown/inconsistent metadata,
failed or oversized reads never establish complete history. Reaching a null
next cursor means the source end for that cursor chain, not a guarantee of all
provider content or full outputs. Unsupported bounded endpoints fail explicitly.
The viewport structure is covered by component tests; actual desktop/mobile
pixel fit and keyboard scrolling require root browser acceptance. Automatic
instrumentation of every agent is a separate integration: a canvas appears only
after a bound agent actually publishes.

## Release and rollback

Use the existing operations gates: frozen Bun 1.4.3 install, typecheck, backend
and frontend tests, production build and shutdown test on Node 24. No new service
or collector is installed. Pin the integrated source commit as the candidate;
root owns deployment, existing deployment lock, stopped data snapshot, atomic
release switch and readiness acceptance. Do not modify the source checkout or
active release in place. Include the private config path in the candidate's
existing service environment only after review.

The only new persistent file is `INBOX_DATA_DIR/observatory.sqlite` with its WAL
sidecars. Existing Inbox schemas and content are unchanged. The normal complete
data snapshot includes these files. Previous code ignores the additive database,
so code rollback leaves Inbox usable; restoring data uses the documented stopped
snapshot procedure. Preserve canvas history when investigating failures.

Release acceptance uses real configured hosts, root and child agents, a bound
actual publish changing both views, stale revision rejection, fresh attempt
binding, selected-agent output retrieval, explicit offline inventory, mobile and
keyboard inspection, reconnect and revision continuity. Unit tests use isolated
fixtures; they are not live host or browser acceptance evidence.

## Host producer registration and explicit agent opt-in

The optional `producerId` on one host entry enables enrollment for that **existing**
Inbox producer only. For example, add `"producerId":"existing-producer-id"` to
that host in the private configuration above. It is the authoritative association;
`hosts[].id` and the producer's display `host` may differ. A producer ID may opt in
only one host, and duplicate host IDs or producer associations fail closed. Hosts
without this field retain static `publishers` bindings and cannot auto-enroll.
Removing the field or changing it revokes that host's durable grants immediately.
No wildcard, new producer, native read-token enrollment, or new secret is created.

`POST /api/observatory/actions/register` uses the same pinned Agent-Native
`defineAction` boundary, existing producer Bearer, JSON validation, private origin
rules and rate limiter as publish. Its input is only the exact identity:

```json
{"hostId":"environment-key","threadId":"thread-id","runId":"run-id","attemptId":"attempt-id"}
```

The server requires the matching configured host producer, verifies the descriptor
of that configured native environment, and freshly reads the exact native thread.
Run ordinals must be unique nonnegative safe integers with unique run IDs. Only the
maximum ordinal run with status `running` or `waiting` and its exact active attempt
can register or publish. Supplied attempt records must agree with that pointer.
Ambiguous metadata, obsolete runs/attempts and cross-host requests fail closed.
Publish accepts a matching static binding **or** a matching unexpired registration,
and always performs the same fresh native check. CAS and canvas provenance stay
unchanged. Registration does not publish a canvas or change its revision.

Successful registration returns the identity, `producerId`, `registeredAt` and
`expiresAt` (201). Grants persist in a separate `registrations` table in the existing
`observatory.sqlite` for 24 hours, renewable only after another live verification.
A new registration replaces that producer/host/thread's previous attempt grant;
canvas history remains. Expired grants are rejected and pruned on registration.
The table is capped at 2000 live registrations; capacity returns 429 rather than
silently evicting another agent. Remote run transitions cannot be atomic with a
local registration or publish, so the documented distributed verification race
still applies. Static binding compatibility preserves its configuration shape;
native fixtures must now include the actual run ordinal.

**Authority is host level.** Agents sharing the same existing producer Bearer can
register and publish any currently active thread on that producer's opted-in host.
Neither the supplied thread ID nor the native read credential establishes
cryptographic per-agent isolation. This bridge is independent of fork298's
server-bound owner/provenance and its attested provider authoring work. Its canvas
remains an explicitly agent-authored assertion. A requested checkpoint is not
canonical proof that the checkpoint was reached.

### Generic stdlib helper

`scripts/observatory-agent.py` is an explicit opt-in client for one verified T3
thread. It reads the existing private bridge's `t3Origin`, `t3TokenFile` and
`producerConfigFile`, and the producer config's existing `endpoint` and `tokenFile`.
For a JSON token packet, set `t3TokenJsonPointer` (RFC 6901, for example
`/credential/token`) or the existing array path in the private bridge; `t3TokenPointer` is accepted as an alias.
Without a pointer the token file is read as plain text. The helper does not rewrite
configuration or copy credentials into files or output.

Pass `--environment-id` explicitly: the public native descriptor must match it
before the helper sends a native read credential. If the bridge also declares
`environmentId`, `t3EnvironmentId` or `expectedEnvironmentId`, each supplied binding
must match the argument. Pass the configured Observatory host ID separately from
producer host labels. Origins come only from private configuration, use HTTPS or
loopback HTTP by default. Existing private IPv4/IPv6 or CGNAT HTTP endpoints require
explicit `t3AllowPrivateHttp: true` in the private bridge; public HTTP remains
rejected. They reject credentials/query/fragment in URLs, and never follow redirects
or environment proxies. Private inputs must be bounded owner-only regular files
without symlink components. Native responses are bounded to 16 MiB/12 seconds.

```sh
python3 scripts/observatory-agent.py \
  --bridge-config /private/existing-bridge.json \
  --environment-id expected-native-environment-id \
  --host-id environment-key --thread-id verified-t3-thread-id \
  --canvas /private/current-canvas.json
```

`--canvas` contains only the structured `canvas` object in the publish example,
including its constrained layout. The helper resolves the current run/attempt
from the native bounded projection, registers that identity, reads the focused
Inbox canvas state, and sends one publish with the read revision as explicit CAS
(or zero for a new identity). Optional `--expected-revision N` additionally asserts
an operator-specified revision and stops if the read differs. A 409 stops; no blind
retry or revision increment occurs. Re-read and review the other writer's canvas
before an intentional new invocation. A transport failure can occur after commit;
inspect the stored revision before trying again. Output contains only success,
identity and revision, or a sanitized failure/status, never canvas text or tokens.
No audio, model call, background loop, service or adapter is started.

### Instruction snippet for later app-owner integration

Root may install the following narrow instruction in the appropriate app-owned
agent instructions once the helper and host opt-in are deployed. This source
change does not install it in global AGENTS, memory or provider configuration.
Use the concrete private paths/environment/host selected by the app owner:

> To opt in your own current T3 thread's agent-authored Observatory canvas, call
> `orchestrator_capabilities({})` in this same thread and use its returned
> `parentThreadId` as the verified T3 thread ID. Do not substitute a provider
> session UUID or infer an ID from logs. If that field is unavailable, stop and
> obtain a verified app-owned thread ID. Write your current structured canvas to
> an owner-only private JSON file, then invoke `python3 <installed-helper-path>
> --bridge-config <existing-private-bridge> --environment-id <expected-environment>
> --host-id <configured-host-id> --thread-id <verified-parentThreadId>
> --canvas <private-canvas-file>`. Invoke again when the plan/layout changes,
> after compaction, or in a new run/attempt; the helper resolves fresh native IDs
> and uses CAS. On conflict, inspect the current canvas before deciding to replace
> it. Report failures honestly; do not create credentials or publish another
> agent's state. This is host-producer trust and explicit authoring, not an
> attested provider-owner channel.

The helper is actual source-level opt-in instrumentation, **not automatic adoption
by every agent**. Root still owns deployment, private host opt-in configuration,
instruction installation, real child/root run acceptance and browser evidence.
Providers without an installed invoking instruction or equivalent integration
will continue to have native evidence without an authored canvas.
