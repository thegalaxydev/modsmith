import type { CatalogEntry, Capability } from '../../shared/types';
import type { CompatibilityCatalog } from '../catalog';
import type { HttpClient } from '../http';
import { placeholderTexture } from '../png';
import { toClassName } from '../validation';
import type { DetectedProject, GeneratedFile, LoaderAdapter, ScaffoldOptions, StarterOption } from './types';
import { detectGradleProject, javaFile, json, lootTableDir, MIT_TEXT } from './fabric';
import { neoforgeDependencyGradle } from './neoforge';

const mavenMetadata = () => process.env.MODSMITH_FORGE_VERSIONS || 'https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json';

const STARTERS: StarterOption[] = [
  { id: 'empty', label: 'Empty mod', description: 'A @Mod entrypoint, client setup listener and mods.toml based on the Forge MDK, built with ModDevGradle Legacy.', state: 'supported' },
  { id: 'item', label: 'Example item', description: 'DeferredRegister item with model, texture, translation and creative tab entry.', state: 'supported' },
  { id: 'block', label: 'Example block', description: 'DeferredRegister block and block item with blockstate, models, texture and loot table.', state: 'supported' },
  { id: 'command', label: 'Command', description: 'Registers a /<modid> hello command through RegisterCommandsEvent.', state: 'supported' },
  { id: 'config', label: 'Configuration', description: 'ForgeConfigSpec common config in the instance config directory.', state: 'supported' },
  { id: 'datagen', label: 'Data generation', description: 'GatherDataEvent with a language provider; run it with the runData task.', state: 'supported' },
  { id: 'networking', label: 'Basic networking', description: 'Custom payload registration. Not implemented yet.', state: 'planned' },
  { id: 'bridge', label: 'Runtime development bridge', description: 'Adds the Modsmith companion mod to development instances only. Never included in the built JAR.', state: 'supported' },
  { id: 'profiles', label: 'Client and dedicated-server test profiles', description: 'Creates isolated dev-client and dev-server profiles.', state: 'supported' }
];

export function forgeDependencyGradle(opts: ScaffoldOptions): string {
  return neoforgeDependencyGradle(opts, { compile: 'modImplementation', runtime: 'modRuntimeOnly' });
}

function tomlString(s: string): string {
  return `'''${s.replace(/'''/g, "''")}'''`;
}

function nextMinecraft(minecraft: string): string {
  const parts = minecraft.split('.').map(Number);
  return parts[0] === 1 && Number.isInteger(parts[1]) ? `1.${parts[1] + 1}` : minecraft;
}

