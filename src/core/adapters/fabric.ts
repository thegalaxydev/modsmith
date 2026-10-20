import fs from 'node:fs';
import path from 'node:path';
import type { CatalogEntry, Capability } from '../../shared/types';
import type { CompatibilityCatalog } from '../catalog';
import type { HttpClient } from '../http';
import { placeholderTexture } from '../png';
import { toClassName } from '../validation';
import type { DetectedProject, GeneratedFile, LoaderAdapter, ScaffoldOptions, StarterOption } from './types';

const meta = () => process.env.MODSMITH_FABRIC_META || 'https://meta.fabricmc.net/v2';

const STARTERS: StarterOption[] = [
  { id: 'empty', label: 'Empty mod', description: 'Main and client entrypoints, metadata, mixin configs and an icon.', state: 'supported' },
  { id: 'item', label: 'Example item', description: 'Registers an item with model, texture, translation and creative tab entry.', state: 'supported' },
  { id: 'block', label: 'Example block', description: 'Registers a block and block item with blockstate, models, texture and loot table.', state: 'supported' },
  { id: 'command', label: 'Command', description: 'Registers a /<modid> hello command through Fabric API.', state: 'supported' },
  { id: 'config', label: 'Configuration', description: 'JSON config file in the instance config directory, loaded at startup.', state: 'supported' },
  { id: 'datagen', label: 'Data generation', description: 'Fabric data generation entrypoint with a language provider and the runDatagen task.', state: 'supported', requires: ['client-environment'] },
  { id: 'networking', label: 'Basic networking', description: 'Custom payload registration. Not implemented yet.', state: 'planned' },
  { id: 'bridge', label: 'Runtime development bridge', description: 'Adds the Modsmith companion mod to development instances only. Never included in the built JAR.', state: 'supported' },
  { id: 'profiles', label: 'Client and dedicated-server test profiles', description: 'Creates isolated dev-client and dev-server profiles.', state: 'supported' }
];

export function javaFile(pkg: string, body: string): string {
  return `package ${pkg};\n\n${body.trim()}\n`;
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, '\t') + '\n';
}

export const MIT_TEXT = (year: number, author: string) => `MIT License

Copyright (c) ${year} ${author}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

export function dependencyGradle(opts: ScaffoldOptions, entry: CatalogEntry): string {
  const modPrefix = entry.remap ? 'mod' : '';
  const lines: string[] = [];
  const repos = new Set<string>();
  for (const d of opts.dependencies) {
    if (d.source === 'modrinth' && d.usage === 'compile') {
      const coords = opts.mavenCoordinates?.[d.projectId] ?? `maven.modrinth:${d.projectId}:${d.versionId ?? ''}`;
      const conf = d.environment === 'client' ? `${modPrefix}${modPrefix ? 'Client' : 'client'}Implementation` : `${modPrefix}${modPrefix ? 'Implementation' : 'implementation'}`;
      lines.push(`\t${conf} '${coords}'`);
    } else if (d.source === 'maven') {
      if (d.repository) repos.add(d.repository);
      const conf = d.usage === 'compile' ? `${modPrefix}${modPrefix ? 'Implementation' : 'implementation'}` : entry.remap ? 'modLocalRuntime' : 'localRuntime';
      lines.push(`\t${conf} '${d.coordinates}'`);
    }
  }
  const repoBlock = [...repos].map((r) => `\tmaven {\n\t\turl = '${r}'\n\t}`).join('\n');
  return `repositories {
\texclusiveContent {
\t\tforRepository {
\t\t\tmaven {
\t\t\t\tname = 'Modrinth'
\t\t\t\turl = 'https://api.modrinth.com/maven'
\t\t\t}
\t\t}
\t\tfilter {
\t\t\tincludeGroup 'maven.modrinth'
\t\t}
\t}
${repoBlock}
}

dependencies {
${lines.join('\n')}
}
`;
}

export function generateFabricProject(opts: ScaffoldOptions, entry: CatalogEntry): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const add = (p: string, content: string | Buffer, executable = false) => files.push({ path: p, content, executable });
  const id = opts.modId;
  const pkg = opts.packageName;
  const cls = toClassName(opts.projectName);
  const pkgPath = pkg.replace(/\./g, '/');
  const has = (s: string) => opts.starters.includes(s);
  const clientEnv = opts.environment !== 'server';
  const datagen = has('datagen') && clientEnv;
  const impl = (s: string) => (entry.remap ? `mod${s[0].toUpperCase()}${s.slice(1)}` : s);
  const javaLevel = `JAVA_${entry.javaRelease}`;

  add('settings.gradle', `pluginManagement {
\trepositories {
\t\tmaven {
\t\t\tname = 'Fabric'
\t\t\turl = 'https://maven.fabricmc.net/'
\t\t}
\t\tmavenCentral()
\t\tgradlePluginPortal()
\t}
}

