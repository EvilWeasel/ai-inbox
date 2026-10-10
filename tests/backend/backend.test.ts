import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type InboxDatabase } from '../../src/server/db';
import { ingestSchema, querySchema } from '../../src/lib/contracts';
import { detail, listItems, patchItem, upsertBatch, ApiError } from '../../src/server/items';
import { audioResponse, parseRange } from '../../src/server/audio';
import { assertSameOrigin, assertTrustedHost, readPatch, failure, queryInput } from '../../src/server/http';
import { collectArtifacts, importRecords, ingestExplicit, copyMedia } from '../../src/server/importer';

let root: string; let db: InboxDatabase;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'inbox-backend-'));db=openDatabase(join(root,'data'));});
afterEach(()=>{db.close();rmSync(root,{recursive:true,force:true});});
function item(externalId='one', extra: Record<string,unknown> = {}) {
  return ingestSchema.parse({externalId,title:'SQLite release',kind:'alert',publishedAt:'2026-01-01T10:00:00+01:00',body:'Persistent Unicode café indexing',summary:'Database news',...extra});
}
function id() { return listItems(db,{view:'all'}).items[0].id; }
function sourceFixture() {
  const project=join(root,'source'); const briefing=join(project,'.t3-artifacts','ai-briefing');const audio=join(project,'.t3-artifacts','audio');
  mkdirSync(join(briefing,'day'),{recursive:true});mkdirSync(join(briefing,'openai-watch','alerts','delivery'),{recursive:true});mkdirSync(join(audio,'day'),{recursive:true});
  writeFileSync(join(project,'MIGRATION.md'),'Historical migration');
  writeFileSync(join(briefing,'day','briefing.md'),'# Daily edition\n\nReal preserved body. [Official](https://example.org/news)');
  writeFileSync(join(briefing,'openai-watch','alerts','delivery','alert.md'),'# Delivered update\n\nActual alert body.');
  writeFileSync(join(audio,'day','named.mp3'),Buffer.from('ID3 audio fixture'));
  writeFileSync(join(audio,'day','unrelated.mp3'),Buffer.from('Unrelated setup audio'));
  writeFileSync(join(audio,'day','named.json'),JSON.stringify({duration_seconds:7.5}));
  writeFileSync(join(briefing,'index.json'),JSON.stringify({briefing_history:[{at:'2026-01-01T10:00:00Z',date:'2026-01-01',briefing_path:'day/briefing.md',audio_path:'.t3-artifacts/audio/day/named.mp3'}],events:[]}));
  const event={id:'release-1',reported_at:'2026-01-01T12:00:00Z',delivery:'delivered',alert_path:'/historical/.t3/scratch/thread/.t3-artifacts/ai-briefing/openai-watch/alerts/delivery/alert.md',sources:['https://example.org/release']};
  writeFileSync(join(briefing,'openai-watch','alerts.json'),JSON.stringify({events:[event,{...event,id:'release-2'},{id:'not-delivered',alert_path:'missing.md'},{id:'baseline',reported_at:'2026-01-01T12:00:00Z',delivery:'baseline'}],dismissed_candidates:[event]}));
  return {project,briefing,audio};
}

