import { getDatabase } from '../../../server/db';
import { assertSameOrigin, assertTrustedHost, failure, json } from '../../../server/http';
import { assertProducerRateLimit, authenticateProducer, ingestResult, readResultRequest } from '../../../server/result-ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    assertTrustedHost(request);
    const producer=authenticateProducer(request);
    assertProducerRateLimit(producer);
    if(request.headers.has('origin')) assertSameOrigin(request);
    const {metadata,audio}=await readResultRequest(request);
    const result=await ingestResult(getDatabase(),producer,metadata,audio);
    return json(result,result.created?201:200);
  } catch(error) { return failure(error); }
}
