import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Identity, Revision } from '../../lib/observatory/contracts';
import { publishSchema } from '../../lib/observatory/contracts';
import { ApiError } from '../items';
export function openObservatory(directory=process.env.INBOX_DATA_DIR) {
  if(!directory) throw new ApiError(503,'Observatory storage unavailable');
  const root=resolve(directory);mkdirSync(root,{recursive:true,mode:0o700});
  const file=join(root,'observatory.sqlite');const db=new Database(file);chmodSync(file,0o600);
  db.pragma('busy_timeout = 5000');db.pragma('journal_mode = WAL');db.pragma('synchronous = FULL');
  db.exec('CREATE TABLE IF NOT EXISTS revisions (identity TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(identity,revision))');
  return db;
}
function key(i:Identity) {return createHash('sha256').update(JSON.stringify([i.hostId,i.threadId,i.runId,i.attemptId])).digest('hex');}
export function publish(db:Database.Database, input:unknown, publisherId:string):Revision {
  const parsed=publishSchema.parse(input);const identity=key(parsed);
  return db.transaction(()=>{
    const row=db.prepare('SELECT MAX(revision) AS revision FROM revisions WHERE identity=?').get(identity) as {revision:number|null};
    const previous=row.revision??0;
    if(previous!==parsed.expectedRevision) throw new ApiError(409,`Stale revision; current revision is ${previous}`);
    const {expectedRevision:_,...data}=parsed;
    const revision={...data,revision:previous+1,publishedAt:new Date().toISOString(),publisherId};
    db.prepare('INSERT INTO revisions VALUES(?,?,?)').run(identity,revision.revision,JSON.stringify(revision));return revision;
  }).immediate();
}
export function latest(db:Database.Database):Revision[] {return (db.prepare('SELECT r.payload FROM revisions r JOIN (SELECT identity,MAX(revision) revision FROM revisions GROUP BY identity) l USING(identity,revision) ORDER BY r.rowid DESC LIMIT 2000').all() as {payload:string}[]).map(r=>JSON.parse(r.payload));}
export function history(db:Database.Database, identity:Identity):Revision[] {return (db.prepare('SELECT payload FROM revisions WHERE identity=? ORDER BY revision DESC LIMIT 100').all(key(identity)) as {payload:string}[]).map(r=>JSON.parse(r.payload));}
