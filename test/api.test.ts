import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { API, mcpToolName } from '../src/shared/api';
import { cfToVersion, cfToProject, pickCfFile, cfDistributable, cfFilePage, type CfFile, type CfMod } from '../src/core/curseforge';
import { SecretStore } from '../src/core/secrets';
import { tmpDir } from './helpers';
import { createService } from './service';
import type { OperationInfo } from '../src/shared/types';

const svc = createService();
afterAll(() => svc.stop());

describe('API definitions', () => {
  it('produce MCP tool names valid for Claude clients', () => {
    for (const [name, def] of Object.entries(API)) {
      if (!def.mcp) continue;
      expect(mcpToolName(name)).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });

  it('marks destructive tools and keeps secrets out of MCP', () => {
    for (const [name, def] of Object.entries(API)) {
      if (def.destructive) expect(def.params.shape).toHaveProperty('confirm');
      if (name.startsWith('provider.set') || name.startsWith('provider.clear')) expect(def.mcp).toBe(false);
    }
  });
});

describe('activity records', () => {
  type Entry = { id: number; ts: number; source: string; action: string; params: string; status: string; summary: string };

  it('stores normalized parameters and a summary of the result for mutating calls', async () => {
    const dir = tmpDir();
    await svc.call('workspace.trust', { path: dir, trusted: false, extra: 1 }, 'ui');
    const [entry] = await svc.call<Entry[]>('activity.list', { limit: 1, source: 'ui' }, 'ui');
    expect(entry).toMatchObject({ source: 'ui', action: 'workspace.trust', params: JSON.stringify({ path: dir, trusted: false }), status: 'ok', summary: '{path, name, exists, trusted, manifest, manifestErrors}' });
    expect(Object.keys(entry)).toEqual(['id', 'ts', 'source', 'action', 'params', 'status', 'summary']);
    const recent = await svc.call<Entry[]>('activity.list', { limit: 2 }, 'ui');
    expect(recent[1]?.params === entry.params && recent[1]?.action === entry.action).toBe(false);
  });

  it('redacts secrets in recorded parameters and records failures with their message', async () => {
    const home = path.join(tmpDir(), 'jdk token=abcdefgh123');
    await expect(svc.call('java.add', { home }, 'cli')).rejects.toThrow(/No Java runtime/);
    const [entry] = await svc.call<Entry[]>('activity.list', { limit: 1, source: 'cli' }, 'ui');
    expect(entry.params).toBe(JSON.stringify({ home: home.replace('abcdefgh123', '[redacted]') }));
    expect(entry).toMatchObject({ action: 'java.add', status: 'error', summary: `No Java runtime found at ${home}` });
    await expect(svc.call('profile.update', { path: 5, id: 'x', patch: { apiKey: 'k' } }, 'mcp')).rejects.toThrow(/Invalid parameters/);
    const [bad] = await svc.call<Entry[]>('activity.list', { limit: 1, source: 'mcp' }, 'ui');
    expect(bad).toMatchObject({ action: 'profile.update', status: 'error', params: '{"path":5,"id":"x","patch":{"apiKey":"[redacted]"}}' });
  });

  it('records reads only for MCP and skips polling methods', async () => {
    const before = (await svc.call<Entry[]>('activity.list', { limit: 1 }, 'ui'))[0]?.id ?? 0;
    await svc.call('workspace.list', {}, 'ui');
    await svc.call('activity.list', { limit: 1 }, 'cli');
    expect((await svc.call<Entry[]>('activity.list', { limit: 1 }, 'ui'))[0]?.id ?? 0).toBe(before);
    const list = await svc.call<unknown[]>('workspace.list', {}, 'mcp');
    const [entry] = await svc.call<Entry[]>('activity.list', { limit: 1 }, 'ui');
    expect(entry).toMatchObject({ action: 'workspace.list', source: 'mcp', params: '{}', summary: `${list.length} items` });
  });
});

describe('service dispatch', () => {
  it('validates arguments before dispatch and records the failure', async () => {
    await expect(svc.call('workspace.inspect', {}, 'mcp')).rejects.toThrow(/Invalid parameters for workspace.inspect/);
    await expect(svc.call('nope.method', {}, 'mcp')).rejects.toThrow(/Unknown method/);
    const act = await svc.call<{ status: string }[]>('activity.list', { limit: 5, source: 'mcp' }, 'ui');
    expect(act[0].status).toBe('error');
  });

  it('dispatches to real services and records MCP activity', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'build.gradle'), "plugins { id 'net.fabricmc.fabric-loom-remap' }");
    const r = (await svc.call('workspace.inspect', { path: dir }, 'mcp')) as { detected: { loader: string }; trusted: boolean };
    expect(r.detected.loader).toBe('fabric');
    expect(r.trusted).toBe(false);
    expect((await svc.call<{ action: string }[]>('activity.list', { limit: 1, source: 'mcp' }, 'ui'))[0].action).toBe('workspace.inspect');
  });

  it('refuses builds in untrusted workspaces', async () => {
    const dir = tmpDir();
    await expect(svc.call('project.build', { path: dir }, 'mcp')).rejects.toThrow(/not trusted/);
  });

  it('scopes file access to the workspace', async () => {
    const dir = tmpDir();
    await expect(svc.call('workspace.read_file', { path: dir, file: '../../etc/passwd' }, 'mcp')).rejects.toThrow(/outside the workspace/);
    await expect(svc.call('workspace.delete_file', { path: dir, file: 'x', confirm: false }, 'mcp')).rejects.toThrow(/destructive/);
  });

  it('requires explicit EULA acceptance', async () => {
    const dir = tmpDir();
    await svc.call('workspace.init', { path: dir, type: 'modpack', minecraft: '1.21.1', loaderVersion: '0.19.5' }, 'ui');
    await expect(svc.call('instance.accept_eula', { path: dir, profile: 'dev-client', accept: true }, 'mcp')).rejects.toThrow(/only needed for server/);
    await svc.call('profile.create', { path: dir, profile: { id: 'srv', name: 'srv', side: 'server' } }, 'ui');
    await expect(svc.call('instance.accept_eula', { path: dir, profile: 'srv', accept: false }, 'mcp')).rejects.toThrow(/accept: true/);
    expect(((await svc.call('instance.eula_status', { path: dir, profile: 'srv' }, 'mcp')) as { accepted: boolean }).accepted).toBe(false);
  });

  it('reports CurseForge as unconfigured without a key', async () => {
    const s = (await svc.call('provider.status', {}, 'ui')) as { providers: { id: string; usable: boolean }[] };
    expect(s.providers.find((p) => p.id === 'curseforge')!.usable).toBe(false);
    await expect(svc.call('dependency.search', { query: 'jei', provider: 'curseforge' }, 'ui')).rejects.toThrow(/API key/);
  });

  it('imports a CurseForge modpack manifest and exports it again', async () => {
    const src = tmpDir();
    const zip = path.join(src, 'pack.zip');
    fs.writeFileSync(
      zip,
      zipSync({
        'manifest.json': strToU8(JSON.stringify({ minecraft: { version: '1.21.1', modLoaders: [{ id: 'fabric-0.19.5', primary: true }] }, manifestType: 'minecraftModpack', manifestVersion: 1, name: 'Test Pack', version: '1', author: 'x', files: [{ projectID: 238222, fileID: 5101366, required: true }], overrides: 'overrides' })),
        'overrides/config/test.json': strToU8('{"a":1}')
      })
    );
    const dest = path.join(tmpDir(), 'pack');
    const op = (await svc.call('modpack.import_curseforge', { file: zip, destination: dest }, 'ui')) as OperationInfo;
    const done = await svc.waitOperation(op.id);
    expect(done!.status).toBe('succeeded');
    const m = JSON.parse(fs.readFileSync(path.join(dest, 'modsmith.json'), 'utf8'));
    expect(m.type).toBe('modpack');
    expect(m.profiles[0].mods[0]).toMatchObject({ source: 'curseforge', projectId: '238222', fileId: '5101366' });
    expect(fs.existsSync(path.join(dest, 'profiles/pack/overrides/config/test.json'))).toBe(true);
    await expect(svc.call('modpack.export_curseforge', { path: dest, profile: 'pack-client', output: path.join(src, 'out.zip') }, 'ui')).rejects.toThrow(/Resolve profile/);
  });
});

