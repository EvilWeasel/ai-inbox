import { defineAction } from '@agent-native/core/action';
import { publishSchema } from '../../../lib/observatory/contracts';
import { config } from '../config';
import { openObservatory,publish,registered } from '../store';
import { authenticateProducer,assertProducerRateLimit } from '../../result-ingest';
import { assertCurrentIdentity } from './register';
import { ApiError } from '../../items';
export default defineAction({description:'Publish your own bound agent canvas with compare-and-swap revision continuity; never controls another agent or executes content.',schema:publishSchema,http:{method:'POST'},authorize:async(input,ctx)=>{
  if(!ctx?.requestHeaders)throw new ApiError(401,'Producer authentication required');
  const producer=authenticateProducer(new Request('http://localhost',{headers:ctx.requestHeaders}));
  const settings=config();
  const binding=settings.publishers.some(p=>p.producerId===producer.id&&p.hostId===input.hostId&&p.threadId===input.threadId&&p.runId===input.runId&&p.attemptId===input.attemptId);
  let enrolled=false;
  if(!binding&&settings.hosts.some(h=>h.id===input.hostId&&h.producerId===producer.id)) {
    const db=openObservatory();try{enrolled=registered(db,input,producer.id);}finally{db.close();}
  }
  if(!binding&&!enrolled)throw new ApiError(403,'Publisher is not bound to this agent');
  assertProducerRateLimit(producer);
  await assertCurrentIdentity(input);
},run:async(input,ctx)=>{const producer=authenticateProducer(new Request('http://localhost',{headers:ctx?.requestHeaders}));const db=openObservatory();try{return publish(db,input,producer.id);}finally{db.close();}}});
