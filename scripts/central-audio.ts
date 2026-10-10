import { openDatabase } from '../src/server/db';
import { ApiError } from '../src/server/items';
import { attachWorkerMedia, getWorkerRequest, listWorkerRequests, resolveWorkerRequest, updateWorkerRequest } from '../src/server/central-audio';

const INPUT_LIMIT=64*1024;
async function stdinJson():Promise<unknown> {
  const chunks:Buffer[]=[]; let size=0;
  for await (const part of process.stdin) {
    const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);
    size+=chunk.length; if(size>INPUT_LIMIT) throw new ApiError(413,'Worker input too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks,size).toString('utf8')) as unknown; }
  catch { throw new ApiError(400,'Invalid worker JSON'); }
}
function record(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new ApiError(400,'Invalid worker request');
  return value as Record<string,unknown>;
}
function exactKeys(value:Record<string,unknown>,keys:string[]) {
  if(Object.keys(value).sort().join(',')!==keys.slice().sort().join(',')) throw new ApiError(400,'Invalid worker request');
}

async function main() {
  const scriptIndex=process.argv.findIndex(value=>value.endsWith('scripts/central-audio.ts'));
  if(scriptIndex>=0&&process.argv.length>scriptIndex+1) throw new ApiError(400,'Worker arguments are not accepted');
  const input=record(await stdinJson());
  const db=openDatabase();
  try {
    let result:unknown;
    if(input.op==='list') {
      exactKeys(input,['op','limit']);
      result={requests:listWorkerRequests(db,input.limit as number)};
    } else if(input.op==='lookup') {
      exactKeys(input,['op','requestId']);
      if(typeof input.requestId!=='string') throw new ApiError(400,'Invalid worker lookup');
      result={request:getWorkerRequest(db,input.requestId)};
    } else if(input.op==='resolve') {
      exactKeys(input,['op','requestId','expectedState','expectedBodySha256','state','safeErrorCode']);
      if(typeof input.requestId!=='string'||typeof input.expectedState!=='string'||typeof input.expectedBodySha256!=='string'
          ||(input.state!=='needs_review'&&input.state!=='superseded')
          ||(input.safeErrorCode!==undefined&&input.safeErrorCode!==null&&typeof input.safeErrorCode!=='string')) throw new ApiError(400,'Invalid worker resolution');
      result=resolveWorkerRequest(db,{requestId:input.requestId,expectedState:input.expectedState as 'queued'|'generating',expectedBodySha256:input.expectedBodySha256,state:input.state,safeErrorCode:input.safeErrorCode as string|null|undefined});
    } else if(input.op==='update') {
      if(Object.keys(input).some(key=>!['op','requestId','ledgerJobId','state','safeErrorCode'].includes(key))
          ||!['op','requestId','ledgerJobId','state'].every(key=>key in input)) throw new ApiError(400,'Invalid worker update');
      if(typeof input.requestId!=='string'||typeof input.ledgerJobId!=='string'
          ||(input.state!=='generating'&&input.state!=='needs_review')
          ||(input.safeErrorCode!==undefined&&input.safeErrorCode!==null&&typeof input.safeErrorCode!=='string')) throw new ApiError(400,'Invalid worker update');
      result=updateWorkerRequest(db,{requestId:input.requestId,ledgerJobId:input.ledgerJobId,state:input.state,safeErrorCode:input.safeErrorCode as string|null|undefined});
    } else if(input.op==='attach') {
      exactKeys(input,['op','requestId','ledgerJobId','bodySha256','source','mediaSha256','duration']);
      if(typeof input.requestId!=='string'||typeof input.ledgerJobId!=='string'||typeof input.bodySha256!=='string'
          ||typeof input.source!=='string'||typeof input.mediaSha256!=='string'||typeof input.duration!=='number') throw new ApiError(400,'Invalid audio attachment');
      result=await attachWorkerMedia(db,{requestId:input.requestId,ledgerJobId:input.ledgerJobId,bodySha256:input.bodySha256,source:input.source,mediaSha256:input.mediaSha256,duration:input.duration});
    } else throw new ApiError(400,'Invalid worker operation');
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { db.close(); }
}

main().catch(error=>{
  const code=error instanceof ApiError ? String(error.status) : 'service_unavailable';
  process.stderr.write(`${JSON.stringify({error:code})}\n`);
  process.exitCode=1;
});
