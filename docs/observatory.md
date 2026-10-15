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
0.209.1. `src/server/observatory/actions/{read,publish}.ts` use
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
The explicit producer binding must match host, thread, run and attempt, and a
fresh native read must confirm the latest run and active attempt before writes.
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
and the retry cursor. Selection changes abort history reads; a changed initial
coverage cursor resets loaded older pages so incompatible windows cannot merge.
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
