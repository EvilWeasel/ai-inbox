import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POST } from '../../src/app/api/results/audio-jobs/route';
import { GET as GET_JOB } from '../../src/app/api/results/audio-jobs/[id]/route';
import { GET as GET_AUDIO } from '../../src/app/api/results/audio-jobs/[id]/audio/route';
import { getDatabase, openDatabase } from '../../src/server/db';
import { ingestResult } from '../../src/server/result-ingest';
import { createAudioRequest, updateWorkerRequest, attachWorkerMedia, listWorkerRequests, type WorkerRequest } from '../../src/server/central-audio';
import { migrate } from '../../src/server/migrations';

const root=mkdtempSync(join(tmpdir(),'inbox-central-audio-'));
process.env.INBOX_DATA_DIR=join(root,'data');
process.env.INBOX_AUDIO_WORKER_MEDIA_DIR=join(root,'worker-media');
process.env.INBOX_AUDIO_PROFILE_SHA256='a'.repeat(64);
process.env.INBOX_ORIGIN='https://inbox.example.test';
mkdirSync(process.env.INBOX_AUDIO_WORKER_MEDIA_DIR,{recursive:true});
const producerToken=randomBytes(32).toString('base64url'),otherToken=randomBytes(32).toString('base64url');
const producerFile=join(root,'producers.json');
writeFileSync(producerFile,JSON.stringify({producers:[
  {id:'audio-owner',host:'owner.example.test',tokenHash:createHash('sha256').update(producerToken).digest('hex')},
  {id:'other-owner',host:'other.example.test',tokenHash:createHash('sha256').update(otherToken).digest('hex')},
]}),{mode:0o600});chmodSync(producerFile,0o600);process.env.INBOX_PRODUCERS_FILE=producerFile;
const db=getDatabase();
const producer={id:'audio-owner',host:'owner.example.test',tokenHash:createHash('sha256').update(producerToken).digest('hex')};
const tokenHeaders={authorization:`Bearer ${producerToken}`,host:'inbox.example.test','content-type':'application/json'};
const body='Written personal result body that remains unchanged.';
const bodySha=hash(body);
function hash(value:string|Buffer){return createHash('sha256').update(value).digest('hex');}
function audioInput(deliveryId='delivery-a',spokenText='Eine kurze gesprochene Fassung.') {
  return {protocol:1 as const,deliveryId,bodySha256:bodySha,spokenText,spokenSha256:hash(spokenText)};
}
function req(url:string,method:string,headers:Record<string,string>,body?:string) {return new Request(url,{method,headers,body});}
function postInput(input:unknown,headers:Record<string,string>=tokenHeaders) {return POST(req('https://inbox.example.test/api/results/audio-jobs','POST',headers,JSON.stringify(input)));}
function validMp3(){const bytes=Buffer.alloc(417);bytes.set([0xff,0xfb,0x90,0x64]);return bytes;}
let itemId='';
after(()=>{db.close();rmSync(root,{recursive:true,force:true});for(const key of ['INBOX_DATA_DIR','INBOX_AUDIO_WORKER_MEDIA_DIR','INBOX_AUDIO_PROFILE_SHA256','INBOX_ORIGIN','INBOX_PRODUCERS_FILE'])delete process.env[key];});

