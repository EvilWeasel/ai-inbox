import { ZodError } from 'zod';
import { ApiError } from './items';
export function json(data: unknown, status = 200) { return Response.json(data,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}}); }
export function failure(error: unknown) {
  if (error instanceof ZodError) return json({error:'Invalid input'},400);
  if (error instanceof ApiError) return json({error:error.message},error.status);
  // No paths, SQL, environment values, or raw exception messages in HTTP responses.
  return json({error:'Service unavailable'},503);
}
export function assertTrustedHost(request: Request) {
  const configured = allowedOrigins();
  if (!configured.length) return;
  const host = request.headers.get('host') ?? new URL(request.url).host;
  if (!configured.some(origin => new URL(origin).host.toLowerCase() === host.toLowerCase())) throw new ApiError(403,'Host not allowed');
}
function allowedOrigins() {
  if (!process.env.INBOX_ORIGIN) return [];
  return [process.env.INBOX_ORIGIN, ...(process.env.INBOX_ADDITIONAL_ORIGINS ?? '').split(',').filter(Boolean)];
}
export function assertSameOrigin(request: Request) {
  assertTrustedHost(request);
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  const configured = allowedOrigins();
  const host = request.headers.get('host') ?? new URL(request.url).host;
  const expected = configured.length ? configured.filter(value => new URL(value).host.toLowerCase() === host.toLowerCase()) : [new URL(request.url).origin];
  if (!origin || !expected.includes(origin) || (site && site !== 'same-origin' && site !== 'none')) throw new ApiError(403,'Same-origin request required');
}
export async function readPatch(request: Request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??'')) throw new ApiError(415,'JSON required');
  const reader = request.body?.getReader(); if (!reader) throw new ApiError(400,'Invalid JSON');
  const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const {done,value} = await reader.read(); if (done) break; size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new ApiError(413,'Request too large'); } parts.push(value); }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new ApiError(400,'Invalid JSON'); }
  } finally { reader.releaseLock(); }
}
export function queryInput(url: string) {
  const params = new URL(url).searchParams; const input: Record<string,string> = {};
  for (const [key,value] of params) { if (key in input) throw new ApiError(400,'Duplicate query parameter'); input[key] = value; }
  return input;
}
