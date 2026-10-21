import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Workbench } from '../src/core/workbench';
import { createService, serviceBinary, type ServiceUnderTest } from './service';
import { startFakeApi } from './fakeapi';
import { fakeModJar, jarBytes, tmpDir } from './helpers';
import type { OperationInfo } from '../src/shared/types';
import { findResourcesDir } from '../src/core/paths';

type Outcome = { ok: unknown } | { err: string };

function pngPixels(buf: Buffer): string {
  const chunks: Buffer[] = [];
  let header = '';
  for (let i = 8; i < buf.length; ) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') header = data.toString('hex');
    if (type === 'IDAT') chunks.push(data);
    i += 12 + len;
  }
  return `${header}:${zlib.inflateSync(Buffer.concat(chunks)).toString('hex')}`;
}

function listFiles(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (r === '.git' || r === '.modsmith/logs') continue;
      out.push(...listFiles(root, r));
    } else out.push(r);
  }
  return out.sort();
}

function eraResources(): string {
  const dir = path.join(tmpDir('mwb-res-'), 'resources');
  fs.cpSync(findResourcesDir(__dirname), dir, { recursive: true });
  const file = path.join(dir, 'catalog', 'compatibility.json');
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = catalog.entries.find((e: { id: string }) => e.id === 'fabric-1.21.1');
  const era = (id: string, minecraft: string, javaRelease: number, extra: Record<string, unknown>) => ({ ...base, id, minecraft, javaRelease, runtimeJavaMin: javaRelease, status: 'tested', starters: ['empty', 'profiles'], bridge: { available: false }, templateSource: `https://github.com/FabricMC/fabric-example-mod/tree/${minecraft}`, ...extra });
  catalog.entries.push(
    era('fabric-era-legacy', '1.16.5', 8, { fabricApiVersion: '0.42.0+1.16', fabric: { splitSources: false, logger: 'log4j', identifier: 'ResourceLocation.new' } }),
    era('fabric-era-1.20', '1.20.1', 17, { fabricApiVersion: '0.92.12+1.20.1', fabric: { splitSources: true, logger: 'slf4j', identifier: 'ResourceLocation.new' } }),
    era('fabric-era-identifier', '26.3', 25, { fabricApiVersion: '0.163.0+26.3', plugin: { id: 'net.fabricmc.fabric-loom', version: base.plugin.version }, mappings: 'none', remap: false, fabric: { splitSources: true, logger: 'slf4j', identifier: 'Identifier.fromNamespaceAndPath' } })
  );
  for (const [id, from] of [['neoforge-era-1.20.4', 'neoforge-1.20.4'], ['neoforge-era-1.21.5', 'neoforge-1.21.5'], ['neoforge-era-1.21.11', 'neoforge-1.21.11'], ['neoforge-era-26.3', 'neoforge-26.3']]) {
    const source = catalog.entries.find((e: { id: string }) => e.id === from);
    catalog.entries.push({ ...source, id, status: 'tested' });
  }
  fs.writeFileSync(file, JSON.stringify(catalog, null, 2));
  return dir;
}

