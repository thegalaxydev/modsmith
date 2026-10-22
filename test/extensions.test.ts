import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { strToU8, zipSync } from 'fflate';
import { PRODUCT } from '../src/shared/product';
import { globToRegExp, methodsFor, viewerMatches } from '../src/shared/extensions';
import { createService, type ServiceUnderTest } from './service';
import { buildIndex, checkEntry } from '../site/registry.mjs';

type Rec = { id: string; name: string; version: string; enabled: boolean; verified: boolean; source: { kind: string; location: string }; sha256: string; manifest: Record<string, unknown> };
type Inspected = { manifest: Record<string, unknown>; file: string; sha256: string; size: number; compatible: boolean; source: { kind: string; location: string }; installed: string | null };
type Catalog = { source: string; error: string | null; extensions: { id: string; latest: { version: string; permissions: string[] }; compatible: boolean; installed: string | null; update: boolean }[] };

const routes = new Map<string, { status?: number; body?: unknown; bytes?: Uint8Array }>();
let server: http.Server;
let base = '';
let svc: ServiceUnderTest;
let dir: string;
let indexFile: string;
const saved: Record<string, string | undefined> = {};

const manifest = (over: Record<string, unknown> = {}) => ({
  id: 'galaxy.sample',
  name: 'Sample',
  version: '1.0.0',
  publisher: 'Galaxy',
  modsmith: PRODUCT.version,
  main: 'main.js',
  permissions: ['project.read'],
  contributes: { viewers: [{ id: 'nbt', title: 'NBT data', files: ['*.nbt'] }], panels: [{ id: 'scenes', title: 'Scenes' }] },
  ...over
});

