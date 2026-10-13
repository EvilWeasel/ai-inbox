#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { open } from 'node:fs/promises';
import { resultMetadataSchema } from '../src/lib/contracts';
import { openDatabase } from '../src/server/db';
import { ingestResult, RESULT_METADATA_LIMIT } from '../src/server/result-ingest';

async function readJson(path:string) {
  const file=await open(path,'r');
  try {
    const chunks:Buffer[]=[]; let size=0;
    for await(const chunk of file.createReadStream({autoClose:false})) {
      size+=chunk.length; if(size>RESULT_METADATA_LIMIT) throw new Error('Input exceeds metadata limit');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks,size).toString('utf8')) as unknown;
  } finally { await file.close(); }
}
async function main() {
  const {values}=parseArgs({options:{envelope:{type:'string'},report:{type:'string'},'producer-id':{type:'string'},'data-dir':{type:'string'},help:{type:'boolean'}},strict:true});
  if(values.help) {
    console.log('Usage: ingest-report --envelope FINAL.json [--report REPORT.json] --producer-id ID [--data-dir DIR]\nCaller must hold the existing deployment lock. INBOX_DATA_DIR may supply the data directory. No audio synthesis or delivery occurs.');return;
  }
  if(!values.envelope || !values['producer-id'] || !/^[a-zA-Z0-9._-]{1,100}$/.test(values['producer-id'])) throw new Error('Envelope and valid producer ID required');
  const raw=await readJson(values.envelope);
  if(!raw||typeof raw!=='object'||Array.isArray(raw)) throw new Error('Result envelope required');
  const metadata=resultMetadataSchema.parse({...raw,...(values.report?{report:await readJson(values.report)}:{})});
  if(Buffer.byteLength(JSON.stringify(metadata),'utf8')>RESULT_METADATA_LIMIT) throw new Error('Input exceeds metadata limit');
  const db=openDatabase(values['data-dir']);
  try {
    const result=await ingestResult(db,{id:values['producer-id'],host:metadata.origin.host,tokenHash:''},metadata,null);
    console.log(JSON.stringify({id:result.item.id,created:result.created,reportAvailable:result.item.reportAvailable}));
  } finally {db.close();}
}
main().catch(()=>{console.error('Report ingestion failed: check arguments, validated metadata and private storage configuration');process.exitCode=1;});
