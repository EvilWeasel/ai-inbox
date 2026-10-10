import { getDatabase } from '../../../server/db';
import { json } from '../../../server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  try { getDatabase().sqlite.prepare('SELECT rowid FROM items_fts LIMIT 1').get(); return json({ready:true}); }
  catch { return json({ready:false},503); }
}
