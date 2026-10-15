import { defineAction } from '@agent-native/core/action';
import { publishSchema } from '../../../lib/observatory/contracts';
import { config } from '../config';
import { openObservatory,publish } from '../store';
import { authenticateProducer,assertProducerRateLimit } from '../../result-ingest';
import { detail,record } from '../native';
import { ApiError } from '../../items';
export default defineAction({description:'Publish your own bound agent canvas with compare-and-swap revision continuity; never controls another agent or executes content.',schema:publishSchema,http:{method:'POST'},authorize:async(input,ctx)=>{
  if(!ctx?.requestHeaders)throw new ApiError(401,'Producer authentication required');
  const producer=authenticateProducer(new Request('http://localhost',{headers:ctx.requestHeaders}));
  const binding=config().publishers.find(p=>p.producerId===producer.id&&p.hostId===input.hostId&&p.threadId===input.threadId&&p.runId===input.runId&&p.attemptId===input.attemptId);
  if(!binding)throw new ApiError(403,'Publisher is not bound to this agent');
  const native=await detail(input.hostId,input.threadId,true);const projection=record(native.projection);
  const runs=Array.isArray(projection.runs)?projection.runs.map(record):[];const current=runs.sort((a,b)=>Number(a.ordinal??0)-Number(b.ordinal??0)).at(-1);
  if(!current||current.id!==input.runId||current.activeAttemptId!==input.attemptId||!['running','inProgress','in_progress','waiting','active'].includes(String(current.status)))throw new ApiError(409,'Publisher run or attempt is no longer active');
  assertProducerRateLimit(producer);
},run:async(input,ctx)=>{const producer=authenticateProducer(new Request('http://localhost',{headers:ctx?.requestHeaders}));const db=openObservatory();try{return publish(db,input,producer.id);}finally{db.close();}}});
