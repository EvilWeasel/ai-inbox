import { getDatabase } from '../../../server/db';
import { listItems } from '../../../server/items';
import { json, failure, queryInput, assertTrustedHost } from '../../../server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { assertTrustedHost(request); return json(listItems(getDatabase(),queryInput(request.url))); } catch(error) { return failure(error); }
}
