import { z } from 'zod';
import { getDatabase } from '../../../../../server/db';
import { requestItemAudio } from '../../../../../server/item-audio';
import { assertSameOrigin, failure, json, readPatch } from '../../../../../server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = {params: Promise<{id:string}>};
export async function POST(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    if (request.body) z.object({}).strict().parse(await readPatch(request));
    const result = requestItemAudio(getDatabase(),(await context.params).id);
    return json({item:result.item},result.status);
  } catch (error) {return failure(error);}
}
