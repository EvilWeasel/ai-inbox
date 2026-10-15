import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detail,historyPage,historyCoverage } from '../../src/server/observatory/native';
import { readSchema } from '../../src/lib/observatory/contracts';
import { agentGraph,agentKey } from '../../src/lib/observatory/graph';
import type { NativeThread } from '../../src/lib/observatory/contracts';
test('graph edges bind exact host and authoritative parent; missing parents and cycles stay finite',()=>{
 const thread=(hostId:string,id:string,parentThreadId:string|null):NativeThread=>({hostId,id,parentThreadId,title:id,status:'running',runId:null,updatedAt:null});
 const graph=agentGraph([thread('a','parent',null),thread('b','parent',null),thread('a','child','parent'),thread('b','orphan','child'),thread('a','cycle1','cycle2'),thread('a','cycle2','cycle1')]);
 assert.deepEqual(graph.edges.find(edge=>edge.child===agentKey('a','child')),{parent:agentKey('a','parent'),child:agentKey('a','child')});
 assert.equal(graph.parentByChild.has(agentKey('b','orphan')),false);
 assert.equal(graph.nodes.length,6);assert.equal(graph.nodes.filter(node=>node.cycle).length,1);
});
test('coverage rejects omitted or inconsistent metadata rather than claiming completeness',()=>{
 for(const raw of [{},{historyCursor:null,hasMoreHistory:true},{historyCursor:'older',hasMoreHistory:false},{historyCursor:null,hasMoreHistory:false,latestLocalTurnOrdinal:-1},{historyCursor:null,hasMoreHistory:false,latestLocalTurnOrdinal:0,turnItemsOmitLocalVisible:true}])assert.throws(()=>historyCoverage(raw));
 assert.equal(historyCoverage({historyCursor:null,hasMoreHistory:false,latestLocalTurnOrdinal:0}).hasMoreHistory,false);
 assert.equal(readSchema.safeParse({cursor:'older'}).success,false);
 assert.equal(readSchema.safeParse({hostId:'host',threadId:'thread',cursor:'older',itemId:'item'}).success,false);
});
test('bounded detail preserves current control state; opaque history cursor, compaction provenance, cache and failures',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'obs-history-')),previousConfig=process.env.INBOX_OBSERVATORY_CONFIG,previousFetch=globalThis.fetch;
 const credentialFile=join(dir,'credential.json'),configFile=join(dir,'config.json');
 writeFileSync(credentialFile,JSON.stringify({token:'test-native-bearer'}),{mode:0o600});
 writeFileSync(configFile,JSON.stringify({hosts:[{id:'history-host',label:'Host',environmentId:'environment',origin:'https://native.example.test',credentialFile,credentialPath:['token']}],publishers:[]}),{mode:0o600});process.env.INBOX_OBSERVATORY_CONFIG=configFile;
 const cursor='opaque+/=? &older';const calls:string[]=[];
 globalThis.fetch=async input=>{const url=new URL(String(input));calls.push(url.pathname+url.search);
  if(url.pathname.includes('.well-known'))return Response.json({environmentId:'environment',orchestrationProtocolVersion:2});
  if(url.pathname.endsWith('/bounded'))return Response.json({snapshotSequence:91,historyCursor:cursor,hasMoreHistory:true,latestLocalTurnOrdinal:30,payloadBudgetExceeded:true,projection:{thread:{id:'thread',activeRunId:'live'},runs:[{id:'old',ordinal:1},{id:'live',ordinal:3,activeAttemptId:'attempt'}],turnItems:[]}});
  assert.equal(url.pathname,'/api/orchestration/threads/thread/history');
  if(url.searchParams.get('cursor')==='failed')return new Response('unavailable',{status:503});
  if(url.searchParams.get('cursor')==='bad')return Response.json({snapshotSequence:90,items:[],nextCursor:'bad',hasMoreHistory:true});
  assert.equal(url.searchParams.get('cursor'),cursor);
  return Response.json({snapshotSequence:90,items:[{position:4,visibility:'inherited',sourceThreadId:'parent',sourceItemId:'compact',item:{id:'compact',type:'context_compaction',runId:'old',text:'Actual source marker'}}],nextCursor:null,hasMoreHistory:false});
 };
 try {
  const focused=await detail('history-host','thread');assert.equal((focused.projection.runs as {id:string}[]).at(-1)?.id,'live');assert.equal(focused.coverage.historyCursor,cursor);assert.equal(focused.coverage.payloadBudgetExceeded,true);
  const page=await historyPage('history-host','thread',cursor);assert.equal(page.items[0].sourceThreadId,'parent');assert.equal(page.items[0].item.type,'context_compaction');assert.equal(page.nextCursor,null);
  await historyPage('history-host','thread',cursor);assert.equal(calls.filter(path=>path.includes('/history')).length,1,'same history page caches for five seconds');
  await assert.rejects(historyPage('history-host','thread','failed'),/coverage remains partial/);await assert.rejects(historyPage('history-host','thread','bad'),/coverage remains partial/);
  assert.equal((focused.projection.runs as {id:string}[]).at(-1)?.id,'live','older page never mutates control state');
 }finally{globalThis.fetch=previousFetch;if(previousConfig===undefined)delete process.env.INBOX_OBSERVATORY_CONFIG;else process.env.INBOX_OBSERVATORY_CONFIG=previousConfig;rmSync(dir,{recursive:true,force:true});}
});
