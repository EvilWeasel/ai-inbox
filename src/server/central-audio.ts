import { createHash } from 'node:crypto';
import { ApiError } from './items';
import { getRow } from './items';
import type { InboxDatabase } from './db';
import { audioResponse } from './audio';

const HEX = /^[a-f0-9]{64}$/;
const MEDIA_LIMIT = 30 * 1024 * 1024;
type Producer = { id: string };
type AudioRequest = {
  protocol: 1; deliveryId: string; bodySha256: string; spokenText: string; spokenSha256: string;
};
type RequestRow = {
  id:string; producer_id:string; delivery_id:string; item_id:string; body_sha256:string;
  spoken_sha256:string; voice_profile_sha256:string; spoken_text:string; state:string;
  created_at:string; updated_at:string; ledger_job_id:string|null; media_sha256:string|null;
  duration:number|null; safe_error_code:string|null;
};
export type WorkerRequest = RequestRow & { title:string; external_id:string; item_body_sha256:string };

function sha256(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }
function now() { return new Date().toISOString(); }
function currentProfile() {
  const profile = process.env.INBOX_AUDIO_PROFILE_SHA256;
  if (!profile || !HEX.test(profile)) throw new ApiError(503,'Audio profile unavailable');
  return profile;
}

export function validateAudioRequest(value: unknown): AudioRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400,'Invalid audio request');
  const input = value as Record<string,unknown>;
  if (Object.keys(input).sort().join(',') !== 'bodySha256,deliveryId,protocol,spokenSha256,spokenText'
      || input.protocol !== 1 || typeof input.deliveryId !== 'string' || !input.deliveryId.trim() || input.deliveryId.trim()!==input.deliveryId
      || input.deliveryId.length > 500 || typeof input.bodySha256 !== 'string' || !HEX.test(input.bodySha256)
      || typeof input.spokenSha256 !== 'string' || !HEX.test(input.spokenSha256)
      || typeof input.spokenText !== 'string' || Array.from(input.spokenText).length < 1
      || Array.from(input.spokenText).length > 3500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.spokenText)) {
    throw new ApiError(400,'Invalid audio request');
  }
  if (sha256(input.spokenText) !== input.spokenSha256) throw new ApiError(400,'Spoken text hash mismatch');
  return input as AudioRequest;
}

export function createAudioRequest(db:InboxDatabase, producer:Producer, input:AudioRequest) {
  const externalId = `producer:${producer.id}:delivery:${input.deliveryId}`;
  const row = db.sqlite.prepare('SELECT id,kind,body,audio_file FROM items WHERE external_id=?').get(externalId) as
    {id:string;kind:string;body:string;audio_file:string|null}|undefined;
  if (!row || row.kind !== 'result') throw new ApiError(404,'Result not found');
  if (sha256(row.body) !== input.bodySha256) throw new ApiError(409,'Result body changed');
  if (row.audio_file) return {state:'ready_existing' as const,itemId:row.id};
  const profileHash = currentProfile();
  const id = sha256(JSON.stringify([producer.id,input.deliveryId,input.bodySha256,input.spokenSha256,profileHash]));
  const created = now();
  let inserted=false;
  try {
    db.sqlite.transaction(() => {
      const fresh = db.sqlite.prepare('SELECT kind,body,audio_file FROM items WHERE id=? AND external_id=?').get(row.id,externalId) as
        {kind:string;body:string;audio_file:string|null}|undefined;
      if (!fresh || fresh.kind !== 'result') throw new ApiError(404,'Result not found');
      if (sha256(fresh.body) !== input.bodySha256) throw new ApiError(409,'Result body changed');
      if (fresh.audio_file) return;
      const duplicate = db.sqlite.prepare('SELECT id,state FROM central_audio_requests WHERE id=?').get(id) as {id:string;state:string}|undefined;
      if (duplicate) return;
      const active = db.sqlite.prepare(`SELECT id,spoken_sha256 FROM central_audio_requests
        WHERE item_id=? AND body_sha256=? AND voice_profile_sha256=? LIMIT 1`).get(row.id,input.bodySha256,profileHash) as
        {id:string;spoken_sha256:string}|undefined;
      if (active) throw new ApiError(409,'Audio adaptation requires review');
      db.sqlite.prepare(`INSERT INTO central_audio_requests
        (id,producer_id,delivery_id,item_id,body_sha256,spoken_sha256,voice_profile_sha256,spoken_text,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'queued',?,?)`).run(id,producer.id,input.deliveryId,row.id,input.bodySha256,input.spokenSha256,profileHash,input.spokenText,created,created);
      inserted=true;
    }).immediate();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // A uniqueness race means another identical request won; the stable key
    // makes this exactly the same job and never a second paid attempt.
    const duplicate = db.sqlite.prepare('SELECT state FROM central_audio_requests WHERE id=?').get(id) as {state:string}|undefined;
    if (!duplicate) throw new ApiError(409,'Audio request conflict');
  }
  const request = db.sqlite.prepare('SELECT state FROM central_audio_requests WHERE id=?').get(id) as {state:string}|undefined;
  if (!request) return {state:'ready_existing' as const,itemId:row.id,created:false};
  return {state:request.state,jobId:id,itemId:row.id,created:inserted};
}