test('v4 migration adds request storage to populated v3 without changing item, FTS or owner state',async()=>{
  const local= openDatabase(join(root,'migration-data'));
  try {
    const inserted=await ingestResult(local,producer,{deliveryId:'migration',title:'Migration result',body:'migration searchable',resultType:'report',origin:{host:producer.host},publishedAt:'2026-10-10T10:00:00Z',phase:'final'},null);
    local.sqlite.prepare('UPDATE items SET read_at=?,archived_at=? WHERE id=?').run('2026-10-10T10:01:00Z','2026-10-10T10:02:00Z',inserted.item.id);
    const before=local.sqlite.prepare('SELECT revision FROM inbox_revision').get() as {revision:number};
    local.sqlite.transaction(()=>{local.sqlite.exec('DROP TRIGGER central_audio_revision_insert; DROP TRIGGER central_audio_revision_state; DROP INDEX central_audio_identity; DROP INDEX central_audio_item_profile; DROP INDEX central_audio_queue; DROP INDEX central_audio_item_state; DROP TABLE central_audio_requests; DELETE FROM inbox_migrations WHERE version=4;');}).immediate();
    migrate(local.sqlite);
    assert.equal((local.sqlite.prepare('SELECT revision FROM inbox_revision').get() as {revision:number}).revision,before.revision);
    assert.deepEqual(local.sqlite.prepare('SELECT read_at,archived_at FROM items WHERE id=?').get(inserted.item.id),{read_at:'2026-10-10T10:01:00Z',archived_at:'2026-10-10T10:02:00Z'});
    assert.equal((local.sqlite.prepare("SELECT count(*) n FROM items_fts WHERE items_fts MATCH 'searchable'").get() as {n:number}).n,1);
    assert.ok(local.sqlite.prepare('SELECT version FROM inbox_migrations WHERE version=4').get());
  } finally {local.close();}
});

test('authenticated request validates exact written/spoken hashes, ownership and stable identity',async()=>{
  const metadata={deliveryId:'delivery-a',title:'Written result',body,resultType:'report' as const,origin:{host:producer.host},publishedAt:'2026-10-10T10:00:00Z',phase:'final' as const};
  const ingested=await ingestResult(db,producer,metadata,null);itemId=ingested.item.id;
  assert.equal((await postInput(audioInput())).status,201);
  const first=await postInput(audioInput());assert.equal(first.status,200);
  const firstBody=await first.json() as {jobId:string;itemId:string;state:string};
  assert.equal(firstBody.itemId,itemId);assert.equal(firstBody.state,'queued');
  const duplicate=await postInput(audioInput());assert.equal(duplicate.status,200);assert.equal((await duplicate.json() as {jobId:string}).jobId,firstBody.jobId);
  const badHash=await postInput({...audioInput(),spokenSha256:'0'.repeat(64)});assert.equal(badHash.status,400);
  const forbidden=await postInput({...audioInput(),voice:'alternate'});assert.equal(forbidden.status,400);
  const oversized=await POST(req('https://inbox.example.test/api/results/audio-jobs','POST',tokenHeaders,JSON.stringify({...audioInput(),spokenText:'x'.repeat(24*1024)})));assert.equal(oversized.status,413);
  const badBody=await postInput({...audioInput(),bodySha256:'0'.repeat(64)});assert.equal(badBody.status,409);
  const changed=await postInput(audioInput('delivery-a','A materially changed adaptation.'));assert.equal(changed.status,409);
  const tooLong=await postInput(audioInput('delivery-a','x'.repeat(4000)));assert.equal(tooLong.status,400);
  const wrongOrigin=await postInput(audioInput(),{...tokenHeaders,origin:'https://evil.example.test'});assert.equal(wrongOrigin.status,403);
  const crossOwner=await postInput(audioInput(),{...tokenHeaders,authorization:`Bearer ${otherToken}`});assert.equal(crossOwner.status,404);
  const noAuth=await postInput(audioInput(),{host:'inbox.example.test','content-type':'application/json'});assert.equal(noAuth.status,401);
  const jobId=firstBody.jobId;
  const statusResponse=await GET_JOB(req(`https://inbox.example.test/api/results/audio-jobs/${jobId}`,'GET',tokenHeaders),{params:Promise.resolve({id:jobId})});
  const status=await statusResponse.text();assert.equal(statusResponse.status,200);assert.equal(status.includes('spokenText'),false);assert.equal(status.includes('worker-media'),false);assert.equal(status.includes(body),false);
  const otherStatus=await GET_JOB(req(`https://inbox.example.test/api/results/audio-jobs/${jobId}`,'GET',{...tokenHeaders,authorization:`Bearer ${otherToken}`}),{params:Promise.resolve({id:jobId})});assert.equal(otherStatus.status,404);
  const revisionBefore=(db.sqlite.prepare('SELECT revision FROM inbox_revision').get() as {revision:number}).revision;
  updateWorkerRequest(db,{requestId:jobId,ledgerJobId:'ledger-1',state:'generating'});
  const revisionAfter=(db.sqlite.prepare('SELECT revision FROM inbox_revision').get() as {revision:number}).revision;assert.equal(revisionAfter,revisionBefore+1);
  const timestampAfter=(db.sqlite.prepare('SELECT updated_at FROM central_audio_requests WHERE id=?').get(jobId) as {updated_at:string}).updated_at;
  updateWorkerRequest(db,{requestId:jobId,ledgerJobId:'ledger-1',state:'generating'});
  assert.equal((db.sqlite.prepare('SELECT revision FROM inbox_revision').get() as {revision:number}).revision,revisionAfter);
  assert.equal((db.sqlite.prepare('SELECT updated_at FROM central_audio_requests WHERE id=?').get(jobId) as {updated_at:string}).updated_at,timestampAfter);
  assert.throws(()=>updateWorkerRequest(db,{requestId:jobId,ledgerJobId:'ledger-2',state:'needs_review'}),/binding/);
  assert.equal((db.sqlite.prepare('SELECT state FROM central_audio_requests WHERE id=?').get(jobId) as {state:string}).state,'generating');
});

