import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { validateManifest, writeManifest, readManifest, LockFileSchema, ModRefSchema, defaultProfiles } from '../src/core/manifest';
import { tmpDir } from './helpers';

const base = {
  schemaVersion: 1,
  name: 'Test',
  type: 'mod',
  modId: 'testmod',
  platform: { loader: 'fabric', minecraft: '1.21.1', loaderVersion: '0.19.5', catalogEntry: 'fabric-1.21.1' },
  profiles: [{ id: 'dev-client', name: 'Dev', side: 'client' }]
};

describe('project manifest', () => {
  it('accepts a minimal manifest and applies defaults', () => {
    const r = validateManifest(base);
    expect(r.errors).toEqual([]);
    expect(r.manifest!.profiles[0].jvm.memoryMb).toBe(4096);
    expect(r.manifest!.profiles[0].bridge).toBe(true);
    expect(r.manifest!.source.kind).toBe('gradle');
  });

  it('rejects unknown schema versions and bad identifiers', () => {
    expect(validateManifest({ ...base, schemaVersion: 2 }).manifest).toBeNull();
    expect(validateManifest({ ...base, modId: 'Bad-Id' }).errors.join()).toMatch(/modId/);
    expect(validateManifest({ ...base, profiles: [{ id: 'Has Space', name: 'x', side: 'client' }] }).manifest).toBeNull();
  });

  it('rejects duplicate profile ids', () => {
    const r = validateManifest({ ...base, profiles: [base.profiles[0], base.profiles[0]] });
    expect(r.manifest).toBeNull();
    expect(r.errors[0]).toMatch(/duplicate profile id/);
  });

  it('round-trips through disk atomically', () => {
    const dir = tmpDir();
    writeManifest(dir, validateManifest(base).manifest!);
    expect(fs.readdirSync(dir)).toEqual(['modsmith.json']);
    expect(readManifest(dir).manifest!.name).toBe('Test');
  });

  it('reports invalid JSON instead of throwing', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'modsmith.json'), '{ nope');
    expect(readManifest(dir).errors[0]).toMatch(/not valid JSON/);
  });

  it('validates mod reference variants', () => {
    expect(ModRefSchema.parse({ source: 'curseforge', projectId: 238222, fileId: 5000 })).toMatchObject({ projectId: '238222', fileId: '5000', usage: 'runtime' });
    expect(() => ModRefSchema.parse({ source: 'curseforge', projectId: 'jei' })).toThrow();
    expect(() => ModRefSchema.parse({ source: 'maven', coordinates: 'not-a-coordinate' })).toThrow();
    expect(ModRefSchema.parse({ source: 'modrinth', projectId: 'P7dR8mSH' }).usage).toBe('runtime');
  });

  it('builds default client and server profiles', () => {
    expect(defaultProfiles('both').map((p) => p.id)).toEqual(['dev-client', 'dev-server']);
    expect(defaultProfiles('client').map((p) => p.side)).toEqual(['client']);
  });

  it('validates lock files', () => {
    expect(() => LockFileSchema.parse({ schemaVersion: 1, profiles: { a: { resolvedAt: 'x', minecraft: '1.21.1', loader: 'fabric', loaderVersion: '0.19.5', entries: [{ key: 'k', provider: 'nope', title: 't', fileName: 'f', reason: 'r', required: true }] } } })).toThrow();
  });
});
