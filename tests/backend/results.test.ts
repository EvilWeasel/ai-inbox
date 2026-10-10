import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type InboxDatabase } from '../../src/server/db';
import type { ResultMetadata } from '../../src/lib/contracts';
import { assertProducerRateLimit, authenticateProducer, ingestResult, readResultRequest, RESULT_AUDIO_LIMIT, RESULT_METADATA_LIMIT } from '../../src/server/result-ingest';
import { assertMp3 } from '../../src/server/result-ingest';
import { listItems, patchItem } from '../../src/server/items';
import { audioResponse } from '../../src/server/audio';

let root:string; let data:string; let config:string; let db:InboxDatabase; let token:string; let oldConfig:string|undefined;
const host='producer.example.test';
function mp3(size=417) { const b=Buffer.alloc(size); b.writeUInt32BE(0xfffb9064,0); return b; }
function metadata(extra:Record<string,unknown>={}):ResultMetadata { return ({
  deliveryId:'delivery-1',title:'Completed implementation',body:'Finished code with searchable result content',summary:'A final result',sources:[{title:'Source',url:'https://example.test/source'}],tags:['completed'],
  resultType:'implementation',origin:{host,project:'generic-project',threadId:'thread-123',model:'test-model'},publishedAt:'2026-08-01T12:00:00Z',phase:'final',...extra,
}) as ResultMetadata; }
function request(body:unknown, bearer=token) { return new Request('https://inbox.example.test/api/results',{method:'POST',headers:{authorization:`Bearer ${bearer}`,'content-type':'application/json',host:'inbox.example.test'},body:JSON.stringify(body)}); }
beforeEach(()=>{
  root=mkdtempSync(join(tmpdir(),'inbox-result-'));data=join(root,'data');db=openDatabase(data);config=join(root,'producers.json');
  token=randomBytes(32).toString('base64url');oldConfig=process.env.INBOX_PRODUCERS_FILE;process.env.INBOX_PRODUCERS_FILE=config;
  writeConfig([{id:'generic-ci',host,tokenHash:createHash('sha256').update(token).digest('hex')}]);
});
afterEach(()=>{db.close();rmSync(root,{recursive:true,force:true});if(oldConfig===undefined)delete process.env.INBOX_PRODUCERS_FILE;else process.env.INBOX_PRODUCERS_FILE=oldConfig;});
function writeConfig(producers:unknown[]) { writeFileSync(config,JSON.stringify({producers}),{mode:0o600});chmodSync(config,0o600); }

test('producer auth rejects missing, wrong and revoked bearer tokens without exposing secrets',()=>{
  const noToken=new Request('https://inbox.example.test/api/results');
  assert.throws(()=>authenticateProducer(noToken),(e:unknown)=>typeof e==='object'&&e!==null&&'status' in e&&(e as {status:number}).status===401);
  assert.throws(()=>authenticateProducer(new Request(noToken.url,{headers:{authorization:'Bearer wrong-token'}})));
  const revoked=randomBytes(32).toString('base64url');writeConfig([]);
  let error='';try{authenticateProducer(new Request(noToken.url,{headers:{authorization:`Bearer ${revoked}`}}));}catch(e){error=String(e);}
  assert.ok(!error.includes(revoked));assert.ok(!error.includes(config));
});

test('producer file must be outside checkout with mode 0600 and auth fails closed',()=>{
  chmodSync(config,0o640);assert.throws(()=>authenticateProducer(new Request('https://inbox.example.test',{headers:{authorization:`Bearer ${token}`}})));
  const previous=process.env.INBOX_PRODUCERS_FILE;process.env.INBOX_PRODUCERS_FILE=join(process.cwd(),'not-a-real-producer-file');
  try { assert.throws(()=>authenticateProducer(new Request('https://inbox.example.test'))); } finally { if(previous===undefined) delete process.env.INBOX_PRODUCERS_FILE;else process.env.INBOX_PRODUCERS_FILE=previous; }
});

