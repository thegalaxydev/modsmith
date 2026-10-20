import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { tmpDir } from './helpers';
import { readServiceFile, serviceBinary, startBinary, waitExit } from './service';

const nodeService = path.join(__dirname, '..', 'dist', 'service', 'main.cjs');
const available = !!serviceBinary || fs.existsSync(nodeService);

async function start(env: NodeJS.ProcessEnv): Promise<{ child: ChildProcess; info: NonNullable<ReturnType<typeof readServiceFile>> }> {
  if (serviceBinary) return startBinary(serviceBinary, env);
  const dataDir = env.MODSMITH_DATA_DIR!;
  const child = spawn(process.execPath, [nodeService], { env, stdio: 'ignore', windowsHide: true });
  const deadline = Date.now() + 60000;
  for (;;) {
    const sf = readServiceFile(dataDir);
    if (sf && sf.pid === child.pid) return { child, info: sf };
    if (Date.now() > deadline) throw new Error('service did not start');
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface Conn {
  ws: WebSocket;
  messages: Record<string, unknown>[];
  closed: Promise<{ code: number; reason: string }>;
  next(pred: (m: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
}

function open(port: number, opts: { origin?: string; path?: string } = {}): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${opts.path ?? '/rpc'}`, opts.origin ? { origin: opts.origin } : {});
    const messages: Record<string, unknown>[] = [];
    const waiters: { pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }[] = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as Record<string, unknown>;
      messages.push(m);
      for (const w of [...waiters]) {
        if (w.pred(m)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    });
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
    ws.on('open', () =>
      resolve({
        ws,
        messages,
        closed,
        next: (pred, timeoutMs = 10000) =>
          new Promise((res, rej) => {
            const hit = messages.find(pred);
            if (hit) return res(hit);
            const t = setTimeout(() => rej(new Error('timed out waiting for message')), timeoutMs);
            waiters.push({ pred, resolve: (m) => (clearTimeout(t), res(m)) });
          })
      })
    );
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`unexpected response ${res.statusCode}`)));
  });
}

async function authed(port: number, token: string, client: string, events: boolean): Promise<Conn> {
  const c = await open(port);
  c.ws.send(JSON.stringify({ type: 'auth', token, client, events, protocol: 1 }));
  await c.next((m) => m.type === 'ready');
  return c;
}

describe.runIf(available)(`service protocol (${serviceBinary ? 'Rust service' : 'Node service'})`, () => {
  const dataDir = path.join(tmpDir('mwb-proto-'), 'data');
  const env = { ...process.env, MODSMITH_DATA_DIR: dataDir, MODSMITH_CACHE_DIR: path.join(path.dirname(dataDir), 'cache') };
  let child: ChildProcess;
  let info: NonNullable<ReturnType<typeof readServiceFile>>;

  beforeAll(async () => {
    ({ child, info } = await start(env));
  });
  afterAll(async () => {
    if (child.exitCode === null) child.kill();
  });

  it('publishes service.json and greets authenticated clients', async () => {
    expect(info).toMatchObject({ pid: child.pid, version: expect.any(String) });
    expect(info.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(info.startedAt).toBeGreaterThan(Date.now() - 120000);
    expect(fs.readFileSync(path.join(dataDir, 'service.json.lock'), 'utf8').trim()).toBe(String(child.pid));
    const c = await authed(info.port, info.token, 'cli', false);
    expect(c.messages[0]).toEqual({ type: 'ready', server: { product: 'Modsmith', version: info.version, pid: child.pid } });
    c.ws.close();
  });

  it('closes with 4004 on a wrong token or a non-auth first message', async () => {
    const a = await open(info.port);
    a.ws.send(JSON.stringify({ type: 'auth', token: 'x'.repeat(43), client: 'ui' }));
    expect((await a.closed).code).toBe(4004);
    const b = await open(info.port);
    b.ws.send(JSON.stringify({ type: 'call', id: 1, method: 'system.info' }));
    expect((await b.closed).code).toBe(4004);
  });

  it('closes with 4002 on invalid JSON', async () => {
    const c = await open(info.port);
    c.ws.send('{not json');
    expect((await c.closed).code).toBe(4002);
  });

  it('closes with 4001 when no auth arrives in time', async () => {
    const c = await open(info.port);
    expect((await c.closed).code).toBe(4001);
  }, 15000);

  it('refuses foreign origins and other paths but accepts the desktop shell origin', async () => {
    await expect(open(info.port, { origin: 'https://evil.example' })).rejects.toThrow();
    await expect(open(info.port, { path: '/other' })).rejects.toThrow();
    const ok = await open(info.port, { origin: 'http://tauri.localhost' });
    ok.ws.close();
    const unix = await open(info.port, { origin: 'tauri://localhost' });
    unix.ws.close();
    await expect(open(info.port, { origin: 'tauri://evil.example' })).rejects.toThrow();
    const dev = await open(info.port, { origin: 'http://localhost:5173' });
    dev.ws.close();
  });

  it('answers calls by id, reports unknown methods and ignores malformed calls', async () => {
    const c = await authed(info.port, info.token, 'cli', false);
    c.ws.send(JSON.stringify({ type: 'call', id: 'text-id', method: 'system.info' }));
    c.ws.send(JSON.stringify({ type: 'call', id: 7, method: 'nope.method', params: {} }));
    c.ws.send(JSON.stringify({ type: 'call', id: 8, method: 'system.info' }));
    expect(await c.next((m) => m.id === 7)).toEqual({ type: 'result', id: 7, ok: false, error: 'Unknown method nope.method' });
    const r = await c.next((m) => m.id === 8);
    expect(r).toMatchObject({ type: 'result', id: 8, ok: true, result: { product: 'Modsmith', dataDir } });
    c.ws.send(JSON.stringify({ type: 'call', id: 9, method: 'workspace.inspect', params: {} }));
    expect(await c.next((m) => m.id === 9)).toEqual({ type: 'result', id: 9, ok: false, error: 'Invalid parameters for workspace.inspect: path: Invalid input: expected string, received undefined' });
    expect(c.messages.some((m) => m.id === 'text-id')).toBe(false);
    c.ws.close();
  });

  it('sends events only to clients that asked for them, and counts clients by kind', async () => {
    const listener = await authed(info.port, info.token, 'ui', true);
    const quiet = await authed(info.port, info.token, 'mcp', false);
    const changed = await listener.next((m) => m.type === 'event' && m.event === 'clients.changed' && (m.data as Record<string, number>).mcp === 1);
    expect(changed.data).toMatchObject({ ui: 1, mcp: 1 });
    const third = await authed(info.port, info.token, 'cli', false);
    await listener.next((m) => m.type === 'event' && (m.data as Record<string, number>)?.cli === 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(quiet.messages.filter((m) => m.type === 'event')).toEqual([]);
    const sys = (await new Promise<Record<string, unknown>>((resolve) => {
      quiet.ws.send(JSON.stringify({ type: 'call', id: 1, method: 'system.info' }));
      void quiet.next((m) => m.id === 1).then(resolve);
    })) as { result: { clients: Record<string, number> } };
    expect(sys.result.clients).toMatchObject({ ui: 1, mcp: 1, cli: 1 });
    for (const c of [listener, quiet, third]) c.ws.close();
  });

  it('announces recorded activity to event listeners', async () => {
    const listener = await authed(info.port, info.token, 'ui', true);
    const cli = await authed(info.port, info.token, 'cli', false);
    const dir = tmpDir();
    cli.ws.send(JSON.stringify({ type: 'call', id: 1, method: 'workspace.trust', params: { path: dir, trusted: false } }));
    await cli.next((m) => m.id === 1);
    const ev = await listener.next((m) => m.type === 'event' && m.event === 'activity.added');
    expect(ev.data).toMatchObject({ source: 'cli', action: 'workspace.trust', status: 'ok', params: JSON.stringify({ path: dir, trusted: false }) });
    expect(Object.keys(ev.data as object)).toEqual(['id', 'ts', 'source', 'action', 'params', 'status', 'summary']);
    listener.ws.close();
    cli.ws.close();
  });

  it('lets a second service exit while the lock is held', async () => {
    const second = serviceBinary ? spawn(serviceBinary, [], { env, stdio: 'ignore' }) : spawn(process.execPath, [nodeService], { env, stdio: 'ignore' });
    expect(await waitExit(second, 20000)).toBe(0);
    expect(readServiceFile(dataDir)?.pid).toBe(child.pid);
  });

  it('shuts down on request, closing clients and removing service.json', async () => {
    const watcher = await authed(info.port, info.token, 'ui', false);
    const cli = await authed(info.port, info.token, 'cli', false);
    cli.ws.send(JSON.stringify({ type: 'call', id: 1, method: 'service.shutdown', params: {} }));
    expect(await cli.next((m) => m.id === 1)).toMatchObject({ ok: true, result: { stopping: true } });
    expect((await watcher.closed).code).toBe(1001);
    expect(await waitExit(child, 30000)).toBe(0);
    expect(fs.existsSync(path.join(dataDir, 'service.json'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'service.json.lock'))).toBe(false);
  });
});