test('ready audio is attached atomically, deduplicated under concurrent retry, and streamed only to its owner',async()=>{
  const job= db.sqlite.prepare("SELECT id FROM central_audio_requests WHERE delivery_id='delivery-a'").get() as {id:string};
  const mp3=validMp3(),source=join(process.env.INBOX_AUDIO_WORKER_MEDIA_DIR!,'source.mp3');writeFileSync(source,mp3,{mode:0o600});
  db.sqlite.prepare('UPDATE items SET read_at=?,archived_at=? WHERE id=?').run('2026-10-10T14:00:00Z','2026-10-10T14:01:00Z',itemId);
  const attach={requestId:job.id,ledgerJobId:'ledger-1',bodySha256:bodySha,source,mediaSha256:hash(mp3),duration:8.5};
  const before=(db.sqlite.prepare('SELECT revision FROM inbox_revision').get() as {revision:number}).revision;
  const [a,b]=await Promise.all([attachWorkerMedia(db,attach),attachWorkerMedia(db,attach)]);
  assert.equal(a.state,'ready');assert.equal(b.state,'ready');
  const afterAttach=(db.sqlite.prepare('SELECT revision FROM inbox_revision').get() as {revision:number}).revision;assert.equal(afterAttach,before+2); // item media + request ready
  const stored=db.sqlite.prepare('SELECT body,read_at,archived_at,audio_file,audio_duration FROM items WHERE id=?').get(itemId) as {body:string;read_at:string|null;archived_at:string|null;audio_file:string;audio_duration:number};
  assert.equal(stored.body,body);assert.equal(stored.read_at,'2026-10-10T14:00:00Z');assert.equal(stored.archived_at,'2026-10-10T14:01:00Z');assert.equal(stored.audio_file,`${hash(mp3)}.mp3`);assert.equal(stored.audio_duration,8.5);
  const status=await GET_JOB(req('https://inbox.example.test','GET',tokenHeaders),{params:Promise.resolve({id:job.id})});
  assert.deepEqual(await status.json(),{jobId:job.id,itemId,state:'ready',mediaSha256:hash(mp3),duration:8.5});
  assert.equal((await GET_AUDIO(req('https://inbox.example.test','GET',tokenHeaders),{params:Promise.resolve({id:job.id})})).status,200);
  assert.equal((await GET_AUDIO(req('https://inbox.example.test','GET',{...tokenHeaders,authorization:`Bearer ${otherToken}`}),{params:Promise.resolve({id:job.id})})).status,404);
});

