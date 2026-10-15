import { config, credential } from './config';
import { record, redact } from './native';
import { ApiError } from '../items';

async function boundedJson(response: Response, limit: number) {
  if (!response.ok || !response.body) throw new Error('Native read failed');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new Error('Native response exceeds limit'); }
      chunks.push(value);
    }
    return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally { reader.releaseLock(); }
}

/** Read one persisted tool result through the same scoped native RPC as T3.
 * Shell/thread snapshots intentionally omit these outputs. Never manufacture a
 * result from the command text or execute the command to recreate its output. */
export async function toolDetail(hostId: string, threadId: string, itemId: string) {
  const host = config().hosts.find(value => value.id === hostId);
  if (!host) throw new ApiError(404, 'Unknown host');
  if (![threadId, itemId].every(value => value.length > 0 && value.length <= 300)) {
    throw new ApiError(400, 'Invalid native item identity');
  }
  try {
    const token = credential(host);
    const descriptor = await boundedJson(await fetch(new URL('/.well-known/t3/environment', host.origin), {
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
    }), 64 * 1024);
    if (descriptor.environmentId !== host.environmentId || descriptor.orchestrationProtocolVersion !== 2) {
      throw new Error('Environment mismatch');
    }
    const ticketResponse = await boundedJson(await fetch(new URL('/api/auth/websocket-ticket', host.origin), {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
    }), 64 * 1024);
    if (typeof ticketResponse.ticket !== 'string' || !ticketResponse.ticket || ticketResponse.ticket.length > 8192) {
      throw new Error('Native ticket unavailable');
    }
    const url = new URL('/ws', host.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('orchestrationProtocol', '2');
    url.searchParams.set('wsTicket', ticketResponse.ticket);
    const socket = new WebSocket(url);
    const result = await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let received = 0;
      const timer = setTimeout(() => finish(new Error('Native read timed out')), 15000);
      function finish(error: Error | null, value?: unknown) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        if (error) reject(error); else resolve(value);
      }
      socket.onopen = () => socket.send(JSON.stringify({
        _tag: 'Request', id: 'observatory-tool', tag: 'orchestration.getTurnItem',
        payload: { threadId, itemId }, headers: [],
      }));
      socket.onerror = () => finish(new Error('Native socket failed'));
      socket.onclose = () => finish(new Error('Native socket closed'));
      socket.onmessage = event => {
        if (settled) return;
        try {
          if (typeof event.data !== 'string') throw new Error('Unexpected native frame');
          received += Buffer.byteLength(event.data);
          if (received > 4 * 1024 * 1024) throw new Error('Native item exceeds limit');
          const frame: unknown = JSON.parse(event.data);
          for (const value of Array.isArray(frame) ? frame : [frame]) {
            const message = record(value);
            if (message._tag === 'Ping') { socket.send(JSON.stringify({ _tag: 'Pong' })); continue; }
            if (message._tag === 'Exit' && message.requestId === 'observatory-tool') {
              const exit = record(message.exit);
              if (exit._tag !== 'Success') throw new Error('Native item read rejected');
              const item = record(record(exit.value).item);
              if (item.id !== itemId || item.threadId !== threadId) throw new Error('Native item identity mismatch');
              finish(null, { hostId, threadId, item: redact(item, [token, ticketResponse.ticket as string]),
                observedAt: new Date().toISOString() });
            }
          }
        } catch { finish(new Error('Native item unavailable')); }
      };
    });
    return result;
  } catch { throw new ApiError(503, 'Native tool result unavailable'); }
}
