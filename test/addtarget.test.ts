import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from './helpers';
import { createService } from './service';
import type { OperationInfo } from '../src/shared/types';

const svc = createService();
afterAll(() => svc.stop());

type Target = { project: string; dir: string; loader: string; minecraft: string };
type Inspected = { detected: { targets?: Target[] }; manifest: { platform: { catalogEntry?: string }; source: { root: string; project?: string } } };
type Plan = { folder: string; convert: boolean; currentFolder?: string; moves: string[]; backup: string; gradle?: { from: string; to: string }; issues: string[] };

const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), 'utf8');

async function finish(op: OperationInfo) {
  const done = await svc.waitOperation(op.id, 60000);
  expect(done.status, JSON.stringify(done.error)).toBe('succeeded');
  return done.result as Record<string, unknown>;
}

async function single(name: string, entry: string) {
  const dest = path.join(tmpDir(), name);
  await finish(await svc.call<OperationInfo>('project.create', { projectName: 'Solo Mod', destination: dest, modId: 'solomod', packageName: 'com.example.solomod', author: 'Tester', description: 'One target', license: 'MIT', catalogEntryId: entry, starters: ['empty', 'item', 'profiles'], runInitialBuild: false }, 'ui'));
  return dest;
}

describe('adding a target to an existing project', () => {
  it('converts a single project and then adds more targets', async () => {
    const dest = await single('solo', 'neoforge-1.21.1');
    fs.mkdirSync(path.join(dest, 'run'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'run', 'options.txt'), 'x');
    const plan = await svc.call<Plan>('project.plan_add_target', { path: dest, catalogEntryId: 'forge-1.20.1' }, 'ui');
    expect(plan).toEqual({ catalogEntry: 'forge-1.20.1', folder: 'forge-1.20.1', project: ':forge-1.20.1', convert: true, currentFolder: 'neoforge-1.21.1', currentPlugin: { id: 'net.neoforged.moddev', version: '2.0.148' }, moves: ['build.gradle', 'gradle.properties', 'modsmith.dependencies.gradle', 'run', 'src'], backup: 'copy', issues: [] });

    const r = await finish(await svc.call<OperationInfo>('project.add_target', { path: dest, catalogEntryId: 'forge-1.20.1' }, 'ui'));
    expect(r).toMatchObject({ folder: 'forge-1.20.1', converted: true, currentFolder: 'neoforge-1.21.1', skipped: [], gradle: null });
    expect(String(r.backup)).toMatch(/^\.modsmith\/backups\/add-target-\d+$/);
    expect(fs.existsSync(path.join(dest, String(r.backup), 'src/main/java/com/example/solomod/SoloMod.java'))).toBe(true);
    expect(fs.existsSync(path.join(dest, String(r.backup), 'run'))).toBe(false);

    expect(read(dest, 'settings.gradle')).toBe("pluginManagement {\n\trepositories {\n\t\tgradlePluginPortal()\n\t}\n}\n\nplugins {\n\tid 'org.gradle.toolchains.foojay-resolver-convention' version '1.0.0'\n}\n\nrootProject.name = 'solomod'\n\ninclude 'neoforge-1.21.1'\ninclude 'forge-1.20.1'\n");
    expect(read(dest, 'build.gradle')).toBe("plugins {\n\tid 'net.neoforged.moddev' version '2.0.148' apply false\n\tid 'net.neoforged.moddev.legacyforge' version '2.0.148' apply false\n}\n\ntasks.named('wrapper', Wrapper).configure {\n\tdistributionType = Wrapper.DistributionType.BIN\n}\n");
    expect(read(dest, 'gradle.properties')).toBe(read(dest, 'gradle.properties').split('\n').filter((l) => l.startsWith('org.gradle.') || !l).join('\n'));
    expect(read(dest, 'gradle.properties')).toContain('org.gradle.jvmargs=');
    const neo = read(dest, 'neoforge-1.21.1/build.gradle');
    expect(neo).toContain("\tid 'net.neoforged.moddev'\n");
    expect(neo).not.toContain("tasks.named('wrapper'");
    expect(neo).toContain("srcDir rootProject.file('common/src/main/java')");
    expect(neo).not.toContain("archivesName = 'solomod-neoforge");
    expect(read(dest, 'neoforge-1.21.1/gradle.properties')).not.toContain('org.gradle.');
    expect(read(dest, 'forge-1.20.1/build.gradle')).toContain("archivesName = 'solomod-forge-1.20.1'");
    expect(fs.existsSync(path.join(dest, 'forge-1.20.1/src/main/java/com/example/solomod/SoloMod.java'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'neoforge-1.21.1/run/options.txt'))).toBe(true);
    for (const f of ['LICENSE', 'README.md', '.gitignore', 'gradlew', 'gradle/wrapper/gradle-wrapper.properties', 'modsmith.json']) expect(fs.existsSync(path.join(dest, f)), f).toBe(true);
    for (const f of ['forge-1.20.1/settings.gradle', 'forge-1.20.1/LICENSE', 'neoforge-1.21.1/settings.gradle']) expect(fs.existsSync(path.join(dest, f)), f).toBe(false);

    const info = await svc.call<Inspected>('workspace.inspect', { path: dest }, 'ui');
    expect(info.detected.targets?.map((t) => [t.project, t.dir, t.loader, t.minecraft])).toEqual([
      [':neoforge-1.21.1', 'neoforge-1.21.1', 'neoforge', '1.21.1'],
      [':forge-1.20.1', 'forge-1.20.1', 'forge', '1.20.1']
    ]);
    expect(info.manifest.source).toEqual({ kind: 'gradle', root: 'neoforge-1.21.1', project: ':neoforge-1.21.1' });
    expect(info.manifest.platform.catalogEntry).toBe('neoforge-1.21.1');

    const again = await svc.call<Plan>('project.plan_add_target', { path: dest, catalogEntryId: 'forge-1.20.1' }, 'ui');
    expect(again.issues).toEqual(['The project already has the target forge-1.20.1.']);

    const fab = await svc.call<Plan>('project.plan_add_target', { path: dest, catalogEntryId: 'fabric-1.21.1' }, 'ui');
    expect(fab).toMatchObject({ convert: false, moves: [], issues: [] });
    await finish(await svc.call<OperationInfo>('project.add_target', { path: dest, catalogEntryId: 'fabric-1.21.1' }, 'ui'));
    expect(read(dest, 'settings.gradle')).toBe("pluginManagement {\n\trepositories {\n\t\tmaven {\n\t\t\tname = 'Fabric'\n\t\t\turl = 'https://maven.fabricmc.net/'\n\t\t}\n\t\tmavenCentral()\n\t\tgradlePluginPortal()\n\t}\n}\n\nplugins {\n\tid 'org.gradle.toolchains.foojay-resolver-convention' version '1.0.0'\n}\n\nrootProject.name = 'solomod'\n\ninclude 'neoforge-1.21.1'\ninclude 'forge-1.20.1'\ninclude 'fabric-1.21.1'\n");
    expect(read(dest, 'build.gradle')).toContain("\tid 'net.fabricmc.fabric-loom-remap' version '1.18-SNAPSHOT' apply false\n}\n");
    expect(read(dest, 'gradle.properties')).not.toContain('configuration-cache');
    const after = await svc.call<Inspected>('workspace.inspect', { path: dest }, 'ui');
    expect(after.detected.targets?.map((t) => t.project)).toEqual([':neoforge-1.21.1', ':forge-1.20.1', ':fabric-1.21.1']);
    await svc.call('project.select_target', { path: dest, project: ':fabric-1.21.1' }, 'ui');
    const v = await svc.call<{ problems: { severity: string; message: string }[] }>('project.validate', { path: dest }, 'ui');
    expect(v.problems.filter((p) => p.severity === 'error' || p.message.includes('declares Minecraft'))).toEqual([]);
  }, 120000);

  it('refuses to convert a Git project with uncommitted changes', async () => {
    const dest = await single('dirty', 'fabric-1.21.1');
    execFileSync('git', ['-C', dest, 'init', '-q']);
    const plan = await svc.call<Plan>('project.plan_add_target', { path: dest, catalogEntryId: 'neoforge-1.21.1' }, 'ui');
    expect(plan.backup).toBe('git');
    expect(plan.issues).toEqual(['The project has uncommitted changes. Commit or stash them first, so Git can undo the move if you need to.']);
    const same = await svc.call<Plan>('project.plan_add_target', { path: dest, catalogEntryId: 'fabric-1.21.1' }, 'ui');
    expect(same.issues[0]).toBe('The project already targets fabric 1.21.1.');
  }, 90000);
});