describe('CurseForge mapping', () => {
  const mod: CfMod = { id: 1, slug: 'x', name: 'X', summary: '', downloadCount: 1, allowModDistribution: true, links: { websiteUrl: 'https://www.curseforge.com/minecraft/mc-mods/x' } };
  const file = (id: number, extra: Partial<CfFile> = {}): CfFile => ({ id, modId: 1, displayName: `x-${id}`, fileName: `x-${id}.jar`, releaseType: 1, fileDate: `2026-01-0${id}T00:00:00Z`, fileLength: 10, downloadUrl: 'https://edge.forgecdn.net/x.jar', hashes: [{ value: 'abc', algo: 2 }, { value: 'f'.repeat(40), algo: 1 }], gameVersions: ['1.21.1', 'Fabric', 'Client', 'Server'], dependencies: [{ modId: 2, relationType: 3 }, { modId: 3, relationType: 2 }, { modId: 4, relationType: 5 }, { modId: 5, relationType: 6 }, { modId: 6, relationType: 4 }], ...extra });

  it('maps files to the common version shape', () => {
    const v = cfToVersion(file(1));
    expect(v.loaders).toEqual(['fabric']);
    expect(v.game_versions).toEqual(['1.21.1']);
    expect(v.files[0].hashes.sha1).toBe('f'.repeat(40));
    expect(v.dependencies.map((d) => d.dependency_type)).toEqual(['required', 'optional', 'incompatible', 'embedded']);
  });

  it('derives sides from file tags', () => {
    expect(cfToProject(mod, file(1, { gameVersions: ['1.21.1', 'Fabric', 'Client'] })).server_side).toBe('unsupported');
    expect(cfToProject(mod).client_side).toBe('unknown');
  });

  it('picks the newest release for the loader and version', () => {
    const files = [file(1), file(2, { releaseType: 2 }), file(3, { gameVersions: ['1.21.1', 'Forge'] }), file(4)];
    expect(pickCfFile(files, 'fabric', '1.21.1')!.id).toBe(4);
    expect(pickCfFile(files, 'fabric', '1.20.1')).toBeNull();
  });

  it('respects distribution permissions', () => {
    expect(cfDistributable(mod, file(1))).toBe(true);
    expect(cfDistributable({ ...mod, allowModDistribution: false }, file(1))).toBe(false);
    expect(cfDistributable(mod, file(1, { downloadUrl: null }))).toBe(false);
    expect(cfFilePage(mod, file(7))).toBe('https://www.curseforge.com/minecraft/mc-mods/x/files/7');
  });
});

describe.runIf(process.platform === 'win32')('OS secret storage', () => {
  it('round-trips values through DPAPI without storing plaintext', () => {
    const file = path.join(tmpDir(), 'secrets.json');
    const s = new SecretStore(file);
    s.set('test.value', 'not-a-real-key-123456');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('not-a-real-key');
    expect(s.get('test.value')).toBe('not-a-real-key-123456');
    s.delete('test.value');
    expect(s.has('test.value')).toBe(false);
  });
});
