import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ApiError } from './items';
import { detail } from './items';
import type { InboxDatabase } from './db';
import { resultMetadataSchema, type ResultMetadata } from '../lib/contracts';

export const RESULT_METADATA_LIMIT = 2 * 1024 * 1024;
export const RESULT_AUDIO_LIMIT = 30 * 1024 * 1024;
export const PRODUCER_REQUESTS_PER_MINUTE = 60;
const MULTIPART_OVERHEAD_LIMIT = 64 * 1024;
const producerRequests = new Map<string,number[]>();
export type Producer = { id:string; host:string; tokenHash:string };

function producers(): Producer[] {
  const configPath = process.env.INBOX_PRODUCERS_FILE;
  if (!configPath || !isAbsolute(configPath)) throw new ApiError(503,'Producer authentication unavailable');
  try {
    const rel = relative(realpathSync(process.cwd()), realpathSync(configPath));
    if (!(rel === '..' || rel.startsWith(`..${sep}`)) || isAbsolute(rel)) throw new Error();
    const stat = lstatSync(configPath);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error();
  } catch { throw new ApiError(503,'Producer authentication unavailable'); }
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath,'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as {producers?:unknown}).producers)) throw new Error();
    const list = (parsed as {producers:unknown[]}).producers;
    if (list.length>100) throw new Error();
    return list.map(value => {
      if (!value || typeof value !== 'object') throw new Error();
      const p = value as Record<string,unknown>;
      if (typeof p.id !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(p.id) || typeof p.host !== 'string' || !p.host.trim() || p.host.length>255 || typeof p.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(p.tokenHash)) throw new Error();
      return {id:p.id,host:p.host.trim(),tokenHash:p.tokenHash};
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503,'Producer authentication unavailable');
  }
}

export function authenticateProducer(request: Request): Producer {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9._~-]{32,512})$/.exec(header);
  const supplied = createHash('sha256').update(match?.[1] ?? 'invalid-token').digest();
  const entries = producers();
  let candidate: Producer | undefined;
  // Compare every configured hash; no token, hash, or producer detail enters an error.
  for (const producer of entries) {
    const expected = Buffer.from(producer.tokenHash,'hex');
    if (timingSafeEqual(supplied,expected)) candidate = producer;
  }
  if (!match || !candidate) throw new ApiError(401,'Producer authentication required');
  return candidate;
}

export function validateProducerHost(producer: Producer, submittedHost: string) {
  if (submittedHost.trim().toLowerCase() !== producer.host.toLowerCase()) throw new ApiError(403,'Producer host mismatch');
}

export function assertProducerRateLimit(producer:Producer, now=Date.now()) {
  const recent=(producerRequests.get(producer.id)??[]).filter(time=>now-time<60_000);
  if(recent.length>=PRODUCER_REQUESTS_PER_MINUTE) throw new ApiError(429,'Producer rate limit exceeded');
  recent.push(now);producerRequests.set(producer.id,recent);
}

export async function readResultRequest(request: Request): Promise<{metadata:ResultMetadata; audio:Buffer|null}> {
  const contentType = request.headers.get('content-type') ?? '';
  const multipart = /^multipart\/form-data\s*;/i.test(contentType);
  const json = /^application\/json(?:\s*;|$)/i.test(contentType);
  if (!multipart && !json) throw new ApiError(415,'JSON or multipart form data required');
  const max = multipart ? RESULT_METADATA_LIMIT + RESULT_AUDIO_LIMIT + MULTIPART_OVERHEAD_LIMIT : RESULT_METADATA_LIMIT;
  const bytes = await readBounded(request,max);
  let raw: unknown; let audio:Buffer|null = null;
  if (json) {
    try { raw=JSON.parse(bytes.toString('utf8')); } catch { throw new ApiError(400,'Invalid result metadata'); }
  } else {
    if (!/(?:^|;)\s*boundary=(?:"[^"]+"|[^;\s]+)/i.test(contentType)) throw new ApiError(400,'Invalid multipart request');
    try {
      const form = await new Request(request.url,{method:'POST',headers:{'content-type':contentType},body:bytes}).formData();
      const metadata=form.get('metadata'); const file=form.get('audio');
      if (typeof metadata !== 'string' || [...form.keys()].some(key=>key!=='metadata'&&key!=='audio') || form.getAll('metadata').length!==1 || form.getAll('audio').length>1) throw new Error();
      if (Buffer.byteLength(metadata,'utf8')>RESULT_METADATA_LIMIT) throw new ApiError(413,'Metadata too large');
      raw=JSON.parse(metadata);
      if (file !== null) {
        if (!(file instanceof File) || file.size > RESULT_AUDIO_LIMIT || !file.name.toLowerCase().endsWith('.mp3') || (file.type && file.type!=='audio/mpeg' && file.type!=='audio/mp3')) throw new ApiError(415,'MP3 audio required');
        audio=Buffer.from(await file.arrayBuffer());
      }
    } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400,'Invalid multipart request'); }
  }
  if (json && bytes.length > RESULT_METADATA_LIMIT) throw new ApiError(413,'Metadata too large');
  try { return {metadata:resultMetadataSchema.parse(raw),audio}; }
  catch { throw new ApiError(400,'Invalid result metadata'); }
}

async function readBounded(request:Request, limit:number) {
  const declared=request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared)>limit)) throw new ApiError(413,'Request too large');
  const reader=request.body?.getReader(); if (!reader) throw new ApiError(400,'Request body required');
  const parts:Buffer[]=[]; let size=0;
  try {
    for (;;) { const {done,value}=await reader.read(); if(done) break; size+=value.byteLength; if(size>limit) { await reader.cancel(); throw new ApiError(413,'Request too large'); } parts.push(Buffer.from(value)); }
    return Buffer.concat(parts,size);
  } finally { reader.releaseLock(); }
}

