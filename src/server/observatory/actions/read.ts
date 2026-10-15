import { defineAction } from '@agent-native/core/action';
import { readSchema } from '../../../lib/observatory/contracts';
import { toolDetail } from '../native-tool';
import { inventory,detail,historyPage } from '../native';
import { latest,openObservatory,history } from '../store';
export default defineAction({description:'Read the connected host inventory or one native agent and its agent-authored canvas revisions.',schema:readSchema,readOnly:true,http:{method:'GET'},run:async input=>{
  if(input.itemId&&input.hostId&&input.threadId)return toolDetail(input.hostId,input.threadId,input.itemId);
  if(input.cursor&&input.hostId&&input.threadId)return historyPage(input.hostId,input.threadId,input.cursor);
  const db=openObservatory();try {
    const canvases=latest(db);
    if(input.hostId&&input.threadId){const native=await detail(input.hostId,input.threadId);const matching=canvases.filter(c=>c.hostId===input.hostId&&c.threadId===input.threadId);return {...native,canvases:matching,history:matching.flatMap(c=>history(db,c))};}
    return {...await inventory(),canvases};
  } finally {db.close();}
}});
