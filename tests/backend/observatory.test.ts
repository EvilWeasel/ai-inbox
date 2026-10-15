import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openObservatory,publish,latest,history } from '../../src/server/observatory/store';
import { canvasSchema } from '../../src/lib/observatory/contracts';
import { dispatch } from '../../src/server/observatory/transport';
import { redact } from '../../src/server/observatory/native';
const identity={hostId:'host',threadId:'thread',runId:'run',attemptId:'attempt'};
const canvas=canvasSchema.parse({title:'Current work',summary:'Actual publisher supplied state',status:'working',currentStep:'Implement',plan:[{id:'one',text:'Implement',status:'active'}],layout:{columns:2,panels:['summary','plan','history'],accent:'blue'}});
test('durable CAS revisions survive reopening and reject stale updates without mutating history',()=>{
 const dir=mkdtempSync(join(tmpdir(),'obs-cas-'));let db=openObservatory(dir);
 try{assert.equal(publish(db,{...identity,expectedRevision:0,canvas},'publisher').revision,1);assert.throws(()=>publish(db,{...identity,expectedRevision:0,canvas},'publisher'),/Stale revision/);db.close();db=openObservatory(dir);assert.equal(latest(db)[0].revision,1);assert.equal(publish(db,{...identity,expectedRevision:1,canvas:{...canvas,currentStep:'After compaction'}},'publisher').revision,2);assert.deepEqual(history(db,identity).map(r=>r.revision),[2,1]);assert.equal(publish(db,{...identity,attemptId:'next-attempt',expectedRevision:0,canvas},'publisher').revision,1);}finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('structured canvas rejects executable markup layout and reached checkpoints without evidence',()=>{
 assert.equal(canvasSchema.safeParse({...canvas,layout:{...canvas.layout,script:'alert(1)'}}).success,false);
 assert.equal(canvasSchema.safeParse({...canvas,checkpoints:[{id:'pause',reason:'User requested review',requestedBy:'user',status:'reached',reachedAt:null,evidence:''}]}).success,false);
});
test('redaction removes configured bearer values, credential fields and bearer strings',()=>{
 const clean=JSON.stringify(redact({input:'curl Bearer example-token and known-value',credential:{token:'private'},password:'hidden'},['known-value']));
 for(const value of ['known-value','example-token','private','hidden'])assert.equal(clean.includes(value),false);
});
test('shared Agent-Native transport binds writes, validates active run and attempt, and returns CAS conflicts',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'obs-action-'));const oldEnv={...process.env};const oldFetch=globalThis.fetch;
 const token='a'.repeat(40);const credentialFile=join(dir,'peer.json'),configFile=join(dir,'config.json'),producerFile=join(dir,'producer.json');
 writeFileSync(credentialFile,JSON.stringify({credential:{token:'native-read-token'}}),{mode:0o600});
 writeFileSync(configFile,JSON.stringify({hosts:[{id:'host',label:'Host',environmentId:'environment',origin:'https://native.example.test',credentialFile,credentialPath:['credential','token']}],publishers:[{producerId:'publisher',...identity}]}),{mode:0o600});
 writeFileSync(producerFile,JSON.stringify({producers:[{id:'publisher',host:'host',tokenHash:createHash('sha256').update(token).digest('hex')}]}),{mode:0o600});
 process.env.INBOX_OBSERVATORY_CONFIG=configFile;process.env.INBOX_DATA_DIR=join(dir,'data');process.env.INBOX_PRODUCERS_FILE=producerFile;delete process.env.INBOX_ORIGIN;
 let activeAttempt='attempt';let nativeCalls=0;
 globalThis.fetch=async url=>{nativeCalls++;return Response.json(String(url).includes('.well-known')?{environmentId:'environment',orchestrationProtocolVersion:2}:{historyCursor:null,hasMoreHistory:false,latestLocalTurnOrdinal:null,projection:{thread:{id:'thread'},runs:[{id:'run',ordinal:1,activeAttemptId:activeAttempt,status:'running'}]},snapshotSequence:7});};
 const request=(body:unknown,bearer=token)=>new Request('http://localhost/api/observatory/actions/publish',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${bearer}`},body:JSON.stringify(body)});
 try{
  const input={...identity,expectedRevision:0,canvas};
  assert.equal((await dispatch(request(input),'publish')).status,201);
  assert.equal((await dispatch(request(input),'publish')).status,409);
  assert.equal((await dispatch(request({...input,threadId:'other'}),'publish')).status,403);
  assert.equal((await dispatch(request(input,'b'.repeat(40)),'publish')).status,401);
  activeAttempt='obsolete-attempt';assert.equal((await dispatch(request({...input,expectedRevision:1}),'publish')).status,409);
  assert.ok(nativeCalls>=6,'each authorized publish verifies current native attempt freshly');
  assert.equal((await dispatch(request({...input,canvas:{...canvas,status:'invented'}}),'publish')).status,400);
 }finally{globalThis.fetch=oldFetch;for(const key of Object.keys(process.env))if(!(key in oldEnv))delete process.env[key];Object.assign(process.env,oldEnv);rmSync(dir,{recursive:true,force:true});}
});
