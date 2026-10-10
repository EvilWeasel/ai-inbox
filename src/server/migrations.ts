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
}