const zip = (files: Record<string, string | Uint8Array>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v])));
const pkg = (over: Record<string, unknown> = {}, extra: Record<string, string | Uint8Array> = {}) => zip({ 'extension.json': JSON.stringify(manifest(over)), 'main.js': 'modsmith.registerViewer("nbt", () => {});', ...extra });
const write = (name: string, bytes: Uint8Array) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, bytes);
  return f;
};
const sha = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
const call = <T>(method: string, params: Record<string, unknown> = {}) => svc.call<T>(method, params, 'ui');
const fails = async (method: string, params: Record<string, unknown>) => {
  try {
    await call(method, params);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error(`${method} did not fail`);
};
const setIndex = (extensions: unknown[]) => fs.writeFileSync(indexFile, JSON.stringify({ schemaVersion: 1, generatedAt: '2026-10-22T00:00:00Z', extensions }));

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const r = routes.get(new URL(req.url ?? '/', 'http://x').pathname);
    if (!r) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"message":"Not Found"}');
      return;
    }
    res.writeHead(r.status ?? 200, { 'Content-Type': r.bytes ? 'application/zip' : 'application/json' });
    res.end(r.bytes ? Buffer.from(r.bytes) : JSON.stringify(r.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  indexFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mwb-extidx-')), 'index.json');
  for (const [k, v] of Object.entries({ MODSMITH_GITHUB_API: `${base}/github`, MODSMITH_EXTENSION_INDEX: indexFile })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  svc = createService();
});

afterAll(async () => {
  await svc.stop();
  await new Promise<void>((r) => server.close(() => r()));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwb-ext-'));
  routes.clear();
  setIndex([]);
  for (const r of await call<Rec[]>('extension.list')) await call('extension.remove', { id: r.id });
});

describe('extension packages', () => {
  it('inspects and installs a package from a file, then reads, disables, updates and removes it', async () => {
    const bytes = pkg({}, { 'assets/icon.bin': new Uint8Array([0, 1, 2, 3]) });
    const file = write('sample.zip', bytes);
    const info = await call<Inspected>('extension.inspect', { file });
    expect(info).toMatchObject({ sha256: sha(bytes), compatible: true, installed: null, source: { kind: 'file' } });
    expect(info.manifest).toMatchObject({ id: 'galaxy.sample', permissions: ['project.read'], main: 'main.js' });
    const r = await call<{ installed: Rec; previous: string | null }>('extension.install', { file: info.file, sha256: info.sha256 });
    expect(r.previous).toBeNull();
    expect(r.installed).toMatchObject({ id: 'galaxy.sample', version: '1.0.0', enabled: true, verified: false, sha256: sha(bytes), source: { kind: 'file' } });
    expect((await call<Rec[]>('extension.list')).map((x) => x.id)).toEqual(['galaxy.sample']);
    expect(await call('extension.read', { id: 'galaxy.sample', file: 'main.js' })).toMatchObject({ file: 'main.js', binary: false, content: 'modsmith.registerViewer("nbt", () => {});' });
    expect(await call('extension.read', { id: 'galaxy.sample', file: 'assets/icon.bin' })).toMatchObject({ binary: true, content: 'AAECAw==' });
    expect(await fails('extension.read', { id: 'galaxy.sample', file: '../install.json' })).toMatch(/points outside the extension/);
    expect(await fails('extension.read', { id: 'galaxy.sample', file: 'missing.js' })).toBe('missing.js is not in galaxy.sample');
    expect((await call<Rec>('extension.set_enabled', { id: 'galaxy.sample', enabled: false })).enabled).toBe(false);
    const next = await call<{ installed: Rec; previous: string | null }>('extension.install', { file: write('next.zip', pkg({ version: '1.1.0' })) });
    expect(next.previous).toBe('1.0.0');
    expect(next.installed).toMatchObject({ version: '1.1.0', enabled: false });
    expect(await call('extension.remove', { id: 'galaxy.sample' })).toEqual({ removed: 'galaxy.sample' });
    expect(await call<Rec[]>('extension.list')).toEqual([]);
    expect(await fails('extension.remove', { id: 'galaxy.sample' })).toBe('No installed extension galaxy.sample');
  });

  it('accepts packages wrapped in one folder and rejects broken ones', async () => {
    const wrapped = zip({ 'sample-1.0.0/extension.json': JSON.stringify(manifest()), 'sample-1.0.0/main.js': '' });
    expect((await call<Inspected>('extension.inspect', { file: write('wrapped.zip', wrapped) })).manifest.id).toBe('galaxy.sample');
    expect(await fails('extension.inspect', { file: write('none.zip', zip({ 'main.js': '' })) })).toBe('The package has no extension.json at its top level');
    expect(await fails('extension.inspect', { file: write('unsafe.zip', zip({ 'extension.json': '{}', 'a/../../evil.js': '' })) })).toBe('The package has an unsafe file path: a/../../evil.js');
    expect(await fails('extension.inspect', { file: write('notzip.zip', strToU8('hello')) })).toBe('The package is not a valid .zip file');
    expect(await fails('extension.inspect', { file: write('perm.zip', pkg({ permissions: ['everything'] })) })).toBe('extension.json: permissions has an unknown permission "everything"');
    expect(await fails('extension.inspect', { file: write('id.zip', pkg({ id: 'Sample' })) })).toMatch(/^extension\.json: id must be publisher\.name/);
    expect(await fails('extension.inspect', { file: write('main.zip', zip({ 'extension.json': JSON.stringify(manifest()) })) })).toBe('extension.json: main points to main.js, which is not in the package');
    expect(await fails('extension.inspect', { file: write('nomain.zip', zip({ 'extension.json': JSON.stringify({ ...manifest(), main: undefined }) })) })).toBe('extension.json: main is required when the extension contributes viewers or panels');
    expect(await fails('extension.inspect', { file: write('viewer.zip', pkg({ contributes: { viewers: [{ id: 'nbt', title: 'NBT', files: [] }] } })) })).toBe('extension.json: contributes.viewers.nbt needs a files list of glob patterns, like ["*.nbt"]');
    expect(await fails('extension.inspect', { file: write('repo.zip', pkg({ repository: 'http://example.com' })) })).toBe('extension.json: repository must be an https:// link');
    const future = write('future.zip', pkg({ modsmith: '99.0.0' }));
    expect((await call<Inspected>('extension.inspect', { file: future })).compatible).toBe(false);
    expect(await fails('extension.install', { file: future })).toBe(`Sample 1.0.0 needs Modsmith 99.0.0 or newer; this is ${PRODUCT.version}`);
    expect(await fails('extension.inspect', {})).toBe('Pass either file or url');
    expect(await fails('extension.install', {})).toBe('Pass registry or file');
  });

  it('refuses a package that changed since it was inspected', async () => {
    const file = write('sample.zip', pkg());
    const info = await call<Inspected>('extension.inspect', { file });
    fs.writeFileSync(file, pkg({ version: '6.6.6' }));
    expect(await fails('extension.install', { file, sha256: info.sha256 })).toBe('The package changed since it was inspected (SHA-256 mismatch)');
  });
});

describe('installing from links', () => {
  it('downloads direct links and the .zip asset of a GitHub release', async () => {
    const bytes = pkg();
    routes.set('/files/sample.zip', { bytes });
    const direct = await call<Inspected>('extension.inspect', { url: `${base}/files/sample.zip` });
    expect(direct).toMatchObject({ sha256: sha(bytes), source: { kind: 'url', location: `${base}/files/sample.zip` } });
    expect(fs.readFileSync(direct.file)).toEqual(Buffer.from(bytes));
    const r = await call<{ installed: Rec }>('extension.install', { file: direct.file, sha256: direct.sha256, url: `${base}/files/sample.zip` });
    expect(r.installed.source).toEqual({ kind: 'url', location: `${base}/files/sample.zip` });
    expect(r.installed.verified).toBe(false);

    routes.set('/github/repos/galaxy/sample/releases/latest', { body: { tag_name: 'v1.0.0', assets: [{ name: 'notes.txt', browser_download_url: `${base}/files/notes.txt` }, { name: 'sample-modsmith.zip', browser_download_url: `${base}/files/sample.zip` }] } });
    expect((await call<Inspected>('extension.inspect', { url: 'https://github.com/galaxy/sample' })).sha256).toBe(sha(bytes));
    routes.set('/github/repos/galaxy/sample/releases/tags/v2', { body: { tag_name: 'v2', assets: [] } });
    expect(await fails('extension.inspect', { url: 'https://github.com/galaxy/sample/releases/tag/v2' })).toBe('The release v2 has no .zip asset; attach the extension package to the release');
    expect(await fails('extension.inspect', { url: 'https://github.com/galaxy/missing' })).toBe('galaxy/missing has no published release');
    expect(await fails('extension.inspect', { url: 'http://example.com/sample.zip' })).toBe('Only https:// links can be installed');
  });
});

describe('Verified extensions', () => {
  const entry = (versions: unknown[], over: Record<string, unknown> = {}) => ({ id: 'galaxy.sample', name: 'Sample', publisher: 'Galaxy', description: 'A sample', repository: 'https://github.com/galaxy/sample', license: 'MIT', versions, ...over });

  it('lists the registry and installs with the pinned SHA-256', async () => {
    const v1 = pkg();
    routes.set('/files/sample-1.0.0.zip', { bytes: v1 });
    setIndex([entry([{ version: '1.0.0', url: `${base}/files/sample-1.0.0.zip`, sha256: sha(v1), size: v1.length, modsmith: '0.1.0', permissions: ['project.read'] }, { version: '9.0.0', url: `${base}/files/x.zip`, sha256: sha(v1), modsmith: '99.0.0', permissions: [] }])]);
    const cat = await call<Catalog>('extension.catalog', { force: true });
    expect(cat.error).toBeNull();
    expect(cat.extensions).toEqual([expect.objectContaining({ id: 'galaxy.sample', latest: { version: '1.0.0', modsmith: '0.1.0', permissions: ['project.read'], size: v1.length }, compatible: true, installed: null, update: false })]);
    const r = await call<{ installed: Rec }>('extension.install', { registry: 'galaxy.sample' });
    expect(r.installed).toMatchObject({ version: '1.0.0', verified: true, source: { kind: 'registry', location: `${base}/files/sample-1.0.0.zip` } });

    const v2 = pkg({ version: '1.1.0' });
    routes.set('/files/sample-1.1.0.zip', { bytes: v2 });
    setIndex([entry([{ version: '1.0.0', url: `${base}/files/sample-1.0.0.zip`, sha256: sha(v1), modsmith: '0.1.0', permissions: ['project.read'] }, { version: '1.1.0', url: `${base}/files/sample-1.1.0.zip`, sha256: sha(v2), modsmith: '0.1.0', permissions: ['project.read'] }])]);
    expect((await call<Catalog>('extension.catalog', { force: true })).extensions[0]).toMatchObject({ installed: '1.0.0', update: true, latest: { version: '1.1.0' } });
    expect((await call<{ installed: Rec }>('extension.install', { registry: 'galaxy.sample' })).installed.version).toBe('1.1.0');
    expect((await call<{ installed: Rec }>('extension.install', { registry: 'galaxy.sample', version: '1.0.0' })).installed.version).toBe('1.0.0');
    expect(await fails('extension.install', { registry: 'galaxy.sample', version: '3.0.0' })).toBe('galaxy.sample has no Verified version 3.0.0');
    expect(await fails('extension.install', { registry: 'galaxy.other' })).toBe('No Verified extension galaxy.other');
  });

  it('refuses tampered files, unapproved permissions and versions this Modsmith cannot run', async () => {
    const bytes = pkg({ permissions: ['project.read', 'game'] });
    routes.set('/files/sample.zip', { bytes });
    setIndex([entry([{ version: '1.0.0', url: `${base}/files/sample.zip`, sha256: sha(pkg({ description: 'The reviewed build' })), modsmith: '0.1.0', permissions: ['project.read', 'game'] }])]);
    expect(await fails('extension.install', { registry: 'galaxy.sample' })).toMatch(/sha256 mismatch/);
    setIndex([entry([{ version: '1.0.0', url: `${base}/files/sample.zip`, sha256: sha(bytes), modsmith: '0.1.0', permissions: ['project.read'] }])]);
    expect(await fails('extension.install', { registry: 'galaxy.sample' })).toBe('The package asks for game, which was not approved for this version');
    setIndex([entry([{ version: '2.0.0', url: `${base}/files/sample.zip`, sha256: sha(bytes), modsmith: '99.0.0', permissions: ['project.read', 'game'] }])]);
    expect((await call<Catalog>('extension.catalog', { force: true })).extensions[0].compatible).toBe(false);
    expect(await fails('extension.install', { registry: 'galaxy.sample' })).toBe(`Sample 2.0.0 needs Modsmith 99.0.0 or newer; this is ${PRODUCT.version}`);
    setIndex([entry([{ version: '1.0.0', url: `${base}/files/sample.zip`, sha256: sha(bytes), modsmith: '0.1.0', permissions: ['project.read', 'game'] }], { id: 'galaxy.renamed' })]);
    expect(await fails('extension.install', { registry: 'galaxy.renamed' })).toBe('The downloaded package is galaxy.sample 1.0.0, not galaxy.renamed 1.0.0');
    expect(await call<Rec[]>('extension.list')).toEqual([]);
  });

  it('reports an unreadable registry without failing', async () => {
    fs.writeFileSync(indexFile, '{"nope": true}');
    expect(await call<Catalog>('extension.catalog', { force: true })).toMatchObject({ error: 'The extension index is not valid', extensions: [] });
  });
});

describe('permissions and viewer patterns', () => {
  it('maps permissions to service methods', () => {
    expect([...methodsFor(['project.read'])]).toContain('workspace.read_file');
    expect([...methodsFor(['project.read'])]).not.toContain('workspace.write_file');
    expect([...methodsFor(['game', 'unknown'])]).toContain('world.run_command');
  });

  it('matches files against viewer globs', () => {
    const v = { id: 'nbt', title: 'NBT', files: ['*.nbt', 'src/main/resources/assets/*/ponder/**/*.json'] };
    expect(viewerMatches(v, 'src/main/resources/data/x/structure/house.nbt')).toBe(true);
    expect(viewerMatches(v, 'house.NBT')).toBe(true);
    expect(viewerMatches(v, 'house.nbt.bak')).toBe(false);
    expect(viewerMatches(v, 'src/main/resources/assets/demo/ponder/a/b.json')).toBe(true);
    expect(viewerMatches(v, 'src/main/resources/assets/demo/ponder/b.json')).toBe(true);
    expect(viewerMatches(v, 'src/main/resources/assets/demo/other/b.json')).toBe(false);
    expect(globToRegExp('a?c.txt').test('abc.txt')).toBe(true);
  });
});

describe('Verified registry files', () => {
  const entry = (over: Record<string, unknown> = {}) => ({ id: 'galaxy.sample', version: '1.0.0', name: 'Sample', publisher: 'Galaxy', repository: 'https://github.com/galaxy/sample', url: 'https://github.com/galaxy/sample/releases/download/v1.0.0/galaxy.sample-1.0.0.zip', sha256: 'a'.repeat(64), size: 10, modsmith: '0.1.12', permissions: ['project.read'], ...over });

  it('accepts a complete entry saved under its id and version', () => {
    expect(checkEntry(entry(), 'registry/extensions/galaxy.sample/1.0.0.json')).toEqual([]);
  });

  it('rejects entries that do not come from the release of their own repository', () => {
    expect(checkEntry(entry({ url: 'https://github.com/someone/else/releases/download/v1/x.zip' }))).toEqual(['url must be a release asset of https://github.com/galaxy/sample']);
    expect(checkEntry(entry({ url: 'https://example.com/x.zip' }))[0]).toMatch(/^url must be a \.zip asset of a GitHub release/);
    expect(checkEntry(entry(), 'registry/extensions/galaxy.sample/2.0.0.json')).toEqual(['registry/extensions/galaxy.sample/2.0.0.json: must be saved as registry/extensions/galaxy.sample/1.0.0.json']);
    expect(checkEntry(entry({ permissions: ['game', 'game'], extra: true }))).toEqual(['unknown field extra', 'permissions must list each of project.read, project.write, game, build, network at most once']);
  });

  it('groups versions into the index the app reads, newest first', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mwb-registry-'));
    const put = (e: ReturnType<typeof entry>) => {
      const f = path.join(root, 'extensions', e.id, `${e.version}.json`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(e));
    };
    put(entry());
    put(entry({ version: '1.10.0', name: 'Sample tools', url: 'https://github.com/galaxy/sample/releases/download/v1.10.0/s.zip' }));
    put(entry({ id: 'acme.alpha', name: 'Alpha', repository: 'https://github.com/acme/alpha', url: 'https://github.com/acme/alpha/releases/download/v1.0.0/a.zip' }));
    const index = buildIndex(root, 'now');
    expect(index.extensions.map((e: { id: string }) => e.id)).toEqual(['acme.alpha', 'galaxy.sample']);
    expect(index.extensions[1]).toMatchObject({ name: 'Sample tools', versions: [{ version: '1.10.0' }, { version: '1.0.0' }] });
    put(entry({ version: '2.0.0', repository: 'https://github.com/someone/fork', url: 'https://github.com/someone/fork/releases/download/v2/f.zip' }));
    expect(() => buildIndex(root)).toThrow(/every version must come from the same repository/);
  });
});
