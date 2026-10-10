import type Database from 'better-sqlite3';

// Kept in code so standalone Next output and local importer use identical migrations.
export function migrate(sqlite: Database.Database) {
  sqlite.exec('CREATE TABLE IF NOT EXISTS inbox_migrations (version INTEGER PRIMARY KEY)');
  sqlite.transaction(() => {
    if (sqlite.prepare('SELECT version FROM inbox_migrations WHERE version=1').get()) return;
    sqlite.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY NOT NULL, external_id TEXT NOT NULL,
        title TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('briefing','alert')),
        edition TEXT CHECK(edition IN ('morning','evening')), published_at TEXT NOT NULL,
        body TEXT NOT NULL, summary TEXT NOT NULL, sources TEXT NOT NULL, tags TEXT NOT NULL,
        audio_file TEXT, audio_duration REAL, read_at TEXT, archived_at TEXT, provenance TEXT NOT NULL
      );
      CREATE UNIQUE INDEX items_external_id ON items(external_id);
      CREATE INDEX items_order ON items(published_at DESC,id DESC);
      CREATE INDEX items_view_order ON items(archived_at,read_at,published_at DESC,id DESC);
      CREATE INDEX items_kind_order ON items(kind,published_at DESC,id DESC);
      CREATE VIRTUAL TABLE items_fts USING fts5(title,body,summary,content='items',content_rowid='rowid',tokenize='unicode61');
      CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
        INSERT INTO items_fts(rowid,title,body,summary) VALUES(new.rowid,new.title,new.body,new.summary);
      END;
      CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
        INSERT INTO items_fts(items_fts,rowid,title,body,summary) VALUES('delete',old.rowid,old.title,old.body,old.summary);
      END;
      CREATE TRIGGER items_au AFTER UPDATE OF title,body,summary ON items BEGIN
        INSERT INTO items_fts(items_fts,rowid,title,body,summary) VALUES('delete',old.rowid,old.title,old.body,old.summary);
        INSERT INTO items_fts(rowid,title,body,summary) VALUES(new.rowid,new.title,new.body,new.summary);
      END;
      INSERT INTO items_fts(items_fts) VALUES('rebuild');
      INSERT INTO inbox_migrations(version) VALUES(1);
    `);
  }).immediate();
  sqlite.transaction(() => {
    if (sqlite.prepare('SELECT version FROM inbox_migrations WHERE version=2').get()) return;
    // Additive migration: old importers and releases also participate through triggers.
    sqlite.exec(`
      CREATE TABLE inbox_revision (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0)
      );
      INSERT INTO inbox_revision VALUES(1,0);
      CREATE TRIGGER items_revision_insert AFTER INSERT ON items BEGIN
        UPDATE inbox_revision SET revision=revision+1 WHERE singleton=1;
      END;
      CREATE TRIGGER items_revision_delete AFTER DELETE ON items BEGIN
        UPDATE inbox_revision SET revision=revision+1 WHERE singleton=1;
      END;
      CREATE TRIGGER items_revision_update AFTER UPDATE ON items
      WHEN
        old.id IS NOT new.id
        OR old.external_id IS NOT new.external_id
        OR old.title IS NOT new.title
        OR old.kind IS NOT new.kind
        OR old.edition IS NOT new.edition
        OR old.published_at IS NOT new.published_at
        OR old.body IS NOT new.body
        OR old.summary IS NOT new.summary
        OR old.sources IS NOT new.sources
        OR old.tags IS NOT new.tags
        OR old.audio_file IS NOT new.audio_file
        OR old.audio_duration IS NOT new.audio_duration
        OR old.read_at IS NOT new.read_at
        OR old.archived_at IS NOT new.archived_at
        OR old.provenance IS NOT new.provenance
      BEGIN
        UPDATE inbox_revision SET revision=revision+1 WHERE singleton=1;
      END;
      INSERT INTO inbox_migrations(version) VALUES(2);
    `);
  }).immediate();
  sqlite.transaction(() => {
    if (sqlite.prepare('SELECT version FROM inbox_migrations WHERE version=3').get()) return;
    // Rebuild the checked kind column without touching owner state or the external-content
    // FTS table. Preserve rowids because items_fts stores those exact rowid references.
    sqlite.exec(`
      DROP TRIGGER IF EXISTS items_ai;
      DROP TRIGGER IF EXISTS items_ad;
      DROP TRIGGER IF EXISTS items_au;
      DROP TRIGGER IF EXISTS items_revision_insert;
      DROP TRIGGER IF EXISTS items_revision_delete;
      DROP TRIGGER IF EXISTS items_revision_update;
      CREATE TABLE items_next (
        id TEXT PRIMARY KEY NOT NULL, external_id TEXT NOT NULL,
        title TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('briefing','alert','result')),
        result_type TEXT CHECK(result_type IN ('research','implementation','report')),
        origin TEXT,
        edition TEXT CHECK(edition IN ('morning','evening')), published_at TEXT NOT NULL,
        body TEXT NOT NULL, summary TEXT NOT NULL, sources TEXT NOT NULL, tags TEXT NOT NULL,
        audio_file TEXT, audio_duration REAL, read_at TEXT, archived_at TEXT, provenance TEXT NOT NULL
      );
      INSERT INTO items_next(rowid,id,external_id,title,kind,edition,published_at,body,summary,sources,tags,audio_file,audio_duration,read_at,archived_at,provenance)
        SELECT rowid,id,external_id,title,kind,edition,published_at,body,summary,sources,tags,audio_file,audio_duration,read_at,archived_at,provenance FROM items;
      DROP TABLE items;
      ALTER TABLE items_next RENAME TO items;
      CREATE UNIQUE INDEX items_external_id ON items(external_id);
      CREATE INDEX items_order ON items(published_at DESC,id DESC);
      CREATE INDEX items_view_order ON items(archived_at,read_at,published_at DESC,id DESC);
      CREATE INDEX items_kind_order ON items(kind,published_at DESC,id DESC);
      CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
        INSERT INTO items_fts(rowid,title,body,summary) VALUES(new.rowid,new.title,new.body,new.summary);
      END;
      CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
        INSERT INTO items_fts(items_fts,rowid,title,body,summary) VALUES('delete',old.rowid,old.title,old.body,old.summary);
      END;
      CREATE TRIGGER items_au AFTER UPDATE OF title,body,summary ON items BEGIN
        INSERT INTO items_fts(items_fts,rowid,title,body,summary) VALUES('delete',old.rowid,old.title,old.body,old.summary);
        INSERT INTO items_fts(rowid,title,body,summary) VALUES(new.rowid,new.title,new.body,new.summary);
      END;
      CREATE TRIGGER items_revision_insert AFTER INSERT ON items BEGIN
        UPDATE inbox_revision SET revision=revision+1 WHERE singleton=1;
      END;
      CREATE TRIGGER items_revision_delete AFTER DELETE ON items BEGIN
        UPDATE inbox_revision SET revision=revision+1 WHERE singleton=1;
      END;
      CREATE TRIGGER items_revision_update AFTER UPDATE ON items
      WHEN old.id IS NOT new.id OR old.external_id IS NOT new.external_id OR old.title IS NOT new.title
        OR old.kind IS NOT new.kind OR old.result_type IS NOT new.result_type OR old.origin IS NOT new.origin
        OR old.edition IS NOT new.edition OR old.published_at IS NOT new.published_at OR old.body IS NOT new.body
        OR old.summary IS NOT new.summary OR old.sources IS NOT new.sources OR old.tags IS NOT new.tags
        OR old.audio_file IS NOT new.audio_file OR old.audio_duration IS NOT new.audio_duration
        OR old.read_at IS NOT new.read_at OR old.archived_at IS NOT new.archived_at OR old.provenance IS NOT new.provenance
      BEGIN UPDATE inbox_revision SET revision=revision+1 WHERE singleton=1; END;
      INSERT INTO inbox_migrations(version) VALUES(3);
    `);
  }).immediate();
}
