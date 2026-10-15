import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { dispatch } from '../../src/server/observatory/transport';
import { config } from '../../src/server/observatory/config';
import { openObservatory, register, registered, REGISTRATION_TTL_MS, MAX_REGISTRATIONS } from '../../src/server/observatory/store';

const identity={hostId:'configured-host',threadId:'thread',runId:'run',attemptId:'attempt'};
const canvas={title:'My current work',summary:'Explicit host-producer assertion',status:'working',currentStep:'Verify',plan:[],layout:{columns:1,panels:['summary'],accent:'blue'}};

test('registration persists exact identity, renews with a bound expiry and replaces previous attempts',()=>{
  const directory=mkdtempSync(join(tmpdir(),'obs-registration-store-'));let db=openObservatory(directory);
  try {
    const result=register(db,identity,'producer',1000);
    assert.equal(Date.parse(result.expiresAt),1000+REGISTRATION_TTL_MS);
    db.close();db=openObservatory(directory);
    assert.equal(registered(db,identity,'producer',1001),true);
    assert.equal(registered(db,identity,'other',1001),false);
    assert.equal(registered(db,{...identity,hostId:'other'},'producer',1001),false);
    assert.equal(registered(db,identity,'producer',1000+REGISTRATION_TTL_MS),false);
    register(db,{...identity,attemptId:'new'},'producer',2000);
    assert.equal(registered(db,identity,'producer',2001),false);
    assert.equal(registered(db,{...identity,attemptId:'new'},'producer',2001),true);
    const row=db.prepare('SELECT COUNT(*) count FROM registrations').get() as {count:number};assert.equal(row.count,1);
    register(db,identity,'producer',2000+REGISTRATION_TTL_MS);
    assert.equal((db.prepare('SELECT COUNT(*) count FROM registrations').get() as {count:number}).count,1);
  } finally {db.close();rmSync(directory,{recursive:true,force:true});}
});

test('registration has a global bounded capacity without evicting valid unrelated grants',()=>{
  const directory=mkdtempSync(join(tmpdir(),'obs-registration-capacity-'));const db=openObservatory(directory);
  try {
    db.transaction(()=>{for(let n=0;n<MAX_REGISTRATIONS;n++)register(db,{...identity,threadId:`thread-${n}`},'producer',1000);})();
    assert.throws(()=>register(db,identity,'producer',1001),/capacity/);
    assert.equal(registered(db,{...identity,threadId:'thread-0'},'producer',1001),true);
    assert.doesNotThrow(()=>register(db,identity,'producer',1000+REGISTRATION_TTL_MS));
  } finally {db.close();rmSync(directory,{recursive:true,force:true});}
});

