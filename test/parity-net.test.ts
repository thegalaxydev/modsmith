import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Workbench } from '../src/core/workbench';
import { createService, serviceBinary, type ServiceUnderTest } from './service';
import { startFakeApi, type Recorded } from './fakeapi';

type Outcome = { ok: unknown } | { err: string };

function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'fetchedAt' && typeof x === 'number' ? 'number' : normalize(x)]));
  return v;
}

describe.runIf(!!serviceBinary)('Rust network and provider methods match the Node service', () => {
  let node: Workbench;
  let rust: ServiceUnderTest;
  let api: Awaited<ReturnType<typeof startFakeApi>>;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    api = await startFakeApi();
    for (const [k, v] of Object.entries({ ...api.env, MODSMITH_CURSEFORGE_API_KEY: '' })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    delete process.env.MODSMITH_CURSEFORGE_API_KEY;
    node = new Workbench();
    rust = createService();
    await rust.call('system.info', {}, 'ui');
  });
  afterAll(async () => {
    await node.stop(false);
    await rust.stop();
    await api.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const clearCache = () => {
    const db = new DatabaseSync(path.join(process.env.MODSMITH_DATA_DIR!, 'workbench.sqlite'));
    db.exec('PRAGMA busy_timeout = 5000; DELETE FROM http_cache');
    db.close();
  };
  const viaNode = (method: string, params: Record<string, unknown>): Promise<Outcome> =>
    node.call(method, params, 'ui').then(
      (ok) => ({ ok: normalize(JSON.parse(JSON.stringify(ok ?? null))) }),
      (e: Error) => ({ err: e.message })
    );
  const viaRust = (method: string, params: Record<string, unknown>): Promise<Outcome> =>
    rust.call(method, params, 'ui').then(
      (ok) => ({ ok: normalize(ok ?? null) }),
      (e: Error) => ({ err: e.message })
    );
  const outbound = (from: number): Omit<Recorded, never>[] => api.requests.slice(from).map((r) => ({ ...r }));

  async function same(method: string, params: Record<string, unknown>) {
    clearCache();
    let mark = api.requests.length;
    const r = await viaRust(method, params);
    const rustRequests = outbound(mark);
    clearCache();
    mark = api.requests.length;
    const n = await viaNode(method, params);
    const nodeRequests = outbound(mark);
    expect(r, `${method} ${JSON.stringify(params)}`).toEqual(n);
    expect(rustRequests, `requests for ${method} ${JSON.stringify(params)}`).toEqual(nodeRequests);
    return n;
  }

  it('reads loader metadata the same way', async () => {
    for (const loader of ['fabric', 'neoforge', 'forge']) await same('meta.game_versions', { loader });
    for (const [loader, minecraft] of [['fabric', '1.21.1'], ['fabric', '1.21 rc/1'], ['neoforge', '1.21.1'], ['neoforge', '1.21'], ['neoforge', '1.20.4'], ['forge', '1.21.1']]) await same('meta.loader_versions', { loader, minecraft });
  });

  it('searches Modrinth and lists versions the same way, including errors and retries', async () => {
    await same('dependency.search', { query: 'mod menu' });
    await same('dependency.search', { query: 'sodium & lithium/é', loader: 'fabric', minecraft: '1.21.1', limit: 5, offset: 10 });
    await same('dependency.search', { query: 'boom' });
    await same('dependency.search', { query: 'nototal' });
    await same('dependency.search', { query: 'flaky' });
    await same('modpack.search', { query: 'pack', loader: 'fabric' });
    await same('dependency.versions', { projectId: 'P', loader: 'fabric', minecraft: '1.21.1' });
    await same('dependency.versions', { projectId: 'with space/slash' });
    await same('dependency.versions', { projectId: 'missing' });
    clearCache();
    const r = await viaRust('dependency.search', { query: 'garbage' });
    const n = await viaNode('dependency.search', { query: 'garbage' });
    expect('err' in r && 'err' in n).toBe(true);
  }, 60000);

  it('handles CurseForge keys, searches and files the same way', async () => {
    await same('provider.status', {});
    await same('dependency.search', { query: 'jei', provider: 'curseforge' });
    await same('provider.set_curseforge_key', { key: 'wrong-key-1234567890' });
    await same('provider.set_curseforge_key', { key: 'broken-key-1234567890' });
    await same('provider.set_curseforge_key', { key: 'good-key-1234567890' });
    expect(fs.existsSync(path.join(process.env.MODSMITH_DATA_DIR!, 'secrets.json'))).toBe(true);
    await same('provider.status', {});
    await same('dependency.search', { query: 'jei', provider: 'curseforge', loader: 'fabric', minecraft: '1.21.1', limit: 80 });
    await same('dependency.search', { query: 'jei', provider: 'curseforge', loader: 'fabric' });
    await same('modpack.search', { query: 'pack', provider: 'curseforge', minecraft: '1.21.1' });
    await same('dependency.versions', { projectId: '1', provider: 'curseforge', loader: 'fabric', minecraft: '1.21.1' });
    await same('dependency.versions', { projectId: '1', provider: 'curseforge' });
    await same('dependency.versions', { projectId: '9', provider: 'curseforge' });
    await same('provider.clear_curseforge_key', {});
    await same('provider.status', {});
  }, 60000);

  it('lists, saves and checks presets the same way', async () => {
    await same('preset.list', {});
    await same('preset.check', { id: 'fabric-modmenu' });
    await same('preset.check', { id: 'nope' });
    await same('preset.save', { preset: { id: 'fabric-minimal', name: 'x', catalogEntryId: 'fabric-1.21.1' } });
    await same('preset.save', { preset: { id: 'Bad Id', dependencies: [{ source: 'curseforge' }], environment: 'q' } });
    const file = path.join(process.env.MODSMITH_DATA_DIR!, 'presets.json');
    fs.rmSync(file, { force: true });
    await viaRust('preset.save', { preset: { id: 'mine', name: 'Mine', catalogEntryId: 'nope-1', dependencies: [{ source: 'modrinth', projectId: 'P', required: true }], profiles: [{ any: 1 }] } });
    const rustFile = fs.readFileSync(file, 'utf8');
    fs.rmSync(file, { force: true });
    await viaNode('preset.save', { preset: { id: 'mine', name: 'Mine', catalogEntryId: 'nope-1', dependencies: [{ source: 'modrinth', projectId: 'P', required: true }], profiles: [{ any: 1 }] } });
    expect(rustFile).toBe(fs.readFileSync(file, 'utf8'));
    await same('preset.check', { id: 'mine' });
    await same('preset.save', { preset: { id: 'other', name: 'Other', catalogEntryId: 'fabric-1.21.1', dependencies: [{ source: 'modrinth', projectId: 'none', title: 'Nothing' }, { source: 'modrinth', projectId: 'missing', required: false }] } });
    await same('preset.check', { id: 'other' });
    await same('preset.list', {});
  }, 60000);
});