export function getAudioRequest(db:InboxDatabase, producer:Producer, id:string) {
  if (!HEX.test(id)) throw new ApiError(404,'Audio job not found');
  const row = db.sqlite.prepare('SELECT * FROM central_audio_requests WHERE id=? AND producer_id=?').get(id,producer.id) as RequestRow|undefined;
  if (!row) throw new ApiError(404,'Audio job not found');
  const item = getRow(db,row.item_id);
  if (!item || item.externalId !== `producer:${producer.id}:delivery:${row.delivery_id}`) throw new ApiError(404,'Audio job not found');
  const currentHash=sha256(item.body);
  const state = currentHash!==row.body_sha256 || (item.audioFile!==null && item.audioFile!==`${row.media_sha256}.mp3`)
    || (row.state==='ready'&&(!item.audioFile||item.audioFile!==`${row.media_sha256}.mp3`)) ? 'superseded' : row.state;
  return {jobId:row.id,itemId:row.item_id,state,...(state==='ready'&&row.media_sha256?{mediaSha256:row.media_sha256,duration:row.duration}:{}),...(state==='needs_review'&&row.safe_error_code?{errorCode:row.safe_error_code}:{})};
}

export async function getAudioRequestMedia(db:InboxDatabase,producer:Producer,id:string,request:Request) {
  if (!HEX.test(id)) throw new ApiError(404,'Audio not found');
  const row = db.sqlite.prepare('SELECT * FROM central_audio_requests WHERE id=? AND producer_id=?').get(id,producer.id) as RequestRow|undefined;
  if (!row || row.state!=='ready' || !row.media_sha256) throw new ApiError(404,'Audio not found');
  const item=getRow(db,row.item_id);
  if (!item || item.externalId!==`producer:${producer.id}:delivery:${row.delivery_id}`
      || !item.audioFile || sha256(item.body)!==row.body_sha256 || item.audioFile!==`${row.media_sha256}.mp3`) throw new ApiError(404,'Audio not found');
  return audioResponse(db,item.id,request);
}

