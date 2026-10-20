import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { buildClientLaunch, expandArguments, libraryFiles, mavenPath, mergeVersions, offlineUuid, rulesAllow, type Platform, type VersionJson } from '../src/core/clientinstall';
import { hypothesize } from '../src/core/crash';

const win: Platform = { os: 'windows', arch: 'x64' };
const linux: Platform = { os: 'linux', arch: 'x64' };

const vanilla: VersionJson = {
  id: '1.21.1',
  type: 'release',
  mainClass: 'net.minecraft.client.main.Main',
  arguments: {
    game: ['--username', '${auth_player_name}', '--version', '${version_name}', '--gameDir', '${game_directory}', '--assetsDir', '${assets_root}', '--assetIndex', '${assets_index_name}', '--uuid', '${auth_uuid}', '--accessToken', '${auth_access_token}', { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: '--demo' }, { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}'] }],
    jvm: [{ rules: [{ action: 'allow', os: { name: 'osx' } }], value: ['-XstartOnFirstThread'] }, '-Djava.library.path=${natives_directory}', '-cp', '${classpath}']
  },
  libraries: [
    { name: 'org.ow2.asm:asm:9.6', downloads: { artifact: { path: 'org/ow2/asm/asm/9.6/asm-9.6.jar', sha1: 'old', size: 1, url: 'https://libraries.minecraft.net/org/ow2/asm/asm/9.6/asm-9.6.jar' } } },
    { name: 'org.lwjgl:lwjgl:3.3.3', downloads: { artifact: { path: 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar', sha1: 'a', size: 1, url: 'https://x/lwjgl.jar' } } },
    { name: 'org.lwjgl:lwjgl:3.3.3:natives-windows', downloads: { artifact: { path: 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar', sha1: 'b', size: 1, url: 'https://x/lwjgl-nw.jar' } }, rules: [{ action: 'allow', os: { name: 'windows' } }] },
    { name: 'org.lwjgl:lwjgl:3.3.3:natives-linux', downloads: { artifact: { path: 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-linux.jar', sha1: 'c', size: 1, url: 'https://x/lwjgl-nl.jar' } }, rules: [{ action: 'allow', os: { name: 'linux' } }] }
  ],
  assetIndex: { id: '17', sha1: 'i', size: 1, url: 'https://x/17.json' },
  downloads: { client: { sha1: 'c', size: 1, url: 'https://x/client.jar' } },
  javaVersion: { majorVersion: 21 }
};

const fabric: VersionJson = {
  id: 'fabric-loader-0.16.10-1.21.1',
  inheritsFrom: '1.21.1',
  mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
  arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] },
  libraries: [
    { name: 'org.ow2.asm:asm:9.7.1', url: 'https://maven.fabricmc.net/', sha1: 'new', size: 2 },
    { name: 'net.fabricmc:fabric-loader:0.16.10', url: 'https://maven.fabricmc.net/' }
  ]
};

describe('release client installation', () => {
  it('evaluates library and argument rules', () => {
    expect(rulesAllow(undefined, win)).toBe(true);
    expect(rulesAllow([{ action: 'allow', os: { name: 'windows' } }], win)).toBe(true);
    expect(rulesAllow([{ action: 'allow', os: { name: 'windows' } }], linux)).toBe(false);
    expect(rulesAllow([{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }], win)).toBe(true);
    expect(rulesAllow([{ action: 'allow', features: { is_demo_user: true } }], win)).toBe(false);
  });

  it('builds Maven paths', () => {
    expect(mavenPath('net.fabricmc:fabric-loader:0.16.10')).toBe('net/fabricmc/fabric-loader/0.16.10/fabric-loader-0.16.10.jar');
    expect(mavenPath('org.lwjgl:lwjgl:3.3.3:natives-windows')).toBe('org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar');
    expect(mavenPath('de.oceanlabs.mcp:mcp_config:1.21.1@zip')).toBe('de/oceanlabs/mcp/mcp_config/1.21.1/mcp_config-1.21.1.zip');
  });

  it('merges a loader profile over vanilla, keeping the loader library versions', () => {
    const merged = mergeVersions(fabric, vanilla);
    expect(merged.mainClass).toBe('net.fabricmc.loader.impl.launch.knot.KnotClient');
    expect(merged.assetIndex?.id).toBe('17');
    const libs = libraryFiles(merged, path.join('L'), win);
    expect(libs.map((l) => path.relative('L', l.file).split(path.sep).join('/'))).toEqual([
      'org/ow2/asm/asm/9.7.1/asm-9.7.1.jar',
      'net/fabricmc/fabric-loader/0.16.10/fabric-loader-0.16.10.jar',
      'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar',
      'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar'
    ]);
    expect(libs[0]).toMatchObject({ url: 'https://maven.fabricmc.net/org/ow2/asm/asm/9.7.1/asm-9.7.1.jar', sha1: 'new' });
    expect(libs[1].sha1).toBeUndefined();
  });

  it('builds offline launch arguments without demo mode or credentials', () => {
    const launch = buildClientLaunch(mergeVersions(fabric, vanilla), { librariesDir: 'L', clientJar: 'C.jar', gameDir: 'G', assetsDir: 'A', nativesDir: 'N', username: 'Player', platform: win, launcherName: 'modsmith', launcherVersion: '0.1.0' });
    expect(launch.mainClass).toBe('net.fabricmc.loader.impl.launch.knot.KnotClient');
    expect(launch.javaMajor).toBe(21);
    expect(launch.jvmArgs[0]).toBe('-Djava.library.path=N');
    expect(launch.jvmArgs).toContain('-DFabricMcEmu= net.minecraft.client.main.Main ');
    expect(launch.jvmArgs).not.toContain('-XstartOnFirstThread');
    const cp = launch.jvmArgs[launch.jvmArgs.indexOf('-cp') + 1].split(path.delimiter);
    expect(cp[cp.length - 1]).toBe('C.jar');
    expect(launch.gameArgs).not.toContain('--demo');
    expect(launch.gameArgs).not.toContain('--width');
    const arg = (k: string) => launch.gameArgs[launch.gameArgs.indexOf(k) + 1];
    expect(arg('--username')).toBe('Player');
    expect(arg('--gameDir')).toBe('G');
    expect(arg('--assetIndex')).toBe('17');
    expect(arg('--accessToken')).toBe('0');
    expect(arg('--uuid')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('derives the standard offline player UUID', () => {
    const u = offlineUuid('Player');
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(offlineUuid('Player')).toBe(u);
    expect(offlineUuid('Notch')).not.toBe(u);
  });

  it('keeps unknown placeholders and supports array values', () => {
    expect(expandArguments(['${a}', { value: ['x', '${b}'] }, '${missing}'], { a: '1', b: '2' }, win)).toEqual(['1', 'x', '2', '${missing}']);
  });

  it('suggests release mode for development-only crashes', () => {
    expect(hypothesize('java.lang.ClassNotFoundException: net.minecraft.class_2960').some((h) => /Release build/.test(h.text))).toBe(true);
    expect(hypothesize('[main/ERROR] (FabricLoader) Failed to remap mods!').some((h) => /Release build/.test(h.text))).toBe(true);
  });
});
