import { z } from 'zod';
const id = z.string().min(1).max(300);
export const identitySchema = z.object({ hostId:id, threadId:id, runId:id, attemptId:id }).strict();
const workEvidenceSchema=z.object({label:z.string().min(1).max(200),href:z.string().max(2048).refine(value=>{try{const u=new URL(value);return !u.username&&!u.password&&(u.protocol==='https:'||u.protocol==='t3-thread:'&&u.hostname==='v1');}catch{return false;}},'Supported artifact link required').optional(),itemId:id.optional(),messageId:id.optional()}).strict();
export const workGraphSchema=z.object({
 goal:z.string().min(1).max(1000),orientation:z.enum(['horizontal','vertical']),
 nodes:z.array(z.object({id,title:z.string().min(1).max(200),kind:z.enum(['goal','step','agent','result']),state:z.enum(['planned','active','completed','waiting','blocked','unknown']),summary:z.string().max(2000).optional(),agentThreadId:id.optional(),evidence:z.array(workEvidenceSchema).max(20).default([])}).strict()).min(1).max(60),
 edges:z.array(z.object({from:id,to:id,label:z.string().max(120).optional()}).strict()).max(120),
}).strict().superRefine((graph,ctx)=>{
 if(graph.nodes.some(n=>n.state==='completed'&&!n.evidence.some(e=>e.href||e.itemId||e.messageId)))ctx.addIssue({code:'custom',message:'Completed work requires linked evidence'});
 const ids=new Set(graph.nodes.map(n=>n.id));
 if(ids.size!==graph.nodes.length){ctx.addIssue({code:'custom',message:'Unique work node IDs required'});return;}
 const outgoing=new Map(graph.nodes.map(n=>[n.id,[] as string[]]));const pairs=new Set<string>();
 for(const edge of graph.edges){const key=JSON.stringify([edge.from,edge.to]);if(!ids.has(edge.from)||!ids.has(edge.to)||edge.from===edge.to||pairs.has(key)){ctx.addIssue({code:'custom',message:'Valid unique work dependencies required'});return;}pairs.add(key);outgoing.get(edge.from)!.push(edge.to);}
 const active=new Set<string>(),done=new Set<string>();
 function visit(id:string):boolean{if(active.has(id))return false;if(done.has(id))return true;active.add(id);for(const child of outgoing.get(id)!)if(!visit(child))return false;active.delete(id);done.add(id);return true;}
 if(graph.nodes.some(n=>!visit(n.id)))ctx.addIssue({code:'custom',message:'Work dependencies must be acyclic'});
});
export type WorkGraph=z.infer<typeof workGraphSchema>;
export const canvasSchema = z.object({
  workGraph:workGraphSchema.optional(),
  title:z.string().min(1).max(200), summary:z.string().max(4000),
  status:z.enum(['working','waiting','blocked','complete','unknown']), currentStep:z.string().max(1000),
  plan:z.array(z.object({id, text:z.string().max(1000), status:z.enum(['pending','active','complete','blocked'])}).strict()).max(100),
  checkpoints:z.array(z.object({id,reason:z.string().min(1).max(2000),requestedBy:z.enum(['user','agent']),status:z.enum(['planned','reached']),reachedAt:z.iso.datetime().nullable(),evidence:z.string().max(2000)}).strict().refine(v=>v.status!=='reached'||Boolean(v.reachedAt&&v.evidence),'Reached checkpoints require timestamp and evidence')).max(50).default([]),
  layout:z.object({columns:z.number().int().min(1).max(3), panels:z.array(z.enum(['summary','plan','activity','history'])).min(1).max(4), accent:z.enum(['blue','green','amber','violet'])}).strict(),
}).strict();
export const registrationSchema = identitySchema;
export type Registration = Identity & {producerId:string;registeredAt:string;expiresAt:string};
export const publishSchema = identitySchema.extend({expectedRevision:z.number().int().nonnegative(), canvas:canvasSchema}).strict();
export type Identity = z.infer<typeof identitySchema>;
export type Canvas = z.infer<typeof canvasSchema>;
export type Revision = Identity & {revision:number; publishedAt:string; publisherId:string; canvas:Canvas};
export type NativeThread = {id:string; hostId:string; title:string; status:string; runId:string|null; parentThreadId:string|null; updatedAt:string|null};
export type HostStatus = {id:string;label:string;environmentId:string;status:'online'|'offline'|'unknown';observedAt:string|null;snapshotSequence:number|null;threadCount:number;message:string};
export type Snapshot = {hosts:HostStatus[];threads:NativeThread[];canvases:Revision[];observedAt:string};
export type HistoryCoverage = {historyCursor:string|null;hasMoreHistory:boolean;latestLocalTurnOrdinal:number|null;payloadBudgetExceeded:boolean};
export type HistoryRow = {position:number;visibility:'local'|'inherited'|'synthetic';sourceThreadId:string;sourceItemId:string;item:Record<string,unknown>};
export type HistoryPage = {hostId:string;threadId:string;snapshotSequence:number;items:HistoryRow[];nextCursor:string|null;hasMoreHistory:boolean;observedAt:string};
export const readSchema=z.object({hostId:id.optional(),threadId:id.optional(),itemId:id.optional(),cursor:z.string().min(1).max(16384).optional()}).strict().refine(v=>Boolean(v.hostId)===Boolean(v.threadId),'Host and thread required together').refine(v=>!(v.itemId||v.cursor)||Boolean(v.threadId),'Item or cursor requires thread').refine(v=>!(v.itemId&&v.cursor),'Item and history reads are separate');