test('worker attach rejects untrusted files and supersedes stale body or original-audio races',async()=>{
  const newMetadata={deliveryId:'stale-body',title:'Stale body',body,resultType:'report' as const,origin:{host:producer.host},publishedAt:'2026-10-10T11:00:00Z',phase:'final' as const};
  const staleItem=await ingestResult(db,producer,newMetadata,null);
  const request=createAudioRequest(db,producer,{...audioInput('stale-body'),protocol:1});
  assert.equal(request.state,'queued');
  const jobId=request.jobId!;updateWorkerRequest(db,{requestId:jobId,ledgerJobId:'ledger-stale',state:'generating'});
  const mp3=validMp3(),source=join(process.env.INBOX_AUDIO_WORKER_MEDIA_DIR!,'stale.mp3');writeFileSync(source,mp3,{mode:0o600});
  const base={requestId:jobId,ledgerJobId:'ledger-stale',bodySha256:bodySha,source,mediaSha256:hash(mp3),duration:5};
  await assert.rejects(()=>attachWorkerMedia(db,{...base,source:join(process.env.INBOX_AUDIO_WORKER_MEDIA_DIR!,'missing.mp3')}));
  const fake=join(process.env.INBOX_AUDIO_WORKER_MEDIA_DIR!,'fake.mp3');writeFileSync(fake,Buffer.from('ID3not an mpeg frame'),{mode:0o600});
  await assert.rejects(()=>attachWorkerMedia(db,{...base,source:fake,mediaSha256:hash(Buffer.from('ID3not an mpeg frame'))}));
  await assert.rejects(()=>attachWorkerMedia(db,{...base,mediaSha256:'0'.repeat(64)}));
  for (const duration of [0, -1, NaN, Infinity]) await assert.rejects(()=>attachWorkerMedia(db,{...base,duration}));
  const outside=join(root,'outside.mp3');writeFileSync(outside,mp3);
  await assert.rejects(()=>attachWorkerMedia(db,{...base,source:outside}));
  const symlink=join(process.env.INBOX_AUDIO_WORKER_MEDIA_DIR!,'link.mp3');symlinkSync(outside,symlink);
  await assert.rejects(()=>attachWorkerMedia(db,{...base,source:symlink}));
  db.sqlite.prepare('UPDATE items SET body=? WHERE id=?').run('A newer written revision.',staleItem.item.id);
  const revisionBeforeList=(db.sqlite.prepare('SELECT revision FROM inbox_revision').get() as {revision:number}).revision;
  assert.equal(listWorkerRequests(db,10).some(row=>row.id===jobId),false);
  assert.equal((db.sqlite.prepare('SELECT state FROM central_audio_requests WHERE id=?').get(jobId) as {state:string}).state,'superseded');
  assert.equal((db.sqlite.prepare('SELECT revision FROM inbox_revision').get() as {revision:number}).revision,revisionBeforeList+1);
  const result=await attachWorkerMedia(db,base);assert.equal(result.state,'superseded');
  assert.equal((db.sqlite.prepare('SELECT audio_file FROM items WHERE id=?').get(staleItem.item.id) as {audio_file:string|null}).audio_file,null);

  const originalMetadata={deliveryId:'original-race',title:'Original race',body,resultType:'report' as const,origin:{host:producer.host},publishedAt:'2026-10-10T12:00:00Z',phase:'final' as const};
  const originalItem=await ingestResult(db,producer,originalMetadata,null);
  const originalReq=createAudioRequest(db,producer,{...audioInput('original-race'),protocol:1});const originalJob=originalReq.jobId!;
  updateWorkerRequest(db,{requestId:originalJob,ledgerJobId:'ledger-original',state:'generating'});
  db.sqlite.prepare('UPDATE items SET audio_file=?,audio_duration=? WHERE id=?').run('b'.repeat(64)+'.mp3',9,originalItem.item.id);
  assert.equal(listWorkerRequests(db,10).some(row=>row.id===originalJob),false);
  const originalResult=await attachWorkerMedia(db,{...base,requestId:originalJob,ledgerJobId:'ledger-original'});
  assert.equal(originalResult.state,'superseded');
  assert.equal((db.sqlite.prepare('SELECT audio_file,audio_duration FROM items WHERE id=?').get(originalItem.item.id) as {audio_file:string;audio_duration:number}).audio_file,'b'.repeat(64)+'.mp3');
});

