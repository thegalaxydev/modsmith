import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { parsePackArchive } from '../src/core/packimport';
import { readManifest, writeManifest } from '../src/core/manifest';
import type { ModrinthVersion } from '../src/core/modrinth';
import { jarBytes, tmpDir } from './helpers';
import { createService } from './service';
import type { OperationInfo } from '../src/shared/types';

const svc = createService();
afterAll(() => svc.stop());

function cfZip(dir: string, opts: { minecraft?: string; loader?: string; name?: string } = {}): string {
  const file = path.join(dir, `${opts.name ?? 'pack'}.zip`);
  const manifest = {
    minecraft: { version: opts.minecraft ?? '1.21.1', modLoaders: [{ id: opts.loader ?? 'fabric-0.16.10', primary: true }] },
    manifestType: 'minecraftModpack',
    manifestVersion: 1,
    name: opts.name ?? 'Cozy Pack',
    version: '2.0',
    files: [
      { projectID: 238222, fileID: 5000001, required: true },
      { projectID: 306612, fileID: 5000002, required: true }
    ],
    overrides: 'overrides'
  };
  fs.writeFileSync(
    file,
    zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest)),
      'overrides/config/jei/jei-client.ini': strToU8('[appearance]\n'),
      'overrides/kubejs/startup_scripts/main.js': strToU8('console.log(1)\n'),
      'overrides/resourcepacks/Cozy Textures.zip': strToU8('zip'),
      'overrides/options.txt': strToU8('guiScale:2\n'),
      'overrides/mods/bundled-helper.jar': jarBytes({ id: 'bundledhelper' })
    })
  );
  return file;
}

async function project(): Promise<string> {
  const dir = tmpDir();
  await svc.call('workspace.init', { path: dir, type: 'modpack', minecraft: '1.21.1', loaderVersion: '0.19.5' }, 'ui');
  return fs.realpathSync.native(dir);
}

async function importPack(dir: string, params: Record<string, unknown>) {
  const op = (await svc.call('profile.import_pack', { path: dir, ...params }, 'mcp')) as OperationInfo;
  const done = await svc.waitOperation(op.id);
  if (done?.status !== 'succeeded') throw new Error(done?.error ?? 'import did not finish');
  return done.result as { profile: string; added: number; replaced: number; skipped: string[]; overrides: number; warnings: string[] };
}

