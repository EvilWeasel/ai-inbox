import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolDetail } from '../../src/server/observatory/native-tool';

test('native tool reads verify environment before ticket and preserve exact persisted item identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'observatory-native-'));
  const configFile = join(directory, 'config.json');
  const credentialFile = join(directory, 'credential.json');
  writeFileSync(credentialFile, JSON.stringify({ credential: { token: 'private-test-value' } }), { mode: 0o600 });
  writeFileSync(configFile, JSON.stringify({ hosts: [{ id: 'test', label: 'Test', environmentId: 'expected',
    origin: 'http://127.0.0.1:1', credentialFile, credentialPath: ['credential', 'token'] }] }), { mode: 0o600 });
  const oldConfig = process.env.INBOX_OBSERVATORY_CONFIG;
  const oldFetch = globalThis.fetch;
  const oldSocket = globalThis.WebSocket;
  process.env.INBOX_OBSERVATORY_CONFIG = configFile;
  const requests: { url: string; headers: Headers; method: string }[] = [];
  let descriptorId = 'wrong';
  let resultThread = 'thread';
  const frames: Record<string, unknown>[] = [];
  let closes = 0;
  class Socket {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(url: URL | string) {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, '/ws');
      assert.equal(parsed.searchParams.get('orchestrationProtocol'), '2');
      assert.equal(parsed.searchParams.get('wsTicket'), 'scoped-ticket');
      queueMicrotask(() => this.onopen?.());
    }
    send(data: string) {
      const frame = JSON.parse(data);
      frames.push(frame);
      if (frame._tag === 'Request') queueMicrotask(() => this.onmessage?.({ data: JSON.stringify([
        { _tag: 'Ping' },
        { _tag: 'Exit', requestId: 'observatory-tool', exit: { _tag: 'Success', value: {
          item: { id: 'item', threadId: resultThread, type: 'command_execution', input: 'existing command', output: 'recorded output' },
        } } },
      ]) }));
    }
    close() { closes++; }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  globalThis.fetch = (async (input, options) => {
    const url = String(input);
    requests.push({ url, headers: new Headers(options?.headers), method: options?.method ?? 'GET' });
    assert.equal(options?.redirect, 'error');
    return Response.json(url.endsWith('/.well-known/t3/environment')
      ? { environmentId: descriptorId, orchestrationProtocolVersion: 2 }
      : { ticket: 'scoped-ticket' });
  }) as typeof fetch;
  try {
    await assert.rejects(toolDetail('test', 'thread', 'item'), /Native tool result unavailable/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.has('authorization'), false);
    assert.equal(frames.length, 0);
    descriptorId = 'expected';
    const result = await toolDetail('test', 'thread', 'item') as { item: { output: string } };
    assert.equal(result.item.output, 'recorded output');
    assert.equal(requests.at(-1)?.method, 'POST');
    assert.equal(requests.at(-1)?.headers.get('authorization'), 'Bearer private-test-value');
    assert.deepEqual(frames[0], { _tag: 'Request', id: 'observatory-tool', tag: 'orchestration.getTurnItem',
      payload: { threadId: 'thread', itemId: 'item' }, headers: [] });
    assert.deepEqual(frames[1], { _tag: 'Pong' });
    assert.equal(closes, 1);
    resultThread = 'another-thread';
    await assert.rejects(toolDetail('test', 'thread', 'item'), /Native tool result unavailable/);
    assert.equal(closes, 2);
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.WebSocket = oldSocket;
    if (oldConfig === undefined) delete process.env.INBOX_OBSERVATORY_CONFIG;
    else process.env.INBOX_OBSERVATORY_CONFIG = oldConfig;
    rmSync(directory, { recursive: true, force: true });
  }
});
