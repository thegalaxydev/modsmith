import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Workbench } from '../src/core/workbench';
import { platform } from '../src/core/temurin';
import type { JavaInstallation, OperationInfo } from '../src/shared/types';
import { createService, serviceBinary, type ServiceUnderTest } from './service';
import { startFakeApi } from './fakeapi';
import { fakeJavaExecutable, fakeTemurin } from './fakejdk';
import { tmpDir } from './helpers';

const java = fakeJavaExecutable();
const { os, arch } = platform();
const key = (major: number, image: string) => `${major}-${image}-${os}-${arch}`;
const dataDir = () => process.env.MODSMITH_DATA_DIR!;
const jdks = () => path.join(dataDir(), 'jdks');
const homeOf = (top: string) => (process.platform === 'darwin' ? path.join(jdks(), top, 'Contents', 'Home') : path.join(jdks(), top));
const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

let api: Awaited<ReturnType<typeof startFakeApi>>;
let svc: ServiceUnderTest;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  api = await startFakeApi();
  for (const [k, v] of Object.entries(api.env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  if (java) {
    api.temurin.set(key(25, 'jdk'), fakeTemurin('25.0.1', 8, 'jdk', java));
    api.temurin.set(key(21, 'jre'), fakeTemurin('21.0.5', 11, 'jre', java, 'tar.gz'));
    api.temurin.set(key(17, 'jdk'), { ...fakeTemurin('17.0.13', 11, 'jdk', java), checksum: 'f'.repeat(64) });
  }
  svc = createService();
  await svc.call('system.info', {}, 'ui');
});

