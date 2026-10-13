import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase, openDatabase, type InboxDatabase } from '../../src/server/db';
import { ingestSchema } from '../../src/lib/contracts';
import { upsertBatch, patchItem, listItems } from '../../src/server/items';
import { importRecords } from '../../src/server/importer';
import { InboxEventHub, inboxEventResponse, inboxRevision, shutdownEventHubs } from '../../src/server/events';
import { GET } from '../../src/app/api/events/route';

let root: string; let db: InboxDatabase;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'inbox-events-')); db = openDatabase(root); });
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
const item = (externalId = 'event', title = 'Update') => ingestSchema.parse({ externalId, title, kind: 'alert', publishedAt: '2026-01-01T00:00:00Z', body: 'Test content' });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('import/new/read/archive revisions are durable, no-op safe and atomic across connections', () => {
  const other = openDatabase(root);
  try {
    assert.equal(inboxRevision(db), '0');
    importRecords(other, [{ item: item() }]);
    assert.equal(inboxRevision(db), '1');
    const id = listItems(db, {}).items[0].id;
    importRecords(other, [{ item: item() }]); assert.equal(inboxRevision(db), '1');
    patchItem(db, id, { read: true }); assert.equal(inboxRevision(other), '2');
    patchItem(db, id, { read: true }); assert.equal(inboxRevision(other), '2');
    patchItem(db, id, { archived: true }); assert.equal(inboxRevision(other), '3');
    upsertBatch(other, [{ item: item('event', 'Changed') }]); assert.equal(inboxRevision(db), '4');
    db.sqlite.exec("CREATE TRIGGER reject_event BEFORE INSERT ON items WHEN new.external_id='reject' BEGIN SELECT RAISE(ABORT,'reject'); END");
    assert.throws(() => upsertBatch(db, [{ item: item('new') }, { item: item('reject') }]));
    assert.equal(inboxRevision(db), '4'); assert.equal(listItems(db, {}).total, 0); // archived
    db.sqlite.transaction(() => {
      upsertBatch(db, [{ item: item('uncommitted') }]);
      assert.equal(inboxRevision(other), '4');
    })();
    assert.equal(inboxRevision(other), '5');
    const reopened = openDatabase(root);
    try { assert.equal(inboxRevision(reopened), '5'); } finally { reopened.close(); }
  } finally { other.close(); }
});

test('hub emits no change for no-op writes, coalesces commits and shares observation', async (t) => {
  const reads = t.mock.method(db.sqlite, 'prepare');
  const hub = new InboxEventHub(db, 10, 10_000);
  const a: string[] = [], b: string[] = [];
  const offA = hub.subscribe(r => { if (r !== null) a.push(r); });
  const offB = hub.subscribe(r => { if (r !== null) b.push(r); });
  const other = openDatabase(root);
  try {
    await delay(30); assert.deepEqual(a, ['0']);
    upsertBatch(other, [{ item: item() }, { item: item('second') }]);
    await delay(30); assert.deepEqual(a, ['0', '2']); assert.deepEqual(b, a);
    upsertBatch(other, [{ item: item() }]); await delay(30); assert.deepEqual(a, ['0', '2']);
    offA(); offB(); const calls = reads.mock.callCount(); await delay(20);
    assert.equal(reads.mock.callCount(), calls); assert.deepEqual(a, ['0', '2']);
  } finally { offA(); offB(); other.close(); }
});

test('SSE baseline, heartbeat, abort/cancel cleanup and reconnect resync without replay', async () => {
  const hub = new InboxEventHub(db, 10, 20);
  const abort = new AbortController();
  const response = inboxEventResponse(new Request('https://inbox.example/api/events', { signal: abort.signal }), hub);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  assert.equal(response.headers.get('connection'), 'close');
  assert.match(response.headers.get('cache-control')!, /no-transform/);
  const reader = response.body!.getReader();
  const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
  assert.match(decode((await reader.read()).value), /event: baseline\ndata: {"revision":"0"}/);
  assert.equal(decode((await reader.read()).value), ': heartbeat\n\n');
  abort.abort(); assert.equal((await reader.read()).done, true);
  upsertBatch(db, [{ item: item() }]);
  const reconnected = inboxEventResponse(new Request('https://inbox.example/api/events', { headers: { 'last-event-id': '0' } }), hub);
  const next = reconnected.body!.getReader();
  assert.match(decode((await next.read()).value), /id: 1\nevent: baseline/);
  await next.cancel();
  // No active subscribers means a closed database will never be polled.
  db.close(); await delay(40); db = openDatabase(root);
});