test('authenticated producer rate is capped at sixty requests per rolling minute',()=>{
  const producer={id:'rate-test',host,tokenHash:'a'.repeat(64)};
  for(let i=0;i<60;i++) assert.doesNotThrow(()=>assertProducerRateLimit(producer,10_000+i));
  assert.throws(()=>assertProducerRateLimit(producer,10_060),(e:unknown)=>typeof e==='object'&&e!==null&&'status' in e&&(e as {status:number}).status===429);
  assert.doesNotThrow(()=>assertProducerRateLimit(producer,70_001));
});

test('host binding and final phase are enforced before writes',async()=>{
  const producer=authenticateProducer(request({}));
  await assert.rejects(ingestResult(db,producer,metadata({origin:{host:'spoof.example.test'}}),null));
  await assert.rejects(readResultRequest(new Request('https://inbox.example.test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(metadata({phase:'draft'}))})));
  assert.equal(listItems(db,{view:'all'}).total,0);
});

test('final text result is searchable and idempotent while preserving owner state',async()=>{
  const producer=authenticateProducer(request({}));
  const first=await ingestResult(db,producer,metadata(),null);assert.equal(first.created,true);const stable=first.item.id;
  patchItem(db,stable,{read:true,archived:true});const revisionBefore=(db.sqlite.prepare('SELECT revision FROM inbox_revision').get() as {revision:number}).revision;
  const second=await ingestResult(db,producer,metadata({title:'Updated final result',body:'Replacement quantum search term'}),null);
  assert.equal(second.created,false);assert.equal(second.item.id,stable);assert.ok(second.item.readAt);assert.ok(second.item.archivedAt);
  assert.equal(listItems(db,{view:'all',q:'quantum',kind:'result'}).total,1);
  assert.equal(listItems(db,{view:'all',q:'Completed'}).total,0);
  const changedRevision=(db.sqlite.prepare('SELECT revision FROM inbox_revision').get() as {revision:number}).revision;assert.ok(changedRevision>revisionBefore);
  assert.equal(second.item.origin?.host,host);assert.equal(second.item.resultType,'implementation');
});

test('JSON and multipart ingestion enforce body and actual MP3 bounds',async()=>{
  const producer=authenticateProducer(request({}));
  const oversized=new Request('https://inbox.example.test/api/results',{method:'POST',headers:{'content-type':'application/json','content-length':String(RESULT_METADATA_LIMIT+1)},body:'{}'});
  await assert.rejects(readResultRequest(oversized));
  const form=new FormData();form.set('metadata',JSON.stringify(metadata()));form.set('audio',new File([mp3()],'report.mp3',{type:'audio/mpeg'}));
  const parsed=await readResultRequest(new Request('https://inbox.example.test/api/results',{method:'POST',body:form}));
  const ingested=await ingestResult(db,producer,parsed.metadata,parsed.audio);assert.ok(ingested.item.audioAvailable);
  assertMp3(mp3());assert.throws(()=>assertMp3(Buffer.from('ID3 not actually audio')));
  const tooLarge=new File([Buffer.alloc(RESULT_AUDIO_LIMIT+1)],'huge.mp3',{type:'audio/mpeg'});
  const hugeForm=new FormData();hugeForm.set('metadata',JSON.stringify(metadata()));hugeForm.set('audio',tooLarge);
  await assert.rejects(readResultRequest(new Request('https://inbox.example.test/api/results',{method:'POST',body:hugeForm})));
});

test('stored result audio uses content hash, range serving and replacement without losing user state',async()=>{
  const producer=authenticateProducer(request({}));const data=mp3();
  const first=await ingestResult(db,producer,metadata(),data);const stable=first.item.id;patchItem(db,stable,{read:true});
  const again=await ingestResult(db,producer,metadata(),data);assert.equal(again.created,false);assert.equal(again.item.id,stable);assert.ok(again.item.readAt);
  const response=await audioResponse(db,stable,new Request(`https://inbox.example.test/api/items/${stable}/audio`,{headers:{range:'bytes=0-3'}}));
  assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),data.subarray(0,4));
});