test('independent migration persists schema, FTS and state across connections',()=>{
  upsertBatch(db,[{item:item()}]);const stable=id();patchItem(db,stable,{read:true,archived:true});
  db.close();db=openDatabase(join(root,'data'));
  assert.equal(detail(db,stable).id,stable);assert.ok(detail(db,stable).readAt);assert.equal(listItems(db,{view:'all',q:'café'}).total,1);
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM inbox_migrations').get() && (db.sqlite.prepare('SELECT count(*) n FROM inbox_migrations').get() as {n:number}).n,4);
});
test('reimport preserves ID/read/archive and synchronizes FTS updates/deletes',()=>{
  upsertBatch(db,[{item:item()}]); const stable=id();const state=patchItem(db,stable,{read:true,archived:true});
  upsertBatch(db,[{item:item('one',{title:'Replacement',body:'Fresh zebras'})}]);
  assert.equal(detail(db,stable).readAt,state.readAt);assert.equal(detail(db,stable).archivedAt,state.archivedAt);
  assert.equal(listItems(db,{view:'all',q:'café'}).total,0);assert.equal(listItems(db,{view:'all',q:'zebras'}).total,1);
  db.sqlite.prepare('DELETE FROM items WHERE id=?').run(stable);assert.equal(listItems(db,{view:'all',q:'zebras'}).total,0);
});
test('patch is idempotent and explicit false clears states',()=>{
  upsertBatch(db,[{item:item()}]);const stable=id();const a=patchItem(db,stable,{read:true,archived:true});const b=patchItem(db,stable,{read:true,archived:true});assert.deepEqual(a,b);
  const c=patchItem(db,stable,{read:false,archived:false});assert.equal(c.readAt,null);assert.equal(c.archivedAt,null);
  for(const patch of [{},{read:'yes'},{unknown:true}]) assert.throws(()=>patchItem(db,stable,patch));
  assert.throws(()=>detail(db,'absent'),(e:unknown)=>e instanceof ApiError && e.status===404);
});
test('bounded cursor pagination is complete and stable with tied timestamps',()=>{
  upsertBatch(db,Array.from({length:7},(_,i)=>({item:item(String(i),{kind:i%2?'alert':'briefing'})})));
  const seen: string[]=[];let cursor: string|undefined;
  do {const page=listItems(db,{view:'all',limit:2,cursor});assert.equal(page.total,7);seen.push(...page.items.map(x=>x.id));cursor=page.nextCursor??undefined;} while(cursor);
  assert.equal(seen.length,7);assert.equal(new Set(seen).size,7);
  const first=listItems(db,{view:'all',limit:2});assert.throws(()=>listItems(db,{view:'inbox',cursor:first.nextCursor!}));
  assert.throws(()=>listItems(db,{cursor:'not-json'}));assert.throws(()=>listItems(db,{limit:101}));assert.throws(()=>listItems(db,{limit:0}));
});
test('counts are global; totals apply view/kind/search before pagination',()=>{
  upsertBatch(db,[{item:item('a')},{item:item('b',{kind:'briefing',body:'Only elephants'})},{item:item('c',{title:'Other'})}]);
  const all=listItems(db,{view:'all'});patchItem(db,all.items[0].id,{archived:true});patchItem(db,all.items[1].id,{read:true});
  const page=listItems(db,{view:'all',kind:'briefing',q:'elephants'});assert.equal(page.total,1);assert.deepEqual(page.counts,{inbox:2,unread:1,archive:1});
  assert.equal(listItems(db,{view:'unread'}).total,1);assert.equal(listItems(db,{view:'archive'}).total,1);
});
test('search handles punctuation and hostile syntax as literal terms',()=>{
  upsertBatch(db,[{item:item()}]);assert.equal(listItems(db,{q:'SQLite café'}).total,1);
  for(const q of ['" OR *','NEAR(sqlite)','x\' UNION SELECT','---','title:sqlite']) assert.doesNotThrow(()=>listItems(db,{q}));
  assert.equal(listItems(db,{q:'---'}).total,0);
});
test('invalid inputs and HTTP errors never disclose raw exceptions',()=>{
  assert.throws(()=>querySchema.parse({view:'bogus'}));assert.throws(()=>queryInput('https://example.org/api?limit=1&limit=2'));
  const response=failure(new Error('private path and SQL'));assert.equal(response.status,503);
  assert.throws(()=>ingestSchema.parse({...item(),sources:[{title:'bad',url:'file:///private'}]}));
});
test('origin guard rejects cross-origin, same-site and absent origins',()=>{
  const url='https://inbox.example/api/items/id';
  assert.doesNotThrow(()=>assertSameOrigin(new Request(url,{headers:{origin:'https://inbox.example','sec-fetch-site':'same-origin'}})));
  for(const headers of ([{},{origin:'https://evil.example'},{origin:'https://inbox.example','sec-fetch-site':'same-site'},{origin:'null'}] as Record<string,string>[])) assert.throws(()=>assertSameOrigin(new Request(url,{headers})));
});
test('bounded streamed PATCH body rejects malformed JSON, media type and oversize',async()=>{
  const req=(body:string,type='application/json')=>new Request('https://example.org',{method:'PATCH',headers:{'content-type':type},body});
  assert.deepEqual(await readPatch(req('{"read":true}')),{read:true});
  await assert.rejects(readPatch(req('{')));await assert.rejects(readPatch(req('{}','text/plain')));await assert.rejects(readPatch(req(' '.repeat(4097))),(e:unknown)=>e instanceof ApiError && e.status===413);
});
test('atomic batch rolls back on SQL failure and validation failure',()=>{
  db.sqlite.exec("CREATE TRIGGER reject_test BEFORE INSERT ON items WHEN new.external_id='reject' BEGIN SELECT RAISE(ABORT,'rejected'); END");
  assert.throws(()=>upsertBatch(db,[{item:item('good')},{item:item('reject')} ]));assert.equal(listItems(db,{}).total,0);
  assert.throws(()=>upsertBatch(db,[{item:item('good')},{item:{...item('bad'),kind:'bad'} as never}]));assert.equal(listItems(db,{}).total,0);
});
test('audio full, prefix, suffix, open range and 416 return exact bytes',async()=>{
  const source=join(root,'audio.mp3');writeFileSync(source,'0123456789');const audioFile=copyMedia(db,source);upsertBatch(db,[{item:item(),audioFile}]);const stable=id();
  for(const [range,status,body] of [[null,200,'0123456789'],['bytes=2-5',206,'2345'],['bytes=-3',206,'789'],['bytes=7-',206,'789'],['bytes=0-99',206,'0123456789']] as const) {
    const res=await audioResponse(db,stable,new Request('https://example.org',{headers:range?{range}:{}}));assert.equal(res.status,status);assert.equal(await res.text(),body);assert.equal(res.headers.get('accept-ranges'),'bytes');
  }
  for(const range of ['bytes=10-','bytes=4-2','bytes=-0','bytes=0-1,2-3','bytes=','bytes=999999999999999999999-']) {const res=await audioResponse(db,stable,new Request('https://example.org',{headers:{range}}));assert.equal(res.status,416);assert.equal(res.headers.get('content-range'),'bytes */10');}
  assert.throws(()=>parseRange('bytes=0-',0));
  const head=await audioResponse(db,stable,new Request('https://example.org',{method:'HEAD'}));assert.equal(head.headers.get('content-length'),'10');assert.equal(await head.text(),'');
});
test('audio rejects unsafe database paths and symlinks out of media',async()=>{
  upsertBatch(db,[{item:item()}]);const stable=id();db.sqlite.prepare('UPDATE items SET audio_file=? WHERE id=?').run('../secret.mp3',stable);
  await assert.rejects(audioResponse(db,stable,new Request('https://example.org')));
  const name='a'.repeat(64)+'.mp3';writeFileSync(join(root,'secret.mp3'),'secret');symlinkSync(join(root,'secret.mp3'),join(db.directory,'media',name));db.sqlite.prepare('UPDATE items SET audio_file=? WHERE id=?').run(name,stable);
  await assert.rejects(audioResponse(db,stable,new Request('https://example.org')));assert.equal(detail(db,stable).body.includes(root),false);
});
test('artifact import preserves content/provenance, groups alerts and excludes candidates',()=>{
  const fixture=sourceFixture();const collected=collectArtifacts(fixture.project);assert.equal(collected.records.length,2);assert.equal(collected.warnings.length,0);
  const briefing=collected.records.find(r=>r.item.kind==='briefing')!;assert.equal(briefing.item.audioDuration,7.5);assert.ok(briefing.item.tags.includes('historical-migration'));assert.equal(briefing.item.sources[0].url,'https://example.org/news');
  const alert=collected.records.find(r=>r.item.kind==='alert')!;assert.equal((alert.item.provenance.events as unknown[]).length,2);assert.ok(alert.item.tags.includes('historical-migration'));assert.equal(alert.mediaPath,undefined);
  importRecords(db,collected.records);const stable=id();patchItem(db,stable,{read:true});importRecords(db,collectArtifacts(fixture.briefing).records);assert.equal(listItems(db,{view:'all'}).total,2);assert.ok(detail(db,stable).readAt);
  assert.equal('provenance' in detail(db,stable),false);
});
test('missing referenced audio stays text-only and never selects unrelated MP3',()=>{
  const fixture=sourceFixture();rmSync(join(fixture.audio,'day','named.mp3'));const result=collectArtifacts(fixture.project);assert.ok(result.warnings.length);assert.ok(result.records.every(r=>!r.mediaPath));
});
test('import blocks traversal and escaped symlinks in source references',()=>{
  const fixture=sourceFixture();const index=join(fixture.briefing,'index.json');
  const setPath=(path:string)=>writeFileSync(index,JSON.stringify({briefing_history:[{at:'2026-01-01T10:00:00Z',date:'2026-01-01',briefing_path:path}]}));
  setPath('../../../../outside.md');assert.throws(()=>collectArtifacts(fixture.project));
  writeFileSync(join(root,'outside.md'),'Private');symlinkSync(join(root,'outside.md'),join(fixture.briefing,'escaped.md'));setPath('escaped.md');assert.throws(()=>collectArtifacts(fixture.project));
});
test('explicit ingestion accepts authorized text/media and retains original metadata',()=>{
  const metadata=join(root,'item.json');const body=join(root,'body.md');const media=join(root,'explicit.mp3');
  writeFileSync(metadata,JSON.stringify({...item(),body:'old',provenance:{job:'local'}}));writeFileSync(body,'Explicit real body');writeFileSync(media,'ID3 fixture');
  importRecords(db,[ingestExplicit(metadata,body,media)]);assert.equal(detail(db,id()).body,'Explicit real body');assert.ok(detail(db,id()).audioAvailable);
});