test('events route rejects untrusted Host, Origin and browser cross-origin requests before opening DB', () => {
  const previous = process.env.INBOX_ORIGIN;
  process.env.INBOX_ORIGIN = 'https://inbox.example';
  try {
    for (const headers of [ { host: 'evil.example' }, { host: 'inbox.example', origin: 'https://evil.example' }, { host: 'inbox.example', 'sec-fetch-site': 'same-site' }, { host: 'inbox.example', 'sec-fetch-site': 'cross-site' } ] as Record<string, string>[]) {
      assert.equal(GET(new Request('https://inbox.example/api/events', { headers })).status, 403);
    }
  } finally { if (previous === undefined) delete process.env.INBOX_ORIGIN; else process.env.INBOX_ORIGIN = previous; }
});


test('same-origin route accepts absent Origin and configured proxy Host and closes on abort', async () => {
  const previousOrigin = process.env.INBOX_ORIGIN;
  const previousDir = process.env.INBOX_DATA_DIR;
  process.env.INBOX_ORIGIN = 'https://inbox.example';
  process.env.INBOX_DATA_DIR = root;
  try {
    for (const extra of [{}, { origin: 'https://inbox.example' }] as Record<string, string>[]) {
      const abort = new AbortController();
      const response = GET(new Request('http://localhost/api/events', {
        headers: { host: 'inbox.example', 'sec-fetch-site': 'same-origin', ...extra }, signal: abort.signal,
      }));
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type')!, /text\/event-stream/);
      const reader = response.body!.getReader();
      assert.match(new TextDecoder().decode((await reader.read()).value), /event: baseline/);
      abort.abort(); assert.equal((await reader.read()).done, true);
    }
  } finally {
    getDatabase().close();
    if (previousOrigin === undefined) delete process.env.INBOX_ORIGIN; else process.env.INBOX_ORIGIN = previousOrigin;
    if (previousDir === undefined) delete process.env.INBOX_DATA_DIR; else process.env.INBOX_DATA_DIR = previousDir;
  }
});


test('additive migration upgrades a populated v1 database without changing owner state', () => {
  upsertBatch(db, [{ item: item() }]);
  const id = listItems(db, {}).items[0].id;
  const state = patchItem(db, id, { read: true, archived: true });
  // Recreate the pre-migration schema, retaining its original item/FTS data.
  db.sqlite.exec(`DROP TRIGGER items_revision_insert; DROP TRIGGER items_revision_update;
    DROP TRIGGER items_revision_delete; DROP TABLE inbox_revision;
    DELETE FROM inbox_migrations WHERE version=2;`);
  const upgraded = openDatabase(root);
  try {
    assert.equal(inboxRevision(upgraded), '0');
    const {report: omittedReport, ...listState} = state; void omittedReport;
    assert.deepEqual(listItems(upgraded, { view: 'all' }).items[0], listState);
    assert.equal(listItems(upgraded, { view: 'all', q: 'content' }).total, 1);
    patchItem(upgraded, id, { read: false }); assert.equal(inboxRevision(db), '1');
  } finally { upgraded.close(); }
});

test('process shutdown closes active SSE streams, releases hub timers and is idempotent', async (t) => {
  const prepare = t.mock.method(db.sqlite, 'prepare');
  const sigtermBefore = process.listenerCount('SIGTERM');
  const sigintBefore = process.listenerCount('SIGINT');
  const first = inboxEventResponse(new Request('https://inbox.example/api/events'), new InboxEventHub(db, 10, 10_000)).body!.getReader();
  assert.match(new TextDecoder().decode((await first.read()).value), /event: baseline/);
  assert.equal(process.listenerCount('SIGTERM'), sigtermBefore + 1);
  assert.equal(process.listenerCount('SIGINT'), sigintBefore + 1);
  const second = inboxEventResponse(new Request('https://inbox.example/api/events'), new InboxEventHub(db, 10, 10_000)).body!.getReader();
  assert.match(new TextDecoder().decode((await second.read()).value), /event: baseline/);
  assert.equal(process.listenerCount('SIGTERM'), sigtermBefore + 1);
  assert.equal(process.listenerCount('SIGINT'), sigintBefore + 1);

  shutdownEventHubs();
  shutdownEventHubs();
  assert.equal((await first.read()).done, true);
  assert.equal((await second.read()).done, true);
  assert.equal(process.listenerCount('SIGTERM'), sigtermBefore);
  assert.equal(process.listenerCount('SIGINT'), sigintBefore);
  const readsAfterShutdown = prepare.mock.callCount();
  await delay(35);
  assert.equal(prepare.mock.callCount(), readsAfterShutdown);

  const rejected = inboxEventResponse(new Request('https://inbox.example/api/events'), new InboxEventHub(db));
  assert.equal((await rejected.body!.getReader().read()).done, true);
});
