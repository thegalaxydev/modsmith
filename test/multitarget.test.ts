import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers';
import { createService } from './service';
import type { OperationInfo } from '../src/shared/types';

const svc = createService();
afterAll(() => svc.stop());

type Target = { project: string; dir: string; loader: string; minecraft: string; loaderVersion?: string };
type Inspected = { detected: { targets?: Target[]; ambiguous: boolean }; manifest: { platform: { loader: string; minecraft: string; catalogEntry?: string }; source: { root: string; project?: string }; dependencies: unknown[] } };

const input = (dest: string, extra: Record<string, unknown>) => ({ projectName: 'Twin Mod', destination: dest, modId: 'twinmod', packageName: 'com.example.twinmod', author: 'Tester', description: 'One mod, two loaders', runInitialBuild: false, ...extra });
const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), 'utf8');

async function create(params: Record<string, unknown>) {
  const op = await svc.call<OperationInfo>('project.create', params, 'ui');
  const done = await svc.waitOperation(op.id, 60000);
  expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
  return done;
}

describe('multi-target project creation', () => {
  it('creates one Gradle subproject per target and selects the first', async () => {
    const dest = path.join(tmpDir(), 'twin');
    const done = await create(input(dest, { catalogEntryId: 'fabric-1.21.1', extraTargets: ['neoforge-1.21.1', 'forge-1.20.1'], starters: ['empty', 'item', 'profiles'] }));
    expect((done.result as { targets: unknown[] }).targets).toEqual([
      { catalogEntry: 'fabric-1.21.1', project: ':fabric-1.21.1' },
      { catalogEntry: 'neoforge-1.21.1', project: ':neoforge-1.21.1' },
      { catalogEntry: 'forge-1.20.1', project: ':forge-1.20.1' }
    ]);
    expect(read(dest, 'settings.gradle')).toContain("include 'fabric-1.21.1', 'neoforge-1.21.1', 'forge-1.20.1'");
    expect(read(dest, 'settings.gradle')).toContain("id 'org.gradle.toolchains.foojay-resolver-convention' version '1.0.0'");
    expect(read(dest, 'build.gradle')).toBe("plugins {\n\tid 'net.fabricmc.fabric-loom-remap' version '1.18-SNAPSHOT' apply false\n\tid 'net.neoforged.moddev' version '2.0.148' apply false\n\tid 'net.neoforged.moddev.legacyforge' version '2.0.148' apply false\n}\n\ntasks.named('wrapper', Wrapper).configure {\n\tdistributionType = Wrapper.DistributionType.BIN\n}\n");
    expect(read(dest, 'neoforge-1.21.1/build.gradle')).not.toContain("tasks.named('wrapper'");
    expect(read(dest, 'gradle.properties')).toBe('org.gradle.jvmargs=-Xmx3G\norg.gradle.parallel=true\n');
    expect(read(dest, 'gradle/wrapper/gradle-wrapper.properties')).toContain('gradle-9.7.1-bin.zip');
    const fabricBuild = read(dest, 'fabric-1.21.1/build.gradle');
    expect(fabricBuild).toContain("\tid 'net.fabricmc.fabric-loom-remap'\n");
    expect(fabricBuild).toContain('from(rootProject.file("LICENSE"))');
    expect(fabricBuild).toContain("srcDir rootProject.file('common/src/main/java')");
    expect(fabricBuild).toContain("archivesName = 'twinmod-fabric-1.21.1'");
    expect(read(dest, 'neoforge-1.21.1/build.gradle')).toContain("\tid 'net.neoforged.moddev'\n");
    expect(read(dest, 'fabric-1.21.1/gradle.properties')).not.toContain('org.gradle.');
    expect(read(dest, 'common/src/main/java/com/example/twinmod/TwinModCommon.java')).toContain('public static final String MOD_ID = "twinmod";');
    expect(fs.existsSync(path.join(dest, 'neoforge-1.21.1/src/main/java/com/example/twinmod/registry/ModItems.java'))).toBe(true);
    for (const f of ['fabric-1.21.1/settings.gradle', 'fabric-1.21.1/LICENSE', 'neoforge-1.21.1/README.md', 'forge-1.20.1/.gitignore']) expect(fs.existsSync(path.join(dest, f)), f).toBe(false);

    const r = await svc.call<Inspected>('workspace.inspect', { path: dest }, 'ui');
    expect(r.detected.targets?.map((t) => [t.project, t.dir, t.loader, t.minecraft])).toEqual([
      [':fabric-1.21.1', 'fabric-1.21.1', 'fabric', '1.21.1'],
      [':neoforge-1.21.1', 'neoforge-1.21.1', 'neoforge', '1.21.1'],
      [':forge-1.20.1', 'forge-1.20.1', 'forge', '1.20.1']
    ]);
    expect(r.manifest.source).toEqual({ kind: 'gradle', root: 'fabric-1.21.1', project: ':fabric-1.21.1' });
    expect(r.manifest.platform.catalogEntry).toBe('fabric-1.21.1');
    const n = await svc.call<Inspected['manifest']>('project.select_target', { path: dest, project: ':neoforge-1.21.1' }, 'ui');
    expect(n.platform.catalogEntry).toBe('neoforge-1.21.1');
    await svc.call('project.select_target', { path: dest, project: ':forge-1.20.1' }, 'ui');
    const v = await svc.call<{ problems: { message: string }[] }>('project.validate', { path: dest }, 'ui');
    expect(v.problems.filter((p) => p.message.includes('declares Minecraft'))).toEqual([]);
  }, 90000);

  it('gives each target only the starters it supports', async () => {
    const dest = path.join(tmpDir(), 'mixed');
    await create(input(dest, { catalogEntryId: 'fabric-1.21.1', extraTargets: ['fabric-26.3'], starters: ['empty', 'item', 'profiles'] }));
    expect(fs.existsSync(path.join(dest, 'fabric-1.21.1/src/main/java/com/example/twinmod/registry/ModItems.java'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'fabric-26.3/src/main/java/com/example/twinmod/registry/ModItems.java'))).toBe(false);
    expect(read(dest, 'build.gradle')).toContain("id 'net.fabricmc.fabric-loom' version '1.18-SNAPSHOT' apply false");
    expect(read(dest, 'settings.gradle')).not.toContain('foojay');
  }, 90000);

  it('refuses duplicate targets and starters no target supports', async () => {
    const base = { license: 'MIT', git: false, environment: 'both', dependencies: [], ...input(path.join(tmpDir(), 'bad'), {}) };
    const v = await svc.call<{ issues: { field: string; message: string }[] }>('project.validate_create', { input: { ...base, catalogEntryId: 'fabric-26.3', extraTargets: ['fabric-26.3', 'missing'], starters: ['empty', 'item'] } }, 'ui');
    expect(v.issues).toEqual([
      { field: 'extraTargets', message: 'Unknown catalog entry missing' },
      { field: 'starters', message: 'Starter "item" is not available for any of the chosen targets' }
    ]);
  });
});
