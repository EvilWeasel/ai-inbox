import type { InboxDatabase } from './db';

export function inboxRevision(db: InboxDatabase): string {
  // Keep the full SQLite integer precision on the wire. Revisions are opaque tokens.
  return (db.sqlite.prepare('SELECT CAST(revision AS TEXT) AS revision FROM inbox_revision WHERE singleton=1').get() as { revision: string }).revision;
}
type Listener = (revision: string | null, heartbeat: boolean) => void;

/** One bounded read per second per server/database, independent of client count.
 * SQLite commits, rather than filesystem notifications, are the source of truth.
 * No retained event log is needed: every connection receives a resync baseline.
 */
export class InboxEventHub {
  private listeners = new Set<Listener>();
  private timer?: ReturnType<typeof setInterval>;
  private revision = '';
  private heartbeatAt = 0;
  constructor(private db: InboxDatabase, private intervalMs = 1000, private heartbeatMs = 15_000) {}
  subscribe(listener: Listener) {
    const revision = inboxRevision(this.db);
    if (!this.listeners.size) {
      this.revision = revision;
      this.heartbeatAt = Date.now();
      this.timer = setInterval(() => this.check(), this.intervalMs);
      this.timer.unref();
    }
    this.listeners.add(listener);
    listener(revision, false);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) { clearInterval(this.timer); this.timer = undefined; }
    };
  }
  private check() {
    try {
      const revision = inboxRevision(this.db);
      const changed = revision !== this.revision;
      const heartbeat = Date.now() - this.heartbeatAt >= this.heartbeatMs;
      if (changed || heartbeat) {
        this.revision = revision;
        this.heartbeatAt = Date.now();
        for (const listener of [...this.listeners]) listener(revision, !changed);
      }
    } catch {
      // Terminate so EventSource retries and receives a fresh baseline.
      for (const listener of [...this.listeners]) listener(null, false);
    }
  }
}
const hubs = new WeakMap<InboxDatabase, InboxEventHub>();
export function eventHub(db: InboxDatabase) {
  let hub = hubs.get(db);
  if (!hub) { hub = new InboxEventHub(db); hubs.set(db, hub); }
  return hub;
}
export function inboxEventResponse(request: Request, hub: InboxEventHub) {
  const encoder = new TextEncoder();
  let dispose = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe: (() => void) | undefined;
      const close = (closeStream = true) => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        request.signal.removeEventListener('abort', abort);
        if (closeStream) controller.close();
      };
      const abort = () => close();
      dispose = () => close(false);
      if (request.signal.aborted) { close(); return; }
      request.signal.addEventListener('abort', abort, { once: true });
      let baseline = true;
      try {
        unsubscribe = hub.subscribe((revision, heartbeat) => {
          if (closed) return;
          // Bound queued data for slow/disconnected consumers; reconnect resyncs.
          if (revision === null || (controller.desiredSize ?? 0) <= 0) { close(); return; }
          const frame = heartbeat ? ': heartbeat\n\n' :
            `id: ${revision}\nevent: ${baseline ? 'baseline' : 'change'}\ndata: ${JSON.stringify({ revision })}\n\n`;
          baseline = false;
          controller.enqueue(encoder.encode(frame));
        });
        if (closed) unsubscribe();
      } catch { close(); }
    },
    cancel() { dispose(); },
  });
  return new Response(body, { headers: {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'private, no-store, no-transform',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  } });
}