afterAll(async () => {
  await svc.stop();
  await api.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function install(s: Pick<ServiceUnderTest, 'call' | 'waitOperation'>, params: Record<string, unknown>): Promise<OperationInfo> {
  const op = await s.call<OperationInfo>('java.install', params, 'ui');
  expect(op).toMatchObject({ kind: 'java.install', status: 'running' });
  return s.waitOperation(op.id, 60000);
}

function writeProject(minMajor?: number): string {
  const dir = tmpDir('mwb-javareq-');
  const catalog = JSON.parse(fs.readFileSync(path.join(process.env.MODSMITH_RESOURCES_DIR!, 'catalog', 'compatibility.json'), 'utf8'));
  const entry = catalog.entries.find((e: { id: string }) => e.id === 'fabric-1.21.1');
  const profile = (id: string, side: string, extra: Record<string, unknown> = {}) => ({ id, name: id, side, ...extra });
  fs.writeFileSync(
    path.join(dir, 'modsmith.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'Java needs',
      type: 'mod',
      modId: 'javaneeds',
      platform: { loader: 'fabric', minecraft: '1.21.1', loaderVersion: entry.loaderVersion, catalogEntry: 'fabric-1.21.1' },
      source: { kind: 'gradle', root: '.' },
      profiles: [profile('dev-client', 'client', minMajor ? { java: { minMajor } } : {}), profile('prod-server', 'server', { mode: 'production', java: { minMajor: 98 } })]
    })
  );
  return dir;
}

describe.runIf(!!java)('Eclipse Temurin downloads', () => {
  it('downloads a JDK, verifies its checksum and registers it with Java detection', async () => {
    const mark = api.requests.length;
    const done = await install(svc, { major: 25 });
    expect(done.error).toBeUndefined();
    expect(done.status).toBe('succeeded');
    const j = done.result as JavaInstallation;
    expect(same(j.home, homeOf('jdk-25.0.1+8'))).toBe(true);
    expect(j).toMatchObject({ version: '25.0.1', major: 25, vendor: 'Eclipse Adoptium', isJdk: true, sources: [jdks()] });
    const urls = api.requests.slice(mark).map((r) => r.url);
    expect(urls).toEqual([`/adoptium/v3/assets/latest/25/hotspot?architecture=${arch}&image_type=jdk&os=${os}&vendor=eclipse`, `/adoptium/v3/binary/latest/25/ga/${os}/${arch}/jdk/hotspot/normal/eclipse`, `/adoptium/files/${encodeURIComponent(api.temurin.get(key(25, 'jdk'))!.name)}`]);
    expect(fs.readFileSync(path.join(j.home, 'lib', ...Array(14).fill('nested'), 'modules'), 'utf8')).toBe('modules');
    if (process.platform !== 'win32') {
      expect(fs.statSync(j.executable).mode & 0o111).not.toBe(0);
      expect(fs.readFileSync(path.join(j.home, 'legal', 'RELEASE'), 'utf8')).toContain('JAVA_VERSION="25.0.1"');
    }
    expect(fs.readdirSync(jdks()).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
    expect(fs.existsSync(path.join(process.env.MODSMITH_CACHE_DIR!, 'downloads', 'temurin', api.temurin.get(key(25, 'jdk'))!.name))).toBe(false);
    const list = await svc.call<JavaInstallation[]>('java.list', {}, 'ui');
    expect(list.some((x) => same(x.home, j.home))).toBe(true);
    const req = await svc.call<{ requirements: { purpose: string; major: number; jdk: boolean; java: JavaInstallation | null }[]; install: unknown[] }>('java.requirements', { catalogEntryId: 'fabric-1.21.1' }, 'ui');
    expect(req.requirements).toHaveLength(1);
    expect(req.requirements[0]).toMatchObject({ purpose: 'gradle', major: 25, jdk: true });
    expect(req.requirements[0].java?.major).toBeGreaterThanOrEqual(25);
    expect(req.install).toEqual([]);
  });

  it('installs a JRE next to the JDK and replaces an existing copy', async () => {
    const first = await install(svc, { major: 21, imageType: 'jre' });
    expect(first.status).toBe('succeeded');
    fs.writeFileSync(path.join((first.result as JavaInstallation).home, 'stale.txt'), 'x');
    const done = await install(svc, { major: 21, imageType: 'jre' });
    const j = done.result as JavaInstallation;
    expect(same(j.home, homeOf('jdk-21.0.5+11-jre'))).toBe(true);
    expect(j).toMatchObject({ major: 21, isJdk: false });
    expect(fs.existsSync(path.join(j.home, 'stale.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(j.home, 'lib', ...Array(14).fill('nested'), 'modules'), 'utf8')).toBe('modules');
    expect(done.title).toBe('Download Java 21 (JRE)');
  });

  it('refuses a download whose checksum does not match and leaves nothing behind', async () => {
    const done = await install(svc, { major: 17 });
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/^Hash verification failed for .*\/adoptium\/v3\/binary\/latest\/17\/ga\/.*: sha256 mismatch$/);
    expect(fs.readdirSync(jdks()).some((n) => n.includes('17.0.13'))).toBe(false);
  });

  it('reports versions Adoptium does not publish for this platform', async () => {
    const done = await install(svc, { major: 99, imageType: 'jre' });
    expect(done.status).toBe('failed');
    expect(done.error).toBe(`Eclipse Temurin 99 (jre) is not available for ${os} ${arch}`);
    await expect(svc.call('java.install', { major: 7 }, 'ui')).rejects.toThrow(/Invalid parameters for java.install/);
  });

  it('plans downloads for the Java a build or launch needs', async () => {
    const dir = writeProject(99);
    const req = await svc.call<{ requirements: { purpose: string; major: number; jdk: boolean; java: unknown }[]; install: unknown[] }>('java.requirements', { path: dir, profile: 'dev-client' }, 'ui');
    expect(req.requirements.map(({ purpose, major, jdk }) => ({ purpose, major, jdk }))).toEqual([
      { purpose: 'gradle', major: 25, jdk: true },
      { purpose: 'runtime', major: 99, jdk: false }
    ]);
    expect(req.requirements[1].java).toBeNull();
    expect(req.install).toEqual([{ major: 99, imageType: 'jre' }]);
    const build = await svc.call<{ requirements: unknown[]; install: unknown[] }>('java.requirements', { path: dir }, 'ui');
    expect(build.requirements).toHaveLength(1);
    await expect(svc.call('java.requirements', { path: dir, profile: 'nope' }, 'ui')).rejects.toThrow('Unknown profile nope');
    await expect(svc.call('java.requirements', { catalogEntryId: 'nope-1' }, 'ui')).rejects.toThrow('Unknown catalog entry nope-1');
    await expect(svc.call('java.requirements', {}, 'ui')).rejects.toThrow('Give a catalogEntryId or a workspace path');
  });
});

describe.runIf(!!java && !!serviceBinary)('Rust Temurin downloads match the Node service', () => {
  let node: Workbench;

  beforeAll(() => {
    node = new Workbench();
  });
  afterAll(() => node.stop(false));

  type Outcome = { status: string; result?: unknown; error?: string; title: string; kind: string; logTail: string[] };
  const outcome = (o: OperationInfo): Outcome => ({ status: o.status, result: o.result ?? null, error: o.error, title: o.title, kind: o.kind, logTail: o.logTail });
  const viaNode = async (params: Record<string, unknown>) => {
    const op = (await node.call('java.install', params, 'ui')) as OperationInfo;
    return outcome((await node.s.ops.wait(op.id, 60000))!);
  };

  it('installs, verifies and fails the same way', async () => {
    for (const params of [{ major: 25 }, { major: 21, imageType: 'jre' }, { major: 17 }, { major: 99 }]) {
      let mark = api.requests.length;
      const r = outcome(await install(svc, params));
      const rustUrls = api.requests.slice(mark).map((x) => x.url);
      mark = api.requests.length;
      const n = await viaNode(params);
      const nodeUrls = api.requests.slice(mark).map((x) => x.url);
      expect(JSON.parse(JSON.stringify(r)), JSON.stringify(params)).toEqual(JSON.parse(JSON.stringify(n)));
      expect(rustUrls).toEqual(nodeUrls);
    }
  }, 120000);

  it('plans Java requirements the same way', async () => {
    const dir = writeProject(99);
    for (const params of [{ catalogEntryId: 'fabric-1.21.1' }, { catalogEntryId: 'nope' }, { path: dir }, { path: dir, profile: 'dev-client' }, { path: dir, profile: 'prod-server' }, { path: dir, profile: 'prod-server', mode: 'development' }, { path: dir, profile: 'x' }, {}]) {
      const r = await svc.call('java.requirements', params, 'ui').then((ok) => ({ ok }), (e: Error) => ({ err: e.message }));
      const n = await node.call('java.requirements', params, 'ui').then((ok) => ({ ok: JSON.parse(JSON.stringify(ok)) }), (e: Error) => ({ err: e.message }));
      expect(r, JSON.stringify(params)).toEqual(n);
    }
  });
});
