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
  sqlite.transaction(() => {
    if (sqlite.prepare('SELECT version FROM inbox_migrations WHERE version=4').get()) return;
    // Central audio is additive: requests point at an existing result and never
    // change item identity or owner state. State transitions share the inbox
    // revision so SSE clients see queued/ready/review changes atomically.
    sqlite.exec(`
      CREATE TABLE central_audio_requests (
        id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=64),
        producer_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        body_sha256 TEXT NOT NULL CHECK(length(body_sha256)=64),
        spoken_sha256 TEXT NOT NULL CHECK(length(spoken_sha256)=64),
        voice_profile_sha256 TEXT NOT NULL CHECK(length(voice_profile_sha256)=64),
        spoken_text TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','generating','ready','needs_review','superseded')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ledger_job_id TEXT,
        media_sha256 TEXT CHECK(media_sha256 IS NULL OR length(media_sha256)=64),
        duration REAL CHECK(duration IS NULL OR (duration>=0 AND duration<1e9)),
        safe_error_code TEXT
      );
      CREATE UNIQUE INDEX central_audio_identity ON central_audio_requests(id);
      CREATE UNIQUE INDEX central_audio_item_profile
        ON central_audio_requests(item_id,body_sha256,voice_profile_sha256);
      CREATE INDEX central_audio_queue ON central_audio_requests(state,created_at,id)
        WHERE state IN ('queued','generating');
      CREATE INDEX central_audio_item_state ON central_audio_requests(item_id,state,updated_at);
      CREATE TRIGGER central_audio_revision_insert AFTER INSERT ON central_audio_requests BEGIN
        UPDATE inbox_revision SET revision=revision+1 WHERE singleton=1;
      END;
      CREATE TRIGGER central_audio_revision_state AFTER UPDATE OF state ON central_audio_requests
      WHEN old.state IS NOT new.state BEGIN
        UPDATE inbox_revision SET revision=revision+1 WHERE singleton=1;
      END;
      INSERT INTO inbox_migrations(version) VALUES(4);
    `);
  }).immediate();
}