describe('importing a modpack into a test profile', () => {
  it('parses Modrinth packs with client overrides and side-specific files', () => {
    const index = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: '1.4',
      name: 'Fresh Pack',
      dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.10' },
      files: [
        { path: 'mods/a.jar', hashes: { sha1: 'AA', sha512: 'x' }, downloads: ['https://cdn.modrinth.com/a.jar'], fileSize: 1, env: { client: 'required', server: 'unsupported' } },
        { path: 'mods/b.jar', hashes: { sha1: 'bb', sha512: 'y' }, downloads: ['https://cdn.modrinth.com/b.jar'], fileSize: 1, env: { client: 'unsupported', server: 'required' } }
      ]
    };
    const bytes = zipSync({ 'modrinth.index.json': strToU8(JSON.stringify(index)), 'overrides/config/a.toml': strToU8('a'), 'client-overrides/config/a.toml': strToU8('client'), 'server-overrides/config/s.toml': strToU8('s') });
    const pack = parsePackArchive(bytes, 'client');
    expect(pack).toMatchObject({ format: 'mrpack', name: 'Fresh Pack', version: '1.4', minecraft: '1.21.1', loader: 'fabric', loaderVersion: '0.16.10' });
    expect(pack.mrFiles.map((f) => [f.path, f.sha1, f.environment, f.supported])).toEqual([
      ['mods/a.jar', 'aa', 'client', true],
      ['mods/b.jar', 'bb', 'server', false]
    ]);
    expect(Object.keys(pack.overrides).sort()).toEqual(['config/a.toml']);
    expect(new TextDecoder().decode(pack.overrides['config/a.toml'])).toBe('client');
    expect(Object.keys(parsePackArchive(bytes, 'server').overrides).sort()).toEqual(['config/a.toml', 'config/s.toml']);
  });

  it('adds CurseForge pack mods and overrides to a new profile, re-imports and removes them', async () => {
    const dir = await project();
    const file = cfZip(tmpDir());
    const r = await importPack(dir, { profile: 'cozy', name: 'Cozy test', file });
    expect(r).toMatchObject({ profile: 'cozy', added: 3, replaced: 0 });
    expect(r.warnings.some((w) => /CurseForge API key/.test(w))).toBe(true);
    let profile = readManifest(dir).manifest!.profiles.find((p) => p.id === 'cozy')!;
    expect(profile.name).toBe('Cozy test');
    expect(profile.mods.map((m) => [m.source, m.source === 'local' ? m.path : m.source === 'maven' ? m.coordinates : m.projectId, m.from])).toEqual([
      ['curseforge', '238222', 'Cozy Pack'],
      ['curseforge', '306612', 'Cozy Pack'],
      ['local', 'profiles/cozy/packs/cozy-pack/mods/bundled-helper.jar', 'Cozy Pack']
    ]);
    expect(profile.configDir).toBe('profiles/cozy/packs/cozy-pack/config');
    expect([...profile.scripts].sort()).toEqual(['profiles/cozy/packs/cozy-pack/kubejs', 'profiles/cozy/packs/cozy-pack/options.txt']);
    expect(profile.resourcePacks).toEqual(['profiles/cozy/packs/cozy-pack/resourcepacks/Cozy Textures.zip']);
    expect(profile.imports).toMatchObject([{ name: 'Cozy Pack', provider: 'file', versionName: '2.0', overrides: 'profiles/cozy/packs/cozy-pack' }]);
    expect(fs.existsSync(path.join(dir, 'profiles/cozy/packs/cozy-pack/config/jei/jei-client.ini'))).toBe(true);

    const again = await importPack(dir, { profile: 'cozy', file });
    expect(again).toMatchObject({ added: 3, replaced: 3 });
    profile = readManifest(dir).manifest!.profiles.find((p) => p.id === 'cozy')!;
    expect(profile.mods).toHaveLength(3);
    expect(profile.imports).toHaveLength(1);

    const removed = (await svc.call('profile.remove_pack', { path: dir, profile: 'cozy', pack: 'Cozy Pack' }, 'ui')) as { removed: number };
    expect(removed.removed).toBe(3);
    profile = readManifest(dir).manifest!.profiles.find((p) => p.id === 'cozy')!;
    expect(profile.mods).toEqual([]);
    expect(profile.imports).toEqual([]);
    expect(profile.configDir).toBeUndefined();
    expect(profile.scripts).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'profiles/cozy/packs/cozy-pack/config'))).toBe(true);
  });

  it('keeps mods the profile already has and refuses packs for another game version or loader', async () => {
    const dir = await project();
    const manifest = readManifest(dir).manifest!;
    manifest.profiles[0].mods.push({ source: 'curseforge', projectId: '238222', title: 'JEI', required: true, usage: 'runtime', environment: 'both' });
    writeManifest(dir, manifest);
    const id = manifest.profiles[0].id;
    const r = await importPack(dir, { profile: id, file: cfZip(tmpDir()) });
    expect(r.added).toBe(2);
    expect(r.skipped).toEqual(['JEI is already in the profile']);
    await expect(importPack(dir, { profile: id, file: cfZip(tmpDir(), { minecraft: '1.20.1', loader: 'forge-47.3.0' }) })).rejects.toThrow(/Minecraft 1\.20\.1/);
    await expect(importPack(dir, { profile: id, file: cfZip(tmpDir(), { loader: 'neoforge-21.1.77' }) })).rejects.toThrow(/uses neoforge/);
  });

  it.skipIf(!svc.workbench)('identifies Modrinth pack mods by hash and pins their versions', async () => {
    const dir = await project();
    const index = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: '3.1',
      name: 'Hash Pack',
      dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.10' },
      files: [
        { path: 'mods/sodium.jar', hashes: { sha1: '1111', sha512: 'x' }, downloads: ['https://cdn.modrinth.com/s.jar'], fileSize: 1, env: { client: 'required', server: 'unsupported' } },
        { path: 'mods/lithium.jar', hashes: { sha1: '2222', sha512: 'y' }, downloads: ['https://cdn.modrinth.com/l.jar'], fileSize: 1 }
      ]
    };
    const file = path.join(tmpDir(), 'hash.mrpack');
    fs.writeFileSync(file, zipSync({ 'modrinth.index.json': strToU8(JSON.stringify(index)) }));
    const mr = svc.workbench!.s.modrinth as unknown as Record<string, unknown>;
    let asked: string[] = [];
    mr.versionsFromHashes = async (hashes: string[]) => {
      asked = hashes;
      return { '1111': { id: 'v-sodium', project_id: 'AANobbMI' }, '2222': { id: 'v-lithium', project_id: 'gvQqBUqZ' } } as unknown as Record<string, ModrinthVersion>;
    };
    mr.projects = async () => [
      { id: 'AANobbMI', title: 'Sodium' },
      { id: 'gvQqBUqZ', title: 'Lithium' }
    ];
    const r = await importPack(dir, { profile: 'hash', file });
    expect(asked).toEqual(['1111', '2222']);
    expect(r.added).toBe(2);
    const profile = readManifest(dir).manifest!.profiles.find((p) => p.id === 'hash')!;
    expect(profile.mods).toMatchObject([
      { source: 'modrinth', projectId: 'AANobbMI', versionId: 'v-sodium', title: 'Sodium', environment: 'client', from: 'Hash Pack' },
      { source: 'modrinth', projectId: 'gvQqBUqZ', versionId: 'v-lithium', title: 'Lithium', environment: 'both', from: 'Hash Pack' }
    ]);
  });
});
