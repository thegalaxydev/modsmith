import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { PRODUCT } from '../shared/product';
import type { ActivitySource } from '../shared/types';
import { appPaths } from '../core/paths';
import { Workbench } from '../core/workbench';
import { constantTimeEqual } from '../core/bridge';
import { readServiceFile } from '../client/connect';

const paths = appPaths();
const logStream = fs.createWriteStream(paths.serviceLog, { flags: 'a' });
const log = (msg: string) => logStream.write(`[${new Date().toISOString()}] ${msg}\n`);
for (const m of ['log', 'info', 'warn', 'error'] as const) {
  console[m] = (...args: unknown[]) => log(`${m}: ${args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
}
process.on('uncaughtException', (err) => log(`uncaught: ${err.stack}`));
process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err instanceof Error ? err.stack : String(err)}`));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(lockFile: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch {
      const owner = Number(fs.readFileSync(lockFile, 'utf8').trim());
      if (owner && owner !== process.pid && pidAlive(owner)) return false;
      fs.rmSync(lockFile, { force: true });
    }
  }
  return false;
}

async function main() {
  const lockFile = `${paths.serviceFile}.lock`;
  if (!acquireLock(lockFile)) {
    log('another service owns the lock; exiting');
    process.exit(0);
  }
  process.on('exit', () => {
    try {
      if (fs.readFileSync(lockFile, 'utf8').trim() === String(process.pid)) fs.rmSync(lockFile, { force: true });
    } catch {
      void 0;
    }
  });
  const wb = new Workbench();
  await wb.start();
  const token = crypto.randomBytes(32).toString('base64url');
  const clients = new Set<{ ws: WebSocket; events: boolean; source: ActivitySource }>();
  const counts = () => {
    const c: Record<string, number> = { ui: 0, mcp: 0, cli: 0 };
    for (const x of clients) c[x.source] = (c[x.source] ?? 0) + 1;
    return c;
  };
  wb.clientCounts = counts;
  wb.s.bus.on((event, data) => {
    const msg = JSON.stringify({ type: 'event', event, data });
    for (const c of clients) if (c.events && c.ws.readyState === c.ws.OPEN) c.ws.send(msg);
  });
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const allowed = !origin || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin) || /^https?:\/\/tauri\.localhost$/.test(origin);
    if (req.url !== '/rpc' || !allowed) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let authed: { ws: WebSocket; events: boolean; source: ActivitySource } | null = null;
      const t = setTimeout(() => ws.close(4001, 'auth timeout'), 5000);
      ws.on('message', async (raw) => {
        let msg: { type: string; token?: string; client?: string; events?: boolean; id?: number; method?: string; params?: unknown };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          ws.close(4002, 'invalid json');
          return;
        }
        if (!authed) {
          if (msg.type !== 'auth' || typeof msg.token !== 'string' || !constantTimeEqual(msg.token, token)) {
            ws.close(4004, 'authentication failed');
            return;
          }
          clearTimeout(t);
          const source: ActivitySource = msg.client === 'mcp' || msg.client === 'cli' || msg.client === 'ui' ? msg.client : 'system';
          authed = { ws, events: !!msg.events, source };
          clients.add(authed);
          wb.s.bus.emit('clients.changed', counts());
          ws.send(JSON.stringify({ type: 'ready', server: { product: PRODUCT.name, version: PRODUCT.version, pid: process.pid } }));
          return;
        }
        if (msg.type !== 'call' || typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
        try {
          const result = await wb.call(msg.method, msg.params, authed.source);
          ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: (err as Error).message }));
        }
      });
      ws.on('close', () => {
        clearTimeout(t);
        if (authed) {
          clients.delete(authed);
          wb.s.bus.emit('clients.changed', counts());
        }
      });
      ws.on('error', () => void 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const mcpScript = path.join(__dirname, '..', 'mcp', 'main.cjs');
  wb.mcpLaunch = { command: process.execPath, args: [mcpScript], env: {} };
  const tmp = `${paths.serviceFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, port, token, version: PRODUCT.version, startedAt: Date.now() }), { mode: 0o600 });
  fs.renameSync(tmp, paths.serviceFile);
  log(`service started pid ${process.pid} port ${port} bridge ${wb.s.bridge.port} runtime ${process.execPath}`);
  let stopping = false;
  const shutdown = async (stopInstances: boolean) => {
    if (stopping) return;
    stopping = true;
    log(`shutting down (stopInstances=${stopInstances})`);
    try {
      const sf = readServiceFile();
      if (sf?.pid === process.pid) fs.rmSync(paths.serviceFile, { force: true });
    } catch {
      void 0;
    }
    for (const c of clients) c.ws.close(1001, 'service stopping');
    await wb.stop(stopInstances).catch((e) => log(`stop error ${e}`));
    server.close();
    setTimeout(() => process.exit(0), 200);
  };
  wb.onShutdown = (stopInstances) => void shutdown(stopInstances);
  process.on('SIGINT', () => void shutdown(true));
  process.on('SIGTERM', () => void shutdown(true));
}

main().catch((err) => {
  log(`fatal: ${err.stack ?? err}`);
  process.exit(1);
});