test('needs_review is a durable non-retry state and changes revision once',async()=>{
  const metadata={deliveryId:'review-needed',title:'Review needed',body,resultType:'report' as const,origin:{host:producer.host},publishedAt:'2026-10-10T12:30:00Z',phase:'final' as const};
  await ingestResult(db,producer,metadata,null);
  const result=createAudioRequest(db,producer,audioInput('review-needed'));
  const revision=(db.sqlite.prepare('SELECT revision FROM inbox_revision').get() as {revision:number}).revision;
  const update=updateWorkerRequest(db,{requestId:result.jobId!,ledgerJobId:'ledger-review',state:'needs_review',safeErrorCode:'timeout_uncertain'});
  assert.equal(update.state,'needs_review');
  assert.equal((db.sqlite.prepare('SELECT revision FROM inbox_revision').get() as {revision:number}).revision,revision+1);
  assert.throws(()=>updateWorkerRequest(db,{requestId:result.jobId!,ledgerJobId:'ledger-review',state:'generating'}),/state/);
});

test('missing voice profile fails only when new generation is needed; original audio remains ready_existing',async()=>{
  const original='c'.repeat(64)+'.mp3';
  const metadata={deliveryId:'already-audio',title:'Original audio',body,resultType:'report' as const,origin:{host:producer.host},publishedAt:'2026-10-10T13:00:00Z',phase:'final' as const};
  const item=await ingestResult(db,producer,metadata,null);
  db.sqlite.prepare('UPDATE items SET audio_file=?,audio_duration=10 WHERE id=?').run(original,item.item.id);
  delete process.env.INBOX_AUDIO_PROFILE_SHA256;
  const accepted=await postInput(audioInput('already-audio'));assert.equal(accepted.status,200);assert.deepEqual(await accepted.json(),{state:'ready_existing',itemId:item.item.id});
  const missing=await postInput(audioInput('delivery-no-profile'));assert.equal(missing.status,404);
  const noItemMeta={deliveryId:'needs-profile',title:'Needs profile',body,resultType:'report' as const,origin:{host:producer.host},publishedAt:'2026-10-10T13:01:00Z',phase:'final' as const};
  await ingestResult(db,producer,noItemMeta,null);
  const unavailable=await postInput(audioInput('needs-profile'));assert.equal(unavailable.status,503);
  process.env.INBOX_AUDIO_PROFILE_SHA256='a'.repeat(64);
});

test('private CLI list, lookup and unbound resolution use the real SQLite contract',async()=>{
  const metadata={deliveryId:'cli-contract',title:'CLI contract',body,resultType:'report' as const,origin:{host:producer.host},publishedAt:'2026-10-10T15:00:00Z',phase:'final' as const};
  await ingestResult(db,producer,metadata,null);
  createAudioRequest(db,producer,audioInput('cli-contract'));
  const run=spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/central-audio.ts'],{cwd:process.cwd(),input:JSON.stringify({op:'list',limit:10}),encoding:'utf8',env:process.env});
  assert.equal(run.status,0,run.stderr);const output=JSON.parse(run.stdout) as {requests:WorkerRequest[]};assert.ok(Array.isArray(output.requests));
  assert.ok(output.requests.every(row=>row.id&&row.item_id&&row.item_body_sha256&&row.state));
  assert.equal(run.stdout.includes(producerToken),false);assert.equal(run.stdout.includes('/tmp/inbox-central-audio-'),false);
  const queued=output.requests.find(row=>row.state==='queued');assert.ok(queued);
  const lookup=spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/central-audio.ts'],{cwd:process.cwd(),input:JSON.stringify({op:'lookup',requestId:queued!.id}),encoding:'utf8',env:process.env});
  assert.equal(lookup.status,0,lookup.stderr);assert.equal((JSON.parse(lookup.stdout) as {request:WorkerRequest}).request.id,queued!.id);
  const resolve=spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/central-audio.ts'],{cwd:process.cwd(),input:JSON.stringify({op:'resolve',requestId:queued!.id,expectedState:'queued',expectedBodySha256:queued!.body_sha256,state:'needs_review',safeErrorCode:'cli_contract_test'}),encoding:'utf8',env:process.env});
  assert.equal(resolve.status,0,resolve.stderr);assert.deepEqual(JSON.parse(resolve.stdout),{state:'needs_review'});
  assert.equal((db.sqlite.prepare('SELECT state FROM central_audio_requests WHERE id=?').get(queued!.id) as {state:string}).state,'needs_review');
});

