import { getDatabase } from '../../../server/db';
import { rankingStatus, startRanking } from '../../../server/ranking';
import { assertSameOrigin, assertTrustedHost, failure, json, readPatch } from '../../../server/http';
import { z } from 'zod';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request) {
  try { assertTrustedHost(request); return json({run:rankingStatus(getDatabase())}); } catch(error) { return failure(error); }
}
export async function POST(request:Request) {
  try { assertSameOrigin(request); z.object({}).strict().parse(await readPatch(request)); return json({run:startRanking(getDatabase())},202); } catch(error) { return failure(error); }
}