export function generateForgeProject(opts: ScaffoldOptions, entry: CatalogEntry): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const add = (p: string, content: string | Buffer) => files.push({ path: p, content });
  const id = opts.modId;
  const pkg = opts.packageName;
  const cls = toClassName(opts.projectName);
  const pkgPath = pkg.replace(/\./g, '/');
  const has = (s: string) => opts.starters.includes(s);
  const clientEnv = opts.environment !== 'server';
  const parchment = entry.parchment ?? { minecraft: entry.minecraft, version: '' };
  const loaderMajor = entry.loaderVersion.split('.')[0];
  const loaderMinor = entry.loaderVersion.split('.').slice(0, 2).join('.');

  add('settings.gradle', `pluginManagement {
\trepositories {
\t\tgradlePluginPortal()
\t}
}

plugins {
\tid 'org.gradle.toolchains.foojay-resolver-convention' version '1.0.0'
}

rootProject.name = '${id}'
`);

  add('gradle.properties', `org.gradle.jvmargs=-Xmx3G
org.gradle.daemon=true
org.gradle.parallel=true
org.gradle.caching=true

parchment_minecraft_version=${parchment.minecraft}
parchment_mappings_version=${parchment.version}
minecraft_version=${entry.minecraft}
minecraft_version_range=[${entry.minecraft},${nextMinecraft(entry.minecraft)})
forge_version=${entry.loaderVersion}
forge_version_range=[${loaderMinor},)
loader_version_range=[${loaderMajor},)

mod_id=${id}
mod_name=${opts.projectName.replace(/[\r\n]/g, ' ')}
mod_license=${opts.license}
mod_version=0.1.0
mod_group_id=${pkg}
mod_authors=${opts.author.replace(/[\r\n]/g, ' ')}
`);

  add('build.gradle', `plugins {
\tid 'java-library'
\tid 'maven-publish'
\tid '${entry.plugin.id}' version '${entry.plugin.version}'
\tid 'idea'
}

tasks.named('wrapper', Wrapper).configure {
\tdistributionType = Wrapper.DistributionType.BIN
}

version = mod_version
group = mod_group_id

sourceSets.main.resources {
\tsrcDir('src/generated/resources')
\texclude('**/*.bbmodel')
\texclude('src/generated/**/.cache')
}

base {
\tarchivesName = mod_id
}

java.toolchain.languageVersion = JavaLanguageVersion.of(${entry.javaRelease})

legacyForge {
\tversion = project.minecraft_version + '-' + project.forge_version

\tparchment {
\t\tmappingsVersion = project.parchment_mappings_version
\t\tminecraftVersion = project.parchment_minecraft_version
\t}

\truns {
\t\tclient {
\t\t\tclient()
\t\t}
\t\tserver {
\t\t\tserver()
\t\t\tprogramArgument '--nogui'
\t\t}
\t\tdata {
\t\t\tdata()
\t\t\tprogramArguments.addAll '--mod', project.mod_id, '--all', '--output', file('src/generated/resources/').getAbsolutePath(), '--existing', file('src/main/resources/').getAbsolutePath()
\t\t}
\t\tconfigureEach {
\t\t\tsystemProperty 'forge.logging.markers', 'REGISTRIES'
\t\t\tlogLevel = org.slf4j.event.Level.DEBUG
\t\t}
\t}

\tmods {
\t\t"\${mod_id}" {
\t\t\tsourceSet(sourceSets.main)
\t\t}
\t}
}

dependencies {
}

apply from: 'modsmith.dependencies.gradle'

var generateModMetadata = tasks.register('generateModMetadata', ProcessResources) {
\tvar replaceProperties = [
\t\tminecraft_version      : minecraft_version,
\t\tminecraft_version_range: minecraft_version_range,
\t\tforge_version          : forge_version,
\t\tforge_version_range    : forge_version_range,
\t\tloader_version_range   : loader_version_range,
\t\tmod_id                 : mod_id,
\t\tmod_name               : mod_name,
\t\tmod_license            : mod_license,
\t\tmod_version            : mod_version,
\t\tmod_authors            : mod_authors
\t]
\tinputs.properties replaceProperties
\texpand replaceProperties
\tfrom 'src/main/templates'
\tinto 'build/generated/sources/modMetadata'
}
sourceSets.main.resources.srcDir generateModMetadata
legacyForge.ideSyncTask generateModMetadata

publishing {
\tpublications {
\t\tregister('mavenJava', MavenPublication) {
\t\t\tfrom components.java
\t\t}
\t}
}

tasks.withType(JavaCompile).configureEach {
\toptions.encoding = 'UTF-8'
}
`);

  add('modsmith.dependencies.gradle', forgeDependencyGradle(opts));

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
.idea/
*.iml
*.ipr
*.iws
.settings/
.eclipse/
.vscode/
bin/
.classpath
.project
run/
runs/
run-data/
repo/
.modsmith/
`);

  const year = new Date().getFullYear();
  add('LICENSE', opts.license === 'MIT' ? MIT_TEXT(year, opts.author || 'the authors') : `SPDX-License-Identifier: ${opts.license}\nCopyright (c) ${year} ${opts.author || 'the authors'}\n`);
  add('README.md', `# ${opts.projectName}\n\n${opts.description}\n\n- Minecraft ${entry.minecraft}\n- Forge ${entry.loaderVersion}\n- Parchment ${parchment.version}\n\nGenerated by Modsmith from catalog entry \`${entry.id}\` (${entry.templateSource}). The build uses ModDevGradle Legacy (\`${entry.plugin.id}\`) instead of ForgeGradle.\n\nBuild with \`./gradlew build\`. The Java ${entry.javaRelease} toolchain is selected by Gradle; the foojay resolver can download it when missing. The JAR for players is in \`build/libs\`.\n`);

  const sideDep = (dep: string, range: string) => `[[dependencies.\${mod_id}]]\nmodId="${dep}"\nmandatory=true\nversionRange="${range}"\nordering="NONE"\nside="BOTH"\n`;
  const extraDeps: string[] = [];
  for (const d of opts.dependencies) {
    const key = d.source === 'modrinth' || d.source === 'curseforge' ? d.projectId : d.source === 'local' ? d.path : d.coordinates;
    const ids = opts.resolvedDependencyModIds?.[key] ?? [];
    for (const modid of ids.slice(0, 1)) extraDeps.push(`[[dependencies.\${mod_id}]]\nmodId="${modid}"\nmandatory=${d.required ? 'true' : 'false'}\nversionRange="*"\nordering="NONE"\nside="BOTH"\n`);
  }
  add('src/main/templates/META-INF/mods.toml', `modLoader="javafml"
loaderVersion="\${loader_version_range}"
license="\${mod_license}"

[[mods]]
modId="\${mod_id}"
version="\${mod_version}"
displayName="\${mod_name}"
authors="\${mod_authors}"
description=${tomlString(opts.description || opts.projectName)}

${sideDep('forge', '${forge_version_range}')}
${sideDep('minecraft', '${minecraft_version_range}')}
${extraDeps.join('\n')}`);

  add('src/main/resources/pack.mcmeta', `{\n\t"pack": {\n\t\t"description": "${id} resources",\n\t\t"pack_format": 15\n\t}\n}\n`);

  const imports = ['com.mojang.logging.LogUtils', 'net.minecraft.resources.ResourceLocation', 'net.minecraftforge.eventbus.api.IEventBus', 'net.minecraftforge.fml.common.Mod', 'net.minecraftforge.fml.javafmlmod.FMLJavaModLoadingContext', 'org.slf4j.Logger'];
  const body: string[] = [];
  if (has('item')) {
    imports.push(`${pkg}.registry.ModItems`);
    body.push('ModItems.register(modEventBus);');
  }
  if (has('block')) {
    imports.push(`${pkg}.registry.ModBlocks`);
    body.push('ModBlocks.register(modEventBus);');
  }
  if (has('command')) {
    imports.push(`${pkg}.command.ModCommands`, 'net.minecraftforge.common.MinecraftForge');
    body.push('MinecraftForge.EVENT_BUS.addListener(ModCommands::register);');
  }
  if (has('config')) {
    imports.push(`${pkg}.config.Config`, 'net.minecraftforge.fml.config.ModConfig');
    body.push('context.registerConfig(ModConfig.Type.COMMON, Config.SPEC);');
  }
  add(`src/main/java/${pkgPath}/${cls}.java`, javaFile(pkg, `
${imports.sort().map((i) => `import ${i};`).join('\n')}

@Mod(${cls}.MOD_ID)
public class ${cls} {
\tpublic static final String MOD_ID = "${id}";
\tpublic static final Logger LOGGER = LogUtils.getLogger();

\tpublic ${cls}(FMLJavaModLoadingContext context) {
\t\tIEventBus modEventBus = context.getModEventBus();
${body.map((b) => `\t\t${b}\n`).join('')}\t\tLOGGER.info("{} initialized", MOD_ID);
\t}

\tpublic static ResourceLocation id(String path) {
\t\treturn ResourceLocation.fromNamespaceAndPath(MOD_ID, path);
\t}
}
`));

  if (clientEnv) {
    add(`src/main/java/${pkgPath}/client/${cls}Client.java`, javaFile(`${pkg}.client`, `
import ${pkg}.${cls};
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.event.lifecycle.FMLClientSetupEvent;

@Mod.EventBusSubscriber(modid = ${cls}.MOD_ID, bus = Mod.EventBusSubscriber.Bus.MOD, value = Dist.CLIENT)
public final class ${cls}Client {
\tprivate ${cls}Client() {
\t}

\t@SubscribeEvent
\tpublic static void onClientSetup(FMLClientSetupEvent event) {
\t\t${cls}.LOGGER.info("{} client initialized", ${cls}.MOD_ID);
\t}
}
`));
  }

  if (has('item')) {
    add(`src/main/java/${pkgPath}/registry/ModItems.java`, javaFile(`${pkg}.registry`, `
import ${pkg}.${cls};
import net.minecraft.world.item.CreativeModeTabs;
import net.minecraft.world.item.Item;
import net.minecraftforge.event.BuildCreativeModeTabContentsEvent;
import net.minecraftforge.eventbus.api.IEventBus;
import net.minecraftforge.registries.DeferredRegister;
import net.minecraftforge.registries.ForgeRegistries;
import net.minecraftforge.registries.RegistryObject;

public final class ModItems {
\tpublic static final DeferredRegister<Item> ITEMS = DeferredRegister.create(ForgeRegistries.ITEMS, ${cls}.MOD_ID);
\tpublic static final RegistryObject<Item> EXAMPLE_ITEM = ITEMS.register("example_item", () -> new Item(new Item.Properties()));

\tprivate ModItems() {
\t}

\tpublic static void register(IEventBus modEventBus) {
\t\tITEMS.register(modEventBus);
\t\tmodEventBus.addListener(ModItems::addToCreativeTabs);
\t}

\tprivate static void addToCreativeTabs(BuildCreativeModeTabContentsEvent event) {
\t\tif (event.getTabKey() == CreativeModeTabs.INGREDIENTS) {
\t\t\tevent.accept(EXAMPLE_ITEM);
\t\t}
\t}
}
`));
    add(`src/main/resources/assets/${id}/models/item/example_item.json`, json({ parent: 'minecraft:item/generated', textures: { layer0: `${id}:item/example_item` } }));
    add(`src/main/resources/assets/${id}/textures/item/example_item.png`, placeholderTexture(`${id}:example_item`, 'item'));
  }

  if (has('block')) {
    add(`src/main/java/${pkgPath}/registry/ModBlocks.java`, javaFile(`${pkg}.registry`, `
import ${pkg}.${cls};
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.CreativeModeTabs;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.material.MapColor;
import net.minecraftforge.event.BuildCreativeModeTabContentsEvent;
import net.minecraftforge.eventbus.api.IEventBus;
import net.minecraftforge.registries.DeferredRegister;
import net.minecraftforge.registries.ForgeRegistries;
import net.minecraftforge.registries.RegistryObject;

public final class ModBlocks {
\tpublic static final DeferredRegister<Block> BLOCKS = DeferredRegister.create(ForgeRegistries.BLOCKS, ${cls}.MOD_ID);
\tpublic static final DeferredRegister<Item> BLOCK_ITEMS = DeferredRegister.create(ForgeRegistries.ITEMS, ${cls}.MOD_ID);
\tpublic static final RegistryObject<Block> EXAMPLE_BLOCK = BLOCKS.register("example_block", () -> new Block(BlockBehaviour.Properties.of().mapColor(MapColor.STONE).strength(1.5f, 6.0f).sound(SoundType.STONE)));
\tpublic static final RegistryObject<Item> EXAMPLE_BLOCK_ITEM = BLOCK_ITEMS.register("example_block", () -> new BlockItem(EXAMPLE_BLOCK.get(), new Item.Properties()));

\tprivate ModBlocks() {
\t}

\tpublic static void register(IEventBus modEventBus) {
\t\tBLOCKS.register(modEventBus);
\t\tBLOCK_ITEMS.register(modEventBus);
\t\tmodEventBus.addListener(ModBlocks::addToCreativeTabs);
\t}

\tprivate static void addToCreativeTabs(BuildCreativeModeTabContentsEvent event) {
\t\tif (event.getTabKey() == CreativeModeTabs.BUILDING_BLOCKS) {
\t\t\tevent.accept(EXAMPLE_BLOCK_ITEM);
\t\t}
\t}
}
`));
    add(`src/main/resources/assets/${id}/blockstates/example_block.json`, json({ variants: { '': { model: `${id}:block/example_block` } } }));
    add(`src/main/resources/assets/${id}/models/block/example_block.json`, json({ parent: 'minecraft:block/cube_all', textures: { all: `${id}:block/example_block` } }));
    add(`src/main/resources/assets/${id}/models/item/example_block.json`, json({ parent: `${id}:block/example_block` }));
    add(`src/main/resources/assets/${id}/textures/block/example_block.png`, placeholderTexture(`${id}:example_block`, 'block'));
    add(`src/main/resources/data/${id}/${lootTableDir(entry.minecraft)}/blocks/example_block.json`, json({ type: 'minecraft:block', pools: [{ rolls: 1, entries: [{ type: 'minecraft:item', name: `${id}:example_block` }], conditions: [{ condition: 'minecraft:survives_explosion' }] }] }));
  }

  if (has('command')) {
    add(`src/main/java/${pkgPath}/command/ModCommands.java`, javaFile(`${pkg}.command`, `
import ${pkg}.${cls};
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraftforge.event.RegisterCommandsEvent;

public final class ModCommands {
\tprivate ModCommands() {
\t}

\tpublic static void register(RegisterCommandsEvent event) {
\t\tevent.getDispatcher().register(Commands.literal(${cls}.MOD_ID).then(Commands.literal("hello").executes(context -> {
\t\t\tcontext.getSource().sendSuccess(() -> Component.literal("Hello from " + ${cls}.MOD_ID), false);
\t\t\treturn 1;
\t\t})));
\t}
}
`));
  }

  if (has('config')) {
    add(`src/main/java/${pkgPath}/config/Config.java`, javaFile(`${pkg}.config`, `
import net.minecraftforge.common.ForgeConfigSpec;

public final class Config {
\tprivate static final ForgeConfigSpec.Builder BUILDER = new ForgeConfigSpec.Builder();

\tpublic static final ForgeConfigSpec.BooleanValue EXAMPLE_TOGGLE = BUILDER.comment("An example toggle").define("exampleToggle", true);
\tpublic static final ForgeConfigSpec.IntValue EXAMPLE_NUMBER = BUILDER.comment("An example number").defineInRange("exampleNumber", 5, 0, 100);

\tpublic static final ForgeConfigSpec SPEC = BUILDER.build();

\tprivate Config() {
\t}
}
`));
  }

  if (has('datagen')) {
    const lp = ['net.minecraft.data.PackOutput', 'net.minecraftforge.common.data.LanguageProvider', `${pkg}.${cls}`];
    if (has('item')) lp.push(`${pkg}.registry.ModItems`);
    if (has('block')) lp.push(`${pkg}.registry.ModBlocks`);
    add(`src/main/java/${pkgPath}/datagen/ModLanguageProvider.java`, javaFile(`${pkg}.datagen`, `
${lp.sort().map((i) => `import ${i};`).join('\n')}

public class ModLanguageProvider extends LanguageProvider {
\tpublic ModLanguageProvider(PackOutput output) {
\t\tsuper(output, ${cls}.MOD_ID, "en_us");
\t}

\t@Override
\tprotected void addTranslations() {
${has('item') ? '\t\taddItem(ModItems.EXAMPLE_ITEM, "Example Item");\n' : ''}${has('block') ? '\t\taddBlock(ModBlocks.EXAMPLE_BLOCK, "Example Block");\n' : ''}\t\tadd("${id}.generated", "Generated by data generation");
\t}
}
`));
    add(`src/main/java/${pkgPath}/datagen/ModDataGenerators.java`, javaFile(`${pkg}.datagen`, `
import ${pkg}.${cls};
import net.minecraftforge.data.event.GatherDataEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;

@Mod.EventBusSubscriber(modid = ${cls}.MOD_ID, bus = Mod.EventBusSubscriber.Bus.MOD)
public final class ModDataGenerators {
\tprivate ModDataGenerators() {
\t}

\t@SubscribeEvent
\tpublic static void gatherData(GatherDataEvent event) {
\t\tevent.getGenerator().addProvider(event.includeClient(), new ModLanguageProvider(event.getGenerator().getPackOutput()));
\t}
}
`));
  } else if (has('item') || has('block')) {
    const translations: Record<string, string> = {};
    if (has('item')) translations[`item.${id}.example_item`] = 'Example Item';
    if (has('block')) translations[`block.${id}.example_block`] = 'Example Block';
    add(`src/main/resources/assets/${id}/lang/en_us.json`, json(translations));
  }

  return files;
}

