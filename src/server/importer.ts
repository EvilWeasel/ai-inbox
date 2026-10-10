import { z } from 'zod';
import { readFileSync, existsSync, realpathSync, statSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve, relative, dirname, basename, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ingestSchema, type IngestItem } from '../lib/contracts';
import { upsertBatch, type PreparedItem } from './items';
import type { InboxDatabase } from './db';

const eventSchema = z.object({id:z.string(),title:z.string().optional(),sources:z.array(z.string()).optional(),alert_path:z.string().optional(),audio_metadata_path:z.string().optional(),reported_at:z.string().optional(),alerted_at:z.string().optional(),delivery:z.string().optional(),updates:z.array(z.unknown()).optional()}).passthrough();
const historySchema = z.object({at:z.string(),date:z.string(),briefing_path:z.string(),audio_path:z.string().optional(),attachment_id:z.string().optional()}).passthrough();
const indexSchema = z.object({events:z.array(eventSchema).default([]),briefing_history:z.array(historySchema).default([])}).passthrough();
function readJson(path: string): unknown { return JSON.parse(readFileSync(path,'utf8')); }
function inside(root: string, path: string) {
  const rel = relative(root,path);
  return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
}
function confined(root: string, path: string) {
  const candidate = resolve(path);
  if (!inside(resolve(root),candidate)) throw new Error('Source reference escapes source root');
  if (existsSync(candidate) && !inside(realpathSync(root),realpathSync(candidate))) throw new Error('Source symlink escapes source root');
  return candidate;
}
export function sourceRoots(source: string) {
  const selected = realpathSync(source);
  const briefing = basename(selected) === 'ai-briefing' ? selected : join(selected,'.t3-artifacts','ai-briefing');
  const project = dirname(dirname(briefing));
  return {briefing:realpathSync(briefing),audio:join(project,'.t3-artifacts','audio')};
}
// Resolve both local references and historical source references without embedding any host path.
function artifactReference(value: string, roots: ReturnType<typeof sourceRoots>, type:'briefing'|'audio') {
  const normalized = value.replaceAll('\\','/');
  const marker = `.t3-artifacts/${type === 'briefing' ? 'ai-briefing' : 'audio'}/`;
  const index = normalized.indexOf(marker);
  const root = roots[type];
  if (index >= 0) return confined(root,join(root,normalized.slice(index+marker.length)));
  if (isAbsolute(value)) return confined(root,value);
  return confined(root,join(root,value));
}
function sources(body: string, urls: string[] = []) {
  const result = new Map<string,string>();
  for (const match of body.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g)) result.set(match[2],match[1]);
  for (const url of urls) if (/^https?:\/\//i.test(url) && !result.has(url)) result.set(url,new URL(url).hostname);
  return [...result].map(([url,title]) => ({title,url}));
}
function plainText(value: string) {
  return value.replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/<[^>]*>/g,'').replace(/[*_`~]/g,'').replace(/\s+/g,' ').trim();
}
function heading(body: string) { return plainText(body.match(/^#{1,6}\s+(.+)$/m)?.[1] ?? body.split('\n').find(x=>x.trim()) ?? ''); }
function summary(body: string) {
  const title = heading(body);
  return plainText(body.split(/\n\s*\n/).find(p=>p.trim() && !p.trim().startsWith('#') && plainText(p)!==title) ?? '').slice(0,600);
}
function historicalReference(value: string) { return value.replaceAll('\\','/').includes('/.t3/scratch/'); }
export function copyMedia(db: InboxDatabase, source: string) {
  if (basename(source).toLowerCase().slice(-4) !== '.mp3') throw new Error('MP3 media required');
  const stat = statSync(source); if (!stat.isFile() || stat.size === 0 || stat.size > 100_000_000) throw new Error('Invalid media size');
  const bytes = readFileSync(source); const name = createHash('sha256').update(bytes).digest('hex')+'.mp3';
  const mediaRoot = realpathSync(join(db.directory,'media'));
  const destination = join(mediaRoot,name);
  if (existsSync(destination)) {
    if (!inside(mediaRoot,realpathSync(destination)) || createHash('sha256').update(readFileSync(destination)).digest('hex')+'.mp3' !== name) throw new Error('Stored media integrity error');
    return name;
  }
  const temporary = join(mediaRoot,`.${randomUUID()}.tmp`);
  const fd = openSync(temporary,'wx',0o600);
  try { writeFileSync(fd,bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary,destination); const dirFd = openSync(mediaRoot,'r'); try {fsyncSync(dirFd);} finally {closeSync(dirFd);} }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return name;
}
export type ImportRecord = {item:IngestItem;mediaPath?:string};
export function collectArtifacts(source: string) {
  const roots = sourceRoots(source); const warnings: string[] = []; const records: ImportRecord[] = [];
  const daily = indexSchema.parse(readJson(join(roots.briefing,'index.json')));
  function audio(reference?: string, metadataFile?: string) {
    let duration: number|null = null;
    if (metadataFile && existsSync(metadataFile)) {
      const meta = z.object({audio_path:z.string().optional(),duration_seconds:z.number().finite().nonnegative().optional()}).passthrough().parse(readJson(metadataFile));
      reference ??= meta.audio_path; duration = meta.duration_seconds ?? null;
    }
    if (!reference) return {duration};
    const path = artifactReference(reference,roots,'audio');
    if (!existsSync(path)) { warnings.push('Referenced audio missing; importing text only'); return {duration:null}; }
    // If duration was not supplied, use only the exact audio sidecar, never a glob.
    if (duration === null && existsSync(path.slice(0,-4)+'.json')) {
      const meta = z.object({duration_seconds:z.number().finite().nonnegative().optional()}).passthrough().parse(readJson(path.slice(0,-4)+'.json'));
      duration = meta.duration_seconds ?? null;
    }
    return {mediaPath:path,duration};
  }
  for (const history of daily.briefing_history) {
    const path = artifactReference(history.briefing_path,roots,'briefing');
    if (!existsSync(path)) { warnings.push('Indexed briefing body missing; skipped'); continue; }
    const body = readFileSync(path,'utf8'); const related = daily.events.filter(e=>e.briefing_path === history.briefing_path);
    const media = audio(history.audio_path);
    const test = /test/i.test(basename(path));
    const historical = historicalReference(history.briefing_path) || historicalReference(history.audio_path??'') || (!history.attachment_id && existsSync(join(dirname(dirname(roots.briefing)),'MIGRATION.md')));
    const tags = ['imported',...(historical?['historical-migration']:[]),...(test?['historical-test']:[])];
    const item = ingestSchema.parse({externalId:`ai-news:briefing:${relative(roots.briefing,path)}`,title:heading(body),kind:'briefing',edition:test?null:/(?:^|[\/_.-])(?:abend|evening)(?:[\/_.-]|$)/i.test(relative(roots.briefing,path))?'evening':'morning',publishedAt:history.at,body,summary:summary(body),sources:sources(body,related.flatMap(e=>e.sources??[])),tags,audioDuration:media.duration,provenance:{type:'ai-news',history,events:related,sourceReference:history.briefing_path}});
    records.push({item,mediaPath:media.mediaPath});
  }
  const alertsPath = join(roots.briefing,'openai-watch','alerts.json');
  if (existsSync(alertsPath)) {
    const alertIndex = indexSchema.parse(readJson(alertsPath));
    const groups = new Map<string,z.infer<typeof eventSchema>[]>();
    for (const parent of alertIndex.events) {
      for (const event of [parent,...(parent.updates??[]).map(v=>eventSchema.parse(v))]) {
        if (!event.alert_path || !(event.reported_at || event.alerted_at) || !event.delivery) continue;
        const path = artifactReference(event.alert_path,roots,'briefing');
        const group = groups.get(path)??[]; group.push(event); groups.set(path,group);
      }
    }
    for (const [path,events] of groups) {
      if (!existsSync(path)) { warnings.push('Delivered alert body missing; skipped'); continue; }
      const body = readFileSync(path,'utf8');
      const metadataReferences = events.map(e=>e.audio_metadata_path).filter((v):v is string=>!!v);
      const metadata = metadataReferences.length ? artifactReference(metadataReferences[0],roots,'briefing') : join(dirname(path),'audio-metadata.json');
      const media = audio(undefined,confined(roots.briefing,metadata));
      const historical = events.some(e=>historicalReference(e.alert_path??''));
      const item = ingestSchema.parse({externalId:`ai-news:alert:${relative(roots.briefing,path)}`,title:heading(body),kind:'alert',publishedAt:events[0].reported_at??events[0].alerted_at,body,summary:summary(body),sources:sources(body,events.flatMap(e=>e.sources??[])),tags:['imported',...(historical?['historical-migration']:[])],audioDuration:media.duration,provenance:{type:'ai-news',events,sourceReference:events[0].alert_path}});
      records.push({item,mediaPath:media.mediaPath});
    }
  }
  return {records,warnings};
}
export function importRecords(db: InboxDatabase, records: ImportRecord[]) {
  const validated = records.map(r=>({...r,item:ingestSchema.parse(r.item)}));
  const prepared: PreparedItem[] = validated.map(({item,mediaPath})=>({item,audioFile:mediaPath?copyMedia(db,mediaPath):undefined}));
  return upsertBatch(db,prepared);
}
export function ingestExplicit(jsonPath: string, textPath?: string, mediaPath?: string): ImportRecord {
  const metadata = readJson(jsonPath);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Item JSON must be an object');
  const item = ingestSchema.parse({...metadata,...(textPath?{body:readFileSync(textPath,'utf8')}: {})});
  return {item,mediaPath};
}
