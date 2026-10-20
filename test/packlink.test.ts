import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { detectPackFolder, parseLoader, readLinks, selectPackJars } from '../src/core/packlink';
import { readLock } from '../src/core/manifest';
import { fakeModJar, jarBytes, tmpDir } from './helpers';
import { createService } from './service';
import type { OperationInfo } from '../src/shared/types';

const svc = createService();
afterAll(() => svc.stop());

function curseforgeInstance(opts: { minecraft?: string; loader?: string } = {}): string {
  const dir = path.join(tmpDir(), 'All the Things');
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'sodium.json'), '{"from":"pack"}');
  fs.writeFileSync(path.join(dir, 'minecraftinstance.json'), JSON.stringify({ name: 'All the Things', gameVersion: opts.minecraft ?? '1.21.1', baseModLoader: { name: opts.loader ?? 'fabric-0.16.10-1.21.1', minecraftVersion: opts.minecraft ?? '1.21.1' } }));
  fakeModJar(path.join(dir, 'mods'), 'packlib-1.0.jar', { id: 'packlib', depends: { minecraft: '*' } });
  fakeModJar(path.join(dir, 'mods'), 'shiny-client-2.0.jar', { id: 'shiny', environment: 'client' });
  fakeModJar(path.join(dir, 'mods'), 'mymod-0.9.jar', { id: 'mymod' });
  fs.writeFileSync(path.join(dir, 'mods', 'old-thing.jar.disabled'), 'x');
  return dir;
}

describe('linked modpack folders', () => {
  it('reads CurseForge app instances', () => {
    const pack = detectPackFolder(curseforgeInstance());
    expect(pack.kind).toBe('curseforge');
    expect(pack.name).toBe('All the Things');
    expect(pack.minecraft).toBe('1.21.1');
    expect(pack.loader).toBe('fabric');
    expect(pack.jars.map((j) => j.name)).toEqual(['mymod-0.9.jar', 'packlib-1.0.jar', 'shiny-client-2.0.jar']);
    expect(pack.disabledJars).toBe(1);
    expect(pack.configDirs.map((d) => path.basename(d))).toEqual(['config']);
  });

  it('accepts the mods folder itself and reads Prism instances', () => {
    expect(detectPackFolder(path.join(curseforgeInstance(), 'mods')).kind).toBe('curseforge');
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'instance.cfg'), 'InstanceType=OneSix\nname=Prism Pack\n');
    fs.writeFileSync(path.join(dir, 'mmc-pack.json'), JSON.stringify({ components: [{ uid: 'net.minecraft', version: '1.21.1' }, { uid: 'net.neoforged', version: '21.1.77' }] }));
    fs.mkdirSync(path.join(dir, '.minecraft', 'mods'), { recursive: true });
    fakeModJar(path.join(dir, '.minecraft', 'mods'), 'a.jar', { id: 'a' });
    const pack = detectPackFolder(dir);
    expect(pack).toMatchObject({ kind: 'prism', name: 'Prism Pack', minecraft: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.77' });
    expect(pack.jars).toHaveLength(1);
  });

  it('parses loader names from launchers', () => {
    expect(parseLoader('neoforge-21.1.77')).toEqual({ loader: 'neoforge', version: '21.1.77' });
    expect(parseLoader('fabric-0.16.10-1.21.1')).toEqual({ loader: 'fabric', version: '0.16.10-1.21.1' });
    expect(parseLoader('Fabric')).toEqual({ loader: 'fabric', version: undefined });
    expect(parseLoader(undefined)).toEqual({});
  });

  it('keeps mods that only bundle a library the development build also has', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'mods'));
    fakeModJar(path.join(dir, 'mods'), 'sodium.jar', { id: 'sodium' }, { 'fabric-api-base.jar': jarBytes({ id: 'fabric-api-base' }) });
    const sel = selectPackJars(detectPackFolder(dir), { side: 'client', replacedIds: ['fabric-api-base', 'fabric-api'] });
    expect(sel.use.map((j) => j.name)).toEqual(['sodium.jar']);
  });

  it('replaces the pack copy of the project mod and drops client-only mods on servers', () => {
    const pack = detectPackFolder(curseforgeInstance());
    const client = selectPackJars(pack, { side: 'client', replacedIds: ['mymod'] });
    expect(client.use.map((j) => j.name)).toEqual(['packlib-1.0.jar', 'shiny-client-2.0.jar']);
    expect(client.skipped[0]).toMatchObject({ name: 'mymod-0.9.jar' });
    const server = selectPackJars(pack, { side: 'server', replacedIds: [] });
    expect(server.use.map((j) => j.name)).toEqual(['mymod-0.9.jar', 'packlib-1.0.jar']);
  });

  it('links, loads on resolve, rejects mismatches and unlinks', async () => {
    const project = tmpDir();
    await svc.call('workspace.init', { path: project, type: 'modpack', minecraft: '1.21.1', loaderVersion: '0.19.5' }, 'ui');
    const packDir = curseforgeInstance();
    const linked = (await svc.call('profile.link_pack', { path: project, profile: 'dev-client', folder: packDir }, 'mcp')) as { name: string; mods: number; enabled: boolean; configs: boolean };
    expect(linked).toMatchObject({ name: 'All the Things', mods: 3, enabled: true, configs: true });
    expect(fs.readFileSync(path.join(project, '.gitignore'), 'utf8')).toContain('.modsmith/');
    expect(Object.keys(readLinks(fs.realpathSync.native(project)))).toEqual(['dev-client']);
    await expect(svc.call('profile.link_pack', { path: project, profile: 'dev-client', folder: curseforgeInstance({ minecraft: '1.20.1', loader: 'forge-47.3.0' }) }, 'ui')).rejects.toThrow(/Minecraft 1\.20\.1.*forge/);
    const op = (await svc.call('profile.resolve', { path: project, id: 'dev-client' }, 'ui')) as OperationInfo;
    const done = await svc.waitOperation(op.id);
    expect(done?.status).toBe('succeeded');
    const entries = readLock(fs.realpathSync.native(project)).profiles['dev-client'].entries;
    expect(entries.filter((e) => e.reason === 'linked pack All the Things').map((e) => e.fileName).sort()).toEqual(['mymod-0.9.jar', 'packlib-1.0.jar', 'shiny-client-2.0.jar']);
    await svc.call('profile.link_pack', { path: project, profile: 'dev-client', folder: packDir, enabled: false }, 'ui');
    const list = (await svc.call('profile.linked_packs', { path: project, profile: 'dev-client' }, 'ui')) as { enabled: boolean; configs: boolean }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ enabled: false, configs: true });
    await svc.call('profile.unlink_pack', { path: project, profile: 'dev-client', folder: packDir }, 'ui');
    expect(readLinks(fs.realpathSync.native(project))).toEqual({});
    expect(fs.readdirSync(path.join(packDir, 'mods')).sort()).toEqual(['mymod-0.9.jar', 'old-thing.jar.disabled', 'packlib-1.0.jar', 'shiny-client-2.0.jar']);
  });
});