rootProject.name = '${id}'
`);

  add('gradle.properties', `org.gradle.jvmargs=-Xmx2G
org.gradle.parallel=true
org.gradle.configuration-cache=true

minecraft_version=${entry.minecraft}
loader_version=${entry.loaderVersion}
loom_version=${entry.plugin.version}

version=0.1.0
group=${pkg}

fabric_api_version=${entry.fabricApiVersion}
`);

  const mappingsLine = entry.mappings === 'mojang' ? '\tmappings loom.officialMojangMappings()\n' : '';
  const datagenBlock = datagen ? `\nfabricApi {\n\tconfigureDataGeneration {\n\t\tclient = true\n\t}\n}\n` : '';
  add('build.gradle', `plugins {
\tid '${entry.plugin.id}' version "\${loom_version}"
\tid 'maven-publish'
}

repositories {
}

loom {
\tsplitEnvironmentSourceSets()

\tmods {
\t\t"${id}" {
\t\t\tsourceSet sourceSets.main
\t\t\tsourceSet sourceSets.client
\t\t}
\t}
}
${datagenBlock}
dependencies {
\tminecraft "com.mojang:minecraft:\${project.minecraft_version}"
${mappingsLine}\t${impl('implementation')} "net.fabricmc:fabric-loader:\${project.loader_version}"
\t${impl('implementation')} "net.fabricmc.fabric-api:fabric-api:\${project.fabric_api_version}"
}

apply from: 'modsmith.dependencies.gradle'

processResources {
\tdef version = project.version
\tinputs.property "version", version

\tfilesMatching("fabric.mod.json") {
\t\texpand "version": version
\t}
}

tasks.withType(JavaCompile).configureEach {
\tit.options.release = ${entry.javaRelease}
}

java {
\twithSourcesJar()

\tsourceCompatibility = JavaVersion.VERSION_${entry.javaRelease}
\ttargetCompatibility = JavaVersion.VERSION_${entry.javaRelease}
}

jar {
\tdef projectName = project.name
\tinputs.property "projectName", projectName

\tfrom("LICENSE") {
\t\trename { "\${it}_$projectName" }
\t}
}

publishing {
\tpublications {
\t\tcreate("mavenJava", MavenPublication) {
\t\t\tfrom components.java
\t\t}
\t}
}
`);
  add('modsmith.dependencies.gradle', dependencyGradle(opts, entry));

  add('gradle/wrapper/gradle-wrapper.properties', `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-${entry.gradleVersion}-bin.zip
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`);

  add('.gitignore', `.gradle/