test('morning and evening directories import as distinct editions and preserve state',()=>{
  const fixture=sourceFixture();
  const history=['morning','evening'].map((edition,index)=>{
    mkdirSync(join(fixture.briefing,'day',edition),{recursive:true});
    writeFileSync(join(fixture.briefing,'day',edition,'briefing.md'),`# ${edition} report\n\nActual report.`);
    return {at:`2026-01-01T${index?'18':'06'}:30:00Z`,date:'2026-01-01',briefing_path:`day/${edition}/briefing.md`,attachment_id:`real-${edition}`};
  });
  writeFileSync(join(fixture.briefing,'index.json'),JSON.stringify({briefing_history:history}));
  const records=collectArtifacts(fixture.project).records.filter(r=>r.item.kind==='briefing');
  assert.deepEqual(records.map(r=>r.item.edition),['morning','evening']);
  importRecords(db,records);const stable=id();const state=patchItem(db,stable,{read:true,archived:true});
  importRecords(db,collectArtifacts(fixture.project).records.filter(r=>r.item.kind==='briefing'));
  assert.equal(listItems(db,{view:'all',kind:'briefing'}).total,2);
  assert.equal(detail(db,stable).readAt,state.readAt);assert.equal(detail(db,stable).archivedAt,state.archivedAt);
});

