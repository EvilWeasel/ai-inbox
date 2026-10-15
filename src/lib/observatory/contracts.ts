import { z } from 'zod';
const id = z.string().min(1).max(300);
export const identitySchema = z.object({ hostId:id, threadId:id, runId:id, attemptId:id }).strict();
export const canvasSchema = z.object({
  title:z.string().min(1).max(200), summary:z.string().max(4000),
  status:z.enum(['working','waiting','blocked','complete','unknown']), currentStep:z.string().max(1000),
  plan:z.array(z.object({id, text:z.string().max(1000), status:z.enum(['pending','active','complete','blocked'])}).strict()).max(100),
  checkpoints:z.array(z.object({id,reason:z.string().min(1).max(2000),requestedBy:z.enum(['user','agent']),status:z.enum(['planned','reached']),reachedAt:z.iso.datetime().nullable(),evidence:z.string().max(2000)}).strict().refine(v=>v.status!=='reached'||Boolean(v.reachedAt&&v.evidence),'Reached checkpoints require timestamp and evidence')).max(50).default([]),
  layout:z.object({columns:z.number().int().min(1).max(3), panels:z.array(z.enum(['summary','plan','activity','history'])).min(1).max(4), accent:z.enum(['blue','green','amber','violet'])}).strict(),
}).strict();
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