describe.runIf(!!serviceBinary)('Rust builds, launches and game methods match the Node service', () => {
  let node: Workbench;
  let rust: ServiceUnderTest;
  let api: Awaited<ReturnType<typeof startFakeApi>>;
  const saved: Record<string, string | undefined> = {};
  const hash = (b: Uint8Array, algo: string) => crypto.createHash(algo).update(b).digest('hex');

  beforeAll(async () => {
    api = await startFakeApi();
    for (const [k, v] of Object.entries(api.env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    saved.MODSMITH_CURSEFORGE_API_KEY = process.env.MODSMITH_CURSEFORGE_API_KEY;
    delete process.env.MODSMITH_CURSEFORGE_API_KEY;
    const project = { id: 'LIBX', slug: 'libx', title: 'Lib X', description: 'd', client_side: 'required', server_side: 'optional', project_type: 'mod', license: { id: 'MIT', name: 'MIT' } };
    const bytes = jarBytes({ id: 'libx', version: '2.0' });
    const version = { id: 'LIBX-2.0', project_id: 'LIBX', name: '2.0', version_number: '2.0', version_type: 'release', loaders: ['fabric', 'neoforge'], game_versions: ['1.21.1', '1.16.5'], date_published: '2024-05-01T00:00:00Z', dependencies: [{ project_id: 'P7dR8mSH', dependency_type: 'required' }], files: [{ hashes: { sha1: hash(bytes, 'sha1'), sha512: hash(bytes, 'sha512') }, url: `${api.base}/files/libx-2.0.jar`, filename: 'libx-2.0.jar', primary: true, size: bytes.length }] };
    for (const key of ['LIBX', 'libx']) api.extra.set(`GET /modrinth/project/${key}`, { body: project });
    api.extra.set('GET /modrinth/project/LIBX/version', { body: [version] });
    api.extra.set('GET /modrinth/version/LIBX-2.0', { body: version });
    api.extra.set('GET /files/libx-2.0.jar', { bytes });
    saved.MODSMITH_RESOURCES_DIR = process.env.MODSMITH_RESOURCES_DIR;
    process.env.MODSMITH_RESOURCES_DIR = eraResources();
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

  const swap = (v: unknown, from: string, to: string): unknown => JSON.parse(JSON.stringify(v ?? null).split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1)));
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
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !['id', 'startedAt', 'endedAt', 'logTail', 'message', 'progress', 'durationMs'].includes(k)).map(([k, x]) => [k, strip(x)]));
    return v;
  };

  async function same(method: string, params: Record<string, unknown>) {
    const r = await viaRust(method, params);
    const n = await viaNode(method, params);
    expect(r, `${method} ${JSON.stringify(params)}`).toEqual(n);
    return n;
  }

  async function both(method: string, pa: Record<string, unknown>, pb: Record<string, unknown>, a: string, b: string) {
    const r = await viaRust(method, pa);
    const n = await viaNode(method, pb);
    if ('ok' in r && 'ok' in n && (r.ok as OperationInfo | null)?.kind && (n.ok as OperationInfo | null)?.kind) {
      const ro = await rust.waitOperation((r.ok as OperationInfo).id, 60000);
      const no = JSON.parse(JSON.stringify(await node.s.ops.wait((n.ok as OperationInfo).id, 60000)));
      expect(strip(swap(ro, a, b)), `${method} operation`).toEqual(strip(no));
      return { ro, no };
    }
    expect(swap(r, a, b), `${method} ${JSON.stringify(pb)}`).toEqual(n);
    return { r, n };
  }

  function sameTree(a: string, b: string) {
    const fa = listFiles(a);
    expect(fa).toEqual(listFiles(b));
    for (const f of fa) {
      const ba = fs.readFileSync(path.join(a, f));
      const bb = fs.readFileSync(path.join(b, f));
      if (f.endsWith('.png')) {
        expect(pngPixels(ba), f).toBe(pngPixels(bb));
        continue;
      }
      const norm = (t: string) => t.replace(/"at": "[^"]+"/g, '"at": "x"');
      expect(norm(ba.toString('utf8').split(a.replace(/\\/g, '\\\\')).join(b.replace(/\\/g, '\\\\')).split(a).join(b)), f).toBe(norm(bb.toString('utf8')));
    }
  }

  const twin = () => {
    const a = path.join(fs.realpathSync.native(tmpDir('mwb-twin-')), 'proj');
    const b = path.join(fs.realpathSync.native(tmpDir('mwb-twin-')), 'proj');
    return { a, b };
  };

  const createInput = (dest: string, extra: Record<string, unknown>) => ({ projectName: 'Starter Test', destination: dest, modId: 'startertest', packageName: 'com.example.startertest', author: 'Tester', description: 'A "quoted" mod', runInitialBuild: false, ...extra });

  it('reports capabilities, starters, Java runtimes and system information the same way', async () => {
    await same('system.capabilities', {});
    for (const entryId of ['fabric-1.21.1', 'neoforge-1.21.1', 'fabric-26.3', 'nope']) await same('catalog.starters', { entryId });
    await same('java.list', {});
    const r = (await rust.call<Record<string, unknown>>('system.info', {}, 'ui')) as Record<string, unknown>;
    expect(r.product).toBe('Modsmith');
    expect(r.bridgePort).toBeGreaterThan(0);
    expect(r.nativeViewport).toBe(process.platform === 'win32' ? 'win32-reparent' : 'unsupported');
  });

  it('validates project settings and plans dependencies the same way', async () => {
    const exists = tmpDir();
    fs.writeFileSync(path.join(exists, 'x.txt'), 'x');
    const jar = fakeModJar(tmpDir(), 'local.jar', { id: 'localmod', version: '1.2' });
    const inputs = [
      createInput(path.join(tmpDir(), 'fresh'), {}),
      createInput('relative/path', { modId: 'Bad', packageName: 'net.minecraft.x', license: ' ' }),
      createInput(exists, { modId: 'fabric', packageName: 'com.int.x', catalogEntryId: 'fabric-26.3', starters: ['empty', 'networking', 'nope'] }),
      createInput(path.join(exists, 'x.txt'), { catalogEntryId: 'missing', projectName: '  ' }),
      createInput(path.join(tmpDir(), 'p'), { environment: 'server', starters: ['datagen'], dependencies: [{ source: 'modrinth' }, { source: 'bogus' }] }),
      createInput(path.join(tmpDir(), 'p'), { catalogEntryId: 'neoforge-1.21.1', environment: 'server', starters: ['datagen'], packageName: 'one' })
    ];
    for (const input of inputs) await same('project.validate_create', { input: { license: 'MIT', git: false, catalogEntryId: 'fabric-1.21.1', environment: 'both', starters: ['empty'], dependencies: [], ...input } });
    await same('project.plan_dependencies', {
      minecraft: '1.21.1',
      loader: 'fabric',
      refs: [
        { source: 'modrinth', projectId: 'LIBX', usage: 'compile', environment: 'both', required: true },
        { source: 'modrinth', projectId: 'libx', versionId: 'LIBX-2.0', usage: 'runtime' },
        { source: 'modrinth', projectId: 'missing', title: 'Gone' },
        { source: 'local', path: jar },
        { source: 'local', path: path.join(tmpDir(), 'nope.jar'), title: 'Nope' },
        { source: 'curseforge', projectId: '123' },
        { source: 'maven', coordinates: 'a:b:1', usage: 'compile' }
      ]
    });
    await same('project.plan_dependencies', { minecraft: '1.20.1', loader: 'neoforge', refs: [{ source: 'modrinth', projectId: 'LIBX' }] });
  });

  const combos: Record<string, unknown>[] = [
    { catalogEntryId: 'fabric-1.21.1', starters: ['empty'] },
    { catalogEntryId: 'fabric-1.21.1', starters: ['empty', 'item', 'block', 'command', 'config', 'datagen', 'bridge', 'profiles'], license: 'CC0-1.0' },
    { catalogEntryId: 'fabric-1.21.1', environment: 'client', starters: ['empty', 'item', 'datagen', 'profiles'], author: '' },
    { catalogEntryId: 'fabric-1.21.1', environment: 'server', starters: ['empty', 'block', 'config', 'profiles'] },
    {
      catalogEntryId: 'fabric-1.21.1',
      starters: ['empty', 'profiles'],
      presetId: 'my-preset',
      dependencies: [
        { source: 'modrinth', projectId: 'libx', usage: 'compile', environment: 'client', required: true },
        { source: 'maven', coordinates: 'org.example:lib:1.0', repository: 'https://maven.example/', usage: 'compile' },
        { source: 'maven', coordinates: 'org.example:rt:1.0', repository: 'https://maven.example/', usage: 'runtime' }
      ]
    },
    { catalogEntryId: 'fabric-era-legacy', starters: ['empty', 'profiles'] },
    {
      catalogEntryId: 'fabric-era-legacy',
      environment: 'client',
      starters: ['empty'],
      dependencies: [{ source: 'modrinth', projectId: 'libx', usage: 'compile', environment: 'client', required: true }]
    },
    { catalogEntryId: 'fabric-era-1.20', starters: ['empty', 'profiles'] },
    { catalogEntryId: 'fabric-era-identifier', starters: ['empty', 'profiles'], environment: 'server' },
    { catalogEntryId: 'fabric-era-identifier', starters: ['empty'] },
    { catalogEntryId: 'neoforge-1.21.1', starters: ['empty'] },
    { catalogEntryId: 'neoforge-era-1.20.4', starters: ['empty', 'profiles'] },
    { catalogEntryId: 'neoforge-era-1.21.5', starters: ['empty', 'profiles'], environment: 'server' },
    { catalogEntryId: 'neoforge-era-1.21.11', starters: ['empty', 'profiles'], environment: 'client' },
    { catalogEntryId: 'neoforge-era-26.3', starters: ['empty', 'profiles'] },
    { catalogEntryId: 'neoforge-1.21.1', starters: ['empty', 'item', 'block', 'command', 'config', 'datagen', 'bridge', 'profiles'], description: '' },
    { catalogEntryId: 'neoforge-1.21.1', environment: 'server', starters: ['empty', 'item', 'config', 'profiles'], projectName: "Neo '''Mod''' Test" },
    { catalogEntryId: 'neoforge-1.21.1', starters: ['empty', 'config'], dependencies: [{ source: 'modrinth', projectId: 'LIBX', usage: 'compile', required: false }, { source: 'maven', coordinates: 'a:b:2', usage: 'runtime' }] }
  ];

  it.each(combos.map((c, i) => [i, c] as const))('generates identical project %i', async (_i, combo) => {
    const { a, b } = twin();
    const created = await both('project.create', createInput(a, combo), createInput(b, combo), a, b);
    expect((created as { ro: OperationInfo }).ro.status, JSON.stringify((created as { ro: OperationInfo }).ro.error)).toBe('succeeded');
    expect(listFiles(a).length).toBeGreaterThan(10);
    sameTree(a, b);
    await both('project.validate', { path: a }, { path: b }, a, b);
    await both('project.diagnostics', { path: a }, { path: b }, a, b);
    await both('workspace.inspect', { path: a }, { path: b }, a, b);
  }, 60000);

  it('initializes, trusts and opens workspaces and refuses untrusted builds the same way', async () => {
    const { a, b } = twin();
    for (const d of [a, b]) {
      fs.mkdirSync(path.join(d, 'src', 'main', 'resources'), { recursive: true });
      fs.writeFileSync(path.join(d, 'build.gradle'), "plugins { id 'net.neoforged.moddev' version '2.0.1' }\n");
      fs.writeFileSync(path.join(d, 'gradle.properties'), 'minecraft_version=1.21.1\nneo_version=21.1.77\n');
      fs.writeFileSync(path.join(d, '.gitignore'), 'build/');
      fs.writeFileSync(path.join(d, 'src', 'main', 'resources', 'fabric.mod.json'), '{"schemaVersion":1,"id":"neo"}');
    }
    await both('project.build', { path: a }, { path: b }, a, b);
    await both('project.datagen', { path: a }, { path: b }, a, b);
    await both('workspace.init', { path: a, type: 'mod' }, { path: b, type: 'mod' }, a, b);
    await both('workspace.init', { path: a, type: 'mod' }, { path: b, type: 'mod' }, a, b);
    expect(fs.readFileSync(path.join(a, '.gitignore'), 'utf8')).toBe(fs.readFileSync(path.join(b, '.gitignore'), 'utf8'));
    expect(fs.readFileSync(path.join(a, 'modsmith.json'), 'utf8')).toBe(fs.readFileSync(path.join(b, 'modsmith.json'), 'utf8'));
    await both('workspace.trust', { path: a, trusted: true }, { path: b, trusted: true }, a, b);
    await both('workspace.trust', { path: a, trusted: false }, { path: b, trusted: false }, a, b);
    await both('workspace.open', { path: a }, { path: b }, a, b);
    await both('project.validate', { path: a }, { path: b }, a, b);
    await same('workspace.open', { path: path.join(tmpDir(), 'missing') });
    const empty = twin();
    for (const d of [empty.a, empty.b]) fs.mkdirSync(d, { recursive: true });
    await both('workspace.init', { path: empty.a, type: 'modpack' }, { path: empty.b, type: 'modpack' }, empty.a, empty.b);
    await both('workspace.init', { path: empty.a, type: 'modpack', minecraft: '1.21.1', loaderVersion: '0.19.5', name: 'Pack' }, { path: empty.b, type: 'modpack', minecraft: '1.21.1', loaderVersion: '0.19.5', name: 'Pack' }, empty.a, empty.b);
    expect(fs.readFileSync(path.join(empty.a, 'modsmith.json'), 'utf8')).toBe(fs.readFileSync(path.join(empty.b, 'modsmith.json'), 'utf8'));
    await both('instance.launch', { path: empty.a, profile: 'dev-client' }, { path: empty.b, profile: 'dev-client' }, empty.a, empty.b);
    await both('instance.launch', { path: empty.a, profile: 'nope' }, { path: empty.b, profile: 'nope' }, empty.a, empty.b);
  });

  it('answers instance, game, world, scenario and bisect calls without a running game the same way', async () => {
    const { a, b } = twin();
    for (const d of [a, b]) {
      fs.mkdirSync(d, { recursive: true });
      await node.call('workspace.init', { path: d, type: 'mod', minecraft: '1.21.1', loaderVersion: '0.19.5' }, 'ui');
      fs.mkdirSync(path.join(d, 'scenarios'));
      fs.writeFileSync(path.join(d, 'scenarios', 'good.json'), JSON.stringify({ schemaVersion: 1, name: 'Good', profile: 'dev-client', steps: [{ action: 'give', item: 'minecraft:stone' }, { action: 'assert_log', pattern: 'x' }] }));
      fs.writeFileSync(path.join(d, 'scenarios', 'bad.json'), JSON.stringify({ schemaVersion: 2, name: 5, profile: 'dev-client', steps: [{ action: 'jump' }], timeoutMs: 5 }));
      fs.writeFileSync(path.join(d, 'scenarios', 'notes.txt'), 'ignored');
    }
    for (const method of ['instance.status', 'instance.stop', 'logs.read', 'crash.inspect', 'crash.bundle', 'game.status', 'game.mods', 'game.reload_capabilities', 'world.open', 'viewport.capture', 'viewport.window', 'bridge.call', 'instance.send_input']) {
      await same(method, { id: 'no-such-instance', method: 'game.status', kind: 'resources', name: 'w', line: 'say hi' });
    }
    await same('bridge.status', { id: 'no-such-instance' });
    await same('instance.list', {});
    await both('instance.history', { path: a }, { path: b }, a, b);
    await both('instance.eula_status', { path: a, profile: 'dev-server' }, { path: b, profile: 'dev-server' }, a, b);
    await both('instance.eula_status', { path: a, profile: 'dev-server', mode: 'production' }, { path: b, profile: 'dev-server', mode: 'production' }, a, b);
    await both('instance.accept_eula', { path: a, profile: 'dev-client', accept: true }, { path: b, profile: 'dev-client', accept: true }, a, b);
    await both('instance.accept_eula', { path: a, profile: 'dev-server', accept: false }, { path: b, profile: 'dev-server', accept: false }, a, b);
    await both('instance.launch', { path: a, profile: 'dev-server' }, { path: b, profile: 'dev-server' }, a, b);
    await same('session.stop', { id: 'no-such-session' });
    await same('session.list', {});
    await both('session.list', { path: a }, { path: b }, a, b);
    for (const extra of [{}, { server: 'dev-client' }, { client: 'dev-server' }, { server: 'nope' }, { clients: 5 }, { clients: 0 }, { names: ['Alex', 'alex'] }, { names: ['no spaces'] }, { clients: 1, names: ['Steve'] }]) {
      await both('session.start', { path: a, server: 'dev-server', client: 'dev-client', ...extra }, { path: b, server: 'dev-server', client: 'dev-client', ...extra }, a, b);
    }
    await both('server.export_pack', { path: a, profile: 'dev-client', output: path.join(a, 'out') }, { path: b, profile: 'dev-client', output: path.join(b, 'out') }, a, b);
    await both('server.export_pack', { path: a, profile: 'nope', output: path.join(a, 'out') }, { path: b, profile: 'nope', output: path.join(b, 'out') }, a, b);
    await both('server.export_pack', { path: a, profile: 'dev-server', output: a }, { path: b, profile: 'dev-server', output: b }, a, b);
    await both('lsp.status', { path: a, language: 'java' }, { path: b, language: 'java' }, a, b);
    await both('lsp.start', { path: a, language: 'java' }, { path: b, language: 'java' }, a, b);
    await same('lsp.send', { session: 'no-such-session', message: '{}' });
    await same('lsp.stop', { session: 'no-such-session' });
    await both('scenario.list', { path: a }, { path: b }, a, b);
    await both('scenario.results', { path: a }, { path: b }, a, b);
    await both('scenario.run', { path: a, scenario: 'missing' }, { path: b, scenario: 'missing' }, a, b);
    await both('scenario.run', { path: a, scenario: 'bad' }, { path: b, scenario: 'bad' }, a, b);
    await both('scenario.run', { path: a, scenario: 'good.json' }, { path: b, scenario: 'good.json' }, a, b);
    await both('world.snapshots', { path: a }, { path: b }, a, b);
    await both('world.snapshot', { path: a, profile: 'dev-client' }, { path: b, profile: 'dev-client' }, a, b);
    await both('world.restore', { path: a, profile: 'dev-client', snapshot: 'x', confirm: false }, { path: b, profile: 'dev-client', snapshot: 'x', confirm: false }, a, b);
    await both('world.restore', { path: a, profile: 'dev-client', snapshot: 'x', confirm: true }, { path: b, profile: 'dev-client', snapshot: 'x', confirm: true }, a, b);
    await both('bisect.status', { path: a }, { path: b }, a, b);
    await both('bisect.start', { path: a, profile: 'dev-client', predicate: 'crashes' }, { path: b, profile: 'dev-client', predicate: 'crashes' }, a, b);
    await both('bisect.record', { path: a, outcome: 'bad' }, { path: b, outcome: 'bad' }, a, b);
    await both('bisect.reset', { path: a }, { path: b }, a, b);
  });

  it('snapshots and restores worlds the same way', async () => {
    const { a, b } = twin();
    for (const d of [a, b]) {
      fs.mkdirSync(d, { recursive: true });
      await node.call('workspace.init', { path: d, type: 'mod', minecraft: '1.21.1', loaderVersion: '0.19.5' }, 'ui');
      const world = path.join(d, '.modsmith', 'instances', 'dev-client-client', 'saves', 'Test World');
      fs.mkdirSync(path.join(world, 'region'), { recursive: true });
      fs.writeFileSync(path.join(world, 'level.dat'), 'level');
      fs.writeFileSync(path.join(world, 'session.lock'), 'lock');
      fs.writeFileSync(path.join(world, 'region', 'r.0.0.mca'), Buffer.alloc(1000, 1));
    }
    const ra = await rust.waitOperation(((await rust.call('world.snapshot', { path: a, profile: 'dev-client', name: 'Before' }, 'ui')) as OperationInfo).id);
    const nb = await node.s.ops.wait(((await node.call('world.snapshot', { path: b, profile: 'dev-client', name: 'Before' }, 'ui')) as OperationInfo).id, 20000);
    const strip2 = (v: unknown) => JSON.parse(JSON.stringify(v).replace(/"id":"[^"]+"/g, '"id":"x"').replace(/"createdAt":"[^"]+"/g, '"createdAt":"x"'));
    expect(strip(strip2(swap(ra.result, a, b)))).toEqual(strip(strip2(nb!.result)));
    const listA = await rust.call<{ id: string }[]>('world.snapshots', { path: a }, 'ui');
    const listB = (await node.call('world.snapshots', { path: b }, 'ui')) as { id: string }[];
    expect(strip2(swap(listA, a, b))).toEqual(strip2(listB));
    for (const [d, svc, id] of [[a, 'rust', listA[0].id], [b, 'node', listB[0].id]] as const) {
      const world = path.join(d, '.modsmith', 'instances', 'dev-client-client', 'saves', 'Test World');
      fs.writeFileSync(path.join(world, 'level.dat'), 'changed');
      const r = svc === 'rust' ? await rust.call('world.restore', { path: d, profile: 'dev-client', snapshot: id, confirm: true }, 'ui') : await node.call('world.restore', { path: d, profile: 'dev-client', snapshot: id, confirm: true }, 'ui');
      expect(r).toEqual({ restoredTo: world });
      expect(fs.readFileSync(path.join(world, 'level.dat'), 'utf8')).toBe('level');
      expect(fs.existsSync(path.join(world, 'session.lock'))).toBe(false);
    }
  });
});
