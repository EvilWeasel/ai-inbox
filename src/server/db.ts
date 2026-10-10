import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { migrate } from './migrations';
import * as schema from './schema';

export function openDatabase(dataDir = process.env.INBOX_DATA_DIR) {
  if (!dataDir) throw new Error('INBOX_DATA_DIR is required');
  const directory = resolve(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(join(directory, 'media'), { recursive: true, mode: 0o700 });
  const sqlite = new Database(join(directory,'inbox.sqlite'));
  try {
    chmodSync(join(directory,'inbox.sqlite'),0o600);
    sqlite.pragma('busy_timeout = 5000'); sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = FULL'); sqlite.pragma('foreign_keys = ON');
    migrate(sqlite);
    return { sqlite, orm: drizzle(sqlite, { schema }), directory, close: () => sqlite.close() };
  } catch (error) { sqlite.close(); throw error; }
}
export type InboxDatabase = ReturnType<typeof openDatabase>;
let singleton: InboxDatabase | undefined;
export function getDatabase() { return singleton ??= openDatabase(); }
