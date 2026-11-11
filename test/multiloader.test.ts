import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Workbench } from '../src/core/workbench';
import { tmpDir } from './helpers';
import { createService, serviceBinary } from './service';

const svc = createService();
afterAll(() => svc.stop());

type Target = { project: string; dir: string; loader: string; minecraft: string; loaderVersion?: string; plugins: string[] };
type Inspected = { detected: { loader: string; minecraftHint?: string; loaderVersionHint?: string; ambiguous: boolean; notes: string[]; targets?: Target[] }; warnings: string[] };
type Manifest = { modId?: string; platform: { loader: string; minecraft: string; loaderVersion: string; catalogEntry?: string }; source: { kind: string; root: string; project?: string } };

function write(root: string, file: string, text: string) {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

function wrapper(dir: string) {
  write(dir, 'gradlew', '#!/bin/sh\n');
  write(dir, 'gradlew.bat', '@echo off\n');
}

function stonecutterProject(): string {
  const dir = tmpDir();
  wrapper(dir);
  write(
    dir,
    'settings.gradle',
    `plugins {
    id 'dev.kikugie.stonecutter' version '0.9.8'
}

stonecutter {
    create(getRootProject()) {
        versions '1.20.1', '1.21.1'
        vcsVersion = '1.21.1'
        branch('fabric') { versions '1.20.1', '1.21.1' }
        branch('forge') { versions '1.20.1' }
        branch('neoforge') { versions '1.21.1' }
    }
}

rootProject.name = 'example'
`
  );
  write(
    dir,
    'build.gradle',
    `plugins {
    id 'net.neoforged.moddev' version '2.0.148' apply false
    id 'net.neoforged.moddev.legacyforge' version '2.0.148' apply false
}

if (hasProperty('neoform_version')) {
    apply plugin: 'net.neoforged.moddev'
    neoForge { neoFormVersion = neoform_version }
} else {
    apply plugin: 'net.neoforged.moddev.legacyforge'
    legacyForge { enable { mcpVersion = minecraft_version } }
}
`
  );
  write(dir, 'gradle.properties', 'mod_id=examplemod\nmod_version=1.0.0\n');
  write(dir, 'versions/1.20.1/gradle.properties', 'minecraft_version=1.20.1\njava_version=17\n');
  write(dir, 'versions/1.21.1/gradle.properties', 'minecraft_version=1.21.1\nneoform_version=1.21.1-20240808.144430\n');
  write(dir, 'fabric/build.gradle', "plugins {\n    id 'net.fabricmc.fabric-loom' version '1.15.5' apply false\n    id 'net.fabricmc.fabric-loom-remap' version '1.15.5' apply false\n}\n");
  write(dir, 'fabric/versions/1.20.1/gradle.properties', 'minecraft_version=1.20.1\nfabric_loader_version=0.16.9\n');
  write(dir, 'fabric/versions/1.21.1/gradle.properties', 'minecraft_version=1.21.1\nfabric_loader_version=0.16.10\n');
  write(dir, 'fabric/src/main/resources/fabric.mod.json', JSON.stringify({ schemaVersion: 1, id: '${mod_id}' }));
  write(dir, 'forge/build.gradle', "plugins {\n    id 'net.neoforged.moddev.legacyforge' version '2.0.148'\n}\n");
  write(dir, 'forge/versions/1.20.1/gradle.properties', 'minecraft_version=1.20.1\nforge_version=47.4.0\n');
  write(dir, 'neoforge/src/main/resources/META-INF/neoforge.mods.toml', '[[mods]]\nmodId="${mod_id}"\n\n[[dependencies.${mod_id}]]\nmodId="neoforge"\n');
  write(dir, 'neoforge/build.gradle', "plugins {\n    id 'net.neoforged.moddev' version '2.0.148'\n}\n");
  write(dir, 'neoforge/versions/1.21.1/gradle.properties', 'minecraft_version=1.21.1\nneoforge_version=21.1.199\n');
  return dir;
}

function flatProject(): string {
  const dir = tmpDir();
  wrapper(dir);
  write(dir, 'settings.gradle', "rootProject.name = 'flat'\ninclude 'common-1.21.1'\ninclude 'fabric-1.21.1'\ninclude('neoforge-1.21.1')\ninclude 'forge-1201'\n");
  write(dir, 'build.gradle', "plugins {\n    id 'java'\n}\n");
  write(dir, 'gradle.properties', 'minecraft_version=1.20.1\nforge_version=47.4.0\nmod_id=flat\n');
  write(dir, 'common-1.21.1/build.gradle', "plugins {\n    id 'net.neoforged.moddev' version '2.0.148'\n}\nneoForge {\n    neoFormVersion = neoform_version\n}\n");
  write(dir, 'fabric-1.21.1/build.gradle', "plugins {\n    id 'net.fabricmc.fabric-loom-remap' version '1.15.5'\n}\n");
  write(dir, 'fabric-1.21.1/gradle.properties', 'fabric_loader_version=0.16.9\n');
  write(dir, 'neoforge-1.21.1/build.gradle', "plugins {\n    id 'net.neoforged.moddev' version '2.0.141'\n}\n");
  write(dir, 'neoforge-1.21.1/gradle.properties', 'neoforge_version=21.1.199\n');
  write(dir, 'forge-1201/build.gradle', "plugins {\n    id 'net.minecraftforge.gradle' version '[6.0.16,6.2)'\n}\n");
  fs.appendFileSync(path.join(dir, 'settings.gradle'), "includeBuild('build-logic')\n");
  write(dir, 'build-logic/build.gradle', "dependencies {\n    implementation 'net.minecraftforge.gradle:ForgeGradle:6.+'\n}\n");
  return dir;
}

describe('multi-version multi-loader projects', () => {
  it('lists each Stonecutter branch version as a target and skips the shared projects', async () => {
    const r = await svc.call<Inspected>('workspace.inspect', { path: stonecutterProject() }, 'ui');
    expect(r.detected.targets).toEqual([
      { project: ':fabric:1.20.1', dir: 'fabric/versions/1.20.1', loader: 'fabric', minecraft: '1.20.1', loaderVersion: '0.16.9', plugins: ['net.fabricmc.fabric-loom-remap', 'net.fabricmc.fabric-loom'] },
      { project: ':fabric:1.21.1', dir: 'fabric/versions/1.21.1', loader: 'fabric', minecraft: '1.21.1', loaderVersion: '0.16.10', plugins: ['net.fabricmc.fabric-loom-remap', 'net.fabricmc.fabric-loom'] },
      { project: ':forge:1.20.1', dir: 'forge/versions/1.20.1', loader: 'forge', minecraft: '1.20.1', loaderVersion: '47.4.0', plugins: ['net.neoforged.moddev.legacyforge'] },
      { project: ':neoforge:1.21.1', dir: 'neoforge/versions/1.21.1', loader: 'neoforge', minecraft: '1.21.1', loaderVersion: '21.1.199', plugins: ['net.neoforged.moddev'] }
    ]);
    expect(r.detected).toMatchObject({ loader: 'fabric', minecraftHint: '1.20.1', loaderVersionHint: '0.16.9', ambiguous: false });
    expect(r.warnings).toEqual([]);
  });

  it('lists flat loader subprojects as targets and reads compact version names', async () => {
    const r = await svc.call<Inspected>('workspace.inspect', { path: flatProject() }, 'ui');
    expect(r.detected.targets).toEqual([
      { project: ':fabric-1.21.1', dir: 'fabric-1.21.1', loader: 'fabric', minecraft: '1.21.1', loaderVersion: '0.16.9', plugins: ['net.fabricmc.fabric-loom-remap'] },
      { project: ':neoforge-1.21.1', dir: 'neoforge-1.21.1', loader: 'neoforge', minecraft: '1.21.1', loaderVersion: '21.1.199', plugins: ['net.neoforged.moddev'] },
      { project: ':forge-1201', dir: 'forge-1201', loader: 'forge', minecraft: '1.20.1', loaderVersion: '47.4.0', plugins: ['net.minecraftforge.gradle'] }
    ]);
  });

  it('leaves single-project folders without targets', async () => {
    const dir = tmpDir();
    wrapper(dir);
    write(dir, 'settings.gradle', "rootProject.name = 'single'\ninclude 'testmod'\n");
    write(dir, 'build.gradle', "plugins { id 'net.fabricmc.fabric-loom-remap' version '1.15.5' }\n");
    write(dir, 'testmod/build.gradle', "plugins { id 'net.fabricmc.fabric-loom-remap' version '1.15.5' }\n");
    write(dir, 'gradle.properties', 'minecraft_version=1.21.1\nloader_version=0.16.9\n');
    const r = await svc.call<Inspected>('workspace.inspect', { path: dir }, 'ui');
    expect(r.detected.targets).toBeUndefined();
    expect(r.detected.loader).toBe('fabric');
  });

  it('starts on the first target and switches targets', async () => {
    const dir = stonecutterProject();
    const m = await svc.call<Manifest>('workspace.init', { path: dir, type: 'mod' }, 'ui');
    expect(m.platform).toMatchObject({ loader: 'fabric', minecraft: '1.20.1', loaderVersion: '0.16.9' });
    expect(m.source).toEqual({ kind: 'gradle', root: 'fabric/versions/1.20.1', project: ':fabric:1.20.1' });
    expect(m.modId).toBe('examplemod');

    const n = await svc.call<Manifest>('project.select_target', { path: dir, project: ':neoforge:1.21.1' }, 'ui');
    expect(n.platform).toMatchObject({ loader: 'neoforge', minecraft: '1.21.1', loaderVersion: '21.1.199' });
    expect(n.source).toEqual({ kind: 'gradle', root: 'neoforge/versions/1.21.1', project: ':neoforge:1.21.1' });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'modsmith.json'), 'utf8'))).toMatchObject({ platform: n.platform, source: n.source });

    await expect(svc.call('project.select_target', { path: dir, project: ':fabric:9.9' }, 'ui')).rejects.toThrow('Unknown target :fabric:9.9');
  });

  it('starts on the target that matches the chosen Minecraft version', async () => {
    const dir = stonecutterProject();
    const m = await svc.call<Manifest>('workspace.init', { path: dir, type: 'mod', minecraft: '1.21.1', loaderVersion: '0.19.5' }, 'ui');
    expect(m.platform).toMatchObject({ loader: 'fabric', minecraft: '1.21.1', loaderVersion: '0.16.10' });
    expect(m.source.project).toBe(':fabric:1.21.1');
  });

  it('warns when the saved target is no longer in settings.gradle', async () => {
    const dir = stonecutterProject();
    await svc.call('workspace.init', { path: dir, type: 'mod' }, 'ui');
    const settings = path.join(dir, 'settings.gradle');
    fs.writeFileSync(settings, fs.readFileSync(settings, 'utf8').replace("branch('fabric') { versions '1.20.1', '1.21.1' }", "branch('fabric') { versions '1.21.1' }"));
    expect((await svc.call<Inspected>('workspace.inspect', { path: dir }, 'ui')).warnings).toEqual(['Target :fabric:1.20.1 is no longer in settings.gradle; choose another target']);
  });

  it('keeps instances of each target apart and leaves single projects unchanged', async () => {
    const dir = stonecutterProject();
    await svc.call('workspace.init', { path: dir, type: 'mod' }, 'ui');
    await svc.call('project.select_target', { path: dir, project: ':neoforge:1.21.1' }, 'ui');
    const multi = await svc.call<{ instanceDir: string }>('instance.eula_status', { path: dir, profile: 'dev-server' }, 'ui');
    expect(multi.instanceDir).toBe(path.join(dir, '.modsmith', 'instances', 'dev-server-server-neoforge-1.21.1'));

    const single = tmpDir();
    wrapper(single);
    write(single, 'build.gradle', "plugins { id 'net.fabricmc.fabric-loom-remap' version '1.15.5' }\n");
    write(single, 'gradle.properties', 'minecraft_version=1.21.1\nloader_version=0.16.9\n');
    const m = await svc.call<Manifest>('workspace.init', { path: single, type: 'mod' }, 'ui');
    expect(m.source).toEqual({ kind: 'gradle', root: '.' });
    expect((await svc.call<{ instanceDir: string }>('instance.eula_status', { path: single, profile: 'dev-server' }, 'ui')).instanceDir).toBe(path.join(single, '.modsmith', 'instances', 'dev-server-server'));
  });

  it('warns about a selected ForgeGradle target', async () => {
    const dir = flatProject();
    await svc.call('workspace.init', { path: dir, type: 'mod' }, 'ui');
    expect((await svc.call<Inspected>('workspace.inspect', { path: dir }, 'ui')).warnings).toEqual([]);
    await svc.call('project.select_target', { path: dir, project: ':forge-1201' }, 'ui');
    expect((await svc.call<Inspected>('workspace.inspect', { path: dir }, 'ui')).warnings).toEqual(['This project uses ForgeGradle; build and launch need ModDevGradle Legacy (net.neoforged.moddev.legacyforge)']);
  });

  it('lists the JARs of the selected target', async () => {
    const dir = stonecutterProject();
    await svc.call('workspace.init', { path: dir, type: 'mod' }, 'ui');
    await svc.call('project.select_target', { path: dir, project: ':fabric:1.21.1' }, 'ui');
    write(dir, 'fabric/versions/1.21.1/build/libs/examplemod-fabric-1.21.1-1.0.0.jar', 'jar');
    write(dir, 'fabric/versions/1.20.1/build/libs/examplemod-fabric-1.20.1-1.0.0.jar', 'jar');
    const r = await svc.call<{ folder: string; files: { name: string }[] }>('project.artifacts', { path: dir }, 'ui');
    expect(r.folder).toBe(path.join(dir, 'fabric', 'versions', '1.21.1', 'build', 'libs'));
    expect(r.files.map((f) => f.name)).toEqual(['examplemod-fabric-1.21.1-1.0.0.jar']);
    await expect(svc.call('project.publish', { path: dir, file: 'examplemod-fabric-1.21.1-1.0.0.jar', targets: ['modrinth'], version: '1.0.0' }, 'ui')).rejects.toThrow('Link a Modrinth project in Project settings first');
  });
});