build/
out/
classes/
*.launch
.idea/
*.iml
*.ipr
*.iws
.settings/
.vscode/
bin/
.classpath
.project
*.DS_Store
run/
hs_err_*.log
replay_*.log
*.hprof
*.jfr
.modsmith/
`);

  const year = new Date().getFullYear();
  add('LICENSE', opts.license === 'MIT' ? MIT_TEXT(year, opts.author || 'the authors') : `SPDX-License-Identifier: ${opts.license}\nCopyright (c) ${year} ${opts.author || 'the authors'}\n`);

  add('README.md', `# ${opts.projectName}\n\n${opts.description}\n\n- Minecraft ${entry.minecraft}\n- Fabric Loader ${entry.loaderVersion}\n- Fabric API ${entry.fabricApiVersion}\n\nGenerated by Modsmith from catalog entry \`${entry.id}\` (${entry.templateSource}).\n\nBuild with \`./gradlew build\`. Gradle must run on Java ${entry.gradleJavaMin} or newer; the mod targets Java ${entry.javaRelease}.\n`);

  const initCalls: string[] = [];
  const imports: string[] = ['net.fabricmc.api.ModInitializer', 'net.minecraft.resources.ResourceLocation', 'org.slf4j.Logger', 'org.slf4j.LoggerFactory'];
  if (has('config')) {
    imports.push(`${pkg}.config.ModConfig`);
    initCalls.push('ModConfig.load();');
  }
  if (has('item')) {
    imports.push(`${pkg}.registry.ModItems`);
    initCalls.push('ModItems.register();');
  }
  if (has('block')) {
    imports.push(`${pkg}.registry.ModBlocks`);
    initCalls.push('ModBlocks.register();');
  }
  if (has('command')) {
    imports.push(`${pkg}.command.ModCommands`);
    initCalls.push('ModCommands.register();');
  }
  const idFn = entry.mappings === 'mojang'
    ? `\tpublic static ResourceLocation id(String path) {\n\t\treturn ResourceLocation.fromNamespaceAndPath(MOD_ID, path);\n\t}`
    : '';
  const mainImports = entry.mappings === 'mojang' ? imports : imports.filter((i) => !i.includes('ResourceLocation'));
  add(`src/main/java/${pkgPath}/${cls}.java`, javaFile(pkg, `
${mainImports.sort().map((i) => `import ${i};`).join('\n')}

public class ${cls} implements ModInitializer {
\tpublic static final String MOD_ID = "${id}";
\tpublic static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

\t@Override
\tpublic void onInitialize() {
${initCalls.map((c) => `\t\t${c}`).join('\n')}${initCalls.length ? '\n' : ''}\t\tLOGGER.info("{} initialized", MOD_ID);
\t}
${idFn ? '\n' + idFn + '\n' : ''}}
`));

  if (clientEnv) {
    add(`src/client/java/${pkgPath}/client/${cls}Client.java`, javaFile(`${pkg}.client`, `
import net.fabricmc.api.ClientModInitializer;

public class ${cls}Client implements ClientModInitializer {
\t@Override
\tpublic void onInitializeClient() {
\t}
}
`));
  }

  if (has('item')) {
    add(`src/main/java/${pkgPath}/registry/ModItems.java`, javaFile(`${pkg}.registry`, `
import ${pkg}.${cls};
import net.fabricmc.fabric.api.itemgroup.v1.ItemGroupEvents;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.item.CreativeModeTabs;
import net.minecraft.world.item.Item;

public final class ModItems {
\tpublic static final Item EXAMPLE_ITEM = Registry.register(BuiltInRegistries.ITEM, ${cls}.id("example_item"), new Item(new Item.Properties()));

\tprivate ModItems() {
\t}

\tpublic static void register() {
\t\tItemGroupEvents.modifyEntriesEvent(CreativeModeTabs.INGREDIENTS).register(entries -> entries.accept(EXAMPLE_ITEM));
\t}
}
`));
    add(`src/main/resources/assets/${id}/models/item/example_item.json`, json({ parent: 'minecraft:item/generated', textures: { layer0: `${id}:item/example_item` } }));
    add(`src/main/resources/assets/${id}/textures/item/example_item.png`, placeholderTexture(`${id}:example_item`, 'item'));
  }

  if (has('block')) {
    add(`src/main/java/${pkgPath}/registry/ModBlocks.java`, javaFile(`${pkg}.registry`, `
import ${pkg}.${cls};
import net.fabricmc.fabric.api.itemgroup.v1.ItemGroupEvents;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.CreativeModeTabs;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.state.BlockBehaviour;

public final class ModBlocks {
\tpublic static final Block EXAMPLE_BLOCK = Registry.register(BuiltInRegistries.BLOCK, ${cls}.id("example_block"), new Block(BlockBehaviour.Properties.of().strength(1.5f, 6.0f).sound(SoundType.STONE)));
\tpublic static final Item EXAMPLE_BLOCK_ITEM = Registry.register(BuiltInRegistries.ITEM, ${cls}.id("example_block"), new BlockItem(EXAMPLE_BLOCK, new Item.Properties()));

\tprivate ModBlocks() {
\t}

\tpublic static void register() {
\t\tItemGroupEvents.modifyEntriesEvent(CreativeModeTabs.BUILDING_BLOCKS).register(entries -> entries.accept(EXAMPLE_BLOCK_ITEM));
\t}
}
`));
    add(`src/main/resources/assets/${id}/blockstates/example_block.json`, json({ variants: { '': { model: `${id}:block/example_block` } } }));
    add(`src/main/resources/assets/${id}/models/block/example_block.json`, json({ parent: 'minecraft:block/cube_all', textures: { all: `${id}:block/example_block` } }));
    add(`src/main/resources/assets/${id}/models/item/example_block.json`, json({ parent: `${id}:block/example_block` }));
    add(`src/main/resources/assets/${id}/textures/block/example_block.png`, placeholderTexture(`${id}:example_block`, 'block'));
    add(`src/main/resources/data/${id}/loot_table/blocks/example_block.json`, json({ type: 'minecraft:block', pools: [{ rolls: 1, entries: [{ type: 'minecraft:item', name: `${id}:example_block` }], conditions: [{ condition: 'minecraft:survives_explosion' }] }] }));
  }

  if (has('command')) {
    add(`src/main/java/${pkgPath}/command/ModCommands.java`, javaFile(`${pkg}.command`, `
import ${pkg}.${cls};
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;

public final class ModCommands {
\tprivate ModCommands() {
\t}

\tpublic static void register() {
\t\tCommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> dispatcher.register(
\t\t\tCommands.literal(${cls}.MOD_ID).then(Commands.literal("hello").executes(context -> {
\t\t\t\tcontext.getSource().sendSuccess(() -> Component.literal("Hello from " + ${cls}.MOD_ID), false);
\t\t\t\treturn 1;
\t\t\t}))
\t\t));
\t}
}
`));
  }

  if (has('config')) {
    add(`src/main/java/${pkgPath}/config/ModConfig.java`, javaFile(`${pkg}.config`, `
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonParseException;
import ${pkg}.${cls};
import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.nio.file.Files;
import java.nio.file.Path;
import net.fabricmc.loader.api.FabricLoader;

public final class ModConfig {
\tprivate static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
\tprivate static ModConfig instance = new ModConfig();

\tpublic boolean exampleToggle = true;
\tpublic int exampleNumber = 5;

\tpublic static ModConfig get() {
\t\treturn instance;
\t}

\tpublic static Path path() {
\t\treturn FabricLoader.getInstance().getConfigDir().resolve(${cls}.MOD_ID + ".json");
\t}

\tpublic static void load() {
\t\tPath file = path();
\t\ttry {
\t\t\tif (Files.exists(file)) {
\t\t\t\ttry (Reader reader = Files.newBufferedReader(file)) {
\t\t\t\t\tModConfig loaded = GSON.fromJson(reader, ModConfig.class);
\t\t\t\t\tif (loaded != null) {
\t\t\t\t\t\tinstance = loaded;
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t\tsave();
\t\t} catch (IOException | JsonParseException e) {
\t\t\t${cls}.LOGGER.error("Failed to load config {}", file, e);
\t\t}
\t}

\tpublic static void save() throws IOException {
\t\tFiles.createDirectories(path().getParent());
\t\ttry (Writer writer = Files.newBufferedWriter(path())) {
\t\t\tGSON.toJson(instance, writer);
\t\t}
\t}
}
`));
  }

  const translations: Record<string, string> = {};
  if (has('item')) translations[`item.${id}.example_item`] = 'Example Item';
  if (has('block')) translations[`block.${id}.example_block`] = 'Example Block';

  if (datagen) {
    const dgImports = [
      'java.util.concurrent.CompletableFuture',
      'net.fabricmc.fabric.api.datagen.v1.FabricDataOutput',
      'net.fabricmc.fabric.api.datagen.v1.provider.FabricLanguageProvider',
      'net.minecraft.core.HolderLookup'
    ];
    if (has('item')) dgImports.push(`${pkg}.registry.ModItems`);
    if (has('block')) dgImports.push(`${pkg}.registry.ModBlocks`);
    add(`src/client/java/${pkgPath}/client/datagen/${cls}DataGenerator.java`, javaFile(`${pkg}.client.datagen`, `
import net.fabricmc.fabric.api.datagen.v1.DataGeneratorEntrypoint;
import net.fabricmc.fabric.api.datagen.v1.FabricDataGenerator;

public class ${cls}DataGenerator implements DataGeneratorEntrypoint {
\t@Override
\tpublic void onInitializeDataGenerator(FabricDataGenerator generator) {
\t\tFabricDataGenerator.Pack pack = generator.createPack();
\t\tpack.addProvider(ModLanguageProvider::new);
\t}
}
`));
    add(`src/client/java/${pkgPath}/client/datagen/ModLanguageProvider.java`, javaFile(`${pkg}.client.datagen`, `
${dgImports.sort().map((i) => `import ${i};`).join('\n')}

public class ModLanguageProvider extends FabricLanguageProvider {
\tpublic ModLanguageProvider(FabricDataOutput output, CompletableFuture<HolderLookup.Provider> registries) {
\t\tsuper(output, registries);
\t}

\t@Override
\tpublic void generateTranslations(HolderLookup.Provider registries, TranslationBuilder builder) {
${has('item') ? '\t\tbuilder.add(ModItems.EXAMPLE_ITEM, "Example Item");\n' : ''}${has('block') ? '\t\tbuilder.add(ModBlocks.EXAMPLE_BLOCK, "Example Block");\n' : ''}\t\tbuilder.add("${id}.generated", "Generated by data generation");
\t}
}
`));
  } else if (Object.keys(translations).length) {
    add(`src/main/resources/assets/${id}/lang/en_us.json`, json(translations));
  }

  add(`src/main/resources/assets/${id}/icon.png`, placeholderTexture(`${id}:icon`, 'block'));
  add(`src/main/resources/${id}.mixins.json`, json({ required: true, package: `${pkg}.mixin`, compatibilityLevel: javaLevel, mixins: [], injectors: { defaultRequire: 1 }, overwrites: { requireAnnotations: true } }));
  if (clientEnv) {
    add(`src/client/resources/${id}.client.mixins.json`, json({ required: true, package: `${pkg}.client.mixin`, compatibilityLevel: javaLevel, client: [], injectors: { defaultRequire: 1 }, overwrites: { requireAnnotations: true } }));
  }

  const depends: Record<string, string> = {
    fabricloader: `>=${entry.loaderVersion}`,
    minecraft: `~${entry.minecraft}`,
    java: `>=${entry.javaRelease}`,
    'fabric-api': '*'
  };
  const recommends: Record<string, string> = {};
  for (const d of opts.dependencies) {
    const key = d.source === 'modrinth' || d.source === 'curseforge' ? d.projectId : d.source === 'local' ? d.path : d.coordinates;
    const ids = opts.resolvedDependencyModIds?.[key] ?? [];
    for (const modid of ids.slice(0, 1)) {
      if (d.required) depends[modid] = '*';
      else recommends[modid] = '*';
    }
  }
  const entrypoints: Record<string, string[]> = { main: [`${pkg}.${cls}`] };
  if (clientEnv) entrypoints.client = [`${pkg}.client.${cls}Client`];
  if (datagen) entrypoints['fabric-datagen'] = [`${pkg}.client.datagen.${cls}DataGenerator`];
  const mixins: unknown[] = [`${id}.mixins.json`];
  if (clientEnv) mixins.push({ config: `${id}.client.mixins.json`, environment: 'client' });
  const fmj: Record<string, unknown> = {
    schemaVersion: 1,
    id,
    version: '${version}',
    name: opts.projectName,
    description: opts.description,
    authors: opts.author ? [opts.author] : [],
    contact: {},
    license: opts.license,
    icon: `assets/${id}/icon.png`,
    environment: opts.environment === 'both' ? '*' : opts.environment,
    entrypoints,
    mixins,
    depends
  };
  if (Object.keys(recommends).length) fmj.recommends = recommends;
  add('src/main/resources/fabric.mod.json', json(fmj));
  return files;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export function detectGradleProject(dir: string): DetectedProject | null {
  const buildFiles = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.properties'].filter((f) => fs.existsSync(path.join(dir, f)));
  const hasGradle = buildFiles.some((f) => f.startsWith('build.gradle') || f.startsWith('settings.gradle'));
  const props = readText(path.join(dir, 'gradle.properties'));
  const prop = (k: string) => props.match(new RegExp(`^\\s*${k}\\s*=\\s*(.+)$`, 'm'))?.[1]?.trim();
  const buildText = buildFiles.filter((f) => f.startsWith('build') || f.startsWith('settings')).map((f) => readText(path.join(dir, f))).join('\n');
  const loaderPlugins: string[] = [];
  const pluginPatterns: [RegExp, string][] = [
    [/net\.fabricmc\.fabric-loom-remap/, 'net.fabricmc.fabric-loom-remap'],
    [/['"]net\.fabricmc\.fabric-loom['"]/, 'net.fabricmc.fabric-loom'],
    [/['"]fabric-loom['"]/, 'fabric-loom'],
    [/dev\.architectury\.loom/, 'dev.architectury.loom'],
    [/net\.neoforged\.moddev/, 'net.neoforged.moddev'],
    [/net\.neoforged\.gradle/, 'net.neoforged.gradle'],
    [/net\.minecraftforge\.gradle/, 'net.minecraftforge.gradle'],
    [/org\.quiltmc\.loom/, 'org.quiltmc.loom']
  ];
  for (const [re, id] of pluginPatterns) if (re.test(buildText)) loaderPlugins.push(id);
  const modMetadata: DetectedProject['modMetadata'] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 6) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (['build', '.gradle', 'run', 'node_modules', '.git', '.modsmith', 'out', 'bin'].includes(e.name)) continue;
        walk(path.join(d, e.name), depth + 1);
      } else if (e.name === 'fabric.mod.json' || e.name === 'neoforge.mods.toml' || e.name === 'mods.toml') {
        const full = path.join(d, e.name);
        if (!/[\\/]resources[\\/]/.test(full)) continue;
        const text = readText(full);
        let modId: string | undefined;
        let minecraft: string | undefined;
        if (e.name === 'fabric.mod.json') {
          try {
            const j = JSON.parse(text);
            modId = j.id;
            minecraft = j.depends?.minecraft;
          } catch {
            void 0;
          }
        } else {
          modId = text.match(/modId\s*=\s*"([^"$]+)"/)?.[1];
        }
        modMetadata.push({ file: path.relative(dir, full), id: modId, minecraft });
      }
    }
  };
  walk(dir, 0);
  if (!hasGradle && modMetadata.length === 0) return null;
  const notes: string[] = [];
  let loader: DetectedProject['loader'] = 'unknown';
  const fabricish = loaderPlugins.some((p) => p.includes('fabric-loom') || p === 'fabric-loom');
  const neo = loaderPlugins.some((p) => p.startsWith('net.neoforged'));
  const forge = loaderPlugins.includes('net.minecraftforge.gradle');
  const kinds = [fabricish, neo, forge, loaderPlugins.includes('dev.architectury.loom'), loaderPlugins.includes('org.quiltmc.loom')].filter(Boolean).length;
  if (fabricish) loader = 'fabric';
  else if (neo) loader = 'neoforge';
  else if (forge) loader = 'forge';
  if (loaderPlugins.includes('dev.architectury.loom')) notes.push('Architectury Loom detected. Multi-loader layouts are not supported yet; subprojects must be inspected manually.');
  if (loaderPlugins.includes('org.quiltmc.loom')) notes.push('Quilt Loom detected. Quilt is not a supported loader.');
  if (!loaderPlugins.length && hasGradle) notes.push('No known loader Gradle plugin was found in the root build files. Plugins may be declared in subprojects, version catalogs or convention plugins.');
  if (fs.existsSync(path.join(dir, 'gradle', 'libs.versions.toml'))) notes.push('A Gradle version catalog is present; versions may be declared there.');
  if (!fs.existsSync(path.join(dir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'))) notes.push('No Gradle wrapper script found. Builds require a Gradle wrapper.');
  if (loader === 'forge') notes.push('Forge projects can be browsed and edited, but build and launch adapters for this loader are not implemented yet.');
  if (loaderPlugins.includes('net.neoforged.gradle')) notes.push('NeoGradle detected. Build and launch are implemented for ModDevGradle (net.neoforged.moddev) projects only.');
  return {
    loader,
    buildSystem: hasGradle ? 'gradle' : 'none',
    gradleWrapper: fs.existsSync(path.join(dir, 'gradlew.bat')) || fs.existsSync(path.join(dir, 'gradlew')),
    buildFiles,
    modMetadata,
    loaderPlugins,
    minecraftHint: prop('minecraft_version') ?? modMetadata.find((m) => m.minecraft)?.minecraft,
    loaderVersionHint: prop('loader_version') ?? prop('neo_version') ?? prop('forge_version'),
    notes,
    ambiguous: kinds > 1 || (hasGradle && loader === 'unknown')
  };
}

export class FabricAdapter implements LoaderAdapter {
  id = 'fabric' as const;
  displayName = 'Fabric';
  implemented = true;

  constructor(private catalog: CompatibilityCatalog, private http: HttpClient) {}

  capabilities(): Capability[] {
    return [
      { id: 'project.generate', label: 'Project generation', state: 'supported', detail: 'Verified catalog entries only' },
      { id: 'project.detect', label: 'Existing project detection', state: 'supported', detail: 'Static inspection of Gradle files and fabric.mod.json' },
      { id: 'build', label: 'Gradle build', state: 'supported' },
      { id: 'launch.dev.client', label: 'Development client launch', state: 'supported', detail: 'Uses Loom launch configuration through an init script' },
      { id: 'launch.dev.server', label: 'Development dedicated server', state: 'supported', detail: 'Requires explicit EULA acceptance per instance' },
      { id: 'launch.datagen', label: 'Data generation run', state: 'supported', detail: 'Runs the project runDatagen task when configured' },
      { id: 'launch.prod.server', label: 'Production server validation', state: 'supported', detail: 'Installs the Fabric server with the official installer and the remapped JAR' },
      { id: 'launch.prod.client', label: 'Production client validation', state: 'planned', detail: 'Requires Loom production run tasks with Microsoft authentication' },
      { id: 'bridge', label: 'Runtime bridge', state: 'supported', detail: 'Minecraft 1.21.1 only' },
      { id: 'reload.resources', label: 'Resource reload', state: 'supported', detail: 'Through the bridge' },
      { id: 'reload.datapacks', label: 'Datapack reload', state: 'supported', detail: 'Through the bridge (/reload)' },
      { id: 'reload.hotswap', label: 'Debugger hotswap', state: 'supported', detail: 'Attach a JDWP debugger; method-body changes only' },
      { id: 'mrpack', label: '.mrpack import/export', state: 'supported' }
    ];
  }

  catalogEntries(): CatalogEntry[] {
    return this.catalog.forLoader('fabric');
  }

  starterOptions(entry: CatalogEntry): StarterOption[] {
    return STARTERS.map((s) => (s.state === 'supported' && !entry.starters.includes(s.id) ? { ...s, state: 'planned' as const, description: `${s.description} Not available for ${entry.id}.` } : s));
  }

  async listGameVersions(signal?: AbortSignal) {
    const res = await this.http.getJson<{ version: string; stable: boolean }[]>(`${meta()}/versions/game`, { signal, maxAgeMs: 6 * 3600 * 1000 });
    return { versions: res.data, fetchedAt: res.fetchedAt, stale: res.stale, error: res.error };
  }

  async listLoaderVersions(minecraft: string, signal?: AbortSignal) {
    const res = await this.http.getJson<{ loader: { version: string; stable: boolean } }[]>(`${meta()}/versions/loader/${encodeURIComponent(minecraft)}`, { signal, maxAgeMs: 6 * 3600 * 1000 });
    return { versions: res.data.map((d) => d.loader), fetchedAt: res.fetchedAt, stale: res.stale, error: res.error };
  }

  generateProject(opts: ScaffoldOptions, entry: CatalogEntry): GeneratedFile[] {
    return generateFabricProject(opts, entry);
  }

  detectProject(dir: string): DetectedProject | null {
    return detectGradleProject(dir);
  }

  runTaskNames() {
    return { client: 'runClient', server: 'runServer', datagen: 'runDatagen' };
  }
}

export class PlannedAdapter implements LoaderAdapter {
  implemented = false;

  constructor(public id: 'neoforge' | 'forge', public displayName: string, private catalog: CompatibilityCatalog) {}

  capabilities(): Capability[] {
    return [
      { id: 'project.detect', label: 'Existing project detection', state: 'supported', detail: 'Static inspection only' },
      { id: 'project.generate', label: 'Project generation', state: 'planned', detail: `${this.displayName} adapter is not implemented yet` },
      { id: 'build', label: 'Gradle build', state: 'planned' },
      { id: 'launch.dev.client', label: 'Development client launch', state: 'planned' },
      { id: 'bridge', label: 'Runtime bridge', state: 'planned' }
    ];
  }

  catalogEntries(): CatalogEntry[] {
    return this.catalog.forLoader(this.id);
  }

  starterOptions(): StarterOption[] {
    return [];
  }

  async listGameVersions() {
    return { versions: [], fetchedAt: Date.now(), stale: false, error: `${this.displayName} metadata is not implemented yet` };
  }

  async listLoaderVersions() {
    return { versions: [], fetchedAt: Date.now(), stale: false, error: `${this.displayName} metadata is not implemented yet` };
  }

  generateProject(): GeneratedFile[] {
    throw new Error(`${this.displayName} project generation is not implemented`);
  }

  detectProject(dir: string): DetectedProject | null {
    return detectGradleProject(dir);
  }

  runTaskNames() {
    return { client: 'runClient', server: 'runServer' };
  }
}
