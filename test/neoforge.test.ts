import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { CompatibilityCatalog, assertGeneratable } from '../src/core/catalog';
import { findResourcesDir } from '../src/core/paths';
import { generateNeoForgeProject, neoforgeDependencyGradle, NeoForgeAdapter } from '../src/core/adapters/neoforge';
import { readJarMetadata, allModIds } from '../src/core/jarmeta';
import { classpathModIds } from '../src/core/profiles';
import { tmpDir } from './helpers';
import { disableEarlyWindowToml } from '../src/core/launch';

const resources = findResourcesDir(__dirname);
const catalog = new CompatibilityCatalog(resources);
const entry = catalog.get('neoforge-1.21.1')!;

const opts = {
  projectName: 'Neo Mod',
  destination: 'C:/x',
  modId: 'neomod',
  packageName: 'com.example.neomod',
  author: 'A',
  description: 'D',
  license: 'MIT',
  git: false,
  catalogEntryId: 'neoforge-1.21.1',
  environment: 'both' as const,
  starters: ['empty'],
  dependencies: []
};

describe('neoforge catalog entry', () => {
  it('matches the ModDevGradle MDK template and is generatable', () => {
    expect(entry).toMatchObject({ loader: 'neoforge', minecraft: '1.21.1', loaderVersion: '21.1.262', gradleVersion: '9.2.1', plugin: { id: 'net.neoforged.moddev', version: '2.0.148' }, mappings: 'parchment', parchment: { version: '2024.11.17' }, remap: false });
    expect(() => assertGeneratable(entry)).not.toThrow();
    expect(entry.bridge.jar).toBe('modsmith-bridge-neoforge-1.21.1.jar');
  });

  it('reports implemented capabilities and starters', () => {
    const a = new NeoForgeAdapter(catalog, null as never);
    expect(a.implemented).toBe(true);
    expect(a.runTaskNames().datagen).toBe('runData');
    expect(a.starterOptions(entry).filter((s) => s.state === 'supported').map((s) => s.id)).toEqual(['empty', 'item', 'block', 'command', 'config', 'datagen', 'bridge', 'profiles']);
  });
});

