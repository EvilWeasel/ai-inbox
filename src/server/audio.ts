import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import type { InboxDatabase } from './db';
import { ApiError, getRow } from './items';

export function parseRange(value: string | null, size: number): {start:number;end:number} | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) throw new ApiError(416,'Range not satisfiable');
  const a = match[1] ? Number(match[1]) : null; const b = match[2] ? Number(match[2]) : null;
  if ((a !== null && !Number.isSafeInteger(a)) || (b !== null && !Number.isSafeInteger(b))) throw new ApiError(416,'Range not satisfiable');
  const start = a === null ? Math.max(0,size-(b??0)) : a;
  const end = a === null ? size-1 : Math.min(b??size-1,size-1);
  if (start >= size || end < start || (a === null && b === 0)) throw new ApiError(416,'Range not satisfiable');
  return {start,end};
}
export async function audioResponse(db: InboxDatabase, id: string, request: Request) {
  const row = getRow(db,id);
  if (!row || !row.audioFile || !/^[a-f0-9]{64}\.mp3$/.test(row.audioFile)) throw new ApiError(404,'Audio not found');
  const root = await realpath(join(db.directory,'media'));
  const path = join(root,row.audioFile);
  let handle;
  try {
    if (dirname(await realpath(path)) !== root) throw new Error();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch { throw new ApiError(404,'Audio not found'); }
  try {
    const stat = await handle.stat(); if (!stat.isFile()) throw new ApiError(404,'Audio not found');
    const headers = new Headers({'Content-Type':'audio/mpeg','Accept-Ranges':'bytes','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
    let range;
    try { range = parseRange(request.headers.get('range'),stat.size); }
    catch (error) { if (error instanceof ApiError && error.status === 416) { await handle.close(); headers.set('Content-Range',`bytes */${stat.size}`); return new Response(null,{status:416,headers}); } throw error; }
    const start = range?.start ?? 0; const end = range?.end ?? stat.size-1;
    headers.set('Content-Length',String(range ? end-start+1 : stat.size));
    if (range) headers.set('Content-Range',`bytes ${start}-${end}/${stat.size}`);
    if (request.method === 'HEAD' || stat.size === 0) { await handle.close(); return new Response(null,{status:range?206:200,headers}); }
    const stream = handle.createReadStream({start,end,autoClose:true});
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>,{status:range?206:200,headers});
  } catch (error) { await handle.close(); throw error; }
}
