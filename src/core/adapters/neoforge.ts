import type { CatalogEntry, Capability } from '../../shared/types';
import type { CompatibilityCatalog } from '../catalog';
import type { HttpClient } from '../http';
import { placeholderTexture } from '../png';
import { toClassName } from '../validation';
import type { DetectedProject, GeneratedFile, LoaderAdapter, ScaffoldOptions, StarterOption } from './types';
import { detectGradleProject, javaFile, json, lootTableDir, MIT_TEXT } from './fabric';

const mavenVersions = () => process.env.MODSMITH_NEOFORGE_VERSIONS || 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';

const STARTERS: StarterOption[] = [
  { id: 'empty', label: 'Empty mod', description: 'A @Mod entrypoint, client entrypoint and neoforge.mods.toml generated from the MDK template.', state: 'supported' },
  { id: 'item', label: 'Example item', description: 'DeferredRegister item with model, texture, translation and creative tab entry.', state: 'supported' },
  { id: 'block', label: 'Example block', description: 'DeferredRegister block and block item with blockstate, models, texture and loot table.', state: 'supported' },
  { id: 'command', label: 'Command', description: 'Registers a /<modid> hello command through RegisterCommandsEvent.', state: 'supported' },
  { id: 'config', label: 'Configuration', description: 'ModConfigSpec common config with an in-game configuration screen.', state: 'supported' },
  { id: 'datagen', label: 'Data generation', description: 'GatherDataEvent with a language provider; run it with the runData task.', state: 'supported' },
  { id: 'networking', label: 'Basic networking', description: 'Custom payload registration. Not implemented yet.', state: 'planned' },
  { id: 'bridge', label: 'Runtime development bridge', description: 'Adds the Modsmith companion mod to development instances only. Never included in the built JAR.', state: 'supported' },
  { id: 'profiles', label: 'Client and dedicated-server test profiles', description: 'Creates isolated dev-client and dev-server profiles.', state: 'supported' }
];

