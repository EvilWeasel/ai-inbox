import { getDatabase } from '../../../../server/db';
import { detail, patchItem } from '../../../../server/items';
import { json, failure, assertSameOrigin, readPatch, assertTrustedHost } from '../../../../server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{id:string}> };
export async function GET(request: Request, context: Context) {
  try { assertTrustedHost(request); return json({item:detail(getDatabase(),(await context.params).id)}); } catch(error) { return failure(error); }
}
export async function PATCH(request: Request, context: Context) {
  try { assertSameOrigin(request); const patch = await readPatch(request); return json({item:patchItem(getDatabase(),(await context.params).id,patch)}); } catch(error) { return failure(error); }
}
