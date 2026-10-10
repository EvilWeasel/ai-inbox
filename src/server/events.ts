import type { InboxDatabase } from './db';

export function inboxRevision(db: InboxDatabase): string {
  // Keep the full SQLite integer precision on the wire. Revisions are opaque tokens.
  return (db.sqlite.prepare('SELECT CAST(revision AS TEXT) AS revision FROM inbox_revision WHERE singleton=1').get() as { revision: string }).revision;
}
type Listener = (revision: string | null, heartbeat: boolean) => void;

interface EventLifecycle {
  hubs: Set<InboxEventHub>;
  shuttingDown: boolean;
  registered: boolean;
  shutdown: () => void;
}

const lifecycleKey = Symbol.for('ai-inbox.event-hub.lifecycle');
const lifecycleGlobal = globalThis as typeof globalThis & Record<symbol, EventLifecycle | undefined>;

function lifecycle(): EventLifecycle {
  return lifecycleGlobal[lifecycleKey] ??= {
    hubs: new Set(),
    shuttingDown: false,
    registered: false,
    shutdown: shutdownEventHubs,
  };
}

function unregisterWhenIdle(state: EventLifecycle) {
  if (state.hubs.size || !state.registered) return;
  process.removeListener('SIGTERM', state.shutdown);
  process.removeListener('SIGINT', state.shutdown);
  state.registered = false;
}

function activateHub(hub: InboxEventHub) {
  const state = lifecycle();
  if (state.shuttingDown) throw new Error('Event stream server is shutting down');
  state.hubs.add(hub);
  if (!state.registered) {
    // Add our cleanup hook without replacing Next's graceful shutdown handlers.
    process.on('SIGTERM', state.shutdown);
    process.on('SIGINT', state.shutdown);
    state.registered = true;
  }
}

function deactivateHub(hub: InboxEventHub) {
  const state = lifecycle();
  state.hubs.delete(hub);
  unregisterWhenIdle(state);
}

/** Close active streams when the process is asked to stop. Exported so tests
 * can exercise shutdown without delivering a signal to the test runner.
 */
export function shutdownEventHubs() {
  const state = lifecycle();
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  for (const hub of [...state.hubs]) hub.shutdown();
  unregisterWhenIdle(state);
}

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
    if (lifecycle().shuttingDown) throw new Error('Event stream server is shutting down');
    const revision = inboxRevision(this.db);
    if (!this.listeners.size) {
      this.revision = revision;
      this.heartbeatAt = Date.now();
      this.timer = setInterval(() => this.check(), this.intervalMs);
      this.timer.unref();
      try { activateHub(this); } catch (error) {
        clearInterval(this.timer);
        this.timer = undefined;
        throw error;
      }
    }
    this.listeners.add(listener);
    listener(revision, false);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        clearInterval(this.timer);
        this.timer = undefined;
        deactivateHub(this);
      }
    };
  }
  shutdown() {
    clearInterval(this.timer);
    this.timer = undefined;
    const listeners = [...this.listeners];
    this.listeners.clear();
    deactivateHub(this);
    for (const listener of listeners) listener(null, false);
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
    // Next starts server.close() before our later-registered SIGTERM hook
    // closes the stream. Avoid leaving the ended SSE socket to the HTTP
    // keep-alive timeout after that response completes.
    'Connection': 'close',
    'Cache-Control': 'private, no-store, no-transform',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  } });
}