export function neoforgeDependencyGradle(opts: ScaffoldOptions, names = { compile: 'implementation', runtime: 'localRuntime' }): string {
  const lines: string[] = [];
  const repos = new Set<string>();
  for (const d of opts.dependencies) {
    if (d.source === 'modrinth' && d.usage === 'compile') {
      lines.push(`\t${names.compile} '${opts.mavenCoordinates?.[d.projectId] ?? `maven.modrinth:${d.projectId}:${d.versionId ?? ''}`}'`);
    } else if (d.source === 'maven') {
      if (d.repository) repos.add(d.repository);
      lines.push(`\t${d.usage === 'compile' ? names.compile : names.runtime} '${d.coordinates}'`);
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

function tomlString(s: string): string {
  return `'''${s.replace(/'''/g, "''")}'''`;
}

export function generateNeoForgeProject(opts: ScaffoldOptions, entry: CatalogEntry): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const add = (p: string, content: string | Buffer) => files.push({ path: p, content });
  const id = opts.modId;
  const pkg = opts.packageName;
  const cls = toClassName(opts.projectName);
  const pkgPath = pkg.replace(/\./g, '/');
  const has = (s: string) => opts.starters.includes(s);
  const clientEnv = opts.environment !== 'server';
  const datagen = has('datagen');
  const parchment = entry.parchment ?? { minecraft: entry.minecraft, version: '' };
  const style = entry.neoforge ?? { modsToml: 'neoforge.mods.toml', modContainer: true, clientEntrypoint: true, loaderFields: true, dataRun: 'data', identifier: 'ResourceLocation.fromNamespaceAndPath' };
  const useParchment = !!entry.parchment || !entry.neoforge;

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

  add('gradle.properties', `org.gradle.jvmargs=-Xmx2G
org.gradle.daemon=true
org.gradle.parallel=true
org.gradle.caching=true
org.gradle.configuration-cache=true

${useParchment ? `parchment_minecraft_version=${parchment.minecraft}\nparchment_mappings_version=${parchment.version}\n` : ''}minecraft_version=${entry.minecraft}
minecraft_version_range=[${entry.minecraft}]
neo_version=${entry.loaderVersion}
${style.loaderFields ? 'loader_version_range=[1,)\n' : ''}
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

neoForge {
\tversion = project.neo_version

${useParchment ? '\tparchment {\n\t\tmappingsVersion = project.parchment_mappings_version\n\t\tminecraftVersion = project.parchment_minecraft_version\n\t}\n\n' : ''}\truns {
\t\tclient {
\t\t\tclient()
\t\t\tsystemProperty 'neoforge.enabledGameTestNamespaces', project.mod_id
\t\t}
\t\tserver {
\t\t\tserver()
\t\t\tprogramArgument '--nogui'
\t\t\tsystemProperty 'neoforge.enabledGameTestNamespaces', project.mod_id
\t\t}
\t\tgameTestServer {
\t\t\ttype = 'gameTestServer'
\t\t\tsystemProperty 'neoforge.enabledGameTestNamespaces', project.mod_id
\t\t}
\t\tdata {
\t\t\t${style.dataRun}()
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

configurations {
\truntimeClasspath.extendsFrom localRuntime
}

dependencies {
}

apply from: 'modsmith.dependencies.gradle'

var generateModMetadata = tasks.register('generateModMetadata', ProcessResources) {
\tvar replaceProperties = [
\t\tminecraft_version      : minecraft_version,
\t\tminecraft_version_range: minecraft_version_range,
\t\tneo_version            : neo_version,
${style.loaderFields ? '\t\tloader_version_range   : loader_version_range,\n' : ''}\t\tmod_id                 : mod_id,
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
neoForge.ideSyncTask generateModMetadata

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

  add('modsmith.dependencies.gradle', neoforgeDependencyGradle(opts));

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
  add('README.md', `# ${opts.projectName}\n\n${opts.description}\n\n- Minecraft ${entry.minecraft}\n- NeoForge ${entry.loaderVersion}\n${useParchment ? `- Parchment ${parchment.version}\n` : ''}\nGenerated by Modsmith from catalog entry \`${entry.id}\` (${entry.templateSource}).\n\nBuild with \`./gradlew build\`. The Java ${entry.javaRelease} toolchain is selected by Gradle; the foojay resolver can download it when missing.\n`);

  const sideDep = (dep: string, range: string) => `[[dependencies.\${mod_id}]]\nmodId="${dep}"\ntype="required"\nversionRange="${range}"\nordering="NONE"\nside="BOTH"\n`;
  const extraDeps: string[] = [];
  for (const d of opts.dependencies) {
    const key = d.source === 'modrinth' || d.source === 'curseforge' ? d.projectId : d.source === 'local' ? d.path : d.coordinates;
    const ids = opts.resolvedDependencyModIds?.[key] ?? [];
    for (const modid of ids.slice(0, 1)) extraDeps.push(`[[dependencies.\${mod_id}]]\nmodId="${modid}"\ntype="${d.required ? 'required' : 'optional'}"\nversionRange="*"\nordering="NONE"\nside="BOTH"\n`);
  }
  add(`src/main/templates/META-INF/${style.modsToml}`, `${style.loaderFields ? 'modLoader="javafml"\nloaderVersion="${loader_version_range}"\n' : ''}license="\${mod_license}"

[[mods]]
modId="\${mod_id}"
version="\${mod_version}"
displayName="\${mod_name}"
authors="\${mod_authors}"
description=${tomlString(opts.description || opts.projectName)}

${sideDep('neoforge', '[${neo_version},)')}
${sideDep('minecraft', '${minecraft_version_range}')}
${extraDeps.join('\n')}`);

  const idClass = style.identifier ? style.identifier.split('.')[0] : null;
  const imports = ['com.mojang.logging.LogUtils', 'net.neoforged.bus.api.IEventBus', 'net.neoforged.fml.common.Mod', 'org.slf4j.Logger'];
  if (idClass) imports.push(`net.minecraft.resources.${idClass}`);
  if (style.modContainer) imports.push('net.neoforged.fml.ModContainer');
  const idFn = !idClass ? '' : style.identifier === 'ResourceLocation.new' ? '\n\tpublic static ResourceLocation id(String path) {\n\t\treturn new ResourceLocation(MOD_ID, path);\n\t}\n' : `\n\tpublic static ${idClass} id(String path) {\n\t\treturn ${idClass}.fromNamespaceAndPath(MOD_ID, path);\n\t}\n`;
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
    imports.push(`${pkg}.command.ModCommands`, 'net.neoforged.neoforge.common.NeoForge');
    body.push('NeoForge.EVENT_BUS.addListener(ModCommands::register);');
  }
  if (has('config')) {
    imports.push(`${pkg}.config.Config`, 'net.neoforged.fml.config.ModConfig');
    body.push('modContainer.registerConfig(ModConfig.Type.COMMON, Config.SPEC);');
  }
  add(`src/main/java/${pkgPath}/${cls}.java`, javaFile(pkg, `
${[...new Set(imports)].sort().map((i) => `import ${i};`).join('\n')}

@Mod(${cls}.MOD_ID)
public class ${cls} {
\tpublic static final String MOD_ID = "${id}";
\tpublic static final Logger LOGGER = LogUtils.getLogger();

\tpublic ${cls}(${style.modContainer ? 'IEventBus modEventBus, ModContainer modContainer' : 'IEventBus modEventBus'}) {
${body.map((b) => `\t\t${b}`).join('\n')}${body.length ? '\n' : ''}\t\tLOGGER.info("{} initialized", MOD_ID);
\t}
${idFn}}
`));

  if (clientEnv && style.clientEntrypoint) {
    const clientImports = ['net.neoforged.api.distmarker.Dist', 'net.neoforged.fml.ModContainer', 'net.neoforged.fml.common.Mod', `${pkg}.${cls}`];
    let ctor = '';
    if (has('config')) {
      clientImports.push('net.neoforged.neoforge.client.gui.ConfigurationScreen', 'net.neoforged.neoforge.client.gui.IConfigScreenFactory');
      ctor = '\t\tcontainer.registerExtensionPoint(IConfigScreenFactory.class, ConfigurationScreen::new);\n';
    }
    add(`src/main/java/${pkgPath}/client/${cls}Client.java`, javaFile(`${pkg}.client`, `
${clientImports.sort().map((i) => `import ${i};`).join('\n')}

@Mod(value = ${cls}.MOD_ID, dist = Dist.CLIENT)
public class ${cls}Client {
\tpublic ${cls}Client(ModContainer container) {
${ctor}\t}
}
`));
  }

  if (has('item')) {
    add(`src/main/java/${pkgPath}/registry/ModItems.java`, javaFile(`${pkg}.registry`, `
import ${pkg}.${cls};
import net.minecraft.world.item.CreativeModeTabs;
import net.minecraft.world.item.Item;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.neoforge.event.BuildCreativeModeTabContentsEvent;
import net.neoforged.neoforge.registries.DeferredItem;
import net.neoforged.neoforge.registries.DeferredRegister;

public final class ModItems {
\tpublic static final DeferredRegister.Items ITEMS = DeferredRegister.createItems(${cls}.MOD_ID);
\tpublic static final DeferredItem<Item> EXAMPLE_ITEM = ITEMS.registerSimpleItem("example_item", new Item.Properties());

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
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.material.MapColor;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.neoforge.event.BuildCreativeModeTabContentsEvent;
import net.neoforged.neoforge.registries.DeferredBlock;
import net.neoforged.neoforge.registries.DeferredItem;
import net.neoforged.neoforge.registries.DeferredRegister;

public final class ModBlocks {
\tpublic static final DeferredRegister.Blocks BLOCKS = DeferredRegister.createBlocks(${cls}.MOD_ID);
\tpublic static final DeferredRegister.Items BLOCK_ITEMS = DeferredRegister.createItems(${cls}.MOD_ID);
\tpublic static final DeferredBlock<Block> EXAMPLE_BLOCK = BLOCKS.registerSimpleBlock("example_block", BlockBehaviour.Properties.of().mapColor(MapColor.STONE).strength(1.5f, 6.0f).sound(SoundType.STONE));
\tpublic static final DeferredItem<BlockItem> EXAMPLE_BLOCK_ITEM = BLOCK_ITEMS.registerSimpleBlockItem("example_block", EXAMPLE_BLOCK);

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
import net.neoforged.neoforge.event.RegisterCommandsEvent;

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
import net.neoforged.neoforge.common.ModConfigSpec;

public final class Config {
\tprivate static final ModConfigSpec.Builder BUILDER = new ModConfigSpec.Builder();

\tpublic static final ModConfigSpec.BooleanValue EXAMPLE_TOGGLE = BUILDER.comment("An example toggle").define("exampleToggle", true);
\tpublic static final ModConfigSpec.IntValue EXAMPLE_NUMBER = BUILDER.comment("An example number").defineInRange("exampleNumber", 5, 0, 100);

\tpublic static final ModConfigSpec SPEC = BUILDER.build();

\tprivate Config() {
\t}
}
`));
  }

  const translations: Record<string, string> = {};
  if (has('item')) translations[`item.${id}.example_item`] = 'Example Item';
  if (has('block')) translations[`block.${id}.example_block`] = 'Example Block';
  if (has('config')) {
    translations[`${id}.configuration.title`] = `${opts.projectName} Configs`;
    translations[`${id}.configuration.section.${id}.common.toml`] = `${opts.projectName} Configs`;
    translations[`${id}.configuration.section.${id}.common.toml.title`] = `${opts.projectName} Configs`;
    translations[`${id}.configuration.exampleToggle`] = 'Example toggle';
    translations[`${id}.configuration.exampleNumber`] = 'Example number';
  }

  if (datagen) {
    const lp = ['net.minecraft.data.PackOutput', 'net.neoforged.neoforge.common.data.LanguageProvider', `${pkg}.${cls}`];
    if (has('item')) lp.push(`${pkg}.registry.ModItems`);
    if (has('block')) lp.push(`${pkg}.registry.ModBlocks`);
    const lines = Object.entries(translations)
      .filter(([k]) => !k.startsWith('item.') && !k.startsWith('block.'))
      .map(([k, v]) => `\t\tadd("${k}", "${v.replace(/"/g, '\\"')}");`);
    add(`src/main/java/${pkgPath}/datagen/ModLanguageProvider.java`, javaFile(`${pkg}.datagen`, `
${lp.sort().map((i) => `import ${i};`).join('\n')}

public class ModLanguageProvider extends LanguageProvider {
\tpublic ModLanguageProvider(PackOutput output) {
\t\tsuper(output, ${cls}.MOD_ID, "en_us");
\t}

\t@Override
\tprotected void addTranslations() {
${has('item') ? '\t\taddItem(ModItems.EXAMPLE_ITEM, "Example Item");\n' : ''}${has('block') ? '\t\taddBlock(ModBlocks.EXAMPLE_BLOCK, "Example Block");\n' : ''}${lines.join('\n')}${lines.length ? '\n' : ''}\t\tadd("${id}.generated", "Generated by data generation");
\t}
}
`));
    add(`src/main/java/${pkgPath}/datagen/ModDataGenerators.java`, javaFile(`${pkg}.datagen`, `
import ${pkg}.${cls};
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.data.event.GatherDataEvent;

@EventBusSubscriber(modid = ${cls}.MOD_ID, bus = EventBusSubscriber.Bus.MOD)
public final class ModDataGenerators {
\tprivate ModDataGenerators() {
\t}

\t@SubscribeEvent
\tpublic static void gatherData(GatherDataEvent event) {
\t\tevent.getGenerator().addProvider(event.includeClient(), new ModLanguageProvider(event.getGenerator().getPackOutput()));
\t}
}
`));
  } else if (Object.keys(translations).length) {
    add(`src/main/resources/assets/${id}/lang/en_us.json`, json(translations));
  }

  return files;
}

function mcFromNeo(v: string): string | null {
  const m = v.match(/^(\d+)\.(\d+)\./);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major < 20 || major > 21) return null;
  return minor === 0 ? `1.${major}` : `1.${major}.${minor}`;
}

export class NeoForgeAdapter implements LoaderAdapter {
  id = 'neoforge' as const;
  displayName = 'NeoForge';
  implemented = true;

  constructor(private catalog: CompatibilityCatalog, private http: HttpClient) {}

  capabilities(): Capability[] {
    return [
      { id: 'project.generate', label: 'Project generation', state: 'supported', detail: 'ModDevGradle MDK layout; verified catalog entries only' },
      { id: 'project.detect', label: 'Existing project detection', state: 'supported', detail: 'Static inspection of Gradle files and neoforge.mods.toml' },
      { id: 'build', label: 'Gradle build', state: 'supported' },
      { id: 'launch.dev.client', label: 'Development client launch', state: 'supported', detail: 'Uses the ModDevGradle run configuration through an init script' },
      { id: 'launch.dev.server', label: 'Development dedicated server', state: 'supported', detail: 'Requires explicit EULA acceptance per instance' },
      { id: 'launch.datagen', label: 'Data generation run', state: 'supported', detail: 'Runs the project runData task when configured' },
      { id: 'launch.prod.server', label: 'Production server validation', state: 'supported', detail: 'Installs the NeoForge server with the official installer and the built JAR' },
      { id: 'launch.prod.client', label: 'Production client validation', state: 'planned', detail: 'Requires Microsoft authentication' },
      { id: 'modpack.dev', label: 'Modpack development launch without source', state: 'planned', detail: 'Modpack workspaces need a ModDevGradle harness; not implemented yet' },
      { id: 'bridge', label: 'Runtime bridge', state: 'supported', detail: 'Minecraft 1.21.1 only' },
      { id: 'reload.resources', label: 'Resource reload', state: 'supported', detail: 'Through the bridge' },
      { id: 'reload.datapacks', label: 'Datapack reload', state: 'supported', detail: 'Through the bridge (/reload)' },
      { id: 'reload.hotswap', label: 'Debugger hotswap', state: 'supported', detail: 'Attach a JDWP debugger; method-body changes only' }
    ];
  }

  catalogEntries(): CatalogEntry[] {
    return this.catalog.forLoader('neoforge');
  }

  starterOptions(entry: CatalogEntry): StarterOption[] {
    return STARTERS.map((s) => (s.state === 'supported' && !entry.starters.includes(s.id) ? { ...s, state: 'planned' as const, description: `${s.description} Not available for ${entry.id}.` } : s));
  }

  private async versions(signal?: AbortSignal) {
    const res = await this.http.getJson<{ versions: string[] }>(mavenVersions(), { signal, maxAgeMs: 6 * 3600 * 1000 });
    return { list: res.data.versions, fetchedAt: res.fetchedAt, stale: res.stale, error: res.error };
  }

  async listGameVersions(signal?: AbortSignal) {
    const v = await this.versions(signal);
    const games = [...new Set(v.list.map(mcFromNeo).filter((x): x is string => !!x))].reverse();
    return { versions: games.map((version) => ({ version, stable: true })), fetchedAt: v.fetchedAt, stale: v.stale, error: v.error };
  }

  async listLoaderVersions(minecraft: string, signal?: AbortSignal) {
    const v = await this.versions(signal);
    const list = v.list.filter((x) => mcFromNeo(x) === minecraft).reverse();
    return { versions: list.map((version) => ({ version, stable: !/beta|alpha/.test(version) })), fetchedAt: v.fetchedAt, stale: v.stale, error: v.error };
  }

  generateProject(opts: ScaffoldOptions, entry: CatalogEntry): GeneratedFile[] {
    return generateNeoForgeProject(opts, entry);
  }

  detectProject(dir: string): DetectedProject | null {
    return detectGradleProject(dir);
  }

  runTaskNames() {
    return { client: 'runClient', server: 'runServer', datagen: 'runData' };
  }
}