test('worker discovery reserves fair capacity for generating work behind a large fresh queue',async()=>{
  for(let i=0;i<55;i++){
    const deliveryId=`fair-queue-${i}`;
    await ingestResult(db,producer,{deliveryId,title:`Fair ${i}`,body,resultType:'report',origin:{host:producer.host},publishedAt:'2026-10-10T14:00:00Z',phase:'final'},null);
    createAudioRequest(db,producer,{...audioInput(deliveryId),deliveryId});
  }
  const activeJobs:string[]=[];
  for(let i=0;i<6;i++){
    const activeDelivery=`fair-generating-${i}`;
    await ingestResult(db,producer,{deliveryId:activeDelivery,title:`Active ${i}`,body,resultType:'report',origin:{host:producer.host},publishedAt:'2026-10-10T14:01:00Z',phase:'final'},null);
    const active=createAudioRequest(db,producer,{...audioInput(activeDelivery),deliveryId:activeDelivery});
    updateWorkerRequest(db,{requestId:active.jobId!,ledgerJobId:`ledger-fair-${i}`,state:'generating'});
    activeJobs.push(active.jobId!);
  }
  const listed=listWorkerRequests(db,10);
  assert.equal(listed.length,10);
  assert.equal(listed.filter(row=>row.state==='generating').length,5);
  assert.equal(listed.filter(row=>row.state==='queued').length,5);
  assert.ok(activeJobs.some(id=>listed.some(row=>row.id===id)));
});

test('unbound worker resolution is conditional and cannot revive superseded requests',async()=>{
  const metadata={deliveryId:'unbound-resolve',title:'Unbound',body,resultType:'report' as const,origin:{host:producer.host},publishedAt:'2026-10-10T14:10:00Z',phase:'final' as const};
  await ingestResult(db,producer,metadata,null);
  const request=createAudioRequest(db,producer,audioInput('unbound-resolve'));
  const resolved=await import('../../src/server/central-audio');
  assert.deepEqual(resolved.resolveWorkerRequest(db,{requestId:request.jobId!,expectedState:'queued',expectedBodySha256:bodySha,state:'needs_review',safeErrorCode:'invalid_backend_request'}),{state:'needs_review'});
  assert.throws(()=>resolved.updateWorkerRequest(db,{requestId:request.jobId!,ledgerJobId:'late-ledger',state:'generating'}),/state/);
  assert.throws(()=>resolved.resolveWorkerRequest(db,{requestId:request.jobId!,expectedState:'queued',expectedBodySha256:bodySha,state:'superseded'}),/state/);
  assert.equal((db.sqlite.prepare('SELECT state FROM central_audio_requests WHERE id=?').get(request.jobId!) as {state:string}).state,'needs_review');
});

