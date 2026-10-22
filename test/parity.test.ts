import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { Workbench } from '../src/core/workbench';
import { createService, serviceBinary, type ServiceUnderTest } from './service';
import { fakeModJar, jarBytes, tmpDir } from './helpers';

type Outcome = { ok: unknown } | { err: string };

describe.runIf(!!serviceBinary)('Rust service matches the Node service', () => {
  let node: Workbench;
  let rust: ServiceUnderTest;

  beforeAll(() => {
    node = new Workbench();
    rust = createService();
  });
  afterAll(async () => {
    await node.stop(false);
    await rust.stop();
  });

  const viaNode = (method: string, params: Record<string, unknown>): Promise<Outcome> =>
    node.call(method, params, 'ui').then(
      (ok) => ({ ok: JSON.parse(JSON.stringify(ok ?? null)) }),
      (e: Error) => ({ err: e.message })
    );
  const viaRust = (method: string, params: Record<string, unknown>): Promise<Outcome> =>
    rust.call(method, params, 'ui').then(
      (ok) => ({ ok: ok ?? null }),
      (e: Error) => ({ err: e.message })
    );

  async function same(method: string, params: Record<string, unknown>, prepare?: () => void) {
    prepare?.();
    const r = await viaRust(method, params);
    prepare?.();
    const n = await viaNode(method, params);
    expect(r, `${method} ${JSON.stringify(params)}`).toEqual(n);
    return n;
  }

  function fabricProject(): string {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'build.gradle'), "plugins { id 'net.fabricmc.fabric-loom-remap' version '1.18' }\n");
    fs.writeFileSync(path.join(dir, 'settings.gradle'), "rootProject.name = 'x'\n");
    fs.writeFileSync(path.join(dir, 'gradle.properties'), 'org.gradle.jvmargs=-Xmx1G\r\nminecraft_version=1.21.1\r\nloader_version=0.19.5\r\n');
    fs.writeFileSync(path.join(dir, 'gradlew.bat'), '@echo off\n');
    fs.mkdirSync(path.join(dir, 'src', 'main', 'resources'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'main', 'resources', 'fabric.mod.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', depends: { minecraft: '~1.21.1' } }));
    fs.mkdirSync(path.join(dir, 'build', 'resources'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'build', 'resources', 'fabric.mod.json'), '{"id":"ignored"}');
    return dir;
  }

  it('inspects missing, empty, Gradle and NeoForge folders the same way', async () => {
    await same('workspace.inspect', { path: path.join(tmpDir(), 'missing') });
    await same('workspace.inspect', { path: tmpDir() });
    await same('workspace.inspect', { path: fabricProject() });
    const neo = tmpDir();
    fs.writeFileSync(path.join(neo, 'build.gradle'), "plugins { id 'net.neoforged.moddev' version '2.0.1' }\nplugins { id 'dev.architectury.loom' }");
    fs.writeFileSync(path.join(neo, 'gradle.properties'), 'neo_version=21.1.77\n');
    fs.mkdirSync(path.join(neo, 'gradle'));
    fs.writeFileSync(path.join(neo, 'gradle', 'libs.versions.toml'), '[versions]\n');
    fs.mkdirSync(path.join(neo, 'src', 'main', 'resources', 'META-INF'), { recursive: true });
    fs.writeFileSync(path.join(neo, 'src', 'main', 'resources', 'META-INF', 'neoforge.mods.toml'), 'modLoader="javafml"\n[[mods]]\nmodId="neodemo"\n');
    await same('workspace.inspect', { path: neo });
    const plain = tmpDir();
    fs.writeFileSync(path.join(plain, 'settings.gradle'), '');
    await same('workspace.inspect', { path: plain });
    for (const plugin of ['net.neoforged.moddev.legacyforge', 'net.minecraftforge.gradle']) {
      const forge = tmpDir();
      fs.writeFileSync(path.join(forge, 'build.gradle'), `plugins { id '${plugin}' version '2.0.148' }\n`);
      fs.writeFileSync(path.join(forge, 'gradle.properties'), 'minecraft_version=1.20.1\nforge_version=47.4.28\n');
      fs.mkdirSync(path.join(forge, 'src', 'main', 'resources', 'META-INF'), { recursive: true });
      fs.writeFileSync(path.join(forge, 'src', 'main', 'resources', 'META-INF', 'mods.toml'), 'modLoader="javafml"\n[[mods]]\nmodId="forgedemo"\n');
      const inspected = ((await same('workspace.inspect', { path: forge })) as { ok: { detected: { loader: string; notes: string[] } } }).ok;
      expect(inspected.detected.loader).toBe('forge');
      expect(inspected.detected.notes.some((n) => n.startsWith('ForgeGradle'))).toBe(plugin === 'net.minecraftforge.gradle');
    }
  });

  it('inspects managed workspaces, manifest errors, lock problems and unknown catalog entries the same way', async () => {
    const dir = tmpDir();
    await node.call('workspace.init', { path: dir, type: 'modpack', minecraft: '1.21.1', loaderVersion: '0.19.5' }, 'ui');
    await node.call('workspace.trust', { path: dir, trusted: true }, 'ui');
    await same('workspace.inspect', { path: dir });
    const manifestFile = path.join(dir, 'modsmith.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, platform: { ...manifest.platform, catalogEntry: 'nope-1' }, extra: true }, null, 2));
    await same('workspace.inspect', { path: dir });
    fs.writeFileSync(path.join(dir, 'modsmith.lock.json'), JSON.stringify({ schemaVersion: 1, profiles: { a: { resolvedAt: 'x', minecraft: '1', loader: 'fabric', loaderVersion: '1', entries: [{ key: 1 }] } } }));
    await same('workspace.inspect', { path: dir });
    const bad = [
      { ...manifest, schemaVersion: 2, name: '' },
      { ...manifest, profiles: [...manifest.profiles, manifest.profiles[0]] },
      { ...manifest, profiles: [{ id: 'Bad Id', name: 'x', side: 'client' }] },
      { ...manifest, dependencies: [{ source: 'nope' }, { source: 'curseforge', projectId: 'abc' }, { source: 'curseforge', projectId: 12, fileId: true }, { source: 'maven', coordinates: 'x' }, { source: 'maven', coordinates: 'a:b:c', repository: 'not a url' }, 5] },
      { ...manifest, profiles: [{ id: 'p', name: 'x', side: 'client', jvm: { memoryMb: 100 }, debug: { port: 80 }, mods: [{ source: 'local', path: '' }] }] },
      { ...manifest, platform: { loader: 'quilt' } },
      { ...manifest, modId: 'X' },
      { ...manifest, dependencies: [{ source: 'curseforge', projectId: 238222, fileId: '5101366' }] },
      { ...manifest, platform: { ...manifest.platform, loader: 'forge' } },
      []
    ];
    for (const m of bad) {
      fs.writeFileSync(manifestFile, JSON.stringify(m));
      await same('workspace.inspect', { path: dir });
    }
  });

  it('lists trees with the same order, depth and ignore rules', async () => {
    const dir = tmpDir();
    for (const name of ['b.txt', 'B2.txt', 'a.txt', '_x.md', '10.txt', '2.txt', 'Zeta', 'alpha', 'Ärger.txt', 'a b.txt', 'a-b.txt', 'a_b.txt', 'a.b.txt', 'A.txt', '.hidden']) fs.writeFileSync(path.join(dir, name), 'x');
    for (const d of ['src/main/java/x', 'build/out', '.gradle/x', 'docs', 'Docs2', 'node_modules/y']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'main', 'java', 'x', 'A.java'), 'class A {}');
    await same('workspace.tree', { path: dir });
    await same('workspace.tree', { path: dir, depth: 0 });
    await same('workspace.tree', { path: dir, dir: 'src', depth: 8 });
    await same('workspace.tree', { path: dir, dir: '../..' });
    await same('workspace.tree', { path: dir, dir: 'missing' });
  });

  it('reads, writes and deletes files with the same results and errors', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'héllo\r\nworld\n');
    fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([1, 0, 2, 255]));
    fs.writeFileSync(path.join(dir, 'big.txt'), Buffer.alloc(4 * 1024 * 1024 + 1, 97));
    fs.mkdirSync(path.join(dir, 'sub'));
    for (const file of ['a.txt', 'bin.dat', 'big.txt', 'sub', 'missing.txt', '../outside.txt', 'C:\\Windows\\win.ini']) await same('workspace.read_file', { path: dir, file });
    const r = (await viaRust('workspace.write_file', { path: dir, file: 'new/deep.txt', content: 'x', create: true })) as { ok: { path: string; mtime: number } };
    expect(r.ok.path).toBe('new/deep.txt');
    expect(fs.readFileSync(path.join(dir, 'new', 'deep.txt'), 'utf8')).toBe('x');
    await same('workspace.write_file', { path: dir, file: 'nope.txt', content: 'x' });
    await same('workspace.write_file', { path: dir, file: 'a.txt', content: 'y', expectedMtime: 5 });
    await same('workspace.write_file', { path: dir, file: '../escape.txt', content: 'y', create: true });
    await same('workspace.delete_file', { path: dir, file: 'a.txt', confirm: false });
    await same('workspace.delete_file', { path: dir, file: 'sub', confirm: true });
    await same('workspace.delete_file', { path: dir, file: '.', confirm: true });
    await same('workspace.delete_file', { path: dir, file: 'missing.txt', confirm: true });
    expect(await viaRust('workspace.delete_file', { path: dir, file: 'bin.dat', confirm: true })).toEqual({ ok: null });
    expect(fs.existsSync(path.join(dir, 'bin.dat'))).toBe(false);
  });

  it('reads and sets project images the same way', async () => {
    const dir = tmpDir();
    await node.call('workspace.init', { path: dir, type: 'modpack', minecraft: '1.21.1', loaderVersion: '0.19.5' }, 'ui');
    fs.writeFileSync(path.join(dir, 'icon.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    await same('workspace.image', { path: dir });
    const before = fs.readFileSync(path.join(dir, 'modsmith.json'), 'utf8');
    expect(await viaRust('workspace.set_image', { path: dir, file: 'icon.png' })).toEqual({ ok: { icon: 'icon.png' } });
    const rustWritten = fs.readFileSync(path.join(dir, 'modsmith.json'), 'utf8');
    fs.writeFileSync(path.join(dir, 'modsmith.json'), before);
    await node.call('workspace.set_image', { path: dir, file: 'icon.png' }, 'ui');
    expect(rustWritten).toBe(fs.readFileSync(path.join(dir, 'modsmith.json'), 'utf8'));
    await same('workspace.image', { path: dir });
    await same('workspace.set_image', { path: dir, file: 'notes.txt' });
    await same('workspace.set_image', { path: dir, file: 'missing.png' });
    await same('workspace.set_image', { path: tmpDir(), file: null });
    expect(await viaRust('workspace.set_image', { path: dir, file: null })).toEqual({ ok: { icon: null } });
    const cleared = fs.readFileSync(path.join(dir, 'modsmith.json'), 'utf8');
    await node.call('workspace.set_image', { path: dir, file: 'icon.png' }, 'ui');
    await node.call('workspace.set_image', { path: dir, file: null }, 'ui');
    expect(cleared).toBe(fs.readFileSync(path.join(dir, 'modsmith.json'), 'utf8'));
  });

  it('returns the same catalog', async () => {
    await same('catalog.list', {});
  });

  it('reads jar metadata the same way', async () => {
    const dir = tmpDir();
    const nested = { 'inner-a.jar': jarBytes({ id: 'inner_a', provides: ['ia'] }), 'inner-b.jar': jarBytes({ id: 'inner_b', depends: { minecraft: ['1.21', '1.21.1'] } }) };
    const jars = [
      fakeModJar(dir, 'plain.jar', { id: 'plain', name: 'Plain', license: ['MIT', 'CC0'], environment: 'client', depends: { fabricloader: '>=0.15', minecraft: 1.21 }, breaks: { other: '*' } }),
      fakeModJar(dir, 'nested.jar', { id: 'outer', version: 3 }, nested)
    ];
    const write = (name: string, files: Record<string, Uint8Array>) => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, zipSync(files));
      jars.push(f);
    };
    write('lenient.jar', { 'fabric.mod.json': strToU8('\uFEFF{\n // comment\n id: "lenient", version: "1.0", description: "line one\nline two", provides: [1, "x"], depends: {a: ">=1",},\n}') });
    write('quilt.jar', { 'quilt.mod.json': strToU8(JSON.stringify({ quilt_loader: { id: 'q', version: '2', metadata: { name: 'Quilty' } } })) });
    write('neo.jar', { 'META-INF/neoforge.mods.toml': strToU8('license="MIT"\n[[mods]]\nmodId="neo"\nversion="1.0"\ndisplayName="Neo"\n[[dependencies.neo]]\nmodId="minecraft"\ntype="required"\nversionRange="[1.21.1,)"\n[[dependencies.neo]]\nmodId="bad"\ntype="incompatible"\n[[dependencies.neo]]\nmodId="opt"\nmandatory=true\n') });
    write('forge.jar', { 'META-INF/mods.toml': strToU8('[[mods]]\nmodId="forgey"\n[[mods]]\nmodId="second"\ndescription=""\n') });
    write('only-nested.jar', { 'META-INF/jarjar/lib.jar': jarBytes({ id: 'lib' }) });
    write('empty.jar', { 'readme.txt': strToU8('x') });
    write('noid.jar', { 'fabric.mod.json': strToU8('{"version":"1"}') });
    fs.writeFileSync(path.join(dir, 'broken.jar'), 'not a zip');
    jars.push(path.join(dir, 'broken.jar'), path.join(dir, 'missing.jar'));
    for (const file of jars) {
      const r = await viaRust('dependency.inspect_jar', { file });
      const n = await viaNode('dependency.inspect_jar', { file });
      if ('err' in n && file.endsWith('broken.jar')) {
        expect('err' in r).toBe(true);
        continue;
      }
      expect(r, file).toEqual(n);
    }
  });
});
