import { defineAction } from '@agent-native/core/action';
import { registrationSchema, type Identity } from '../../../lib/observatory/contracts';
import { config } from '../config';
import { detail, record } from '../native';
import { openObservatory, register } from '../store';
import { authenticateProducer, assertProducerRateLimit } from '../../result-ingest';
import { ApiError } from '../../items';

// detail(...,true) revalidates the configured environment descriptor and exact
// native thread, bypassing the read cache. Reject ambiguous or malformed runs.
export async function assertCurrentIdentity(input:Identity) {
  const native=await detail(input.hostId,input.threadId,true);
  const projection=record(native.projection);
  const runs=Array.isArray(projection.runs)?projection.runs.map(record):[];
  if(!runs.length||runs.some(r=>!Number.isSafeInteger(r.ordinal)||Number(r.ordinal)<0||typeof r.id!=='string'||!r.id||r.threadId!==undefined&&r.threadId!==input.threadId)||
    new Set(runs.map(r=>r.ordinal)).size!==runs.length||new Set(runs.map(r=>r.id)).size!==runs.length) {
    throw new ApiError(409,'Native current run is ambiguous');
  }
  const current=runs.reduce((a,b)=>Number(a.ordinal)>Number(b.ordinal)?a:b);
  if(current.id!==input.runId||current.activeAttemptId!==input.attemptId||!['running','waiting'].includes(String(current.status))) {
    throw new ApiError(409,'Publisher run or attempt is no longer active');
  }
  // When supplied, attempt records must agree with the authoritative run pointer.
  if(projection.attempts!==undefined&&projection.attempts!==null&&!Array.isArray(projection.attempts))throw new ApiError(409,'Native active attempt is ambiguous');
  if(Array.isArray(projection.attempts)) {
    const attempts=projection.attempts.map(record).filter(a=>a.id===input.attemptId);
    if(attempts.length!==1||attempts[0].runId!==input.runId||attempts[0].threadId!==undefined&&attempts[0].threadId!==input.threadId) {
      throw new ApiError(409,'Native active attempt is ambiguous');
    }
  }
}

export default defineAction({
  description:'Opt in an existing host producer to its exact current native agent identity; grants host-level canvas publishing only.',
  schema:registrationSchema,http:{method:'POST'},
  authorize:async(input,ctx)=>{
    if(!ctx?.requestHeaders)throw new ApiError(401,'Producer authentication required');
    const producer=authenticateProducer(new Request('http://localhost',{headers:ctx.requestHeaders}));
    if(!config().hosts.some(h=>h.id===input.hostId&&h.producerId===producer.id))throw new ApiError(403,'Host enrollment is not enabled for this producer');
    assertProducerRateLimit(producer);
    await assertCurrentIdentity(input);
  },
  run:async(input,ctx)=>{
    const producer=authenticateProducer(new Request('http://localhost',{headers:ctx?.requestHeaders}));
    const db=openObservatory();try{return register(db,input,producer.id);}finally{db.close();}
  },
});
