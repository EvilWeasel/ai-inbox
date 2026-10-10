import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POST } from '../../src/app/api/results/route';
import { getDatabase } from '../../src/server/db';
import { listItems } from '../../src/server/items';

const root=mkdtempSync(join(tmpdir(),'inbox-results-route-'));
process.env.INBOX_DATA_DIR=join(root,'data');process.env.INBOX_ORIGIN='https://inbox.example.test';
const token=randomBytes(32).toString('base64url');const config=join(root,'producers.json');
writeFileSync(config,JSON.stringify({producers:[{id:'route-ci',host:'runner.example.test',tokenHash:createHash('sha256').update(token).digest('hex')}]}),{mode:0o600});chmodSync(config,0o600);process.env.INBOX_PRODUCERS_FILE=config;
const db=getDatabase();
const payload={deliveryId:'route-final',title:'Route result',body:'Route searchable cobalt',summary:'Final only',resultType:'report',origin:{host:'runner.example.test',threadId:'thread-x'},publishedAt:'2026-08-02T12:00:00Z',phase:'final'};
function req(body:unknown,headers:Record<string,string>={}) {return new Request('https://inbox.example.test/api/results',{method:'POST',headers:{'content-type':'application/json',host:'inbox.example.test',...headers},body:JSON.stringify(body)});}
after(()=>{db.close();rmSync(root,{recursive:true,force:true});for(const key of ['INBOX_DATA_DIR','INBOX_ORIGIN','INBOX_PRODUCERS_FILE']) delete process.env[key];});

test('results route requires bearer auth, rejects cross-origin and returns idempotent final item',async()=>{
  const noAuth=await POST(req(payload));assert.equal(noAuth.status,401);assert.equal((await noAuth.text()).includes(token),false);
  assert.equal((await POST(req(payload,{authorization:'Bearer invalid-token'}))).status,401);
  assert.equal((await POST(req(payload,{authorization:`Bearer ${token}`,origin:'https://evil.example.test'}))).status,403);
  assert.equal(listItems(db,{view:'all'}).total,0);
  const first=await POST(req(payload,{authorization:`Bearer ${token}`}));assert.equal(first.status,201);const firstBody=await first.json() as {item:{id:string;origin:{host:string};resultType:string};created:boolean};
  assert.equal(firstBody.created,true);assert.equal(firstBody.item.origin.host,'runner.example.test');assert.equal(firstBody.item.resultType,'report');
  const retry=await POST(req({...payload,title:'Updated route result'},{authorization:`Bearer ${token}`}));assert.equal(retry.status,200);
  const retryBody=await retry.json() as {item:{id:string};created:boolean};assert.equal(retryBody.created,false);assert.equal(retryBody.item.id,firstBody.item.id);
  const draft=await POST(req({...payload,deliveryId:'draft',phase:'intermediate'},{authorization:`Bearer ${token}`}));assert.equal(draft.status,400);
  assert.equal(listItems(db,{view:'all',kind:'result',q:'cobalt'}).total,1);
});
