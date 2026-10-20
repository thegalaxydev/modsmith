import { describe, expect, it } from 'vitest';
import { CompatibilityCatalog, assertGeneratable } from '../src/core/catalog';
import { findResourcesDir } from '../src/core/paths';
import { generateFabricProject, dependencyGradle, detectGradleProject } from '../src/core/adapters/fabric';
import { validateModId, validatePackage, validateDestination, suggestModId, toClassName } from '../src/core/validation';
import { tmpDir } from './helpers';
import fs from 'node:fs';
import path from 'node:path';

const catalog = new CompatibilityCatalog(findResourcesDir(__dirname));

const opts = {
  projectName: 'My Mod',
  destination: 'C:/x',
  modId: 'mymod',
  packageName: 'com.example.mymod',
  author: 'A',
  description: 'D',
  license: 'MIT',
  git: false,
  catalogEntryId: 'fabric-1.21.1',
  environment: 'both' as const,
  starters: ['empty'],
  dependencies: []
};

describe('compatibility catalog', () => {
  it('selects only verified entries unless asked', () => {
    expect(catalog.select('fabric', '1.21.1')?.id).toBe('fabric-1.21.1');
    expect(catalog.select('fabric', '26.3')).toBeNull();
    expect(catalog.select('fabric', '26.3', { allowUnverified: true })?.status).toBe('unverified');
    expect(catalog.select('forge', '1.21.1')).toBeNull();
  });

  it('refuses to generate unverified combinations', () => {
    expect(() => assertGeneratable(catalog.get('fabric-26.3')!)).toThrow(/unverified/);
    expect(() => assertGeneratable(catalog.get('fabric-1.21.1')!)).not.toThrow();
  });

  it('records the Loom JDK requirement separately from bytecode level', () => {
    const e = catalog.get('fabric-1.21.1')!;
    expect(e.gradleJavaMin).toBe(25);
    expect(e.javaRelease).toBe(21);
  });
});

describe('fabric project generation', () => {
  const entry = catalog.get('fabric-1.21.1')!;

  it('generates a minimal project with valid metadata', () => {
    const files = generateFabricProject(opts, entry);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.content.toString()]));
    const fmj = JSON.parse(byPath['src/main/resources/fabric.mod.json']);
    expect(fmj.id).toBe('mymod');
    expect(fmj.entrypoints.main).toEqual(['com.example.mymod.MyMod']);
    expect(fmj.depends.minecraft).toBe('~1.21.1');
    expect(byPath['gradle/wrapper/gradle-wrapper.properties']).toContain('gradle-9.7.1-bin.zip');
    expect(byPath['build.gradle']).toContain("id 'net.fabricmc.fabric-loom-remap'");
    expect(byPath['build.gradle']).toContain('officialMojangMappings');
    expect(byPath['build.gradle']).not.toContain('fabricApi {');
    expect(byPath['.gitignore']).toContain('.modsmith/');
    expect(files.some((f) => f.path.includes('ModItems'))).toBe(false);
  });

  it('adds starter content only when selected', () => {
    const files = generateFabricProject({ ...opts, starters: ['empty', 'item', 'block', 'command', 'config', 'datagen'] }, entry);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('src/main/java/com/example/mymod/registry/ModItems.java');
    expect(paths).toContain('src/main/resources/data/mymod/loot_table/blocks/example_block.json');
    expect(paths).toContain('src/client/java/com/example/mymod/client/datagen/ModLanguageProvider.java');
    expect(paths).not.toContain('src/main/resources/assets/mymod/lang/en_us.json');
    const build = files.find((f) => f.path === 'build.gradle')!.content.toString();
    expect(build).toContain('configureDataGeneration');
    const main = files.find((f) => f.path.endsWith('/MyMod.java'))!.content.toString();
    expect(main).toContain('ModItems.register();');
    expect(main).not.toMatch(/\/\//);
  });

  it('omits the client entrypoint for server-only mods', () => {
    const files = generateFabricProject({ ...opts, environment: 'server' }, entry);
    const fmj = JSON.parse(files.find((f) => f.path.endsWith('fabric.mod.json'))!.content.toString());
    expect(fmj.environment).toBe('server');
    expect(fmj.entrypoints.client).toBeUndefined();
  });

  it('writes compile dependencies to the integration file', () => {
    const g = dependencyGradle({ ...opts, dependencies: [{ source: 'modrinth', projectId: 'mOgUt4GM', versionId: 'abc', required: false, usage: 'compile', environment: 'client' }] }, entry);
    expect(g).toContain("modClientImplementation 'maven.modrinth:mOgUt4GM:abc'");
    expect(g).toContain("includeGroup 'maven.modrinth'");
  });
});

describe('identifier validation', () => {
  it('validates mod ids and packages', () => {
    expect(validateModId('mymod')).toBeNull();
    expect(validateModId('1mod')).not.toBeNull();
    expect(validateModId('minecraft')).not.toBeNull();
    expect(validatePackage('com.example.mymod')).toBeNull();
    expect(validatePackage('com.class.x')).toMatch(/keyword/);
    expect(validatePackage('net.minecraft.mine')).toMatch(/namespace/);
    expect(suggestModId('My Cool Mod!')).toBe('my_cool_mod');
    expect(toClassName('my cool mod')).toBe('MyCoolMod');
  });

  it('refuses non-empty destinations', () => {
    const d = tmpDir();
    expect(validateDestination(d)).toBeNull();
    fs.writeFileSync(path.join(d, 'x'), '');
    expect(validateDestination(d)).toMatch(/not empty/);
    expect(validateDestination('relative/path')).toMatch(/absolute/);
  });

  it('detects projects statically without running Gradle', () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, 'build.gradle'), "plugins { id 'net.fabricmc.fabric-loom-remap' version '1.18-SNAPSHOT' }");
    fs.writeFileSync(path.join(d, 'gradle.properties'), 'minecraft_version=1.21.1\nloader_version=0.19.5\n');
    fs.mkdirSync(path.join(d, 'src/main/resources'), { recursive: true });
    fs.writeFileSync(path.join(d, 'src/main/resources/fabric.mod.json'), JSON.stringify({ id: 'x', depends: { minecraft: '~1.21.1' } }));
    const r = detectGradleProject(d)!;
    expect(r.loader).toBe('fabric');
    expect(r.minecraftHint).toBe('1.21.1');
    expect(r.gradleWrapper).toBe(false);
    expect(r.notes.join()).toMatch(/wrapper/);
  });
});
