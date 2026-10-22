import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Workbench } from '../src/core/workbench';
import type { OperationInfo } from '../src/shared/types';
import { createService, serviceBinary, type ServiceUnderTest } from './service';
import { startFakeSftp, type FakeSftp } from './sftpserver';
import { strToU8, zipSync } from 'fflate';
import { tmpDir } from './helpers';

type Caller = { call(method: string, params: Record<string, unknown>): Promise<unknown>; wait(id: string): Promise<OperationInfo> };
type Step = { step: string; outcome: unknown; remote: Record<string, string> };

function remoteTree(root: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, remoteTree(root, r));
    else out[r] = fs.readFileSync(path.join(root, r), 'utf8').replace(/"deployedAt": "[^"]+"/, '"deployedAt": "x"');
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

async function outcome(c: Caller, method: string, params: Record<string, unknown>): Promise<unknown> {
  try {
    const r = (await c.call(method, params)) as OperationInfo | null;
    if (r && typeof r === 'object' && 'kind' in r && r.kind === method) {
      const op = await c.wait(r.id);
      return { status: op.status, result: op.result ?? null, error: op.error ?? null };
    }
    return { ok: JSON.parse(JSON.stringify(r ?? null)) };
  } catch (e) {
    return { err: (e as Error).message };
  }
}

