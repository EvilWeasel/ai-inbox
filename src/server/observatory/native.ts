import type { NativeThread, HostStatus } from '../../lib/observatory/contracts';
import { config, credential, type ObservatoryConfig } from './config';
import { ApiError } from '../items';
type Host=ObservatoryConfig['hosts'][number];
type RecordValue=Record<string,unknown>;
export function record(v:unknown):RecordValue {return v&&typeof v==='object'&&!Array.isArray(v)?v as RecordValue:{};}
function string(v:unknown,fallback='') {return typeof v==='string'?v:fallback;}
const cache=new Map<string,{expires:number,value:unknown}>();
const pending=new Map<string,Promise<unknown>>();
export function redact(value:unknown,secrets:string[]=[]):unknown {
  if(typeof value==='string') {let text=value;for(const secret of secrets) if(secret)text=text.split(secret).join('[redacted]');return text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi,'Bearer [redacted]').replace(/((?:api[_-]?key|access[_-]?token|password|secret|credential)\s*[=:]\s*)[^\s,;]+/gi,'$1[redacted]');}
  if(Array.isArray(value))return value.map(v=>redact(v,secrets));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/(?:token|password|secret|authorization|credential|cookie)/i.test(k)?'[redacted]':redact(v,secrets)]));
  return value;
}
async function boundedJson(response:Response) {
  if(!response.ok)throw new Error('Native read failed');
  const reader=response.body?.getReader();if(!reader)throw new Error();let size=0;const chunks:Uint8Array[]=[];
  try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16*1024*1024){await reader.cancel();throw new Error();}chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{reader.releaseLock();}
}
async function request(host:Host,path:string,token:string,authenticated=true) {
  return boundedJson(await fetch(new URL(path,host.origin),{headers:authenticated?{Authorization:`Bearer ${token}`,'x-t3-orchestration-protocol':'2'}:{},redirect:'error',signal:AbortSignal.timeout(12000),cache:'no-store'}));
}
async function read(host:Host,threadId?:string,fresh=false):Promise<unknown> {
  const key=JSON.stringify([host,threadId]);const hit=cache.get(key);if(!fresh&&hit&&hit.expires>Date.now())return hit.value;
  if(!fresh&&pending.has(key))return pending.get(key)!;
  const promise=(async()=>{const token=credential(host);const descriptor=record(await request(host,'/.well-known/t3/environment',token,false));
    if(descriptor.environmentId!==host.environmentId||descriptor.orchestrationProtocolVersion!==2)throw new Error('Environment mismatch');
    const raw=await request(host,threadId?`/api/orchestration/threads/${encodeURIComponent(threadId)}`:'/api/orchestration/shell',token);
    const value=redact(raw,[token]);cache.set(key,{expires:Date.now()+5000,value});if(cache.size>100)cache.delete(cache.keys().next().value!);return value;
  })();pending.set(key,promise);try{return await promise;}finally{pending.delete(key);}
}
function normalize(hostId:string,raw:unknown):NativeThread {
  const t=record(raw),lineage=record(t.lineage);
  return {id:string(t.id),hostId,title:string(t.title,'Untitled thread'),status:string(t.activityRunStatus,string(t.status,'unknown')),runId:string(t.activeRunId,string(t.latestRunId))||null,parentThreadId:string(lineage.parentThreadId)||null,updatedAt:string(t.updatedAt)||null};
}
export async function inventory() {
  const hosts:HostStatus[]=[],threads:NativeThread[]=[];
  await Promise.all(config().hosts.map(async host=>{
    try {const shell=record(await read(host));if(shell.schemaVersion!==2||!Array.isArray(shell.threads))throw new Error();
      const active=shell.threads,archived=Array.isArray(shell.archivedThreads)?shell.archivedThreads:[];
      const all=[...active,...archived];const unique=new Map(all.map(t=>{const item=normalize(host.id,t);return [item.id,item];}));
      threads.push(...unique.values());hosts.push({id:host.id,label:host.label,environmentId:host.environmentId,status:'online',observedAt:new Date().toISOString(),snapshotSequence:typeof shell.snapshotSequence==='number'?shell.snapshotSequence:null,threadCount:unique.size,message:`${active.length} active inventory · ${archived.length} archived inventory`});
    }catch{hosts.push({id:host.id,label:host.label,environmentId:host.environmentId,status:'offline',observedAt:null,snapshotSequence:null,threadCount:0,message:'Native read unavailable or environment identity not verified'});}
  }));
  return {hosts:hosts.sort((a,b)=>a.label.localeCompare(b.label)),threads:threads.sort((a,b)=>(b.updatedAt??'').localeCompare(a.updatedAt??'')),observedAt:new Date().toISOString()};
}
export async function detail(hostId:string,threadId:string,fresh=false) {
  const host=config().hosts.find(h=>h.id===hostId);if(!host)throw new ApiError(404,'Unknown host');
  try {const raw=record(await read(host,threadId,fresh));const projection=record(raw.projection);if(record(projection.thread).id!==threadId)throw new Error();
    // Provider session metadata can contain credential-bearing runtime configuration.
    const allowed=['thread','runs','attempts','nodes','subagents','runtimeRequests','messages','plans','turnItems','contextHandoffs','contextTransfers','updatedAt'];
    return {hostId,snapshotSequence:raw.snapshotSequence,projection:Object.fromEntries(allowed.map(k=>[k,projection[k]??null])),observedAt:new Date().toISOString()};
  }catch{throw new ApiError(503,'Native thread unavailable');}
}