test('imported titles and summaries are readable plain text while original body is preserved',()=>{
  const fixture=sourceFixture();const body='**Daily AI briefing**\n\nNew **model** with [original source](https://example.org/new).';
  writeFileSync(join(fixture.briefing,'day','briefing.md'),body);
  const record=collectArtifacts(fixture.project).records.find(r=>r.item.kind==='briefing')!;
  assert.equal(record.item.title,'Daily AI briefing');assert.equal(record.item.summary,'New model with original source.');assert.equal(record.item.body,body);
});

test('production host restriction rejects rebinding while configured origin supports Next URL normalization',()=>{
  const old=process.env.INBOX_ORIGIN;process.env.INBOX_ORIGIN='http://192.0.2.1:3400';
  try {
    const allowed=new Request('http://localhost:3400/api/items',{headers:{host:'192.0.2.1:3400',origin:'http://192.0.2.1:3400'}});
    assert.doesNotThrow(()=>assertTrustedHost(allowed));assert.doesNotThrow(()=>assertSameOrigin(allowed));
    assert.throws(()=>assertTrustedHost(new Request('http://localhost:3400/api/items',{headers:{host:'attacker.example'}})));
    assert.throws(()=>assertSameOrigin(new Request('http://localhost:3400/api/items',{headers:{host:'192.0.2.1:3400',origin:'https://attacker.example'}})));
  } finally {if(old===undefined)delete process.env.INBOX_ORIGIN;else process.env.INBOX_ORIGIN=old;}
});
test('HTTPS proxy and direct private origin each require their matching Host',()=>{
  const old=process.env.INBOX_ORIGIN, aliases=process.env.INBOX_ADDITIONAL_ORIGINS;
  process.env.INBOX_ORIGIN='https://inbox.example.test';process.env.INBOX_ADDITIONAL_ORIGINS='http://192.0.2.1:3400';
  const request=(host:string,origin:string)=>new Request('http://localhost:3400/api/items',{headers:{host,origin}});
  try {
    assert.doesNotThrow(()=>assertSameOrigin(request('inbox.example.test','https://inbox.example.test')));
    assert.doesNotThrow(()=>assertSameOrigin(request('192.0.2.1:3400','http://192.0.2.1:3400')));
    assert.throws(()=>assertSameOrigin(request('inbox.example.test','http://192.0.2.1:3400')));
    assert.throws(()=>assertSameOrigin(request('192.0.2.1:3400','https://inbox.example.test')));
    assert.throws(()=>assertTrustedHost(request('attacker.example','https://inbox.example.test')));
  } finally {
    if(old===undefined)delete process.env.INBOX_ORIGIN;else process.env.INBOX_ORIGIN=old;
    if(aliases===undefined)delete process.env.INBOX_ADDITIONAL_ORIGINS;else process.env.INBOX_ADDITIONAL_ORIGINS=aliases;
  }
});
