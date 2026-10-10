import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase } from '../../src/server/db';
import { ingestSchema } from '../../src/lib/contracts';
import { upsertBatch, listItems } from '../../src/server/items';
import { copyMedia } from '../../src/server/importer';
import { GET as list } from '../../src/app/api/items/route';
import { GET as detail, PATCH } from '../../src/app/api/items/[id]/route';
import { GET as audio } from '../../src/app/api/items/[id]/audio/route';
import { GET as health } from '../../src/app/api/health/route';
const root=mkdtempSync(join(tmpdir(),'inbox-routes-'));const oldDir=process.env.INBOX_DATA_DIR;process.env.INBOX_DATA_DIR=join(root,'data');
const db=getDatabase();const mp3=join(root,'explicit.mp3');writeFileSync(mp3,'0123456789');
upsertBatch(db,[{item:ingestSchema.parse({externalId:'route',title:'Route update',kind:'alert',publishedAt:'2026-01-01T00:00:00Z',body:'Real test body',provenance:{private:'not exposed'}}),audioFile:copyMedia(db,mp3)}]);
const id=listItems(db,{}).items[0].id;const origin='https://inbox.example';const context={params:Promise.resolve({id})};
after(()=>{db.close();if(oldDir===undefined) delete process.env.INBOX_DATA_DIR;else process.env.INBOX_DATA_DIR=oldDir;rmSync(root,{recursive:true,force:true});});
test('list/detail routes match public contract with private caching and no provenance',async()=>{
  const response=await list(new Request(origin+'/api/items?view=all&limit=1'));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
  const payload=await response.json();assert.deepEqual(Object.keys(payload).sort(),['counts','items','nextCursor','total']);assert.equal(payload.items.length,1);
  const itemResponse=await detail(new Request(origin+'/api/items/'+id),context);const payload2=await itemResponse.json();assert.equal(payload2.item.id,id);assert.equal('externalId' in payload2.item,false);assert.equal('provenance' in payload2.item,false);assert.equal('audioFile' in payload2.item,false);
});
test('route validation returns 400 for unknown/duplicate/bounded query parameters',async()=>{
  for(const query of ['limit=101','view=other','cursor=garbage','limit=1&limit=2','unknown=1']) assert.equal((await list(new Request(origin+'/api/items?'+query))).status,400);
});
test('PATCH route applies same-origin guard, validates body, and returns stable state',async()=>{
  const req=(body:string,withOrigin=true)=>new Request(origin+'/api/items/'+id,{method:'PATCH',headers:{'content-type':'application/json',...(withOrigin?{origin}: {})},body});
  assert.equal((await PATCH(req('{"read":true}',false),context)).status,403);
  assert.equal((await PATCH(req('{}'),context)).status,400);assert.equal((await PATCH(req('{'),context)).status,400);
  assert.equal((await PATCH(req('{"externalId":"evil"}'),context)).status,400);
  const first=await (await PATCH(req('{"read":true}'),context)).json();const second=await (await PATCH(req('{"read":true}'),context)).json();assert.ok(first.item.readAt);assert.equal(first.item.readAt,second.item.readAt);
});
test('audio and health routes expose range/readiness without filesystem details',async()=>{
  const response=await audio(new Request(origin+'/api/items/'+id+'/audio',{headers:{range:'bytes=1-3'}}),context);assert.equal(response.status,206);assert.equal(await response.text(),'123');
  const unavailable=await audio(new Request(origin+'/api/items/no/audio'),{params:Promise.resolve({id:'no'})});assert.equal(unavailable.status,404);
  const ready=await health();assert.equal(ready.status,200);assert.deepEqual(await ready.json(),{ready:true});
});