describe('neoforge project generation', () => {
  it('generates the MDK layout with templated metadata', () => {
    const files = generateNeoForgeProject(opts, entry);
    const by = Object.fromEntries(files.map((f) => [f.path, f.content.toString()]));
    expect(by['build.gradle']).toContain("id 'net.neoforged.moddev' version '2.0.148'");
    expect(by['build.gradle']).toContain('parchment {');
    expect(by['build.gradle']).toContain("apply from: 'modsmith.dependencies.gradle'");
    expect(by['gradle.properties']).toContain('neo_version=21.1.262');
    expect(by['gradle.properties']).toContain('parchment_mappings_version=2024.11.17');
    expect(by['settings.gradle']).toContain("rootProject.name = 'neomod'");
    expect(by['gradle/wrapper/gradle-wrapper.properties']).toContain('gradle-9.2.1-bin.zip');
    const toml = by['src/main/templates/META-INF/neoforge.mods.toml'];
    expect(toml).toContain('modId="${mod_id}"');
    expect(toml).toContain('modId="neoforge"');
    expect(by['src/main/java/com/example/neomod/NeoMod.java']).toContain('@Mod(NeoMod.MOD_ID)');
    expect(by['src/main/java/com/example/neomod/client/NeoModClient.java']).toContain('dist = Dist.CLIENT');
    expect(files.some((f) => f.path.includes('registry'))).toBe(false);
  });

  it('adds DeferredRegister, command, config and datagen starters', () => {
    const files = generateNeoForgeProject({ ...opts, starters: ['empty', 'item', 'block', 'command', 'config', 'datagen'] }, entry);
    const by = Object.fromEntries(files.map((f) => [f.path, f.content.toString()]));
    expect(by['src/main/java/com/example/neomod/registry/ModItems.java']).toContain('DeferredRegister.createItems');
    expect(by['src/main/java/com/example/neomod/registry/ModBlocks.java']).toContain('registerSimpleBlockItem');
    expect(by['src/main/java/com/example/neomod/command/ModCommands.java']).toContain('RegisterCommandsEvent');
    expect(by['src/main/java/com/example/neomod/config/Config.java']).toContain('ModConfigSpec');
    expect(by['src/main/java/com/example/neomod/datagen/ModDataGenerators.java']).toContain('GatherDataEvent');
    expect(by['src/main/java/com/example/neomod/NeoMod.java']).toContain('NeoForge.EVENT_BUS.addListener(ModCommands::register);');
    expect(by['src/main/resources/assets/neomod/lang/en_us.json']).toBeUndefined();
    for (const f of files.filter((x) => x.path.endsWith('.java'))) expect(f.content.toString()).not.toMatch(/^\s*\/\//m);
  });

  it('writes a static translation file without datagen and skips the client entrypoint for servers', () => {
    const files = generateNeoForgeProject({ ...opts, environment: 'server', starters: ['empty', 'item'] }, entry);
    expect(JSON.parse(files.find((f) => f.path.endsWith('lang/en_us.json'))!.content.toString())['item.neomod.example_item']).toBe('Example Item');
    expect(files.some((f) => f.path.includes('/client/'))).toBe(false);
  });

  it('uses plain implementation configurations for compile dependencies', () => {
    const g = neoforgeDependencyGradle({ ...opts, dependencies: [{ source: 'modrinth', projectId: 'u6dRKJwZ', versionId: 'v1', required: true, usage: 'compile', environment: 'both' }] });
    expect(g).toContain("implementation 'maven.modrinth:u6dRKJwZ:v1'");
    expect(g).not.toContain('modImplementation');
  });
});

describe('neoforge metadata', () => {
  it('reads mods packaged inside META-INF/jarjar wrappers', () => {
    const inner = zipSync({ 'META-INF/neoforge.mods.toml': strToU8('modLoader="javafml"\nloaderVersion="[1,)"\nlicense="MIT"\n[[mods]]\nmodId="innerlib"\nversion="1.0"\n') });
    const dir = tmpDir();
    const file = path.join(dir, 'wrapper.jar');
    fs.writeFileSync(file, zipSync({ 'META-INF/MANIFEST.MF': strToU8('FMLModType: GAMELIBRARY\n'), 'META-INF/jarjar/inner.jar': inner }));
    const meta = readJarMetadata(file);
    expect(meta[0]).toMatchObject({ loader: 'neoforge', id: 'innerlib' });
    expect(allModIds(meta)).toEqual(['innerlib']);
  });

  it('reads neoforge.mods.toml from development class directories', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'META-INF'));
    fs.writeFileSync(path.join(dir, 'META-INF', 'neoforge.mods.toml'), '[[mods]]\nmodId="devmod"\nversion="0.1.0"\n');
    expect(classpathModIds([dir])).toContain('devmod');
  });

  it('disables the early loading window without corrupting CRLF fml.toml files', () => {
    const crlf = '#Should we control the window.\r\nearlyWindowControl = true\r\n#Max threads\r\nmaxThreads = -1\r\n';
    expect(disableEarlyWindowToml(crlf)).toBe('#Should we control the window.\r\nearlyWindowControl = false\r\n#Max threads\r\nmaxThreads = -1\r\n');
    expect(disableEarlyWindowToml('')).toBe('earlyWindowControl = false\n');
    expect(disableEarlyWindowToml('maxThreads = -1\n')).toBe('maxThreads = -1\nearlyWindowControl = false\n');
    expect(disableEarlyWindowToml(disableEarlyWindowToml(crlf))).toBe(disableEarlyWindowToml(crlf));
  });

  it('extracts ModDevGradle launch specs in the init script', () => {
    const script = fs.readFileSync(path.join(resources, 'gradle', 'modsmith-init.gradle'), 'utf8');
    expect(script).toContain("hasPlugin('net.neoforged.moddev')");
    expect(script).toContain('classpathProvider');
  });
});
