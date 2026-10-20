import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventBus } from '../src/core/events';
import { Store } from '../src/core/db';
import { BridgeHost } from '../src/core/bridge';
import { InstanceManager } from '../src/core/instances';
import { tmpDir } from './helpers';

const bus = new EventBus();
const store = new Store(path.join(tmpDir(), 'db.sqlite'));
const bridge = new BridgeHost(bus);
const mgr = new InstanceManager(bus, store, bridge);
afterAll(async () => {
  await mgr.stopAll();
  await bridge.stop();
});

const fakeServer = `
const rl = require('readline').createInterface({ input: process.stdin });
console.log('[12:00:00] [Server thread/INFO]: Done (1.0s)! For help, type "help"');
console.log('token env present: ' + !!process.env.MODSMITH_BRIDGE_TOKEN);
rl.on('line', (l) => { if (l.trim() === 'stop') { console.log('[12:00:01] [Server thread/INFO]: Stopping server'); process.exit(0); } });
setInterval(() => {}, 1000);
`;

const stubborn = `setInterval(() => console.log('[12:00:00] [main/INFO] (x) alive'), 200);`;

function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error('timeout'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe('instance lifecycle', () => {
  it('starts, reaches running, stops gracefully through the server console', async () => {
    await bridge.start();
    const dir = tmpDir();
    const info = mgr.launch({ workspace: dir, profileId: 'srv', side: 'server', mode: 'development', instanceDir: path.join(dir, 'inst'), java: process.execPath, args: ['-e', fakeServer], bridge: true });
    await waitFor(() => mgr.get(info.id)?.status === 'running');
    expect(() => mgr.launch({ workspace: dir, profileId: 'srv', side: 'server', mode: 'development', instanceDir: path.join(dir, 'inst'), java: process.execPath, args: ['-e', fakeServer], bridge: false })).toThrow(/already in use/);
    const stopped = await mgr.stop(info.id, { timeoutMs: 5000 });
    expect(stopped.status).toBe('exited');
    expect(stopped.exitCode).toBe(0);
    const logs = mgr.logs(info.id, {}).lines.map((l) => l.text).join('\n');
    expect(logs).toContain('Stopping server');
    expect(logs).toContain('token env present: true');
    expect(fs.readFileSync(info.logFile, 'utf8')).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect((store.listLaunches(dir) as { status: string }[])[0].status).toBe('exited');
  });

  it('forces termination when graceful stop times out', async () => {
    const dir = tmpDir();
    const info = mgr.launch({ workspace: dir, profileId: 'c', side: 'client', mode: 'development', instanceDir: path.join(dir, 'inst'), java: process.execPath, args: ['-e', stubborn], bridge: false });
    await waitFor(() => mgr.logs(info.id, {}).lines.length > 3);
    const t0 = Date.now();
    const r = await mgr.stop(info.id, { force: true });
    expect(['exited', 'crashed']).toContain(r.status);
    expect(Date.now() - t0).toBeLessThan(10000);
  });

  it('terminates a client stuck on the NeoForge early-display error dialog', async () => {
    const dir = tmpDir();
    const script = `console.log('[17:42:48] [pool-2-thread-1/ERROR] [EARLYDISPLAY/]: ERROR DISPLAY');setInterval(() => {}, 1000)`;
    const info = mgr.launch({ workspace: dir, profileId: 'c', side: 'client', mode: 'development', instanceDir: path.join(dir, 'inst'), java: process.execPath, args: ['-e', script], bridge: false });
    const done = await waitFor(() => (['crashed', 'exited'].includes(mgr.get(info.id)!.status) ? mgr.get(info.id) : undefined), 10000);
    expect(done!.status).toBe('crashed');
    expect(mgr.logs(info.id, {}).lines.some((l) => /early loading window/.test(l.text))).toBe(true);
  });

  it('detects crashes from exit codes and crash reports', async () => {
    const dir = tmpDir();
    const inst = path.join(dir, 'inst');
    const script = `require('fs').mkdirSync('crash-reports',{recursive:true});require('fs').writeFileSync('crash-reports/crash-x.txt','Description: test');process.exit(-1)`;
    const info = mgr.launch({ workspace: dir, profileId: 'c', side: 'client', mode: 'development', instanceDir: inst, java: process.execPath, args: ['-e', script], bridge: false });
    const done = await waitFor(() => (['crashed', 'exited'].includes(mgr.get(info.id)!.status) ? mgr.get(info.id) : undefined));
    expect(done!.status).toBe('crashed');
    expect(done!.crashReport).toMatch(/crash-x\.txt$/);
  });
});
