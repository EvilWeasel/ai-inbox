import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/server/db';
import { ingestSchema, resultMetadataSchema } from '../../src/lib/contracts';
import { reportSchema } from '../../src/lib/report';
import { ingestResult } from '../../src/server/result-ingest';
import { detail, listItems, patchItem, upsertBatch } from '../../src/server/items';
import { migrate } from '../../src/server/migrations';

const report={version:1 as const,title:'Research',sections:[{id:'summary',title:'Findings',blocks:[{type:'text' as const,text:'A supported finding',sourceIds:['official']}]}],sources:[{id:'official',title:'Official source',url:'https://example.test/docs'}]};
const envelope={deliveryId:'report-delivery',title:'Research result',body:'Original searchable markdown',resultType:'research',origin:{host:'producer.example.test'},publishedAt:'2026-10-01T00:00:00Z',phase:'final'};
const producer={id:'research',host:envelope.origin.host,tokenHash:''};
function fixture(){const root=mkdtempSync(join(tmpdir(),'inbox-report-'));const db=openDatabase(join(root,'data'));return {root,db,close(){db.close();rmSync(root,{recursive:true,force:true});}};}

test('report final ingestion preserves identity, reading state, original body, media and omitted report on reimport',async()=>{
 const f=fixture();try{
  const first=await ingestResult(f.db,producer,resultMetadataSchema.parse({...envelope,report}),null);
  assert.deepEqual(first.item.report,report);assert.equal(first.item.reportAvailable,true);
  patchItem(f.db,first.item.id,{read:true,archived:true});
  f.db.sqlite.prepare('UPDATE items SET audio_file=?,audio_duration=? WHERE id=?').run('a'.repeat(64)+'.mp3',12,first.item.id);
  const second=await ingestResult(f.db,producer,resultMetadataSchema.parse(envelope),null);
  assert.equal(second.created,false);assert.equal(second.item.id,first.item.id);assert.ok(second.item.readAt);assert.ok(second.item.archivedAt);
  assert.equal(second.item.body,envelope.body);assert.deepEqual(second.item.report,report);assert.equal(second.item.audioAvailable,true);assert.equal(second.item.audioDuration,12);
  const page=listItems(f.db,{view:'all',q:'searchable'});assert.equal(page.total,1);assert.equal(page.items[0].reportAvailable,true);assert.equal('report' in page.items[0],false);
  const rev=()=> (f.db.sqlite.prepare('SELECT revision FROM inbox_revision').get() as {revision:number}).revision;
  const before=rev();await ingestResult(f.db,producer,resultMetadataSchema.parse({...envelope,report:{...report,title:'Updated report'}}),null);assert.ok(rev()>before);
  const unchanged=rev();await ingestResult(f.db,producer,resultMetadataSchema.parse({...envelope,report:{...report,title:'Updated report'}}),null);assert.equal(rev(),unchanged);
 }finally{f.close();}
});

test('legacy local imports keep their report on updates and remain compatible without a report',()=>{
 const f=fixture();try{
  const item=ingestSchema.parse({externalId:'local',kind:'briefing',title:'Briefing',body:'Original text',publishedAt:envelope.publishedAt,report});
  upsertBatch(f.db,[{item}]);const id=listItems(f.db,{view:'all'}).items[0].id;
  const {report:omitted,...legacy}=item;void omitted;upsertBatch(f.db,[{item:legacy}]);assert.deepEqual(detail(f.db,id).report,report);
  upsertBatch(f.db,[{item:{...legacy,externalId:'another'}}]);assert.equal(listItems(f.db,{view:'all'}).items.find(i=>i.id!==id)?.reportAvailable,false);
 }finally{f.close();}
});

test('invalid reports fail before any writes including direct ingestion callers',async()=>{
 const f=fixture();try{
  for(const url of ['javascript:alert(1)','data:text/html,<script>x</script>','https://name:password@example.test']) {
   const invalid={...report,sources:[{...report.sources[0],url}]};assert.equal(reportSchema.safeParse(invalid).success,false);
   await assert.rejects(ingestResult(f.db,producer,{...envelope,report:invalid} as never,null));
  }
  assert.equal(reportSchema.safeParse({...report,sources:[]}).success,false);
  assert.equal(reportSchema.safeParse({...report,html:'<script>alert(1)</script>'}).success,false);
  assert.equal(reportSchema.safeParse({...report,sections:[...report.sections,...report.sections]}).success,false);
  assert.equal(reportSchema.safeParse({...report,sections:[{id:'table',title:'Table',blocks:[{type:'comparison',columns:['a','b'],rows:[{label:'row',cells:['one'],sourceIds:[]}]}]}]}).success,false);
  const tooLarge={...report,sections:Array.from({length:30},(_,i)=>({id:`s${i}`,title:'Findings',blocks:Array.from({length:3},()=>({type:'text',text:'x'.repeat(12000),sourceIds:[]}))}))};
  assert.equal(resultMetadataSchema.safeParse({...envelope,report:tooLarge}).success,false);
  assert.equal(listItems(f.db,{view:'all'}).total,0);
 }finally{f.close();}
});

test('populated migration 4 gains nullable bounded report storage without changing rows or FTS',()=>{
 const f=fixture();try{
  upsertBatch(f.db,[{item:ingestSchema.parse({externalId:'old',title:'Kept row',body:'Migration searchable',kind:'alert',publishedAt:envelope.publishedAt})}]);
  const id=listItems(f.db,{view:'all'}).items[0].id;patchItem(f.db,id,{read:true,archived:true});
  const before=f.db.sqlite.prepare('SELECT rowid,id,read_at,archived_at FROM items WHERE id=?').get(id);
  f.db.sqlite.exec('DROP TRIGGER items_report_revision; ALTER TABLE items DROP COLUMN report_json; DELETE FROM inbox_migrations WHERE version=5');
  migrate(f.db.sqlite);migrate(f.db.sqlite);
  assert.deepEqual(f.db.sqlite.prepare('SELECT rowid,id,read_at,archived_at FROM items WHERE id=?').get(id),before);
  assert.equal(detail(f.db,id).report,null);assert.equal(listItems(f.db,{view:'all',q:'searchable'}).total,1);
  assert.throws(()=>f.db.sqlite.prepare('UPDATE items SET report_json=? WHERE id=?').run('not json',id));
  assert.throws(()=>f.db.sqlite.prepare('UPDATE items SET report_json=? WHERE id=?').run(JSON.stringify('x'.repeat(1048576)),id));
 }finally{f.close();}
});

test('local helper imports validated envelope with separate report file and emits a bounded receipt',()=>{
 const f=fixture();try{
  const envelopeFile=join(f.root,'final.json'),reportFile=join(f.root,'report.json');writeFileSync(envelopeFile,JSON.stringify(envelope));writeFileSync(reportFile,JSON.stringify(report));
  const result=spawnSync(process.execPath,['--import','tsx','scripts/ingest-report.ts','--envelope',envelopeFile,'--report',reportFile,'--producer-id',producer.id,'--data-dir',f.db.directory],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout);assert.equal(receipt.reportAvailable,true);assert.equal(receipt.created,true);assert.equal(Object.keys(receipt).length,3);assert.deepEqual(detail(f.db,receipt.id).report,report);
 }finally{f.close();}
});
