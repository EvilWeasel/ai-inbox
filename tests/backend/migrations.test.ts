import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/server/db';
import { ingestSchema } from '../../src/lib/contracts';
import { upsertBatch, patchItem, listItems } from '../../src/server/items';
import { migrate } from '../../src/server/migrations';

function asV2(sqlite:ReturnType<typeof openDatabase>['sqlite']) {
  sqlite.transaction(()=>{
    sqlite.exec(`DROP TRIGGER items_ai; DROP TRIGGER items_ad; DROP TRIGGER items_au;
      DROP TRIGGER items_revision_insert; DROP TRIGGER items_revision_delete; DROP TRIGGER items_revision_update;
      CREATE TABLE items_v2 (id TEXT PRIMARY KEY NOT NULL,external_id TEXT NOT NULL,title TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('briefing','alert')),edition TEXT CHECK(edition IN ('morning','evening')),
        published_at TEXT NOT NULL,body TEXT NOT NULL,summary TEXT NOT NULL,sources TEXT NOT NULL,tags TEXT NOT NULL,
        audio_file TEXT,audio_duration REAL,read_at TEXT,archived_at TEXT,provenance TEXT NOT NULL);
      INSERT INTO items_v2(rowid,id,external_id,title,kind,edition,published_at,body,summary,sources,tags,audio_file,audio_duration,read_at,archived_at,provenance)
        SELECT rowid,id,external_id,title,kind,edition,published_at,body,summary,sources,tags,audio_file,audio_duration,read_at,archived_at,provenance FROM items;
      DROP TABLE items; ALTER TABLE items_v2 RENAME TO items;
      CREATE UNIQUE INDEX items_external_id ON items(external_id);
      CREATE INDEX items_order ON items(published_at DESC,id DESC);
      CREATE INDEX items_view_order ON items(archived_at,read_at,published_at DESC,id DESC);
      CREATE INDEX items_kind_order ON items(kind,published_at DESC,id DESC);
      CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN INSERT INTO items_fts(rowid,title,body,summary) VALUES(new.rowid,new.title,new.body,new.summary); END;
      CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN INSERT INTO items_fts(items_fts,rowid,title,body,summary) VALUES('delete',old.rowid,old.title,old.body,old.summary); END;
      CREATE TRIGGER items_au AFTER UPDATE OF title,body,summary ON items BEGIN
        INSERT INTO items_fts(items_fts,rowid,title,body,summary) VALUES('delete',old.rowid,old.title,old.body,old.summary);
        INSERT INTO items_fts(rowid,title,body,summary) VALUES(new.rowid,new.title,new.body,new.summary); END;
      CREATE TRIGGER items_revision_insert AFTER INSERT ON items BEGIN UPDATE inbox_revision SET revision=revision+1 WHERE singleton=1; END;
      CREATE TRIGGER items_revision_delete AFTER DELETE ON items BEGIN UPDATE inbox_revision SET revision=revision+1 WHERE singleton=1; END;
      CREATE TRIGGER items_revision_update AFTER UPDATE ON items WHEN old.title IS NOT new.title OR old.body IS NOT new.body
        OR old.read_at IS NOT new.read_at OR old.archived_at IS NOT new.archived_at
        BEGIN UPDATE inbox_revision SET revision=revision+1 WHERE singleton=1; END;
      DELETE FROM inbox_migrations WHERE version IN (3,5);`);
  }).immediate();
}

