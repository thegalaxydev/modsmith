import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const catalogFile = path.join(root, 'resources', 'catalog', 'compatibility.json');
const REPO = 'FabricMC/fabric-example-mod';
const RAW = `https://raw.githubusercontent.com/${REPO}`;
const OLDEST = '1.14.4';
const dryRun = process.argv.includes('--dry-run');

export function compareMinecraft(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

async function text(url) {
  const headers = { 'User-Agent': 'modsmith-catalog-sync' };
  if (url.startsWith('https://api.github.com/') && process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function json(url) {
  return JSON.parse(await text(url));
}

function properties(src) {
  const out = {};
  for (const line of src.split(/\r?\n/)) {
    const m = /^\s*([\w.]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function describeBranch(branch, files, javaMajor) {
  const props = properties(files.properties);
  const build = files.build;
  const plugin = /id\s+['"](net\.fabricmc\.fabric-loom(?:-remap)?)['"]/.exec(build)?.[1];
  if (!plugin) throw new Error(`${branch}: no Fabric Loom plugin in build.gradle`);
  if (/\byarn\b|mappings\s+["']net\.fabricmc:yarn/.test(build)) throw new Error(`${branch}: uses Yarn mappings, which Modsmith does not generate`);
  const release = Number(/options\.release\s*=\s*(\d+)/.exec(build)?.[1]);
  if (!release) throw new Error(`${branch}: no Java release in build.gradle`);
  const gradle = /gradle-([\d.]+)-(?:bin|all)\.zip/.exec(files.wrapper)?.[1];
  if (!gradle) throw new Error(`${branch}: no Gradle version in the wrapper`);
  const mod = files.mainClass;
  const identifier = /Identifier\.fromNamespaceAndPath/.test(mod)
    ? 'Identifier.fromNamespaceAndPath'
    : /ResourceLocation\.fromNamespaceAndPath/.test(mod)
      ? 'ResourceLocation.fromNamespaceAndPath'
      : /new ResourceLocation\(/.test(mod)
        ? 'ResourceLocation.new'
        : null;
  if (!identifier) throw new Error(`${branch}: could not tell how the example mod builds identifiers`);
  const minecraft = props.minecraft_version;
  const fabricApi = props.fabric_api_version ?? props.fabric_version;
  if (!minecraft || !props.loader_version || !props.loom_version || !fabricApi) throw new Error(`${branch}: gradle.properties is missing a version`);
  const mojang = /officialMojangMappings\(\)/.test(build);
  return {
    id: `fabric-${minecraft}`,
    schema: 1,
    loader: 'fabric',
    minecraft,
    loaderVersion: props.loader_version,
    status: 'unverified',
    verificationNote: `Generated from ${REPO} branch ${branch}. Not built yet.`,
    gradleVersion: gradle,
    plugin: { id: plugin, version: props.loom_version },
    mappings: mojang ? 'mojang' : 'none',
    remap: plugin.endsWith('-remap'),
    javaRelease: release,
    gradleJavaMin: 25,
    runtimeJavaMin: Math.max(javaMajor ?? release, release),
    fabricApiVersion: fabricApi,
    fabric: {
      splitSources: /splitEnvironmentSourceSets\(\)/.test(build),
      logger: /org\.apache\.logging\.log4j/.test(mod) ? 'log4j' : 'slf4j',
      identifier
    },
    templateSource: `https://github.com/${REPO}/tree/${branch}`,
    starters: ['empty', 'profiles'],
    bridge: { available: false }
  };
}

const BUILD_FIELDS = ['minecraft', 'loaderVersion', 'gradleVersion', 'plugin', 'mappings', 'remap', 'javaRelease', 'runtimeJavaMin', 'fabricApiVersion', 'fabric'];

export function merge(existing, generated) {
  if (!existing) return generated;
  if (existing.status === 'verified') return existing;
  const same = BUILD_FIELDS.every((k) => JSON.stringify(existing[k]) === JSON.stringify(generated[k]));
  if (same) return { ...generated, status: existing.status, verifiedOn: existing.verifiedOn, verificationNote: existing.verificationNote };
  return generated;
}

async function mainClass(branch) {
  const direct = await fetch(`${RAW}/${branch}/src/main/java/com/example/ExampleMod.java`);
  if (direct.ok) return direct.text();
  const tree = await json(`https://api.github.com/repos/${REPO}/git/trees/${branch}?recursive=1`);
  const file = tree.tree.map((t) => t.path).find((p) => /^src\/main\/java\/.+\/ExampleMod\.java$/.test(p));
  if (!file) throw new Error(`${branch}: no ExampleMod.java`);
  return text(`${RAW}/${branch}/${file}`);
}

async function javaMajors() {
  const manifest = await json('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  return new Map(manifest.versions.map((v) => [v.id, v.url]));
}

async function main() {
  const branches = (await json(`https://api.github.com/repos/${REPO}/branches?per_page=100`)).map((b) => b.name).filter((b) => /^\d+\.\d+(\.\d+)?$/.test(b) && compareMinecraft(b, OLDEST) >= 0);
  const versions = await javaMajors();
  const catalog = JSON.parse(readFileSync(catalogFile, 'utf8'));
  const byId = new Map(catalog.entries.map((e) => [e.id, e]));
  const generated = [];
  for (const branch of branches.sort(compareMinecraft).reverse()) {
    const [props, build, wrapper, mod] = await Promise.all([
      text(`${RAW}/${branch}/gradle.properties`),
      text(`${RAW}/${branch}/build.gradle`),
      text(`${RAW}/${branch}/gradle/wrapper/gradle-wrapper.properties`),
      mainClass(branch)
    ]);
    const versionUrl = versions.get(properties(props).minecraft_version);
    const javaMajor = versionUrl ? (await json(versionUrl)).javaVersion?.majorVersion : undefined;
    try {
      const entry = describeBranch(branch, { properties: props, build, wrapper, mainClass: mod }, javaMajor);
      generated.push(merge(byId.get(entry.id), entry));
      console.log(`${branch}: Java ${entry.javaRelease}, ${entry.plugin.id}, ${entry.fabric.logger}, ${entry.fabric.identifier}${entry.fabric.splitSources ? ', split sources' : ''}`);
    } catch (err) {
      console.warn(`skipped ${err.message}`);
    }
  }
  const generatedIds = new Set(generated.map((e) => e.id));
  const others = catalog.entries.filter((e) => e.loader !== 'fabric' || !generatedIds.has(e.id));
  const fabricOthers = others.filter((e) => e.loader === 'fabric');
  const rest = others.filter((e) => e.loader !== 'fabric');
  const entries = [...[...generated, ...fabricOthers].sort((a, b) => compareMinecraft(b.minecraft, a.minecraft)), ...rest];
  const next = { ...catalog, entries };
  if (JSON.stringify(next.entries) !== JSON.stringify(catalog.entries)) next.updated = new Date().toISOString().slice(0, 10);
  const out = JSON.stringify(next, null, 2) + '\n';
  if (dryRun) console.log(`${entries.length} entries (dry run, nothing written)`);
  else {
    writeFileSync(catalogFile, out);
    console.log(`${generated.length} Fabric entries written to ${path.relative(root, catalogFile)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