async function scenario(c: Caller, ws: string, sftp: FakeSftp, remoteDir: string): Promise<Step[]> {
  const steps: Step[] = [];
  const target = { host: sftp.host, port: sftp.port, username: 'player.abc123', remoteDir, mode: 'mods' };
  const run = async (step: string, method: string, params: Record<string, unknown>) => {
    steps.push({ step, outcome: await outcome(c, method, params), remote: remoteTree(sftp.root) });
  };
  await c.call('workspace.init', { path: ws, type: 'modpack', minecraft: '1.21.1', loaderVersion: '0.19.5' });
  await c.call('workspace.trust', { path: ws, trusted: true });
  await c.call('profile.create', { path: ws, profile: { id: 'dev-server', name: 'Server', side: 'server', includeSourceMod: false } });
  for (const id of ['alpha', 'beta']) fs.writeFileSync(path.join(ws, `${id}.jar`), zipSync({ 'fabric.mod.json': [strToU8(JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', environment: '*' })), { mtime: new Date('2024-01-01T00:00:00Z') }] }));
  fs.mkdirSync(path.join(ws, 'server-config'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'server-config', 'alpha.toml'), 'speed = 3\n');
  const manifestFile = path.join(ws, 'modsmith.json');
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  for (const p of m.profiles) if (p.id === 'dev-server') p.configDir = 'server-config';
  fs.writeFileSync(manifestFile, JSON.stringify(m, null, 2));
  await c.call('dependency.add', { path: ws, profile: 'dev-server', ref: { source: 'local', path: 'alpha.jar' } });

  await run('target before setup', 'deploy.target_get', { path: ws, profile: 'dev-server' });
  await run('deploy before setup', 'server.deploy', { path: ws, profile: 'dev-server' });
  await run('client profile', 'deploy.target_get', { path: ws, profile: 'dev-client' });
  await run('bad host', 'deploy.target_set', { path: ws, profile: 'dev-server', target: { ...target, host: 'bad host' } });
  await run('save target with wrong password', 'deploy.target_set', { path: ws, profile: 'dev-server', target, password: 'wrong' });
  await run('deploy before trusting the host', 'server.deploy', { path: ws, profile: 'dev-server' });
  await run('host key', 'deploy.host_key', { target });
  const key = (steps.at(-1)!.outcome as { ok: { hostKey: string } }).ok.hostKey;
  await run('trust host', 'deploy.trust_host', { host: sftp.host, port: sftp.port, hostKey: key });
  await run('host key trusted', 'deploy.host_key', { target });
  await run('wrong password', 'server.deploy', { path: ws, profile: 'dev-server' });
  await run('right password not saved', 'server.deploy', { path: ws, profile: 'dev-server', password: 'secret' });
  await run('save password', 'deploy.target_set', { path: ws, profile: 'dev-server', target, password: 'secret' });
  await run('preview', 'server.deploy', { path: ws, profile: 'dev-server', dryRun: true });
  await run('deploy without confirm', 'server.deploy', { path: ws, profile: 'dev-server', dryRun: false });
  await run('deploy', 'server.deploy', { path: ws, profile: 'dev-server', dryRun: false, confirm: true });
  await run('deploy again', 'server.deploy', { path: ws, profile: 'dev-server', dryRun: false, confirm: true });
  fs.writeFileSync(path.join(ws, 'server-config', 'alpha.toml'), 'speed = 4\n');
  await c.call('dependency.remove', { path: ws, profile: 'dev-server', key: `local:${path.join(ws, 'alpha.jar')}` });
  await c.call('dependency.add', { path: ws, profile: 'dev-server', ref: { source: 'local', path: 'beta.jar' } });
  fs.writeFileSync(path.join(sftp.root, remoteDir.slice(1), 'mods', 'handmade.jar'), 'not from modsmith');
  await run('swap a mod and change a config', 'server.deploy', { path: ws, profile: 'dev-server', dryRun: false, confirm: true });
  await run('forget password', 'deploy.target_set', { path: ws, profile: 'dev-server', target, password: null });
  await run('deploy without password', 'server.deploy', { path: ws, profile: 'dev-server' });
  await run('trust a different key', 'deploy.trust_host', { host: sftp.host, port: sftp.port, hostKey: `SHA256:${'A'.repeat(43)}` });
  await run('changed host key', 'server.deploy', { path: ws, profile: 'dev-server', password: 'secret' });
  await run('changed host key check', 'deploy.host_key', { target });
  return steps;
}

function resetDeployState() {
  const data = process.env.MODSMITH_DATA_DIR!;
  for (const f of ['deploy-targets.json', 'known-hosts.json']) fs.rmSync(path.join(data, f), { force: true });
}

describe('SFTP deploy', () => {
  let svc: ServiceUnderTest;
  let sftp: FakeSftp;
  let first: Step[];
  let firstWs: string;

  beforeAll(async () => {
    resetDeployState();
    sftp = await startFakeSftp(tmpDir('mwb-sftp-'));
    svc = createService();
  });
  afterAll(async () => {
    await svc.stop();
    await sftp.close();
    resetDeployState();
  });

  it('previews, uploads, skips unchanged files, removes only its own stale mods and refuses changed host keys', async () => {
    firstWs = path.join(fs.realpathSync.native(tmpDir('mwb-deploy-')), 'pack');
    first = await scenario({ call: (m, p) => svc.call(m, p, 'ui'), wait: (id) => svc.waitOperation(id, 60000) }, firstWs, sftp, '/srv');
    const by = Object.fromEntries(first.map((s) => [s.step, s]));
    expect(by['target before setup'].outcome).toEqual({ ok: { target: null, hasPassword: false, hostKey: null } });
    expect(by['deploy before setup'].outcome).toEqual({ err: 'Set up where to deploy dev-server first (deploy.target_set)' });
    expect(by['deploy without confirm'].outcome).toEqual({ err: 'A deploy changes files on the server; preview it with dryRun, then pass confirm: true' });
    expect(by['deploy without confirm'].remote).toEqual({});
    expect(by['client profile'].outcome).toEqual({ err: 'Profile dev-client is not a server profile' });
    expect((by['deploy before trusting the host'].outcome as { err: string }).err).toContain('has not seen the host key');
    expect((by['host key'].outcome as { ok: { hostKey: string; trusted: boolean } }).ok).toMatchObject({ hostKey: sftp.fingerprint, trusted: false, changed: false });
    expect((by['host key trusted'].outcome as { ok: { trusted: boolean } }).ok.trusted).toBe(true);
    expect(by['wrong password'].outcome).toMatchObject({ status: 'failed', error: 'The server refused the user name or password for player.abc123' });
    expect(by['right password not saved'].outcome).toMatchObject({ status: 'succeeded', result: { dryRun: true } });
    expect(sftp.logins.filter((l) => l.ok).length).toBeGreaterThan(0);
    const preview = by.preview.outcome as { result: { upload: { path: string; reason: string }[]; remove: string[]; unchanged: number } };
    expect(preview.result.upload.map((u) => `${u.path}:${u.reason}`)).toEqual(['config/alpha.toml:new', 'mods/alpha.jar:new']);
    expect(by.preview.remote).toEqual({});
    expect(Object.keys(by.deploy.remote)).toEqual(['srv/.modsmith-deploy.json', 'srv/config/alpha.toml', 'srv/mods/alpha.jar']);
    const again = by['deploy again'].outcome as { result: { upload: unknown[]; unchanged: number } };
    expect(again.result.upload).toEqual([]);
    expect(again.result.unchanged).toBe(2);
    const swap = by['swap a mod and change a config'];
    expect((swap.outcome as { result: { upload: { path: string; reason: string }[]; remove: string[] } }).result).toMatchObject({ upload: [{ path: 'config/alpha.toml', reason: 'changed' }, { path: 'mods/beta.jar', reason: 'new' }], remove: ['mods/alpha.jar'] });
    expect(Object.keys(swap.remote)).toEqual(['srv/.modsmith-deploy.json', 'srv/config/alpha.toml', 'srv/mods/beta.jar', 'srv/mods/handmade.jar']);
    expect(swap.remote['srv/config/alpha.toml']).toBe('speed = 4\n');
    expect(by['deploy without password'].outcome).toEqual({ err: 'No password is saved for player.abc123; enter it to deploy' });
    expect((by['changed host key'].outcome as { error: string }).error).toContain('has changed');
    expect((by['changed host key check'].outcome as { ok: { changed: boolean } }).ok.changed).toBe(true);
  }, 120000);

  it.runIf(!!serviceBinary)('behaves the same in the Rust and Node services', async () => {
    resetDeployState();
    fs.rmSync(path.join(sftp.root, 'srv'), { recursive: true, force: true });
    sftp.logins.length = 0;
    const node = new Workbench();
    try {
      const ws = path.join(fs.realpathSync.native(tmpDir('mwb-deploy-')), 'pack');
      const second = await scenario({ call: (m, p) => node.call(m, p, 'ui'), wait: async (id) => (await node.s.ops.wait(id, 60000))! }, ws, sftp, '/srv');
      const strip = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(strip);
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !['id', 'startedAt', 'endedAt', 'logTail', 'message', 'progress', 'durationMs'].includes(k)).map(([k, x]) => [k, strip(x)]));
        return v;
      };
      const norm = (steps: Step[], from: string) => JSON.parse(JSON.stringify(strip(steps)).split(JSON.stringify(from).slice(1, -1)).join('WS'));
      expect(norm(first, firstWs)).toEqual(norm(second, ws));
    } finally {
      await node.stop(false);
    }
  }, 120000);
});
