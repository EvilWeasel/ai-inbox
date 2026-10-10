# Live updates integration

`GET /api/events` is a same-origin SSE stream on the Node runtime. It sends only
opaque decimal revision tokens, never item content, paths or credentials:

```text
id: 42
event: baseline
data: {"revision":"42"}

```

Every connection starts with `baseline`, including reconnects with Last-Event-ID.
Later committed changes send `change` with the same payload shape. Treat a
baseline as mandatory resync, even if the token matches the last observed token:
a server restart, database restore or interrupted loader must recover. Heartbeats
are SSE comments after 15 seconds without a revision notification. Native
EventSource handles reconnect; no browser polling or custom retry timer is needed.

The stream uses existing Host validation, checks Origin when supplied, and rejects
cross-site and same-site Fetch Metadata. Same-origin GETs may omit Origin. It
sets private/no-store/no-transform and X-Accel-Buffering: no. The existing private
proxy must stream these responses and respect that header; disable SSE buffering
or response compression explicitly if a proxy ignores it. Verify baseline arrives
immediately and heartbeat arrives incrementally over the actual private HTTPS
route before declaring deployed streaming verified.

## Parent frontend changes

Import `useInboxEvents` from `./use-inbox-events`. Mount it once in Inbox, outside
list/detail conditional rendering. It returns `connected`, `reconnecting`, or
`unavailable` (the latter supports tests/environments without EventSource).
Callback identity can change on navigation without reconnecting. The callback
receives `{ revision, baseline, signal }`; signal aborts on unmount. Async callbacks
are serialized and bursts retain one trailing invalidation for the latest token.
Callbacks should handle loader failures with existing error/retry UI.

Delete the complete effect that installs focus, visibilitychange and the 60,000 ms
interval. Remove the toolbar Refresh button. Keep error-state Try again actions
as explicit recovery. Do not remove RefreshCw if those error actions still use it.
Show reconnecting as unobtrusive connection text, not an alert on every attempt.

For the current counter-driven loaders, use a pending invalidation ref and drain
on busy-state transitions so updates arriving during mutations/pagination are not
lost. Place this after `busy`, refresh controllers, and paginationRequest exist:

```tsx
const liveInvalidation = useRef(false);
const flushLiveInvalidation = useCallback(() => {
  if (!liveInvalidation.current || busy.current.pending ||
      busy.current.moreLoading || busy.current.loading) return;
  liveInvalidation.current = false;
  refreshController.current?.abort();
  detailController.current?.abort();
  paginationRequest.current++;
  setRefresh(n => n + 1);
  setDetailRefresh(n => n + 1);
}, []);
const connectionStatus = useInboxEvents(() => {
  liveInvalidation.current = true;
  flushLiveInvalidation();
});
useEffect(() => {
  flushLiveInvalidation();
}, [pending, moreLoading, loading, flushLiveInvalidation]);
```

This counter adapter deliberately schedules the existing effects; the hook's
async serialization applies only if the callback returns actual loader promises.
Preserve current query/selected-ID checks, aborted-request checks, detailRevision,
mutatingId and paginationRequest guards. A write must synchronously mark itself
busy and invalidate/abort pre-write list and detail requests before optimistic
state is applied. `busy.current.pending` must become true synchronously with that
write start, rather than waiting for a render. On completion it must become false
and trigger the pending live drain, even on errors. Never skip an event solely
because a mutation is active; defer it. Incrementing both counters ensures a
selected item outside the current list is reloaded too. Keep existing detail cache
and list scroll anchors, loaded-page replay, navigation URL and persistent audio
provider/node. Live updates must not change selection or scroll the reading pane.

Add `src/components/use-inbox-events.test.tsx` to the explicit `test:frontend`
script in package.json; the backend glob already includes events.test.ts. Parent
integration tests should additionally cover event arrival during mutation and
pagination, selected detail outside the list, loaded-page/reading scroll retention,
and stable audio playback. These behaviors cannot be proven by the hook alone.

## Storage and rollback

Migration 2 adds one singleton revision row and INSERT/UPDATE/DELETE triggers.
UPDATE uses null-safe comparisons of persisted item fields, so idempotent imports
and repeated read/archive writes do not advance it. Real changes, including media
and provenance updates, increment it in the writer's transaction. Rollback of a
batch also rolls back its revision increments. One revision per changed row is
intentional; readers coalesce all commits observed in each interval.

Each app process shares one revision read per second across connected clients;
there is no timer when no clients are connected. SQLite/WAL commits from separate
importer processes and old code are visible without filesystem notification races.
Multiple app processes each have their own bounded observation timer. Change
latency is normally up to one second plus network/loader time. Slow consumers are
closed rather than allowed unbounded queues; reconnect baseline resyncs them.

This migration is additive. Old releases continue to read/write the existing items
schema; triggers still advance revisions for their writes. Keep migration 2 and
its triggers when rolling code back. A coordinated code/data restore follows the
existing deployment lock and stopped snapshot procedure. Restored revision tokens
may decrease, which is why clients compare tokens for equality only and always
resync baselines. Do not manually reset the revision in a running database.
