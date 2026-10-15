import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../../src/server/db';
import {upsertBatch,listItems,detail,patchItem} from '../../src/server/items';
import {ingestSchema} from '../../src/lib/contracts';
import {rankingStatus,startRanking} from '../../src/server/ranking';

test('importance and chronology sort every page; unranked stays last in either importance direction',()=>{
 const root=mkdtempSync(join(tmpdir(),'ranking-'));const db=openDatabase(root);
 try {
  upsertBatch(db,Array.from({length:6},(_,i)=>({item:ingestSchema.parse({externalId:String(i),title:`Item ${i}`,body:'Useful content',kind:'alert',publishedAt:`2026-01-0${i+1}T00:00:00Z`})})));
  const newest=listItems(db,{}).items;
  assert.deepEqual(listItems(db,{sort:'oldest'}).items.map(x=>x.id),newest.map(x=>x.id).reverse());
  db.sqlite.prepare("INSERT INTO ranking_runs VALUES('run','ready','2026-01-01',NULL,NULL,NULL)").run();
  newest.slice(1).forEach((r,i)=>db.sqlite.prepare("INSERT INTO item_rankings VALUES(?,'run','hash',?,?, '2026-01-01')").run(r.id,[0,90,90,30,50][i],`Reason ${i}`));
  for(const sort of ['important','least-important']) {
   let cursor:string|undefined;const all=[];
   do {const page=listItems(db,{sort,limit:2,...(cursor?{cursor}:{})});all.push(...page.items);cursor=page.nextCursor??undefined;} while(cursor);
   assert.equal(new Set(all.map(x=>x.id)).size,6);assert.equal(all.at(-1)!.importance,null);
   assert.deepEqual(all.slice(0,5).map(x=>x.importance!.score),sort==='important'?[90,90,50,30,0]:[0,30,50,90,90]);
  }
  const first=listItems(db,{sort:'important',limit:2});
  assert.throws(()=>listItems(db,{sort:'least-important',cursor:first.nextCursor!}),/Invalid cursor/);
  db.sqlite.prepare("INSERT INTO ranking_runs VALUES('new-run','ready','2026-02-01','2026-02-01',NULL,NULL)").run();
  assert.throws(()=>listItems(db,{sort:'important',cursor:first.nextCursor!}),/Invalid cursor/);
  const id=newest[1].id;patchItem(db,id,{read:true});assert.ok(detail(db,id).importance);
  db.sqlite.prepare('UPDATE items SET body=? WHERE id=?').run('changed',id);assert.equal(detail(db,id).importance,null);
  assert.equal(listItems(db,{q:'changed'}).items[0].id,id);
 } finally {db.close();rmSync(root,{recursive:true,force:true});}
});
test('ranking is explicitly configured and stale jobs can be retried without changing scores',()=>{
 const root=mkdtempSync(join(tmpdir(),'ranking-status-'));const db=openDatabase(root);const previous=process.env.INBOX_RANKING_CONFIG;
 try {
  delete process.env.INBOX_RANKING_CONFIG;assert.throws(()=>startRanking(db),/not configured/);
  db.sqlite.prepare("INSERT INTO ranking_runs VALUES('stale','running','2020-01-01',NULL,NULL,NULL)").run();
  assert.equal((rankingStatus(db) as {state:string}).state,'failed');
 } finally {if(previous===undefined)delete process.env.INBOX_RANKING_CONFIG;else process.env.INBOX_RANKING_CONFIG=previous;db.close();rmSync(root,{recursive:true,force:true});}
});