test('populated v2 forward migration preserves rows, rowids, user state, FTS, indexes and revision',()=>{
  const root=mkdtempSync(join(tmpdir(),'inbox-migrate-v2-'));const db=openDatabase(join(root,'data'));
  try {
    upsertBatch(db,[{item:ingestSchema.parse({externalId:'first',title:'Migration preserves',kind:'briefing',publishedAt:'2026-01-01T00:00:00Z',body:'Searchable oldbody',provenance:{source:'test'}})},{item:ingestSchema.parse({externalId:'second',title:'Another old record',kind:'alert',publishedAt:'2026-01-02T00:00:00Z',body:'State survives',provenance:{}})}]);
    const row=listItems(db,{view:'all'}).items.find(x=>x.title==='Migration preserves')!;patchItem(db,row.id,{read:true,archived:true});
    const rowid=(db.sqlite.prepare('SELECT rowid FROM items WHERE id=?').get(row.id) as {rowid:number}).rowid;
    db.sqlite.prepare('UPDATE inbox_revision SET revision=41 WHERE singleton=1').run();asV2(db.sqlite);
    migrate(db.sqlite);
    assert.equal(db.sqlite.prepare('SELECT version FROM inbox_migrations WHERE version=3').get()!=null,true);
    assert.equal((db.sqlite.prepare('SELECT revision FROM inbox_revision').get() as {revision:number}).revision,41);
    assert.equal((db.sqlite.prepare('SELECT rowid FROM items WHERE id=?').get(row.id) as {rowid:number}).rowid,rowid);
    const preserved=listItems(db,{view:'all',q:'oldbody'}).items[0];assert.equal(preserved.id,row.id);assert.ok(preserved.readAt);assert.ok(preserved.archivedAt);
    assert.equal(listItems(db,{view:'all',q:'Another'}).total,1);
    const schema=db.sqlite.prepare("SELECT type,name FROM sqlite_schema WHERE name IN ('items_external_id','items_order','items_view_order','items_kind_order','items_ai','items_ad','items_au','items_revision_insert','items_revision_delete','items_revision_update')").all() as {type:string;name:string}[];
    assert.equal(schema.length,10);assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM items WHERE kind IN ('briefing','alert')").get() && (db.sqlite.prepare("SELECT count(*) AS n FROM items WHERE kind IN ('briefing','alert')").get() as {n:number}).n,2);
    upsertBatch(db,[{item:ingestSchema.parse({externalId:'third',title:'New result',kind:'result',publishedAt:'2026-01-03T00:00:00Z',body:'result type searchable',provenance:{}})}]);
    assert.equal(listItems(db,{view:'all',kind:'result',q:'searchable'}).total,1);
  } finally {db.close();rmSync(root,{recursive:true,force:true});}
});

test('failed v2 rebuild rolls back DDL and leaves populated database usable for retry',()=>{
  const root=mkdtempSync(join(tmpdir(),'inbox-migrate-failure-'));const db=openDatabase(join(root,'data'));
  try {
    upsertBatch(db,[{item:ingestSchema.parse({externalId:'keep',title:'Rollback keeps row',kind:'alert',publishedAt:'2026-02-01T00:00:00Z',body:'kept in FTS',provenance:{}})}]);
    const id=listItems(db,{view:'all'}).items[0].id;db.sqlite.prepare('UPDATE inbox_revision SET revision=77 WHERE singleton=1').run();asV2(db.sqlite);
    db.sqlite.exec('CREATE TABLE items_next(blocking TEXT)');
    assert.throws(()=>migrate(db.sqlite));
    assert.equal((db.sqlite.prepare('SELECT count(*) n FROM items WHERE id=?').get(id) as {n:number}).n,1);
    assert.equal((db.sqlite.prepare('SELECT revision FROM inbox_revision').get() as {revision:number}).revision,77);
    assert.ok(db.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='items_ai'").get());
    assert.equal((db.sqlite.prepare('SELECT count(*) n FROM items_fts WHERE items_fts MATCH ?').get('kept') as {n:number}).n,1);
    db.sqlite.exec('DROP TABLE items_next');migrate(db.sqlite);
    assert.equal(listItems(db,{view:'all',q:'kept'}).total,1);
    assert.equal((db.sqlite.prepare('SELECT revision FROM inbox_revision').get() as {revision:number}).revision,77);
  } finally {db.close();rmSync(root,{recursive:true,force:true});}
});
