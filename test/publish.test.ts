import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Workbench } from '../src/core/workbench';
import { createService, serviceBinary, type ServiceUnderTest } from './service';
import { startFakeApi } from './fakeapi';
import { tmpDir } from './helpers';
import type { OperationInfo } from '../src/shared/types';

type Api = Awaited<ReturnType<typeof startFakeApi>>;
type Call = <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;

const JAR = Buffer.from('PK\u0003\u0004fake jar ÿ bytes', 'latin1');

async function project(call: Call) {
  const dir = tmpDir('mwb-publish-');
  fs.writeFileSync(path.join(dir, 'build.gradle'), "plugins { id 'net.fabricmc.fabric-loom-remap' version '1.18' }\n");
  fs.writeFileSync(path.join(dir, 'settings.gradle'), "rootProject.name = 'gizmo'\n");
  fs.mkdirSync(path.join(dir, 'src', 'main', 'resources'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'main', 'resources', 'fabric.mod.json'), JSON.stringify({ schemaVersion: 1, id: 'gizmo', version: '${version}' }));
  await call('workspace.init', { path: dir, type: 'mod', name: 'Gizmo Mod', minecraft: '1.21.1', loaderVersion: '0.19.5' });
  return dir;
}

function withEnv(api: () => Api) {
  const saved: Record<string, string | undefined> = {};
  return {
    set() {
      for (const [k, v] of Object.entries({ ...api().env, MODSMITH_CURSEFORGE_API_KEY: '', MODSMITH_MODRINTH_TOKEN: '', MODSMITH_CURSEFORGE_UPLOAD_TOKEN: '' })) {
        saved[k] = process.env[k];
        process.env[k] = v;
      }
    },
    restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

describe('publishing to Modrinth and CurseForge', () => {
  let api: Api;
  let svc: ServiceUnderTest;
  const env = withEnv(() => api);
  beforeAll(async () => {
    api = await startFakeApi();
    env.set();
    svc = createService();
  });
  afterAll(async () => {
    await svc.stop();
    await api.close();
    env.restore();
  });
  const call: Call = (m, p) => svc.call(m, p, 'ui');
  const publish = async (p: Record<string, unknown>) => {
    const op = await call<OperationInfo>('project.publish', p);
    return svc.waitOperation(op.id);
  };

  it('links projects, stores tokens and uploads the built JAR', async () => {
    const dir = await project(call);
    expect(await call('publish.status', { path: dir })).toMatchObject({ modrinth: { project: null, token: null }, curseforge: { project: null, token: null } });

    await expect(call('publish.link', { path: dir, provider: 'modrinth', project: 'some-pack' })).rejects.toThrow('Some Pack is a modpack on Modrinth, not a mod');
    await expect(call('publish.link', { path: dir, provider: 'modrinth', project: 'nothing-here' })).rejects.toThrow('Modrinth has no project nothing-here');
    await expect(call('publish.link', { path: dir, provider: 'curseforge', project: 'https://www.curseforge.com/minecraft/mc-mods/gizmo' })).rejects.toThrow(/numeric Project ID/);
    expect(await call('publish.link', { path: dir, provider: 'modrinth', project: 'https://modrinth.com/mod/gizmo/versions' })).toEqual({ id: 'GZM1', slug: 'gizmo', title: 'Gizmo', url: 'https://modrinth.com/mod/gizmo' });
    expect(await call('publish.link', { path: dir, provider: 'curseforge', project: ' 123456 ' })).toEqual({ id: '123456', url: 'https://www.curseforge.com/projects/123456' });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'modsmith.json'), 'utf8'));
    expect(manifest.publish).toEqual({ modrinth: { id: 'GZM1', slug: 'gizmo', title: 'Gizmo' }, curseforge: { id: '123456' } });

    await expect(publish({ path: dir, file: 'gizmo-1.0.0.jar', targets: ['modrinth'], version: '1.0.0' })).rejects.toThrow('gizmo-1.0.0.jar is not in build/libs; build the project first');
    fs.mkdirSync(path.join(dir, 'build', 'libs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'build', 'libs', 'gizmo-1.0.0.jar'), JAR);
    await expect(publish({ path: dir, file: 'gizmo-1.0.0.jar', targets: ['modrinth'], version: '1.0.0' })).rejects.toThrow('Add a Modrinth upload token in Project settings first');
    await expect(call('publish.set_token', { provider: 'modrinth', token: 'wrong-token' })).rejects.toThrow('Modrinth rejected this token');
    await expect(call('publish.set_token', { provider: 'curseforge', token: 'wrong-token' })).rejects.toThrow('CurseForge rejected this token');
    expect(await call('publish.set_token', { provider: 'modrinth', token: 'mr-good-token' })).toMatchObject({ stored: true });
    expect(await call('publish.set_token', { provider: 'curseforge', token: 'cf-upload-good' })).toMatchObject({ stored: true });
    expect(await call('publish.status', { path: dir })).toMatchObject({ modrinth: { token: 'os-secret-store', project: { id: 'GZM1' } }, curseforge: { token: 'os-secret-store', project: { id: '123456' } } });


    const from = api.requests.length;
    const done = await publish({ path: dir, file: 'gizmo-1.0.0.jar', targets: ['curseforge', 'modrinth'], version: '1.0.0', changelog: '- First release', releaseType: 'beta' });
    expect(done.status).toBe('succeeded');
    const results = (done.result as { results: { provider: string; ok: boolean; id: string; url: string }[] }).results;
    expect(results.map((r) => [r.provider, r.ok])).toEqual([['modrinth', true], ['curseforge', true]]);
    expect(results[0].url).toBe(`https://modrinth.com/mod/gizmo/version/${results[0].id}`);
    expect(results[1].url).toBe('https://www.curseforge.com/projects/123456');

    const sent = api.requests.slice(from);
    const mr = sent.find((r) => r.method === 'POST' && r.url === '/modrinth/version')!;
    expect(mr.auth).toBe('mr-good-token');
    const boundary = /boundary=(\S+)$/.exec(mr.contentType!)![1];
    expect(boundary).toMatch(/^ModsmithBoundary[0-9a-f]{16}$/);
    const data = JSON.parse(/name="data"\r\nContent-Type: application\/json\r\n\r\n(.*?)\r\n--/s.exec(mr.body)![1]);
    expect(data).toEqual({ changelog: '- First release', dependencies: [], featured: true, file_parts: ['file'], game_versions: ['1.21.1'], loaders: ['fabric'], name: 'Gizmo Mod 1.0.0', primary_file: 'file', project_id: 'GZM1', version_number: '1.0.0', version_type: 'beta' });
    expect(mr.body).toContain('Content-Disposition: form-data; name="file"; filename="gizmo-1.0.0.jar"');
    expect(mr.body.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
    const cf = sent.find((r) => r.method === 'POST' && r.url === '/cfupload/api/projects/123456/upload-file')!;
    expect(cf.auth).toBe('cf-upload-good');
    const metadata = JSON.parse(/name="metadata"\r\nContent-Type: application\/json\r\n\r\n(.*?)\r\n--/s.exec(cf.body)![1]);
    expect(metadata).toEqual({ changelog: '- First release', changelogType: 'markdown', displayName: 'Gizmo Mod 1.0.0', gameVersions: [11779, 7499], releaseType: 'beta' });

    const partial = await publish({ path: dir, file: 'gizmo-1.0.0.jar', targets: ['modrinth', 'curseforge'], version: '1.0.1', gameVersions: ['1.21.1', '1.99'], name: 'Gizmo 1.0.1' });
    expect(partial.status).toBe('succeeded');
    expect((partial.result as { results: unknown[] }).results).toMatchObject([{ provider: 'modrinth', ok: true }, { provider: 'curseforge', ok: false, error: 'CurseForge does not list Minecraft 1.99' }]);

    await call('publish.link', { path: dir, provider: 'modrinth', project: 'taken' });
    const failed = await publish({ path: dir, file: 'gizmo-1.0.0.jar', targets: ['modrinth'], version: '1.0.0' });
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('Modrinth: Modrinth answered HTTP 400: Error while validating input: version number already used');

    expect(await call('publish.link', { path: dir, provider: 'modrinth', project: null })).toBeNull();
    expect(await call('publish.link', { path: dir, provider: 'curseforge', project: null })).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'modsmith.json'), 'utf8')).publish).toBeUndefined();
    await call('publish.clear_token', { provider: 'modrinth' });
    await call('publish.clear_token', { provider: 'curseforge' });
    expect(await call('publish.status', { path: dir })).toMatchObject({ modrinth: { token: null }, curseforge: { token: null } });
  });
});

