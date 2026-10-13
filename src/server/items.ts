import { createHash, randomUUID } from 'node:crypto';
import { eq, getTableColumns, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ingestSchema, querySchema, patchSchema, type InboxItem, type ItemList, type IngestItem } from '../lib/contracts';
import type { InboxDatabase } from './db';
import { items } from './schema';

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
type Row = typeof items.$inferSelect;
export function publicItem(row: Row, audioStatus: InboxItem['audioStatus'] = null, includeReport = true, reportAvailable = !!row.report): InboxItem {
  return { id:row.id,title:row.title,kind:row.kind,resultType:row.resultType,origin:row.origin,edition:row.edition,publishedAt:row.publishedAt,
    ...(includeReport ? {report:row.report ?? null} : {}), reportAvailable,
    body:row.body,summary:row.summary,sources:row.sources,tags:row.tags,audioAvailable:!!row.audioFile,
    audioDuration:row.audioDuration,audioStatus,readAt:row.readAt,archivedAt:row.archivedAt };
}
export function getRow(db: InboxDatabase, id: string) { return db.orm.select().from(items).where(eq(items.id,id)).get(); }
export function detail(db: InboxDatabase, id: string, includeReport = true) {
  // Lists select only availability, keeping large private report JSON out of page reads.
  const {report: reportColumn, ...columns} = getTableColumns(items);
  const row = includeReport ? getRow(db,id) : db.orm.select({...columns, report:sql<null>`NULL`, reportAvailable:sql<number>`CASE WHEN ${reportColumn} IS NULL THEN 0 ELSE 1 END`}).from(items).where(eq(items.id,id)).get();
  if (!row) throw new ApiError(404,'Item not found');
  const request = db.sqlite.prepare(`SELECT state,body_sha256 FROM central_audio_requests
    WHERE item_id=? ORDER BY updated_at DESC,created_at DESC,id DESC LIMIT 1`).get(id) as {state:InboxItem['audioStatus'];body_sha256:string}|undefined;
  let audioStatus: InboxItem['audioStatus'] = row.audioFile ? 'ready' : (request?.state ?? null);
  if (request && request.body_sha256 !== createHash('sha256').update(row.body,'utf8').digest('hex') && !row.audioFile) audioStatus='superseded';
  return publicItem(row,audioStatus,includeReport,'reportAvailable' in row ? Boolean(row.reportAvailable) : !!row.report);
}
export function patchItem(db: InboxDatabase, id: string, input: unknown) {
  const patch = patchSchema.parse(input);
  return db.sqlite.transaction(() => {
    const row = getRow(db,id); if (!row) throw new ApiError(404,'Item not found');
    const now = new Date().toISOString();
    const values: Partial<Row> = {};
    if (patch.read !== undefined) values.readAt = patch.read ? row.readAt ?? now : null;
    if (patch.archived !== undefined) values.archivedAt = patch.archived ? row.archivedAt ?? now : null;
    db.orm.update(items).set(values).where(eq(items.id,id)).run();
    return detail(db,id);
  }).immediate();
}
const cursorSchema = z.object({ at:z.string().datetime(), id:z.string().uuid(), filter:z.string().length(64) }).strict();
export function listItems(db: InboxDatabase, input: unknown): ItemList {
  const query = querySchema.parse(input);
  const filter = createHash('sha256').update(JSON.stringify([query.view,query.kind??null,query.q])).digest('hex');
  const where: string[] = []; const values: (string|number)[] = [];
  if (query.view === 'inbox') where.push('archived_at IS NULL');
  if (query.view === 'unread') where.push('archived_at IS NULL AND read_at IS NULL');
  if (query.view === 'archive') where.push('archived_at IS NOT NULL');
  if (query.kind) { where.push('kind = ?'); values.push(query.kind); }
  if (query.q) {
    const terms = query.q.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!terms.length) where.push('0');
    else { where.push('rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)'); values.push(terms.map(t => `"${t}"`).join(' AND ')); }
  }
  const sqlWhere = () => where.length ? ` WHERE ${where.join(' AND ')}` : '';
  // One read transaction keeps counts, total and the page on the same snapshot.
  return db.sqlite.transaction(() => {
    const total = (db.sqlite.prepare(`SELECT count(*) AS n FROM items${sqlWhere()}`).get(...values) as {n:number}).n;
    const counts = db.sqlite.prepare(`SELECT COALESCE(sum(archived_at IS NULL),0) AS inbox,
      COALESCE(sum(archived_at IS NULL AND read_at IS NULL),0) AS unread,
      COALESCE(sum(archived_at IS NOT NULL),0) AS archive FROM items`).get() as ItemList['counts'];
    if (query.cursor) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
        const cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor,'base64url').toString('utf8')));
        if (cursor.filter !== filter) throw new Error();
        where.push('(published_at < ? OR (published_at = ? AND id < ?))'); values.push(cursor.at,cursor.at,cursor.id);
      } catch { throw new ApiError(400,'Invalid cursor'); }
    }
    const rows = db.sqlite.prepare(`SELECT id FROM items${sqlWhere()} ORDER BY published_at DESC,id DESC LIMIT ?`).all(...values,query.limit+1) as {id:string}[];
    const page = rows.slice(0,query.limit).map(r => detail(db,r.id,false));
    const last = page.at(-1);
    const nextCursor = rows.length > query.limit && last ? Buffer.from(JSON.stringify({at:last.publishedAt,id:last.id,filter})).toString('base64url') : null;
    return { items:page,nextCursor,counts,total };
  })();
}
export type PreparedItem = { item: IngestItem; audioFile?: string | null };
export function upsertBatch(db: InboxDatabase, records: PreparedItem[]) {
  // Validation precedes the transaction; a bad record cannot partially import a batch.
  const parsed = records.map(({item,audioFile}) => {
    if (audioFile != null && !/^[a-f0-9]{64}\.mp3$/.test(audioFile)) throw new Error('Invalid media filename');
    return {item:ingestSchema.parse(item),audioFile};
  });
  db.sqlite.transaction(() => {
    for (const {item,audioFile} of parsed) {
      const {externalId, ...content} = item;
      const audio = audioFile === undefined ? {} : {audioFile};
      // Never overwrite owner state or stable IDs on conflict. Unknown audio stays intact.
      db.orm.insert(items).values({id:randomUUID(),externalId,...content,...audio}).onConflictDoUpdate({
        target:items.externalId, set:{...content,...audio},
      }).run();
    }
  }).immediate();
  return parsed.length;
}