test('reviewed retry preserves identity and rejects stale bodies, other ledgers and existing audio',async()=>{
  const {requeueReviewedWorkerRequest}=await import('../../src/server/central-audio');
  const metadata={deliveryId:'review-retry',title:'Reviewed recovery',body,resultType:'report' as const,origin:{host:producer.host},publishedAt:'2026-10-10T14:15:00Z',phase:'final' as const};
  const item=await ingestResult(db,producer,metadata,null);
  const request=createAudioRequest(db,producer,audioInput(metadata.deliveryId));
  const input={requestId:request.jobId!,ledgerJobId:'review-ledger',expectedBodySha256:bodySha};
  assert.throws(()=>requeueReviewedWorkerRequest(db,input),/conflict/);
  updateWorkerRequest(db,{requestId:request.jobId!,ledgerJobId:input.ledgerJobId,state:'needs_review'});
  assert.throws(()=>requeueReviewedWorkerRequest(db,{...input,ledgerJobId:'other-ledger'}),/conflict/);
  db.sqlite.prepare('UPDATE items SET body=? WHERE id=?').run('changed',item.item.id);
  assert.throws(()=>requeueReviewedWorkerRequest(db,input),/changed/);
  db.sqlite.prepare('UPDATE items SET body=?,audio_file=? WHERE id=?').run(body,'existing.mp3',item.item.id);
  assert.throws(()=>requeueReviewedWorkerRequest(db,input),/changed/);
  db.sqlite.prepare('UPDATE items SET audio_file=NULL,read_at=?,archived_at=? WHERE id=?').run('2026-10-10T15:00:00Z','2026-10-10T15:01:00Z',item.item.id);
  const before=(db.sqlite.prepare('SELECT revision FROM inbox_revision').get() as {revision:number}).revision;
  assert.deepEqual(requeueReviewedWorkerRequest(db,input),{state:'queued'});
  assert.equal((db.sqlite.prepare('SELECT revision FROM inbox_revision').get() as {revision:number}).revision,before+1);
  assert.deepEqual(db.sqlite.prepare('SELECT read_at,archived_at FROM items WHERE id=?').get(item.item.id),{read_at:'2026-10-10T15:00:00Z',archived_at:'2026-10-10T15:01:00Z'});
  assert.throws(()=>requeueReviewedWorkerRequest(db,input),/conflict/);
});

test('ready attachment retry detects later written revision or original media before returning ready',async()=>{
  const metadata={deliveryId:'ready-race',title:'Ready race',body,resultType:'report' as const,origin:{host:producer.host},publishedAt:'2026-10-10T14:20:00Z',phase:'final' as const};
  const item=await ingestResult(db,producer,metadata,null);
  const request=createAudioRequest(db,producer,audioInput('ready-race'));
  updateWorkerRequest(db,{requestId:request.jobId!,ledgerJobId:'ledger-ready-race',state:'generating'});
  const mp3=validMp3(),source=join(process.env.INBOX_AUDIO_WORKER_MEDIA_DIR!,'ready-race.mp3');writeFileSync(source,mp3,{mode:0o600});
  const attachment={requestId:request.jobId!,ledgerJobId:'ledger-ready-race',bodySha256:bodySha,source,mediaSha256:hash(mp3),duration:6};
  assert.equal((await attachWorkerMedia(db,attachment)).state,'ready');
  db.sqlite.prepare('UPDATE items SET body=? WHERE id=?').run('new body after ready',item.item.id);
  const retry=await attachWorkerMedia(db,attachment);
  assert.equal(retry.state,'superseded');
  assert.equal((db.sqlite.prepare('SELECT audio_file FROM items WHERE id=?').get(item.item.id) as {audio_file:string}).audio_file,`${hash(mp3)}.mp3`);
  assert.equal((db.sqlite.prepare('SELECT state FROM central_audio_requests WHERE id=?').get(request.jobId!) as {state:string}).state,'superseded');

  const originalMeta={deliveryId:'ready-original-race',title:'Original after ready',body,resultType:'report' as const,origin:{host:producer.host},publishedAt:'2026-10-10T14:21:00Z',phase:'final' as const};
  const originalItem=await ingestResult(db,producer,originalMeta,null);
  const originalRequest=createAudioRequest(db,producer,audioInput('ready-original-race'));
  updateWorkerRequest(db,{requestId:originalRequest.jobId!,ledgerJobId:'ledger-original-ready-race',state:'generating'});
  assert.equal((await attachWorkerMedia(db,{...attachment,requestId:originalRequest.jobId!,ledgerJobId:'ledger-original-ready-race'})).state,'ready');
  const originalName='d'.repeat(64)+'.mp3';
  db.sqlite.prepare('UPDATE items SET audio_file=?,audio_duration=? WHERE id=?').run(originalName,11,originalItem.item.id);
  assert.equal((await attachWorkerMedia(db,{...attachment,requestId:originalRequest.jobId!,ledgerJobId:'ledger-original-ready-race'})).state,'superseded');
  assert.deepEqual(db.sqlite.prepare('SELECT audio_file,audio_duration FROM items WHERE id=?').get(originalItem.item.id),{audio_file:originalName,audio_duration:11});
});
