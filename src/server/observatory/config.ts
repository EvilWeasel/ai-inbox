import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { z } from 'zod';
import { ApiError } from '../items';
const id=z.string().min(1).max(300);
const schema=z.object({hosts:z.array(z.object({id,label:id,environmentId:id,origin:z.url(),credentialFile:id,credentialPath:z.array(id).min(1).max(10)}).strict()).max(32),publishers:z.array(z.object({producerId:id,hostId:id,threadId:id,runId:id,attemptId:id}).strict()).max(1000).default([])}).strict();
export type ObservatoryConfig=z.infer<typeof schema>;
export function privateJson(path:string, limit=1024*1024):unknown {
  if(!isAbsolute(path)) throw new Error('Private file required');
  const stat=lstatSync(path); const rel=relative(realpathSync(process.cwd()),realpathSync(path));
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.size>limit||!(rel==='..'||rel.startsWith(`..${sep}`))) throw new Error('Private file required');
  return JSON.parse(readFileSync(path,'utf8'));
}
export function config():ObservatoryConfig {
  if(!process.env.INBOX_OBSERVATORY_CONFIG) return {hosts:[],publishers:[]};
  try {
    const result=schema.parse(privateJson(process.env.INBOX_OBSERVATORY_CONFIG));
    if(new Set(result.hosts.map(h=>h.id)).size!==result.hosts.length) throw new Error();
    for(const h of result.hosts) {const u=new URL(h.origin); if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash) throw new Error();}
    return result;
  } catch {throw new ApiError(503,'Observatory configuration unavailable');}
}
export function credential(host:ObservatoryConfig['hosts'][number]):string {
  let value=privateJson(host.credentialFile);
  for(const key of host.credentialPath) {if(!value||typeof value!=='object'||!Object.hasOwn(value,key)) throw new Error();value=(value as Record<string,unknown>)[key];}
  if(typeof value!=='string'||!value||value.length>4096||/[\r\n]/.test(value)) throw new Error();
  return value;
}
