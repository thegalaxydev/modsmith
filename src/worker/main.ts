import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { ActivitySource } from '../shared/types';
import { appPaths } from '../core/paths';
import { Workbench } from '../core/workbench';

const paths = appPaths();
const logStream = fs.createWriteStream(paths.serviceLog, { flags: 'a' });
const log = (msg: string) => logStream.write(`[${new Date().toISOString()}] worker ${msg}\n`);
for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  console[m] = (...args: unknown[]) => log(`${m}: ${args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
}
process.on('uncaughtException', (err) => log(`uncaught: ${err.stack}`));
process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err instanceof Error ? err.stack : String(err)}`));

const out = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');

type Incoming =
  | { type: 'call'; id: number; method: string; params?: unknown; source?: ActivitySource; record?: boolean }
  | { type: 'clients'; counts: Record<string, number> }
  | { type: 'invalidate'; what: string }
  | { type: 'stop'; stopInstances?: boolean };

async function main() {
  const wb = new Workbench();
  await wb.start();
  let counts: Record<string, number> = { ui: 0, mcp: 0, cli: 0 };
  wb.clientCounts = () => counts;
  wb.mcpLaunch = { command: process.execPath, args: [path.join(__dirname, '..', 'mcp', 'main.cjs')], env: {} };
  wb.onShutdown = (stopInstances) => out({ type: 'shutdown', stopInstances });
  wb.s.bus.on((event, data) => out({ type: 'event', event, data }));
  let stopping = false;
  const stop = async (stopInstances: boolean) => {
    if (stopping) return;
    stopping = true;
    await wb.stop(stopInstances).catch((e) => log(`stop error ${e}`));
    logStream.end(() => process.exit(0));
  };
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    let msg: Incoming;
    try {
      msg = JSON.parse(line) as Incoming;
    } catch {
      log(`invalid message from front: ${line.slice(0, 200)}`);
      return;
    }
    if (msg.type === 'clients') counts = msg.counts;
    else if (msg.type === 'invalidate' && msg.what === 'curseforge-key') wb.resetCfKey();
    else if (msg.type === 'stop') void stop(!!msg.stopInstances);
    else if (msg.type === 'call') {
      const run = msg.record === false ? wb.execute(msg.method, msg.params, msg.source ?? 'system') : wb.call(msg.method, msg.params, msg.source ?? 'system');
      run.then(
        (result) => out({ type: 'result', id: msg.id, ok: true, result }),
        (err: Error) => out({ type: 'result', id: msg.id, ok: false, error: err.message })
      );
    }
  });
  rl.on('close', () => void stop(false));
  out({ type: 'ready', pid: process.pid, bridgePort: wb.s.bridge.port, runtime: process.execPath, node: process.versions.node });
  log(`started pid ${process.pid} bridge ${wb.s.bridge.port} runtime ${process.execPath}`);
}

main().catch((err) => {
  log(`fatal: ${err.stack ?? err}`);
  process.exit(1);
});
