import { getDatabase } from '@/server/db';
import { eventHub, inboxEventResponse } from '@/server/events';
import { assertTrustedHost, assertSameOrigin, failure } from '@/server/http';
import { ApiError } from '@/server/items';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  try {
    assertTrustedHost(request);
    // Same-origin EventSource GETs often omit Origin. Validate it when present,
    // and reject browser cross-site / same-site requests even without Origin.
    const site = request.headers.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') throw new ApiError(403, 'Same-origin request required');
    if (request.headers.has('origin')) assertSameOrigin(request);
    return inboxEventResponse(request, eventHub(getDatabase()));
  } catch (error) { return failure(error); }
}
