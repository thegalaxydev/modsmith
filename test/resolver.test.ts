import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProfile, type ResolverProvider, type ResolvedVersion } from '../src/core/resolver';
import { readJarMetadata } from '../src/core/jarmeta';
import type { ModrinthProject } from '../src/core/modrinth';
import type { ModRef } from '../src/core/manifest';
import { fakeModJar, jarBytes, tmpDir } from './helpers';

interface FakeMod {
  id: string;
  title: string;
  modId: string;
  deps?: { id: string; type: 'required' | 'optional' | 'incompatible' }[];
  client?: string;
  server?: string;
  loaders?: string[];
  fmj?: Record<string, unknown>;
  manual?: boolean;
}

function fakeProvider(mods: FakeMod[], dir: string): ResolverProvider {
  const project = async (id: string): Promise<ModrinthProject> => {
    const m = mods.find((x) => x.id === id);
    if (!m) throw new Error(`404 ${id}`);
    return { id: m.id, slug: m.id, title: m.title, description: '', client_side: m.client ?? 'required', server_side: m.server ?? 'required', project_type: 'mod' };
  };
  const version = (m: FakeMod): ResolvedVersion => {
    const bytes = jarBytes({ id: m.modId, ...(m.fmj ?? {}) });
    const sha1 = crypto.createHash('sha1').update(bytes).digest('hex');
    fs.writeFileSync(path.join(dir, `${sha1}.jar`), bytes);
    return {
      id: `v-${m.id}`,
      project_id: m.id,
      name: '1.0',
      version_number: '1.0',
      version_type: 'release',
      loaders: m.loaders ?? ['fabric'],
      game_versions: ['1.21.1'],
      date_published: '2026-01-01',
      dependencies: (m.deps ?? []).map((d) => ({ version_id: null, project_id: d.id, file_name: null, dependency_type: d.type })),
      files: [{ hashes: { sha1, sha512: '' }, url: m.manual ? '' : `https://example.invalid/${m.id}.jar`, filename: `${m.id}.jar`, primary: true, size: bytes.length }],
      distribution: m.manual ? 'manual' : 'direct',
      manualUrl: m.manual ? `https://example.invalid/${m.id}/files` : undefined
    };
  };
  const api = {
    project,
    versions: async (id: string) => [version(mods.find((x) => x.id === id)!)],
    version: async (vid: string) => version(mods.find((x) => `v-${x.id}` === vid)!)
  };
  return {
    providers: { modrinth: api, curseforge: api },
    fetchFile: async (e) => {
      if (e.distribution === 'manual') throw new Error('manual download required');
      return path.join(dir, `${e.sha1}.jar`);
    },
    readMetadata: (f) => readJarMetadata(f),
    hashLocal: async (f) => {
      const b = fs.readFileSync(f);
      return { sha1: crypto.createHash('sha1').update(b).digest('hex'), sha512: crypto.createHash('sha512').update(b).digest('hex'), size: b.length };
    }
  };
}

const ref = (projectId: string, extra: Partial<ModRef> = {}): { ref: ModRef; reason: string } => ({ ref: { source: 'modrinth', projectId, required: true, usage: 'runtime', environment: 'both', ...extra } as ModRef, reason: 'profile' });

const input = (refs: { ref: ModRef; reason: string }[], extra: Record<string, unknown> = {}) => ({ loader: 'fabric', minecraft: '1.21.1', side: 'client' as const, refs, providedModIds: [], providedModrinthProjects: {}, baseDir: tmpDir(), ...extra });