export function assertMp3(buffer:Buffer) {
  if (buffer.length<4 || buffer.length>RESULT_AUDIO_LIMIT) throw new ApiError(400,'Invalid MP3 audio');
  let offset=0;
  if (buffer.subarray(0,3).toString('ascii')==='ID3') {
    if (buffer.length<10 || (buffer[6]&0x80)||(buffer[7]&0x80)||(buffer[8]&0x80)||(buffer[9]&0x80)) throw new ApiError(400,'Invalid MP3 audio');
    const tagSize=(buffer[6]<<21)|(buffer[7]<<14)|(buffer[8]<<7)|buffer[9]; offset=10+tagSize;
    if(offset+4>buffer.length) throw new ApiError(400,'Invalid MP3 audio');
  }
  const h=buffer.readUInt32BE(offset); const version=(h>>>19)&3, layer=(h>>>17)&3, bitrateIndex=(h>>>12)&15, sampleIndex=(h>>>10)&3;
  if ((h>>>21)!==0x7ff || version===1 || layer!==1 || bitrateIndex===0 || bitrateIndex===15 || sampleIndex===3) throw new ApiError(400,'Invalid MP3 audio');
  const mpeg1=[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320];
  const mpeg2=[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
  const bitrate=(version===3?mpeg1:mpeg2)[bitrateIndex]*1000;
  const sampleRates=version===3?[44100,48000,32000]:version===2?[22050,24000,16000]:[11025,12000,8000];
  const frameLength=Math.floor((version===3?144:72)*bitrate/sampleRates[sampleIndex])+((h>>>9)&1);
  if(offset+frameLength>buffer.length) throw new ApiError(400,'Invalid MP3 audio');
}

async function storeAudio(db:InboxDatabase, audio:Buffer) {
  assertMp3(audio);
  const name=createHash('sha256').update(audio).digest('hex')+'.mp3';
  const media=join(db.directory,'media'); await mkdir(media,{recursive:true,mode:0o700});
  const mediaStat=await lstat(media).catch(()=>null);
  if (!mediaStat?.isDirectory() || mediaStat.isSymbolicLink()) throw new ApiError(503,'Audio storage unavailable');
  const root=await realpath(media); if(root!==resolve(media)) throw new ApiError(503,'Audio storage unavailable');
  const target=join(root,name);
  try { const st=await lstat(target); if(!st.isFile()||st.isSymbolicLink()) throw new Error(); return {name,created:false}; }
  catch (error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw new ApiError(503,'Audio storage unavailable'); }
  const temp=join(root,`.result-${process.pid}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle=await open(temp,'wx',0o600); await handle.writeFile(audio); await handle.sync(); await handle.close(); handle=undefined;
    try { await link(temp,target); await unlink(temp); return {name,created:true}; }
    catch (error) {
      await unlink(temp).catch(()=>{});
      if((error as NodeJS.ErrnoException).code==='EEXIST') {
        const st=await lstat(target).catch(()=>null);
        if(st?.isFile()&&!st.isSymbolicLink()) return {name,created:false};
      }
      throw error;
    }
  } catch { if(handle) await handle.close().catch(()=>{}); await unlink(temp).catch(()=>{}); throw new ApiError(503,'Audio storage unavailable'); }
}

export async function ingestResult(db:InboxDatabase, producer:Producer, metadata:ResultMetadata, audio:Buffer|null) {
  validateProducerHost(producer,metadata.origin.host);
  const stored=audio ? await storeAudio(db,audio) : null;
  const externalId=`producer:${producer.id}:delivery:${metadata.deliveryId}`;
  const origin=JSON.stringify(metadata.origin);
  try {
    const created=db.sqlite.transaction(()=>{
      const exists=db.sqlite.prepare('SELECT id FROM items WHERE external_id=?').get(externalId) as {id:string}|undefined;
      db.sqlite.prepare(`INSERT INTO items
        (id,external_id,title,kind,result_type,origin,edition,published_at,body,summary,sources,tags,audio_file,audio_duration,provenance)
        VALUES(?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?)
        ON CONFLICT(external_id) DO UPDATE SET title=excluded.title,kind=excluded.kind,result_type=excluded.result_type,
          origin=excluded.origin,published_at=excluded.published_at,body=excluded.body,summary=excluded.summary,
          sources=excluded.sources,tags=excluded.tags,audio_file=COALESCE(excluded.audio_file,items.audio_file),
          audio_duration=CASE WHEN excluded.audio_file IS NULL THEN items.audio_duration ELSE excluded.audio_duration END`).run(
        randomUUID(),externalId,metadata.title,'result',metadata.resultType,origin,new Date(metadata.publishedAt).toISOString(),
        metadata.body,metadata.summary??'',JSON.stringify(metadata.sources??[]),JSON.stringify(metadata.tags??[]),stored?.name??null,
        stored ? metadata.audioDuration??null : null,'{}');
      const row=db.sqlite.prepare('SELECT id FROM items WHERE external_id=?').get(externalId) as {id:string};
      return {created:!exists,id:row.id};
    }).immediate();
    return {item:detail(db,created.id),created:created.created};
  } catch (error) {
    if (stored?.created) {
      const used=db.sqlite.prepare('SELECT 1 FROM items WHERE audio_file=? LIMIT 1').get(stored.name);
      if (!used) await unlink(join(db.directory,'media',stored.name)).catch(()=>{});
    }
    throw error;
  }
}