type ForgeMetadata = Record<string, string[]>;

export class ForgeAdapter implements LoaderAdapter {
  id = 'forge' as const;
  displayName = 'Forge';
  implemented = true;

  constructor(private catalog: CompatibilityCatalog, private http: HttpClient) {}

  capabilities(): Capability[] {
    return [
      { id: 'project.generate', label: 'Project generation', state: 'supported', detail: 'Forge MDK layout built with ModDevGradle Legacy; verified catalog entries only' },
      { id: 'project.detect', label: 'Existing project detection', state: 'supported', detail: 'Static inspection of Gradle files and mods.toml' },
      { id: 'build', label: 'Gradle build', state: 'supported', detail: 'ModDevGradle Legacy projects; ForgeGradle projects can only be browsed' },
      { id: 'launch.dev.client', label: 'Development client launch', state: 'supported', detail: 'Uses the ModDevGradle Legacy run configuration through an init script' },
      { id: 'launch.dev.server', label: 'Development dedicated server', state: 'supported', detail: 'Requires explicit EULA acceptance per instance' },
      { id: 'launch.datagen', label: 'Data generation run', state: 'supported', detail: 'Runs the project runData task when configured' },
      { id: 'launch.prod.server', label: 'Production server validation', state: 'supported', detail: 'Installs the Forge server with the official installer and the reobfuscated JAR' },
      { id: 'launch.prod.client', label: 'Production client validation', state: 'planned', detail: 'Requires Microsoft authentication' },
      { id: 'modpack.dev', label: 'Modpack development launch without source', state: 'planned', detail: 'Modpack workspaces need a ModDevGradle harness; not implemented yet' },
      { id: 'bridge', label: 'Runtime bridge', state: 'supported', detail: 'Minecraft 1.20.1 only' },
      { id: 'reload.resources', label: 'Resource reload', state: 'supported', detail: 'Through the bridge' },
      { id: 'reload.datapacks', label: 'Datapack reload', state: 'supported', detail: 'Through the bridge (/reload)' },
      { id: 'reload.hotswap', label: 'Debugger hotswap', state: 'supported', detail: 'Attach a JDWP debugger; method-body changes only' }
    ];
  }