test('shared action authenticates opt-in host producers, rejects obsolete/ambiguous identities and preserves CAS',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'obs-registration-action-'));const oldEnv={...process.env},oldFetch=globalThis.fetch;
  const token='r'.repeat(40),otherToken='s'.repeat(40),nativeToken='native-read-only';
  const credentialFile=join(directory,'peer.json'),configFile=join(directory,'config.json'),producerFile=join(directory,'producers.json');
  const host={id:identity.hostId,label:'Host',environmentId:'environment',origin:'https://native.example.test',credentialFile,credentialPath:['credential','token'],producerId:'registration-producer'};
  const settings={hosts:[host,{...host,id:'other-host',producerId:'other-producer'}],publishers:[] as object[]};
  const save=()=>writeFileSync(configFile,JSON.stringify(settings),{mode:0o600});save();
  writeFileSync(credentialFile,JSON.stringify({credential:{token:nativeToken}}),{mode:0o600});
  writeFileSync(producerFile,JSON.stringify({producers:[{id:'registration-producer',host:'different-display-name',tokenHash:createHash('sha256').update(token).digest('hex')},{id:'other-producer',host:'other-host',tokenHash:createHash('sha256').update(otherToken).digest('hex')}]}),{mode:0o600});
  Object.assign(process.env,{INBOX_OBSERVATORY_CONFIG:configFile,INBOX_PRODUCERS_FILE:producerFile,INBOX_DATA_DIR:join(directory,'data')});delete process.env.INBOX_ORIGIN;
  let attempt='attempt',runId='run',ordinal=1,status='running',environment='environment',threadId='thread',ambiguous=false;
  let calls=0;
  globalThis.fetch=async(url,init)=>{
    calls++;assert.equal(init?.redirect,'error');
    if(String(url).includes('.well-known'))return Response.json({environmentId:environment,orchestrationProtocolVersion:2});
    assert.equal(new Headers(init?.headers).get('authorization'),`Bearer ${nativeToken}`);
    return Response.json({historyCursor:null,hasMoreHistory:false,latestLocalTurnOrdinal:null,snapshotSequence:1,projection:{thread:{id:threadId},runs:[{id:runId,threadId:'thread',ordinal,activeAttemptId:attempt,status},...(ambiguous?[{id:'duplicate',ordinal,activeAttemptId:attempt,status}]:[])],attempts:[{id:attempt,runId,threadId:'thread'}]}});
  };
  const call=async(name:string,body:unknown,bearer=token)=>dispatch(new Request(`http://localhost/api/observatory/actions/${name}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${bearer}`},body:JSON.stringify(body)}),name);
  const input={...identity,canvas,expectedRevision:0};
  try {
    assert.equal((await call('publish',input)).status,403);
    assert.equal((await call('register',identity,nativeToken)).status,401);
    assert.equal((await call('register',identity,otherToken)).status,403);
    assert.equal((await call('register',{...identity,hostId:'other-host'})).status,403);
    const response=await call('register',identity);assert.equal(response.status,201);assert.equal((await response.json()).producerId,'registration-producer');
    assert.equal((await call('publish',input)).status,201);
    assert.equal((await call('publish',input)).status,409);
    const expiryDb=openObservatory();try{expiryDb.prepare('UPDATE registrations SET expires_at=0').run();}finally{expiryDb.close();}
    assert.equal((await call('publish',{...input,expectedRevision:1})).status,403);
    assert.equal((await call('register',identity)).status,201);
    assert.equal((await call('publish',{...input,expectedRevision:1,canvas:{...canvas,currentStep:'After compaction'}})).status,201);
    attempt='attempt-2';
    assert.equal((await call('publish',{...input,expectedRevision:2})).status,409);
    assert.equal((await call('register',identity)).status,409);
    const next={...identity,attemptId:attempt};assert.equal((await call('register',next)).status,201);
    assert.equal((await call('publish',{...input,...next})).status,201);
    assert.equal((await call('publish',input)).status,403);
    ordinal=2;runId='run-2';attempt='attempt-3';
    assert.equal((await call('register',next)).status,409);
    const latest={...identity,runId,attemptId:attempt};assert.equal((await call('register',latest)).status,201);
    assert.equal((await call('publish',{...input,...latest})).status,201);
    ambiguous=true;assert.equal((await call('register',latest)).status,409);ambiguous=false;
    ordinal=NaN;assert.equal((await call('register',latest)).status,409);ordinal=2;
    status='completed';assert.equal((await call('register',latest)).status,409);status='waiting';
    assert.equal((await call('register',latest)).status,201);
    threadId='different';assert.equal((await call('register',latest)).status,503);threadId='thread';
    environment='wrong';assert.equal((await call('register',latest)).status,503);environment='environment';
    // Revoking host opt-in invalidates durable grants immediately; static bindings still work.
    delete (settings.hosts[0] as {producerId?:string}).producerId;save();
    assert.equal((await call('register',latest)).status,403);
    assert.equal((await call('publish',{...input,...latest,expectedRevision:1})).status,403);
    settings.publishers=[{producerId:'registration-producer',...latest}];save();
    assert.equal((await call('publish',{...input,...latest,expectedRevision:1})).status,201);
    assert.equal((await call('register',{...latest,producerId:'other-producer'})).status,400);
    settings.hosts[0].producerId='other-producer';save();assert.throws(()=>config(),/configuration unavailable/);
    assert.ok(calls>25,'authorization always performs fresh native reads');
  } finally {
    globalThis.fetch=oldFetch;for(const key of Object.keys(process.env))if(!(key in oldEnv))delete process.env[key];Object.assign(process.env,oldEnv);rmSync(directory,{recursive:true,force:true});
  }
});
