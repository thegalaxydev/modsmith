import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createService } from './service';
import { tmpDir } from './helpers';

const svc = createService();
afterAll(() => svc.stop());
const call = (m: string, p: Record<string, unknown>) => svc.call(m, p, 'ui');

async function project() {
  const dir = tmpDir('mwb-profile-mods-');
  await call('workspace.init', { path: dir, type: 'modpack', minecraft: '1.21.1', loaderVersion: '0.19.5' });
  const file = path.join(dir, 'modsmith.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  m.profiles.find((p: { id: string }) => p.id === 'dev-client').mods = [
    { source: 'modrinth', projectId: 'u6dRKJwZ', slug: 'jei', title: 'Just Enough Items (JEI)', usage: 'runtime', required: true, environment: 'both' },
    { source: 'modrinth', projectId: 'nU0bVIaL', slug: 'jade', title: 'Jade', usage: 'runtime', required: true, environment: 'both' }
  ];
  m.dependencies = [{ source: 'modrinth', projectId: 'P7dR8mSH', slug: 'fabric-api', title: 'Fabric API', usage: 'runtime', required: true, environment: 'both' }];
  fs.writeFileSync(file, JSON.stringify(m, null, 2));
  return { dir, mods: () => JSON.parse(fs.readFileSync(file, 'utf8')).profiles.find((p: { id: string }) => p.id === 'dev-client').mods.map((r: { slug: string; enabled?: boolean }) => [r.slug, r.enabled !== false]) };
}

describe('profile mods by key', () => {
  it('toggles and removes a Modrinth mod by the key the Mods page sends', async () => {
    const { dir, mods } = await project();
    await call('dependency.set_enabled', { path: dir, profile: 'dev-client', key: 'modrinth:u6dRKJwZ', enabled: false });
    expect(mods()).toEqual([['jei', false], ['jade', true]]);
    await call('dependency.set_enabled', { path: dir, profile: 'dev-client', key: 'modrinth:jei', enabled: true });
    await call('dependency.set_enabled', { path: dir, profile: 'dev-client', key: 'nU0bVIaL', enabled: false });
    expect(mods()).toEqual([['jei', true], ['jade', false]]);
    await call('dependency.remove', { path: dir, profile: 'dev-client', key: 'modrinth:u6dRKJwZ' });
    expect(mods()).toEqual([['jade', false]]);
    await call('dependency.remove', { path: dir, profile: 'dev-client', key: 'jade' });
    expect(mods()).toEqual([]);
    await call('dependency.remove', { path: dir, key: 'modrinth:P7dR8mSH' });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'modsmith.json'), 'utf8')).dependencies).toEqual([]);
  });

  it('says so when the mod to remove is not there', async () => {
    const { dir } = await project();
    await expect(call('dependency.remove', { path: dir, profile: 'dev-client', key: 'modrinth:nothing' })).rejects.toThrow('modrinth:nothing is not in profile dev-client');
    await expect(call('dependency.remove', { path: dir, key: 'modrinth:u6dRKJwZ' })).rejects.toThrow('modrinth:u6dRKJwZ is not in the project dependencies');
    await expect(call('dependency.remove', { path: dir, profile: 'nope', key: 'jei' })).rejects.toThrow('Unknown profile nope');
  });
});