  catalogEntries(): CatalogEntry[] {
    return this.catalog.forLoader('forge');
  }

  starterOptions(entry: CatalogEntry): StarterOption[] {
    return STARTERS.map((s) => (s.state === 'supported' && !entry.starters.includes(s.id) ? { ...s, state: 'planned' as const, description: `${s.description} Not available for ${entry.id}.` } : s));
  }

  private async metadata(signal?: AbortSignal) {
    const res = await this.http.getJson<ForgeMetadata>(mavenMetadata(), { signal, maxAgeMs: 6 * 3600 * 1000 });
    if (!res.data || typeof res.data !== 'object' || Array.isArray(res.data)) throw new Error('Forge version metadata is not an object');
    return { map: res.data, fetchedAt: res.fetchedAt, stale: res.stale, error: res.error };
  }

  async listGameVersions(signal?: AbortSignal) {
    const m = await this.metadata(signal);
    return { versions: Object.keys(m.map).reverse().map((version) => ({ version, stable: true })), fetchedAt: m.fetchedAt, stale: m.stale, error: m.error };
  }

  async listLoaderVersions(minecraft: string, signal?: AbortSignal) {
    const m = await this.metadata(signal);
    const list = Array.isArray(m.map[minecraft]) ? [...m.map[minecraft]].reverse() : [];
    const prefix = `${minecraft}-`;
    return { versions: list.map((v) => ({ version: v.startsWith(prefix) ? v.slice(prefix.length) : v, stable: true })), fetchedAt: m.fetchedAt, stale: m.stale, error: m.error };
  }

  generateProject(opts: ScaffoldOptions, entry: CatalogEntry): GeneratedFile[] {
    return generateForgeProject(opts, entry);
  }

  detectProject(dir: string): DetectedProject | null {
    return detectGradleProject(dir);
  }

  runTaskNames() {
    return { client: 'runClient', server: 'runServer', datagen: 'runData' };
  }
}
