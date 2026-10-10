import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { Agent, createServer, get, type IncomingMessage } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function request(port: number, path: string, agent: Agent): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = get({
      hostname: '127.0.0.1',
      port,
      path,
      headers: { host: `127.0.0.1:${port}` },
      agent,
    }, resolve);
    req.setTimeout(1_000, () => req.destroy(new Error(`Timed out requesting ${path}`)));
    req.once('error', reject);
  });
}

async function waitForHealth(port: number, agent: Agent, child: ChildProcess, getLog: () => string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`next start exited before readiness\n${getLog()}`);
    }
    try {
      const response = await request(port, '/api/health', agent);
      response.resume();
      await new Promise<void>(resolve => response.once('end', resolve));
      if (response.statusCode === 200) return;
    } catch {
      // The server is still starting; retry until the bounded deadline.
    }
    await wait(100);
  }
  throw new Error(`next start did not become healthy\n${getLog()}`);
}

test('production next start exits promptly on SIGTERM with SSE and keep-alive clients', { timeout: 25_000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'inbox-shutdown-integration-'));
  const port = await unusedPort();
  const agent = new Agent({ keepAlive: true, maxSockets: 2 });
  const child = spawn(process.execPath, [
    'node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port),
  ], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'production', INBOX_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const append = (chunk: Buffer) => { log = `${log}${chunk.toString()}`.slice(-8_000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  let eventResponse: IncomingMessage | undefined;
  t.after(async () => {
    eventResponse?.destroy();
    agent.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await Promise.race([
        new Promise<void>(resolve => child.once('exit', () => resolve())),
        wait(1_000),
      ]);
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  await waitForHealth(port, agent, child, () => log);
  eventResponse = await request(port, '/api/events', agent);
  assert.equal(eventResponse.statusCode, 200, log);
  assert.match(eventResponse.headers['content-type'] ?? '', /^text\/event-stream/);
  assert.equal(eventResponse.headers.connection, 'close');
  const firstFrame = await new Promise<string>((resolve, reject) => {
    eventResponse!.once('data', chunk => resolve(chunk.toString()));
    eventResponse!.once('error', reject);
  });
  assert.match(firstFrame, /event: baseline/);

  // Leave a separate idle HTTP keep-alive socket in the server while SSE is active.
  const keepAliveResponse = await request(port, '/api/health', agent);
  keepAliveResponse.resume();
  await new Promise<void>(resolve => keepAliveResponse.once('end', resolve));
  assert.ok(Object.values(agent.freeSockets).some(sockets => (sockets?.length ?? 0) > 0), 'health request left an idle keep-alive socket');

  const streamEnded = new Promise<void>((resolve, reject) => {
    eventResponse!.once('end', resolve);
    eventResponse!.once('error', reject);
  });
  const processExited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const signalAt = Date.now();
  assert.equal(child.kill('SIGTERM'), true, log);

  await Promise.race([
    Promise.all([streamEnded, processExited]),
    wait(5_000).then(() => { throw new Error(`SIGTERM shutdown exceeded 5s\n${log}`); }),
  ]);
  const elapsedMs = Date.now() - signalAt;
  assert.ok(elapsedMs < 5_000, `production process exited in ${elapsedMs}ms`);
  assert.equal(child.exitCode, 143, `expected Next's SIGTERM exit code; logs:\n${log}`);
  t.diagnostic(`production next start exited ${elapsedMs}ms after SIGTERM (exit ${child.exitCode})`);
});
