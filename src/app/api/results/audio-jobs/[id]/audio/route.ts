import { getDatabase } from '../../../../../../server/db';
import { getAudioRequestMedia } from '../../../../../../server/central-audio';
import { assertSameOrigin, assertTrustedHost, failure } from '../../../../../../server/http';
import { assertProducerRateLimit, authenticateProducer } from '../../../../../../server/result-ingest';

export const runtime='nodejs';
export const dynamic='force-dynamic';

export async function GET(request:Request,context:{params:Promise<{id:string}>}) {
  try {
    assertTrustedHost(request);
    const producer=authenticateProducer(request); assertProducerRateLimit(producer);
    if(request.headers.has('origin')) assertSameOrigin(request);
    return await getAudioRequestMedia(getDatabase(),producer,(await context.params).id,request);
  } catch(error) { return failure(error); }
}