function mpegFrame(buffer:Buffer) {
  if (buffer.length<4 || buffer.length>MEDIA_LIMIT) throw new ApiError(400,'Invalid MP3 audio');
  let offset=0;
  if (buffer.subarray(0,3).toString('ascii')==='ID3') {
    if (buffer.length<10 || (buffer[6]&0x80)||(buffer[7]&0x80)||(buffer[8]&0x80)||(buffer[9]&0x80)) throw new ApiError(400,'Invalid MP3 audio');
    offset=10+((buffer[6]<<21)|(buffer[7]<<14)|(buffer[8]<<7)|buffer[9]);
  }
  if (offset+4>buffer.length) throw new ApiError(400,'Invalid MP3 audio');
  const header=buffer.readUInt32BE(offset),version=(header>>>19)&3,layer=(header>>>17)&3,bitrateIndex=(header>>>12)&15,sampleIndex=(header>>>10)&3;
  if ((header>>>21)!==0x7ff||version===1||layer!==1||bitrateIndex===0||bitrateIndex===15||sampleIndex===3) throw new ApiError(400,'Invalid MP3 audio');
  const mpeg1=[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320],mpeg2=[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
  const bitrate=(version===3?mpeg1:mpeg2)[bitrateIndex]*1000;
  const rate=(version===3?[44100,48000,32000]:version===2?[22050,24000,16000]:[11025,12000,8000])[sampleIndex];
  const frameSize=Math.floor((version===3?144:72)*bitrate/rate)+((header>>>9)&1);
  if (offset+frameSize>buffer.length) throw new ApiError(400,'Invalid MP3 audio');
}

export function listWorkerRequests(db:InboxDatabase,limit:number) {
  if (!Number.isInteger(limit)||limit<1||limit>10) throw new ApiError(400,'Invalid worker limit');
  // Queue discovery is also the recovery point for stale queued/active requests.
  // The caller holds the deployment lock for this local DB operation.
  const rows=db.sqlite.transaction(()=>{
    const candidateLimit=Math.min(100,limit*10);
    const selectState=db.sqlite.prepare(`SELECT id,item_id,body_sha256 FROM central_audio_requests
      WHERE state=? ORDER BY created_at,id LIMIT ?`);
    const queued=selectState.all('queued',candidateLimit) as {id:string;item_id:string;body_sha256:string}[];
    const active=selectState.all('generating',candidateLimit) as {id:string;item_id:string;body_sha256:string}[];
    // Reserve equal capacity for queued and generating work so a new queue
    // cannot starve existing requests that need reconciliation.
    const mark=db.sqlite.prepare(`UPDATE central_audio_requests SET state='superseded',safe_error_code=NULL,updated_at=?
      WHERE id=? AND state IN ('queued','generating')`);
    const live:Array<{id:string;item_body_sha256:string;state:'queued'|'generating'}> = [];
    const itemQuery=db.sqlite.prepare('SELECT body,audio_file FROM items WHERE id=?');
    const seen=new Set<string>();
    const selectLive=(source:typeof queued,state:'queued'|'generating',maximum:number)=>{
      let count=0;
      for(const candidate of source){
        if(seen.has(candidate.id)||count>=maximum) continue;
        const item=itemQuery.get(candidate.item_id) as {body:string;audio_file:string|null}|undefined;
        if(!item||sha256(item.body)!==candidate.body_sha256||item.audio_file){mark.run(now(),candidate.id);seen.add(candidate.id);continue;}
        live.push({id:candidate.id,item_body_sha256:candidate.body_sha256,state});seen.add(candidate.id);count++;
      }
    };
    selectLive(queued,'queued',Math.ceil(limit/2));
    selectLive(active,'generating',Math.floor(limit/2));
    // Release unused fair-share slots when one state has too little work.
    if(live.length<limit){selectLive(queued,'queued',limit-live.length);}
    if(live.length<limit){selectLive(active,'generating',limit-live.length);}
    live.splice(limit);
    const get=db.sqlite.prepare(`SELECT r.*,i.title,i.external_id FROM central_audio_requests r
      JOIN items i ON i.id=r.item_id WHERE r.id=? AND r.state IN ('queued','generating') AND i.audio_file IS NULL`);
    return live.map(row=>({...get.get(row.id) as WorkerRequest,item_body_sha256:row.item_body_sha256,item_has_audio:false}));
  }).immediate();
  return rows;
}

export function updateWorkerRequest(db:InboxDatabase,input:{requestId:string;ledgerJobId:string;state:'generating'|'needs_review';safeErrorCode?:string|null}) {
  if (!HEX.test(input.requestId)||! /^[A-Za-z0-9._:-]{1,256}$/.test(input.ledgerJobId)
      || (input.safeErrorCode!=null&&!/^[a-z][a-z0-9_]{0,63}$/.test(input.safeErrorCode))) throw new ApiError(400,'Invalid worker update');
  return db.sqlite.transaction(()=>{
    const row=db.sqlite.prepare('SELECT * FROM central_audio_requests WHERE id=?').get(input.requestId) as RequestRow|undefined;
    if (!row) throw new ApiError(404,'Audio job not found');
    if (row.ledger_job_id&&row.ledger_job_id!==input.ledgerJobId) throw new ApiError(409,'Audio ledger binding conflict');
    if (input.state==='generating'&&row.state!=='queued'&&row.state!=='generating') throw new ApiError(409,'Audio job state conflict');
    if (input.state==='needs_review'&&row.state!=='queued'&&row.state!=='generating'&&row.state!=='needs_review') throw new ApiError(409,'Audio job state conflict');
    const safeErrorCode=input.state==='needs_review'?(input.safeErrorCode??'audio_review_required'):null;
    if(row.state===input.state){
      if(row.ledger_job_id===input.ledgerJobId&&(input.state==='generating'||row.safe_error_code===safeErrorCode))
        return {state:row.state,ledger_job_id:row.ledger_job_id};
      throw new ApiError(409,'Audio job state conflict');
    }
    const changed=db.sqlite.prepare(`UPDATE central_audio_requests SET ledger_job_id=?,state=?,safe_error_code=?,updated_at=?
      WHERE id=? AND (ledger_job_id IS NULL OR ledger_job_id=?)`).run(input.ledgerJobId,input.state,safeErrorCode,now(),input.requestId,input.ledgerJobId);
    if (!changed.changes) throw new ApiError(409,'Audio ledger binding conflict');
    return db.sqlite.prepare('SELECT state,ledger_job_id FROM central_audio_requests WHERE id=?').get(input.requestId) as {state:string;ledger_job_id:string};
  }).immediate();
}

export function getWorkerRequest(db:InboxDatabase,id:string) {
  if(!HEX.test(id)) throw new ApiError(400,'Invalid worker request');
  return db.sqlite.transaction(()=>{
    const get=db.sqlite.prepare(`SELECT r.*,i.title,i.external_id,i.body,i.audio_file
      FROM central_audio_requests r JOIN items i ON i.id=r.item_id WHERE r.id=?`);
    const row=get.get(id) as (WorkerRequest & {body:string;audio_file:string|null})|undefined;
    if(!row) return null;
    const bodyHash=sha256(row.body),hasAudio=row.audio_file!==null;
    if(['queued','generating'].includes(row.state)&&(bodyHash!==row.body_sha256||hasAudio)){
      db.sqlite.prepare(`UPDATE central_audio_requests SET state='superseded',safe_error_code=NULL,updated_at=?
        WHERE id=? AND state IN ('queued','generating')`).run(now(),id);
      return {...row,state:'superseded',item_body_sha256:bodyHash,item_has_audio:hasAudio};
    }
    return {...row,item_body_sha256:bodyHash,item_has_audio:hasAudio};
  }).immediate();
}

export function resolveWorkerRequest(db:InboxDatabase,input:{requestId:string;expectedState:'queued'|'generating';expectedBodySha256:string;state:'needs_review'|'superseded';safeErrorCode?:string|null}) {
  if(!HEX.test(input.requestId)||!HEX.test(input.expectedBodySha256)
      ||!['queued','generating'].includes(input.expectedState)||!['needs_review','superseded'].includes(input.state)
      ||(input.safeErrorCode!=null&&!/^[a-z][a-z0-9_]{0,63}$/.test(input.safeErrorCode))) throw new ApiError(400,'Invalid worker resolution');
  return db.sqlite.transaction(()=>{
    const row=db.sqlite.prepare('SELECT * FROM central_audio_requests WHERE id=?').get(input.requestId) as RequestRow|undefined;
    if(!row) throw new ApiError(404,'Audio job not found');
    if(row.state!==input.expectedState||row.body_sha256!==input.expectedBodySha256) throw new ApiError(409,'Audio job state conflict');
    if(input.state==='superseded'){
      const item=db.sqlite.prepare('SELECT body,audio_file FROM items WHERE id=?').get(row.item_id) as {body:string;audio_file:string|null}|undefined;
      if(!item||(sha256(item.body)===row.body_sha256&&!item.audio_file)) throw new ApiError(409,'Audio request is not obsolete');
    }
    const errorCode=input.state==='needs_review'?(input.safeErrorCode??'audio_review_required'):null;
    db.sqlite.prepare('UPDATE central_audio_requests SET state=?,safe_error_code=?,updated_at=? WHERE id=? AND state=? AND body_sha256=?')
      .run(input.state,errorCode,now(),input.requestId,input.expectedState,input.expectedBodySha256);
    return {state:input.state};
  }).immediate();
}

async function readPrivateMp3(source:string) {
  const { lstat, open, realpath } = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const { isAbsolute, resolve, relative, sep, dirname, parse } = await import('node:path');
  const configured=process.env.INBOX_AUDIO_WORKER_MEDIA_DIR;
  if (!configured||!isAbsolute(configured)||!isAbsolute(source)) throw new ApiError(400,'Audio media unavailable');
  const root=resolve(configured),file=resolve(source),rel=relative(root,file);
  if (rel===''||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel)) throw new ApiError(400,'Audio media unavailable');
  const ancestors:string[]=[]; let cursor=dirname(file);
  while (cursor!==parse(cursor).root) { ancestors.push(cursor); cursor=dirname(cursor); }
  ancestors.push(cursor);
  for (const path of ancestors.reverse()) { const stat=await lstat(path).catch(()=>null); if (!stat?.isDirectory()||stat.isSymbolicLink()) throw new ApiError(400,'Audio media unavailable'); }
  const rootStat=await lstat(root).catch(()=>null);
  if (!rootStat?.isDirectory()||rootStat.isSymbolicLink()||await realpath(root)!==root) throw new ApiError(400,'Audio media unavailable');
  const stat=await lstat(file).catch(()=>null);
  if (!stat?.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||stat.size<4||stat.size>MEDIA_LIMIT||await realpath(file)!==file) throw new ApiError(400,'Audio media unavailable');
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW).catch(()=>null);
  if (!handle) throw new ApiError(400,'Audio media unavailable');
  try {
    const actual=await handle.stat();
    if (!actual.isFile()||actual.uid!==process.getuid?.()||actual.size!==stat.size||actual.size>MEDIA_LIMIT) throw new ApiError(400,'Audio media unavailable');
    const chunks:Buffer[]=[];let size=0;const chunk=Buffer.alloc(64*1024);
    for(;;){
      const {bytesRead}=await handle.read(chunk,0,chunk.length,null);if(!bytesRead)break;
      size+=bytesRead;if(size>MEDIA_LIMIT)throw new ApiError(400,'Audio media unavailable');
      chunks.push(Buffer.from(chunk.subarray(0,bytesRead)));
    }
    if (size!==actual.size) throw new ApiError(400,'Audio media unavailable');
    const bytes=Buffer.concat(chunks,size);
    mpegFrame(bytes);
    return bytes;
  } finally { await handle.close(); }
}

