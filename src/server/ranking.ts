import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { InboxDatabase } from './db';
import { ApiError } from './items';

export function rankingStatus(db: InboxDatabase) {
  // A killed process must not leave the button disabled indefinitely.
  db.sqlite.prepare("UPDATE ranking_runs SET state='failed',error='Ranking interrupted. Please try again.' WHERE state='running' AND created_at < ?")
    .run(new Date(Date.now()-30*60_000).toISOString());
  return db.sqlite.prepare('SELECT id,state,created_at AS createdAt,completed_at AS completedAt,error,context_info AS contextInfo FROM ranking_runs ORDER BY created_at DESC,id DESC LIMIT 1').get() ?? null;
}
export function startRanking(db: InboxDatabase) {
  if (!process.env.INBOX_RANKING_CONFIG) throw new ApiError(503,'AI ranking is not configured');
  const run = db.sqlite.transaction(() => {
    const latest = rankingStatus(db) as {id:string;state:string}|null;
    if (latest?.state === 'running') return {id:latest.id, start:false};
    const id=randomUUID();
    db.sqlite.prepare("INSERT INTO ranking_runs(id,state,created_at) VALUES(?,'running',?)").run(id,new Date().toISOString());
    return {id,start:true};
  }).immediate();
  if (run.start) {
    const child=spawn(process.env.INBOX_PYTHON ?? 'python3', [resolve('scripts/rank-inbox.py'),'--config',process.env.INBOX_RANKING_CONFIG,'--data-dir',db.directory,'--run-id',run.id], {stdio:'ignore', detached:false});
    child.on('error', () => { db.sqlite.prepare("UPDATE ranking_runs SET state='failed',error='Ranking worker could not start' WHERE id=? AND state='running'").run(run.id); });
    child.unref();
  }
  return rankingStatus(db);
}
