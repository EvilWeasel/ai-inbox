import { getDatabase } from '../../../../server/db';
import { createAudioRequest, validateAudioRequest } from '../../../../server/central-audio';
import { ApiError } from '../../../../server/items';
import { assertSameOrigin, assertTrustedHost, failure, json } from '../../../../server/http';
import { assertProducerRateLimit, authenticateProducer } from '../../../../server/result-ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const BODY_LIMIT=24*1024;

async function readJson(request:Request) {
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??'')) throw new ApiError(415,'JSON required');
  const declared=request.headers.get('content-length');
  if(declared&&(!/^\d+$/.test(declared)||Number(declared)>BODY_LIMIT)) throw new ApiError(413,'Request too large');
  const reader=request.body?.getReader(); if(!reader) throw new ApiError(400,'Invalid JSON');
  const parts:Buffer[]=[]; let size=0;
  try {
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>BODY_LIMIT){await reader.cancel();throw new ApiError(413,'Request too large');}parts.push(Buffer.from(value));}
    try{return JSON.parse(Buffer.concat(parts,size).toString('utf8')) as unknown;}catch{throw new ApiError(400,'Invalid JSON');}
  } finally {reader.releaseLock();}
}

export async function POST(request:Request) {
  try {
    assertTrustedHost(request);
    const producer=authenticateProducer(request); assertProducerRateLimit(producer);
    if(request.headers.has('origin')) assertSameOrigin(request);
    const input=validateAudioRequest(await readJson(request));
    const result=createAudioRequest(getDatabase(),producer,input);
    const {created,...publicResult}=result;
    return json(publicResult,created?201:200);
  } catch(error) { return failure(error); }
}
