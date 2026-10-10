import { getDatabase } from '../../../../../server/db';
import { audioResponse } from '../../../../../server/audio';
import { failure, assertTrustedHost } from '../../../../../server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: {params:Promise<{id:string}>}) {
  try { assertTrustedHost(request); return await audioResponse(getDatabase(),(await context.params).id,request); } catch(error) { return failure(error); }
}
export const HEAD = GET;