describe.runIf(!!serviceBinary)('Rust and Node publish the same way', () => {
  let api: Api;
  let node: Workbench;
  let rust: ServiceUnderTest;
  const env = withEnv(() => api);
  beforeAll(async () => {
    api = await startFakeApi();
    env.set();
    process.env.MODSMITH_MODRINTH_TOKEN = 'mr-good-token';
    process.env.MODSMITH_CURSEFORGE_UPLOAD_TOKEN = 'cf-upload-good';
    node = new Workbench();
    rust = createService();
  });
  afterAll(async () => {
    await node.stop(false);
    await rust.stop();
    await api.close();
    env.restore();
  });

  it('sends byte-identical uploads and returns the same results', async () => {
    const run = async (call: Call, wait: (id: string) => Promise<OperationInfo | undefined>) => {
      const dir = await project(call);
      fs.mkdirSync(path.join(dir, 'build', 'libs'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'build', 'libs', 'gizmo-1.0.0.jar'), JAR);
      const linked = [await call('publish.link', { path: dir, provider: 'modrinth', project: 'gizmo' }), await call('publish.link', { path: dir, provider: 'curseforge', project: '42' })];
      const status = await call('publish.status', { path: dir });
      const from = api.requests.length;
      const op = await call<OperationInfo>('project.publish', { path: dir, file: 'gizmo-1.0.0.jar', targets: ['modrinth', 'curseforge'], version: '2.0.0', changelog: 'Ünïcode "quotes"\nand lines', loaders: ['fabric', 'quilt'] });
      const done = await wait(op.id);
      const sent = api.requests.slice(from).map((r) => ({ ...r }));
      const errors = await Promise.all([call('publish.link', { path: dir, provider: 'curseforge', project: '4x' }).catch((e: Error) => e.message), call('project.publish', { path: dir, file: '../x.jar', targets: ['modrinth'], version: '1' }).catch((e: Error) => e.message)]);
      return { linked, status, result: done?.result, error: done?.error, sent, errors };
    };
    const n = await run((m, p) => node.call(m, p, 'ui').then((r) => JSON.parse(JSON.stringify(r ?? null))), async (id) => node.s.ops.wait(id, 20000));
    const r = await run((m, p) => rust.call(m, p, 'ui'), (id) => rust.waitOperation(id));
    const strip = (x: typeof n) => ({ ...x, result: JSON.parse(JSON.stringify(x.result).replace(/VER\d+/g, 'VER').replace(/50000\d\d/g, 'CF')), sent: x.sent.map((s) => ({ ...s, body: s.body.replace(/VER\d+/g, 'VER') })) });
    expect(strip(r)).toEqual(strip(n));
    expect(n.result).toMatchObject({ results: [{ provider: 'modrinth', ok: true }, { provider: 'curseforge', ok: false, error: 'CurseForge does not list the Quilt loader' }] });
  });
});