async function copyValidatedMedia(db:InboxDatabase,bytes:Buffer) {
  const { mkdir, lstat, realpath, open, link, unlink }=await import('node:fs/promises');
  const { join, resolve }=await import('node:path');
  const { randomUUID }=await import('node:crypto');
  const { constants }=await import('node:fs');
  const media=join(db.directory,'media'); await mkdir(media,{recursive:true,mode:0o700});
  const stat=await lstat(media).catch(()=>null);
  if (!stat?.isDirectory()||stat.isSymbolicLink()||await realpath(media)!==resolve(media)) throw new ApiError(503,'Audio storage unavailable');
  const hash=sha256(bytes),name=`${hash}.mp3`,target=join(media,name);
  const verifyTarget=async()=>{
    const targetStat=await lstat(target).catch(()=>null);
    if(!targetStat?.isFile()||targetStat.isSymbolicLink()||targetStat.uid!==process.getuid?.()||targetStat.size<4||targetStat.size>MEDIA_LIMIT)
      throw new ApiError(503,'Audio storage unavailable');
    const existingHandle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW).catch(()=>null);
    if(!existingHandle) throw new ApiError(503,'Audio storage unavailable');
    try{
      const actual=await existingHandle.stat();
      if(!actual.isFile()||actual.uid!==process.getuid?.()||actual.size!==targetStat.size) throw new ApiError(503,'Audio storage unavailable');
      const storedBytes=await existingHandle.readFile();
      if(storedBytes.length!==actual.size||sha256(storedBytes)!==hash) throw new ApiError(503,'Audio storage unavailable');
      mpegFrame(storedBytes);
    }finally{await existingHandle.close();}
  };
  const existing=await lstat(target).catch(()=>null);
  if (existing) { await verifyTarget(); return {name,hash,created:false}; }
  const temp=join(media,`.central-audio-${process.pid}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle=await open(temp,'wx',0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle=undefined;
    try { await link(temp,target); await unlink(temp); return {name,hash,created:true}; }
    catch (error) {
      await unlink(temp).catch(()=>{});
      if ((error as NodeJS.ErrnoException).code==='EEXIST') {
        await verifyTarget(); return {name,hash,created:false};
      }
      throw error;
    }
  } catch { if(handle) await handle.close().catch(()=>{}); await unlink(temp).catch(()=>{}); throw new ApiError(503,'Audio storage unavailable'); }
}

export async function attachWorkerMedia(db:InboxDatabase,input:{requestId:string;ledgerJobId:string;bodySha256:string;source:string;mediaSha256:string;duration:number}) {
  if (!HEX.test(input.requestId)||! /^[A-Za-z0-9._:-]{1,256}$/.test(input.ledgerJobId)||!HEX.test(input.bodySha256)
      ||!HEX.test(input.mediaSha256)||!Number.isFinite(input.duration)||input.duration<=0||input.duration>86400) throw new ApiError(400,'Invalid audio attachment');
  const bytes=await readPrivateMp3(input.source),actualHash=sha256(bytes);
  if(actualHash!==input.mediaSha256) throw new ApiError(400,'Audio media hash mismatch');
  const stored=await copyValidatedMedia(db,bytes);
  try {
    const result=db.sqlite.transaction(()=>{
      const request=db.sqlite.prepare('SELECT * FROM central_audio_requests WHERE id=?').get(input.requestId) as RequestRow|undefined;
      if(!request) throw new ApiError(404,'Audio job not found');
      if(request.ledger_job_id!==input.ledgerJobId) throw new ApiError(409,'Audio ledger binding conflict');
      if(request.body_sha256!==input.bodySha256) throw new ApiError(409,'Audio body hash mismatch');
      const item=db.sqlite.prepare('SELECT id,external_id,kind,body,audio_file FROM items WHERE id=?').get(request.item_id) as
        {id:string;external_id:string;kind:string;body:string;audio_file:string|null}|undefined;
      if(!item||item.kind!=='result'||item.external_id!==`producer:${request.producer_id}:delivery:${request.delivery_id}`) throw new ApiError(404,'Result not found');
      const sameReadyMedia=request.state==='ready'&&request.media_sha256===actualHash&&item.audio_file===stored.name;
      if(sha256(item.body)!==input.bodySha256||input.bodySha256!==request.body_sha256||(item.audio_file&&!sameReadyMedia)) {
        db.sqlite.prepare(`UPDATE central_audio_requests SET state='superseded',safe_error_code=NULL,updated_at=? WHERE id=? AND state<>'superseded'`).run(now(),input.requestId);
        return {state:'superseded',itemId:request.item_id};
      }
      if(request.state==='ready') {
        if(sameReadyMedia&&request.ledger_job_id===input.ledgerJobId) return {state:'ready',itemId:request.item_id,mediaSha256:actualHash,duration:request.duration};
        throw new ApiError(409,'Audio attachment conflict');
      }
      if(request.state!=='generating'&&request.state!=='needs_review') throw new ApiError(409,'Audio job state conflict');
      db.sqlite.prepare('UPDATE items SET audio_file=?,audio_duration=? WHERE id=? AND audio_file IS NULL').run(stored.name,input.duration,item.id);
      db.sqlite.prepare(`UPDATE central_audio_requests SET state='ready',media_sha256=?,duration=?,safe_error_code=NULL,updated_at=? WHERE id=?`).run(actualHash,input.duration,now(),input.requestId);
      return {state:'ready',itemId:item.id,mediaSha256:actualHash,duration:input.duration};
    }).immediate();
    if(result.state==='superseded'&&stored.created) {
      const used=db.sqlite.prepare('SELECT 1 FROM items WHERE audio_file=? LIMIT 1').get(stored.name);
      if(!used) { const {unlink}=await import('node:fs/promises'); await unlink(`${db.directory}/media/${stored.name}`).catch(()=>{}); }
    }
    return result;
  } catch(error) {
    if(stored.created) {
      const used=db.sqlite.prepare('SELECT 1 FROM items WHERE audio_file=? LIMIT 1').get(stored.name);
      if(!used) { const {unlink}=await import('node:fs/promises'); await unlink(`${db.directory}/media/${stored.name}`).catch(()=>{}); }
    }
    throw error;
  }
}
