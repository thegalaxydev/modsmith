import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { Workbench } from '../src/core/workbench';
import { createService, serviceBinary, type ServiceUnderTest } from './service';
import { startFakeApi } from './fakeapi';
import { fakeModJar, jarBytes, tmpDir } from './helpers';
import type { OperationInfo } from '../src/shared/types';

type Outcome = { ok: unknown } | { err: string };

describe.runIf(!!serviceBinary)('Rust profiles, resolution and packs match the Node service', () => {
  let node: Workbench;
  let rust: ServiceUnderTest;
  let api: Awaited<ReturnType<typeof startFakeApi>>;
  const saved: Record<string, string | undefined> = {};
  const hash = (b: Uint8Array, algo: string) => crypto.createHash(algo).update(b).digest('hex');

  function publish(id: string, slug: string, title: string, versions: { id: string; type?: string; date?: string; fmj: Record<string, unknown>; deps?: { project_id?: string | null; version_id?: string | null; dependency_type: string }[]; loaders?: string[]; games?: string[] }[], side: { client?: string; server?: string } = {}) {
    const project = { id, slug, title, description: 'd', client_side: side.client ?? 'required', server_side: side.server ?? 'optional', project_type: 'mod', license: { id: 'MIT', name: 'MIT' } };
    api.extra.set(`GET /modrinth/project/${id}`, { body: project });
    api.extra.set(`GET /modrinth/project/${slug}`, { body: project });
    const list = versions.map((v) => {
      const bytes = jarBytes({ id: v.fmj.id ?? slug, version: v.id, ...v.fmj });
      api.extra.set(`GET /files/${slug}-${v.id}.jar`, { bytes });
      const version = { id: `${id}-${v.id}`, project_id: id, name: v.id, version_number: v.id, version_type: v.type ?? 'release', loaders: v.loaders ?? ['fabric'], game_versions: v.games ?? ['1.21.1'], date_published: v.date ?? '2024-05-01T00:00:00Z', dependencies: v.deps ?? [], files: [{ hashes: { sha1: hash(bytes, 'sha1'), sha512: hash(bytes, 'sha512') }, url: `${api.base}/files/${slug}-${v.id}.jar`, filename: `${slug}-${v.id}.jar`, primary: true, size: bytes.length }] };
      api.extra.set(`GET /modrinth/version/${version.id}`, { body: version });
      api.extra.set(`GET /modrinth/version_file/${version.files[0].hashes.sha1}?algorithm=sha1`, { body: version });
      return { version, bytes };
    });
    api.extra.set(`GET /modrinth/project/${id}/version`, { body: list.map((l) => l.version) });
    return list;
  }

  beforeAll(async () => {
    api = await startFakeApi();
    for (const [k, v] of Object.entries(api.env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    saved.MODSMITH_CURSEFORGE_API_KEY = process.env.MODSMITH_CURSEFORGE_API_KEY;
    delete process.env.MODSMITH_CURSEFORGE_API_KEY;
    publish('AAA', 'alpha', 'Alpha', [{ id: '1.0', fmj: { id: 'alpha', depends: { beta: '*', fabricloader: '>=0.15', missingdep: '*' }, breaks: { delta: '<2' } }, deps: [{ project_id: 'BBB', dependency_type: 'required' }, { project_id: 'EEE', dependency_type: 'optional' }, { project_id: 'DDD', dependency_type: 'incompatible' }] }, { id: '2.0', type: 'beta', date: '2025-01-01T00:00:00Z', fmj: { id: 'alpha' } }]);
    publish('BBB', 'beta', 'Beta', [{ id: '3.1', fmj: { id: 'beta', provides: ['beta-api'] } }]);
    publish('CCC', 'gamma', 'Gamma', [{ id: '0.5', fmj: { id: 'gamma', environment: 'client' } }], { server: 'unsupported' });
    publish('DDD', 'delta', 'Delta', [{ id: '1.5', fmj: { id: 'delta' } }]);
    publish('FFF', 'forgeonly', 'Forge Only', [{ id: '1', fmj: { id: 'forgeonly' }, loaders: ['forge'] }]);
    publish('GGG', 'pinned', 'Pinned', [{ id: '7', fmj: { id: 'pinned' } }, { id: '8', fmj: { id: 'pinned' } }]);
    api.extra.set('GET /modrinth/project/missing', { status: 404, body: { error: 'not_found' } });
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

  const swap = (v: unknown, from: string, to: string): unknown => JSON.parse(JSON.stringify(v ?? null).split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1)).split(from.replace(/\\/g, '/')).join(to.replace(/\\/g, '/')));
  const viaNode = (method: string, params: Record<string, unknown>): Promise<Outcome> =>
    node.call(method, params, 'ui').then(
      (ok) => ({ ok: JSON.parse(JSON.stringify(ok ?? null)) }),
      (e: Error) => ({ err: e.message })
    );
  const viaRust = (method: string, params: Record<string, unknown>): Promise<Outcome> =>
    rust.call(method, params, 'ui').then(
      (ok) => ({ ok: ok ?? null }),
      (e: Error) => ({ err: e.message })
    );
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !['id', 'startedAt', 'endedAt', 'logTail', 'resolvedAt', 'importedAt', 'message', 'createdAt', 'rolledBackAt', 'rollback'].includes(k)).map(([k, x]) => [k, strip(x)]));
    return v;
  };

  async function waitBoth(r: Outcome, n: Outcome) {
    const rid = ((r as { ok: OperationInfo }).ok ?? {}).id;
    const nid = ((n as { ok: OperationInfo }).ok ?? {}).id;
    const ro = rid ? await rust.waitOperation(rid, 30000) : null;
    const no = nid ? JSON.parse(JSON.stringify((await node.s.ops.wait(nid, 30000)) ?? null)) : null;
    return { ro, no };
  }

  function twins(build: (dir: string) => void | Promise<void>) {
    return (async () => {
      const a = path.join(tmpDir('mwb-twin-'), 'proj');
      const b = path.join(tmpDir('mwb-twin-'), 'proj');
      for (const d of [a, b]) {
        fs.mkdirSync(d, { recursive: true });
        await build(d);
      }
      return { a: fs.realpathSync.native(a), b: fs.realpathSync.native(b) };
    })();
  }

  async function both(method: string, pa: Record<string, unknown>, pb: Record<string, unknown>, a: string, b: string, opts: { op?: boolean } = {}) {
    const r = await viaRust(method, pa);
    const n = await viaNode(method, pb);
    if (opts.op && 'ok' in r && 'ok' in n) {
      const { ro, no } = await waitBoth(r, n);
      expect(strip(swap(ro, a, b)), `${method} operation`).toEqual(strip(no));
      return { r, n, ro, no };
    }
    expect(strip(swap(r, a, b)), `${method} ${JSON.stringify(pb)}`).toEqual(strip(n));
    return { r, n };
  }

  const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
  function sameFiles(a: string, b: string, rel: string) {
    const ra = read(path.join(a, rel));
    const rb = read(path.join(b, rel));
    expect(ra === null ? null : ra.split(a.replace(/\\/g, '\\\\')).join(b.replace(/\\/g, '\\\\')).split(a).join(b).replace(/"resolvedAt": "[^"]+"/g, '"resolvedAt": "x"').replace(/"importedAt": "[^"]+"/g, '"importedAt": "x"'), rel).toBe(rb === null ? null : rb.replace(/"resolvedAt": "[^"]+"/g, '"resolvedAt": "x"').replace(/"importedAt": "[^"]+"/g, '"importedAt": "x"'));
  }

  const initModpack = async (dir: string) => {
    await node.call('workspace.init', { path: dir, type: 'modpack', minecraft: '1.21.1', loaderVersion: '0.19.5' }, 'ui');
  };

  it('edits profiles and dependencies the same way', async () => {
    const { a, b } = await twins(async (dir) => {
      await initModpack(dir);
      fakeModJar(dir, 'local.jar', { id: 'localmod', name: 'Local Mod' });
    });
    const steps: [string, Record<string, unknown>][] = [
      ['profile.list', {}],
      ['profile.create', { profile: { id: 'srv', name: 'Server', side: 'server', jvm: { memoryMb: 2048 } } }],
      ['profile.create', { profile: { id: 'srv', name: 'Again', side: 'server' } }],
      ['profile.create', { profile: { id: 'Bad Id', side: 'nope' } }],
      ['profile.update', { id: 'srv', patch: { name: 'Server 2', programArgs: ['--nogui'], extra: 1 } }],
      ['profile.update', { id: 'nope', patch: {} }],
      ['profile.clone', { source: 'srv', id: 'srv2' }],
      ['profile.clone', { source: 'srv', id: 'srv2', name: 'Dup' }],
      ['profile.remove', { id: 'srv2', confirm: false }],
      ['profile.remove', { id: 'srv2', confirm: true }],
      ['dependency.add', { profile: 'dev-client', ref: { source: 'modrinth', projectId: 'alpha' } }],
      ['dependency.add', { profile: 'dev-client', ref: { source: 'modrinth', projectId: 'AAA' } }],
      ['dependency.add', { profile: 'dev-client', ref: { source: 'local', path: 'local.jar' } }],
      ['dependency.add', { profile: 'dev-client', ref: { source: 'local', path: 'missing.jar' } }],
      ['dependency.add', { profile: 'dev-client', ref: { source: 'curseforge', projectId: 'abc' } }],
      ['dependency.add', { profile: 'dev-client', ref: { source: 'curseforge', projectId: '12' } }],
      ['dependency.add', { profile: 'nope', ref: { source: 'maven', coordinates: 'a:b:1' } }],
      ['dependency.add', { ref: { source: 'maven', coordinates: 'a:b:1', usage: 'compile' } }],
      ['dependency.add', { ref: { source: 'modrinth', projectId: 'missing' } }],
      ['dependency.set_enabled', { profile: 'dev-client', key: 'alpha', enabled: false }],
      ['dependency.set_enabled', { profile: 'dev-client', key: 'nope', enabled: false }],
      ['dependency.set_enabled', { key: 'nope', enabled: true }],
      ['dependency.remove', { profile: 'dev-client', key: 'modrinth:alpha' }],
      ['profile.list', {}],
      ['profile.lock', {}],
      ['profile.compare', { a: 'dev-client', b: 'srv' }],
      ['profile.compare', { a: 'dev-client', b: 'zzz' }]
    ];
    for (const [method, params] of steps) {
      await both(method, { path: a, ...params }, { path: b, ...params }, a, b);
      sameFiles(a, b, 'modsmith.json');
    }
  });

  it('resolves profiles with remote, local, linked and filtered mods the same way', async () => {
    const pack = path.join(tmpDir('mwb-pack-'), 'Linked Pack');
    fs.mkdirSync(path.join(pack, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(pack, 'minecraftinstance.json'), JSON.stringify({ name: 'Linked Pack', gameVersion: '1.21.1', baseModLoader: { name: 'fabric-0.16.10-1.21.1' } }));
    fakeModJar(path.join(pack, 'mods'), 'packlib.jar', { id: 'packlib' });
    fakeModJar(path.join(pack, 'mods'), 'clientonly.jar', { id: 'clientonly', environment: 'client' });
    fakeModJar(path.join(pack, 'mods'), 'dupe-beta.jar', { id: 'beta' });
    const { a, b } = await twins(async (dir) => {
      await initModpack(dir);
      fakeModJar(dir, 'local.jar', { id: 'localmod', depends: { alpha: '>=9' } });
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'modsmith.json'), 'utf8'));
      m.profiles[0].mods = [
        { source: 'modrinth', projectId: 'AAA' },
        { source: 'modrinth', projectId: 'CCC', environment: 'client' },
        { source: 'modrinth', projectId: 'GGG', versionId: 'GGG-7' },
        { source: 'modrinth', projectId: 'DDD', enabled: false },
        { source: 'modrinth', projectId: 'FFF', required: false },
        { source: 'modrinth', projectId: 'missing', required: false },
        { source: 'local', path: 'local.jar' },
        { source: 'local', path: 'nothere.jar', required: false },
        { source: 'curseforge', projectId: 5 },
        { source: 'modrinth', projectId: 'BBB', from: 'Some Pack' }
      ];
      m.profiles.push({ ...m.profiles[0], id: 'server', name: 'Server', side: 'server', mods: [{ source: 'modrinth', projectId: 'CCC' }, { source: 'modrinth', projectId: 'GGG', versionId: 'GGG-8' }, { source: 'modrinth', projectId: 'GGG', versionId: 'GGG-7' }] });
      fs.writeFileSync(path.join(dir, 'modsmith.json'), JSON.stringify(m, null, 2));
    });
    await both('profile.link_pack', { path: a, profile: 'dev-client', folder: pack }, { path: b, profile: 'dev-client', folder: pack }, a, b);
    await both('profile.linked_packs', { path: a, profile: 'dev-client' }, { path: b, profile: 'dev-client' }, a, b);
    for (const id of ['dev-client', 'server']) {
      await both('profile.resolve', { path: a, id }, { path: b, id }, a, b, { op: true });
      sameFiles(a, b, 'modsmith.lock.json');
      sameFiles(a, b, `.modsmith/resolved-${id}.files.json`);
    }
    await both('profile.resolve', { path: a, id: 'dev-client', mode: 'production' }, { path: b, id: 'dev-client', mode: 'production' }, a, b, { op: true });
    sameFiles(a, b, 'modsmith.lock.json');
    await both('profile.compare', { path: a, a: 'dev-client', b: 'server' }, { path: b, a: 'dev-client', b: 'server' }, a, b);
    await both('profile.unlink_pack', { path: a, profile: 'dev-client', folder: pack }, { path: b, profile: 'dev-client', folder: pack }, a, b);
    await both('profile.unlink_pack', { path: a, profile: 'dev-client', folder: pack }, { path: b, profile: 'dev-client', folder: pack }, a, b);
    await both('profile.resolve', { path: a, id: 'nope' }, { path: b, id: 'nope' }, a, b, { op: true });
  }, 120000);

  it('imports packs into profiles and workspaces and exports them the same way', async () => {
    const alpha = publish('HHH', 'packmod', 'Pack Mod', [{ id: '1', fmj: { id: 'packmod' } }]);
    const extraFile = strToU8('resource');
    api.extra.set('GET /files/extra.zip', { bytes: extraFile });
    api.extra.set('POST /modrinth/version_files', (body) => {
      const hashes = (JSON.parse(body) as { hashes: string[] }).hashes;
      return { body: Object.fromEntries(hashes.filter((h) => h === alpha[0].version.files[0].hashes.sha1).map((h) => [h, alpha[0].version])) };
    });
    api.extra.set(`GET /modrinth/projects?ids=${encodeURIComponent(JSON.stringify(['HHH']))}`, { body: [{ id: 'HHH', title: 'Pack Mod' }] });
    const index = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: '2.0',
      name: 'Twin Pack',
      dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.10' },
      files: [
        { path: 'mods/packmod.jar', hashes: { sha1: alpha[0].version.files[0].hashes.sha1, sha512: 'x' }, downloads: [`${api.base}/files/packmod-1.jar`], fileSize: alpha[0].bytes.length },
        { path: 'mods/unknown.jar', hashes: { sha1: 'f'.repeat(40) }, downloads: [`${api.base}/files/nothing.jar`], fileSize: 3, env: { client: 'required', server: 'unsupported' } },
        { path: 'resourcepacks/extra.zip', hashes: { sha1: hash(extraFile, 'sha1') }, downloads: [`${api.base}/files/extra.zip`], fileSize: extraFile.length }
      ]
    };
    const mrpack = path.join(tmpDir(), 'twin.mrpack');
    fs.writeFileSync(mrpack, zipSync({ 'modrinth.index.json': strToU8(JSON.stringify(index)), 'overrides/config/a.json': strToU8('{}'), 'client-overrides/options.txt': strToU8('x'), 'overrides/mods/bundled.jar': jarBytes({ id: 'bundled' }), 'overrides/kubejs/x.js': strToU8('1') }));
    const cfzip = path.join(tmpDir(), 'twin.zip');
    fs.writeFileSync(cfzip, zipSync({ 'manifest.json': strToU8(JSON.stringify({ minecraft: { version: '1.21.1', modLoaders: [{ id: 'fabric-0.16.10', primary: true }] }, manifestType: 'minecraftModpack', manifestVersion: 1, name: 'CF Twin', version: '1', files: [{ projectID: 1, fileID: 2 }, { projectID: 3, fileID: 4, required: false }], overrides: 'over' })), 'over/config/c.toml': strToU8('a=1') }));
    const { a, b } = await twins(initModpack);
    await both('profile.import_pack', { path: a, profile: 'imp', file: mrpack }, { path: b, profile: 'imp', file: mrpack }, a, b, { op: true });
    sameFiles(a, b, 'modsmith.json');
    for (const rel of ['profiles/imp/packs/twin-pack/config/a.json', 'profiles/imp/packs/twin-pack/options.txt', 'profiles/imp/packs/twin-pack/resourcepacks/extra.zip', 'profiles/imp/packs/twin-pack/kubejs/x.js']) sameFiles(a, b, rel);
    await both('profile.import_pack', { path: a, profile: 'imp', file: mrpack }, { path: b, profile: 'imp', file: mrpack }, a, b, { op: true });
    await both('profile.import_pack', { path: a, profile: 'cf', file: cfzip, name: 'From CF' }, { path: b, profile: 'cf', file: cfzip, name: 'From CF' }, a, b, { op: true });
    sameFiles(a, b, 'modsmith.json');
    await both('profile.import_pack', { path: a, profile: 'x' }, { path: b, profile: 'x' }, a, b);
    await both('profile.import_pack', { path: a, profile: 'x', file: path.join(a, 'nope.zip') }, { path: b, profile: 'x', file: path.join(b, 'nope.zip') }, a, b);
    await both('profile.remove_pack', { path: a, profile: 'imp', pack: 'Twin Pack' }, { path: b, profile: 'imp', pack: 'Twin Pack' }, a, b);
    await both('profile.remove_pack', { path: a, profile: 'imp', pack: 'Twin Pack' }, { path: b, profile: 'imp', pack: 'Twin Pack' }, a, b);
    sameFiles(a, b, 'modsmith.json');

    const da = path.join(tmpDir('mwb-dest-'), 'ws');
    const db = path.join(tmpDir('mwb-dest-'), 'ws');
    const wsPack = path.join(tmpDir(), 'ws.mrpack');
    const wsIndex = { ...index, summary: 'S', files: index.files.map((f) => ({ ...f, hashes: { sha512: 'y'.repeat(128), ...f.hashes } })) };
    fs.writeFileSync(wsPack, zipSync({ 'modrinth.index.json': strToU8(JSON.stringify(wsIndex)), 'overrides/config/a.json': strToU8('{}'), 'client-overrides/options.txt': strToU8('x') }));
    await both('modpack.import_mrpack', { file: mrpack, destination: path.join(da, '..', 'bad') }, { file: mrpack, destination: path.join(db, '..', 'bad') }, path.dirname(da), path.dirname(db), { op: true });
    await both('modpack.import_mrpack', { file: wsPack, destination: da }, { file: wsPack, destination: db }, da, db, { op: true });
    sameFiles(da, db, 'modsmith.json');
    sameFiles(da, db, '.gitignore');
    await both('modpack.import_mrpack', { file: wsPack, destination: da }, { file: wsPack, destination: db }, da, db);
    const ca = path.join(tmpDir('mwb-dest-'), 'cf');
    const cb = path.join(tmpDir('mwb-dest-'), 'cf');
    await both('modpack.import_curseforge', { file: cfzip, destination: ca, name: 'Named' }, { file: cfzip, destination: cb, name: 'Named' }, ca, cb, { op: true });
    sameFiles(ca, cb, 'modsmith.json');
    sameFiles(ca, cb, 'profiles/pack/overrides/config/c.toml');

    for (const [ws, wsb] of [[a, b], [da, db]]) {
      await both('profile.resolve', { path: ws, id: ws === a ? 'imp' : 'pack-client' }, { path: wsb, id: wsb === b ? 'imp' : 'pack-client' }, ws, wsb, { op: true });
    }
    for (const method of ['modpack.export_mrpack', 'modpack.export_curseforge']) {
      const ext = method.endsWith('mrpack') ? '.mrpack' : '.zip';
      const oa = path.join(da, 'exports', 'out');
      const ob = path.join(db, 'exports', 'out');
      const exported = await both(method, { path: da, profile: 'pack-client', output: oa }, { path: db, profile: 'pack-client', output: ob }, da, db);
      expect(exported.n).not.toHaveProperty('err');
      const za = unzipSync(fs.readFileSync(oa + ext));
      const zb = unzipSync(fs.readFileSync(ob + ext));
      expect(Object.keys(za)).toEqual(Object.keys(zb));
      for (const k of Object.keys(za)) expect(strFromU8(za[k]).split(da).join(db), k).toBe(strFromU8(zb[k]));
      await both(method, { path: da, profile: 'nope', output: oa }, { path: db, profile: 'nope', output: ob }, da, db);
    }
  }, 120000);

  it('resolves CurseForge mods through the configured key the same way', async () => {
    const file13 = { id: 13, modId: 1, displayName: 'File 13', fileName: 'f13.jar', releaseType: 1, fileDate: '2024-05-02T00:00:00Z', fileLength: 5, downloadUrl: null, hashes: [{ value: 'c'.repeat(40), algo: 1 }], gameVersions: ['1.21.1', 'Fabric'], dependencies: [{ modId: 2, relationType: 3 }, { modId: 4, relationType: 2 }] };
    api.extra.set('GET /cf/mods/1/files/13', { body: { data: file13 } });
    api.extra.set('GET /cf/mods/2', { body: { data: { id: 2, slug: 'cf-2', name: 'CF 2', summary: 's', downloadCount: 1, allowModDistribution: false, classId: 6 } } });
    api.extra.set('GET /cf/mods/2/files', { body: { data: [] } });
    const { a, b } = await twins(async (dir) => {
      await initModpack(dir);
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'modsmith.json'), 'utf8'));
      m.profiles[0].mods = [{ source: 'curseforge', projectId: '1', fileId: '13' }];
      fs.writeFileSync(path.join(dir, 'modsmith.json'), JSON.stringify(m, null, 2));
    });
    expect(await rust.call('provider.set_curseforge_key', { key: 'good-key-1234567890' }, 'ui')).toMatchObject({ stored: true });
    await node.call('provider.set_curseforge_key', { key: 'good-key-1234567890' }, 'ui');
    await both('profile.resolve', { path: a, id: 'dev-client' }, { path: b, id: 'dev-client' }, a, b, { op: true });
    sameFiles(a, b, 'modsmith.lock.json');
    await both('dependency.add', { path: a, profile: 'dev-client', ref: { source: 'curseforge', projectId: '2', versionId: '99' } }, { path: b, profile: 'dev-client', ref: { source: 'curseforge', projectId: '2', versionId: '99' } }, a, b);
    sameFiles(a, b, 'modsmith.json');
    await rust.call('provider.clear_curseforge_key', {}, 'ui');
    await node.call('provider.clear_curseforge_key', {}, 'ui');
  }, 60000);

  it('checks, previews, applies and rolls back mod updates the same way', async () => {
    publish('HHH', 'hotel', 'Hotel', [{ id: '1', fmj: { id: 'hotel' } }]);
    publish('III', 'india', 'India', [{ id: '1', fmj: { id: 'india' } }]);
    const { a, b } = await twins(async (dir) => {
      await initModpack(dir);
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'modsmith.json'), 'utf8'));
      m.profiles[0].mods = [{ source: 'modrinth', projectId: 'HHH' }, { source: 'modrinth', projectId: 'III', versionId: 'III-1' }];
      fs.writeFileSync(path.join(dir, 'modsmith.json'), JSON.stringify(m, null, 2));
    });
    const lockOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'modsmith.lock.json'), 'utf8')).profiles['dev-client'].entries.map((e: { key: string; versionId?: string }) => `${e.key}=${e.versionId}`);
    const pair = (method: string, params: Record<string, unknown>, op = true) => both(method, { path: a, ...params }, { path: b, ...params }, a, b, { op });
    await pair('profile.check_updates', { id: 'dev-client' });
    await pair('profile.check_updates', { id: 'nope' });
    await pair('profile.resolve', { id: 'dev-client' });
    publish('JJJ', 'juliet', 'Juliet', [{ id: '1', fmj: { id: 'juliet' } }]);
    publish('HHH', 'hotel', 'Hotel', [{ id: '1', fmj: { id: 'hotel' } }, { id: '2', date: '2025-01-01T00:00:00Z', fmj: { id: 'hotel' }, deps: [{ project_id: 'JJJ', dependency_type: 'required' }] }]);
    publish('III', 'india', 'India', [{ id: '1', fmj: { id: 'india' } }, { id: '2', date: '2025-01-01T00:00:00Z', fmj: { id: 'india' } }]);
    await pair('profile.resolve', { id: 'dev-client' });
    expect(lockOf(a)).toEqual(['modrinth:HHH=HHH-1', 'modrinth:III=III-1']);
    const checked = await pair('profile.check_updates', { id: 'dev-client' });
    expect((checked.no as { result: { updates: { key: string; pinned: boolean }[] } }).result.updates.map((u) => `${u.key}:${u.pinned}`)).toEqual(['modrinth:HHH:false', 'modrinth:III:true']);
    const preview = await pair('profile.preview_update', { id: 'dev-client' });
    expect((preview.no as { result: { diff: unknown } }).result.diff).toMatchObject({ changed: [{ key: 'modrinth:HHH', from: '1', to: '2' }, { key: 'modrinth:III', from: '1', to: '2' }], added: [{ key: 'modrinth:JJJ', version: '1' }], removed: [] });
    expect(lockOf(a)).toEqual(['modrinth:HHH=HHH-1', 'modrinth:III=III-1']);
    await pair('profile.preview_update', { id: 'dev-client', keys: ['modrinth:nope'] });
    await pair('profile.apply_update', { id: 'dev-client', keys: ['modrinth:HHH'] });
    expect(lockOf(b)).toEqual(['modrinth:HHH=HHH-2', 'modrinth:III=III-1', 'modrinth:JJJ=JJJ-1']);
    sameFiles(a, b, 'modsmith.lock.json');
    await pair('profile.apply_update', { id: 'dev-client' });
    expect(lockOf(b)).toEqual(['modrinth:HHH=HHH-2', 'modrinth:III=III-2', 'modrinth:JJJ=JJJ-1']);
    sameFiles(a, b, 'modsmith.json');
    expect(fs.readFileSync(path.join(b, 'modsmith.json'), 'utf8')).toContain('"versionId": "III-2"');
    await pair('profile.apply_update', { id: 'dev-client' });
    const history = await pair('profile.update_history', { id: 'dev-client' }, false);
    const first = (o: unknown) => ((o as { ok: { id: string }[] }).ok.at(-1) as { id: string }).id;
    await both('profile.rollback_update', { path: a, rollback: first(history.r) }, { path: b, rollback: first(history.n) }, a, b, { op: true });
    expect(lockOf(a)).toEqual(['modrinth:HHH=HHH-1', 'modrinth:III=III-2']);
    expect(lockOf(b)).toEqual(['modrinth:HHH=HHH-1', 'modrinth:III=III-2']);
    sameFiles(a, b, 'modsmith.json');
    await pair('profile.update_history', {}, false);
    await pair('profile.rollback_update', { rollback: 'nope' }, false);
    await pair('profile.rollback_update', { rollback: '../x' }, false);
  });

  it('routes operation calls to whichever side owns the operation', async () => {
    const dir = tmpDir();
    await initModpack(dir);
    const op = await rust.call<OperationInfo>('profile.resolve', { path: dir, id: 'dev-client' }, 'ui');
    const done = await rust.call<OperationInfo>('operation.wait', { id: op.id, timeoutMs: 20000 }, 'ui');
    expect(done.status).toBe('succeeded');
    expect(await rust.call<OperationInfo>('operation.status', { id: op.id }, 'ui')).toMatchObject({ id: op.id, kind: 'profile.resolve', status: 'succeeded' });
    expect((await rust.call<{ lines: string[] }>('operation.log', { id: op.id, tail: 1 }, 'ui')).lines.length).toBeLessThanOrEqual(1);
    expect(await rust.call('operation.cancel', { id: op.id }, 'ui')).toEqual({ cancelled: false });
    expect((await rust.call<OperationInfo[]>('operation.list', {}, 'ui')).some((o) => o.id === op.id)).toBe(true);
    await expect(rust.call('operation.status', { id: 'no-such-op' }, 'ui')).rejects.toThrow('Unknown operation no-such-op');
    await expect(rust.call('operation.wait', { id: 'no-such-op', timeoutMs: 10 }, 'ui')).rejects.toThrow('Unknown operation no-such-op');
    expect(await rust.call('operation.cancel', { id: 'no-such-op' }, 'ui')).toEqual({ cancelled: false });
  });
});