describe('dependency resolution', () => {
  it('follows required dependencies and records optional ones', async () => {
    const dir = tmpDir();
    const r = await resolveProfile(input([ref('a')]), fakeProvider([{ id: 'a', title: 'A', modId: 'a', deps: [{ id: 'b', type: 'required' }, { id: 'c', type: 'optional' }] }, { id: 'b', title: 'B', modId: 'b' }, { id: 'c', title: 'C', modId: 'c' }], dir));
    expect(r.entries.map((e) => e.title)).toEqual(['A', 'B']);
    expect(r.entries[1].reason).toBe('required by A');
    expect(r.optionalSuggestions).toEqual([{ projectId: 'c', provider: 'modrinth', requestedBy: 'A' }]);
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('reports declared incompatibilities', async () => {
    const r = await resolveProfile(input([ref('a'), ref('b')]), fakeProvider([{ id: 'a', title: 'A', modId: 'a', deps: [{ id: 'b', type: 'incompatible' }] }, { id: 'b', title: 'B', modId: 'b' }], tmpDir()));
    expect(r.issues.some((i) => i.severity === 'error' && /incompatible/.test(i.message))).toBe(true);
  });

  it('detects duplicate mod ids and duplicate files', async () => {
    const r = await resolveProfile(input([ref('a'), ref('b')]), fakeProvider([{ id: 'a', title: 'A', modId: 'same' }, { id: 'b', title: 'B', modId: 'same' }], tmpDir()));
    expect(r.issues.some((i) => /Duplicate mod ID "same"/.test(i.message))).toBe(true);
    expect(r.issues.some((i) => /included more than once/.test(i.message))).toBe(true);
  });

  it('flags mods that duplicate the development classpath', async () => {
    const r = await resolveProfile(input([ref('a')], { providedModIds: ['fabric-api'] }), fakeProvider([{ id: 'a', title: 'API copy', modId: 'fabric-api' }], tmpDir()));
    expect(r.issues.some((i) => /development classpath/.test(i.message))).toBe(true);
  });

  it('leaves a modpack copy of the development mod out instead of failing', async () => {
    const r = await resolveProfile(input([{ ...ref('a'), reason: 'pack Big Pack' }, ref('b')], { providedModIds: ['mymod'] }), fakeProvider([{ id: 'a', title: 'My Mod release', modId: 'mymod' }, { id: 'b', title: 'B', modId: 'b' }], tmpDir()));
    expect(r.entries.map((e) => e.title)).toEqual(['B']);
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(r.issues.some((i) => /My Mod release from the Big Pack pack not loaded/.test(i.message))).toBe(true);
  });

  it('skips Fabric API when the dev classpath provides it', async () => {
    const r = await resolveProfile(input([ref('a')], { providedModrinthProjects: { P7dR8mSH: 'Fabric API' } }), fakeProvider([{ id: 'a', title: 'A', modId: 'a', deps: [{ id: 'P7dR8mSH', type: 'required' }] }], tmpDir()));
    expect(r.entries.map((e) => e.title)).toEqual(['A']);
    expect(r.issues.some((i) => /already provided/.test(i.message))).toBe(true);
  });

  it('respects environment metadata for the profile side', async () => {
    const r = await resolveProfile(input([ref('a')], { side: 'server' }), fakeProvider([{ id: 'a', title: 'Shaders', modId: 'a', server: 'unsupported' }], tmpDir()));
    expect(r.entries).toEqual([]);
    expect(r.issues[0].message).toMatch(/unsupported on the server side/);
  });

  it('reports declared but missing metadata dependencies without evaluating ranges', async () => {
    const r = await resolveProfile(input([ref('a')]), fakeProvider([{ id: 'a', title: 'A', modId: 'a', fmj: { depends: { cloth_config: '>=15' } } }], tmpDir()));
    expect(r.issues.some((i) => i.severity === 'warning' && /cloth_config/.test(i.message))).toBe(true);
  });

  it('marks CurseForge files that need manual download', async () => {
    const r = await resolveProfile(input([{ ref: { source: 'curseforge', projectId: '123', required: true, usage: 'runtime', environment: 'both' }, reason: 'profile' }]), fakeProvider([{ id: '123', title: 'Restricted', modId: 'r', manual: true }], tmpDir()));
    expect(r.entries[0]).toMatchObject({ provider: 'curseforge', distribution: 'manual', key: 'curseforge:123' });
    expect(r.issues.some((i) => /does not allow third-party downloads/.test(i.message))).toBe(true);
    expect(r.issues.some((i) => i.severity === 'error' && /Manual file missing/.test(i.message))).toBe(true);
  });

  it('errors when a provider is not configured', async () => {
    const p = fakeProvider([], tmpDir());
    delete p.providers.curseforge;
    const r = await resolveProfile(input([{ ref: { source: 'curseforge', projectId: '5', required: true, usage: 'runtime', environment: 'both' }, reason: 'profile' }]), p);
    expect(r.issues[0]).toMatchObject({ severity: 'error' });
    expect(r.issues[0].message).toMatch(/not configured/);
  });

  it('reads local JARs including nested jar-in-jar mods', async () => {
    const dir = tmpDir();
    const jar = fakeModJar(dir, 'local.jar', { id: 'outer' }, { 'inner.jar': jarBytes({ id: 'inner' }) });
    const r = await resolveProfile(input([{ ref: { source: 'local', path: jar, required: true, usage: 'runtime', environment: 'both' }, reason: 'profile' }]), fakeProvider([], dir));
    expect(r.entries[0].modIds.sort()).toEqual(['inner', 'outer']);
  });
});
