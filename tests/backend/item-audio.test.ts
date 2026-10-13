import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase, openDatabase } from '../../src/server/db';
import { upsertBatch, listItems, detail } from '../../src/server/items';
import { requestItemAudio, itemAudioJobId } from '../../src/server/item-audio';
import { inboxRevision, InboxEventHub } from '../../src/server/events';
import { POST } from '../../src/app/api/items/[id]/audio-request/route';
import { GET } from '../../src/app/api/items/[id]/route';
import { ingestSchema } from '../../src/lib/contracts';

const root=mkdtempSync(join(tmpdir(),'inbox-demand-'));
process.env.INBOX_DATA_DIR=root;
process.env.INBOX_ORIGIN='https://inbox.example.test';
process.env.INBOX_AUDIO_ON_DEMAND='1';
const db=getDatabase();
const origin=process.env.INBOX_ORIGIN;
function add(name:string,kind:'result'|'alert'|'briefing'='result',audioFile?:string) {
  upsertBatch(db,[{item:ingestSchema.parse({externalId:name,title:name,kind,publishedAt:'2026-01-01T00:00:00Z',body:'Actual report '+name}),audioFile}]);
  return listItems(db,{view:'all'}).items.find(item=>item.title===name)!.id;
}
function job(id:string) {return db.sqlite.prepare('SELECT * FROM item_audio_jobs WHERE item_id=? ORDER BY created_at DESC').get(id) as {id:string;state:string;body_sha256:string};}
function count() {return (db.sqlite.prepare('SELECT count(*) n FROM item_audio_jobs').get() as {n:number}).n;}
function post(id:string,headers:Record<string,string>={origin},body?:string) {
  return POST(new Request(origin+'/api/items/'+id+'/audio-request',{method:'POST',headers,body}),{params:Promise.resolve({id})});
}
after(()=>{db.close();rmSync(root,{recursive:true,force:true});delete process.env.INBOX_DATA_DIR;delete process.env.INBOX_ORIGIN;delete process.env.INBOX_AUDIO_ON_DEMAND;});

test('POST requires trusted host and same origin; rejects caller settings without writes',async()=>{
  const id=add('protected'),before=count();
  for (const headers of [{},{origin:'https://evil.example.test'},{origin,host:'evil.example.test'},{origin,'sec-fetch-site':'cross-site'}] as Record<string,string>[]) {
    assert.equal((await post(id,headers)).status,403);
  }
  assert.equal((await post(id,{origin,'content-type':'application/json'},'{"model":"other"}')).status,400);
  assert.equal(count(),before);
  assert.equal((await post('missing')).status,404);
});

test('reading detail/list never queues or revises audio; all kinds support requests',async()=>{
  for (const kind of ['result','alert','briefing'] as const) {
    const id=add('kind-'+kind,kind),before=count(),revision=inboxRevision(db);
    assert.equal((await GET(new Request(origin+'/api/items/'+id),{params:Promise.resolve({id})})).status,200);
    listItems(db,{view:'all'});
    assert.equal(count(),before);assert.equal(inboxRevision(db),revision);
    const response=await post(id);assert.equal(response.status,202);
    const payload=await response.json();assert.deepEqual(Object.keys(payload),['item']);assert.equal(payload.item.audioStatus,'queued');
  }
});

test('repeated concurrent clicks and separate connections share one immutable job',async()=>{
  const id=add('concurrent'),before=count();
  const responses=await Promise.all(Array.from({length:8},()=>post(id,{origin,'content-type':'application/json'},'{}')));
  assert.ok(responses.every(response=>response.status===202));assert.equal(count(),before+1);
  const stored=job(id),revision=inboxRevision(db);
  const other=openDatabase(root);try {requestItemAudio(other,id);} finally {other.close();}
  assert.equal(count(),before+1);assert.equal(inboxRevision(db),revision);
  assert.equal(stored.id,itemAudioJobId(id,createHash('sha256').update('Actual report concurrent').digest('hex')));
});

test('state changes are visible publicly and needs_review never authorizes a paid retry',async()=>{
  const id=add('review');await post(id);
  for (const state of ['generating','needs_review']) {
    const before=inboxRevision(db);db.sqlite.prepare('UPDATE item_audio_jobs SET state=? WHERE item_id=?').run(state,id);
    assert.notEqual(inboxRevision(db),before);assert.equal(detail(db,id).audioStatus,state);
    assert.equal((await post(id)).status,202);assert.equal(job(id).state,state);
  }
  db.sqlite.prepare("UPDATE item_audio_jobs SET state='ready' WHERE item_id=?").run(id);
  assert.equal(detail(db,id).audioStatus,'ready');assert.equal((await post(id)).status,200);
});

test('body changes supersede paid claims immediately and queue a distinct current job',async()=>{
  const id=add('changing');await post(id);const first=job(id);
  db.sqlite.prepare("UPDATE item_audio_jobs SET state='generating' WHERE id=?").run(first.id);
  db.sqlite.prepare('UPDATE items SET body=? WHERE id=?').run('Updated report',id);
  assert.equal(job(id).state,'superseded');assert.equal(detail(db,id).audioStatus,'superseded');
  await post(id);
  assert.equal(detail(db,id).audioStatus,'queued');
  assert.equal((db.sqlite.prepare('SELECT count(*) n FROM item_audio_jobs WHERE item_id=?').get(id) as {n:number}).n,2);
  assert.equal((db.sqlite.prepare('SELECT state FROM item_audio_jobs WHERE id=?').get(first.id) as {state:string}).state,'superseded');
});

test('existing audio returns ready without a generation job',async()=>{
  const id=add('existing','result','a'.repeat(64)+'.mp3'),before=count();
  const response=await post(id);assert.equal(response.status,200);assert.equal((await response.json()).item.audioStatus,'ready');assert.equal(count(),before);
});

test('paused legacy requests remain stored but do not disable new default generation',async()=>{
  const id=add('legacy');
  db.sqlite.prepare(`INSERT INTO central_audio_requests(id,producer_id,delivery_id,item_id,body_sha256,spoken_sha256,voice_profile_sha256,spoken_text,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,'queued',?,?)`).run('b'.repeat(64),'producer','legacy',id,createHash('sha256').update('Actual report legacy').digest('hex'),'c'.repeat(64),'d'.repeat(64),'Existing speech','2026-01-01','2026-01-01');
  assert.equal(detail(db,id).audioStatus,null);
  await post(id);assert.equal(detail(db,id).audioStatus,'queued');
  assert.equal((db.sqlite.prepare('SELECT state FROM central_audio_requests WHERE item_id=?').get(id) as {state:string}).state,'queued');
});

test('committed job revisions publish through the existing event stream',()=>{
  const id=add('events'),hub=new InboxEventHub(db,60_000),seen:(string|null)[]=[];
  const dispose=hub.subscribe(revision=>seen.push(revision));
  try {requestItemAudio(db,id);hub.notifyCommit();assert.equal(seen.length,2);assert.equal(seen[1],inboxRevision(db));} finally {dispose();}
});