describe.runIf(!!serviceBinary)('multi-loader projects in the Rust service match the Node service', () => {
  let node: Workbench;
  beforeAll(() => {
    node = new Workbench();
  });
  afterAll(() => node.stop(false));

  const outcome = (p: Promise<unknown>) => p.then((ok) => ({ ok: JSON.parse(JSON.stringify(ok ?? null)) }), (e: Error) => ({ err: e.message }));

  it('inspects, initializes and switches targets the same way', async () => {
    for (const make of [stonecutterProject, flatProject]) {
      const a = make();
      const b = make();
      expect(await outcome(svc.call('workspace.inspect', { path: a }, 'ui'))).toEqual(await outcome(node.call('workspace.inspect', { path: a }, 'ui')));
      expect(await outcome(svc.call('workspace.init', { path: a, type: 'mod', name: 'example' }, 'ui'))).toEqual(await outcome(node.call('workspace.init', { path: b, type: 'mod', name: 'example' }, 'ui')));
      expect(fs.readFileSync(path.join(a, 'modsmith.json'), 'utf8')).toBe(fs.readFileSync(path.join(b, 'modsmith.json'), 'utf8'));
      for (const project of [':neoforge:1.21.1', ':forge-1201', ':missing']) {
        expect(await outcome(svc.call('project.select_target', { path: a, project }, 'ui'))).toEqual(await outcome(node.call('project.select_target', { path: b, project }, 'ui')));
        expect(fs.readFileSync(path.join(a, 'modsmith.json'), 'utf8')).toBe(fs.readFileSync(path.join(b, 'modsmith.json'), 'utf8'));
      }
    }
  });
});
