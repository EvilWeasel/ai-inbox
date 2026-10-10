import { getDatabase } from '../../../../../server/db';
import { getAudioRequest } from '../../../../../server/central-audio';
import { assertSameOrigin, assertTrustedHost, failure, json } from '../../../../../server/http';
import { assertProducerRateLimit, authenticateProducer } from '../../../../../server/result-ingest';

export const runtime='nodejs';
export const dynamic='force-dynamic';

export async function GET(request:Request,context:{params:Promise<{id:string}>}) {
  try {
    assertTrustedHost(request);
    const producer=authenticateProducer(request); assertProducerRateLimit(producer);
    if(request.headers.has('origin')) assertSameOrigin(request);
    const {id}=await context.params;
    return json(getAudioRequest(getDatabase(),producer,id));
  } catch(error) { return failure(error); }
}
