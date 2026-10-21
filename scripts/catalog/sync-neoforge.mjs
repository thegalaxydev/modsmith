import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareMinecraft } from './sync-fabric.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const catalogFile = path.join(root, 'resources', 'catalog', 'compatibility.json');
const ORG = 'NeoForgeMDKs';
const dryRun = process.argv.includes('--dry-run');

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
    if (m && !line.trimStart().startsWith('#')) out[m[1]] = m[2];
  }
  return out;
}

export function describeMdk(repo, files, identifier) {
  const props = properties(files.properties);
  const minecraft = props.minecraft_version;
  const neo = props.neo_version;
  if (!minecraft || !neo) throw new Error(`${repo}: gradle.properties is missing minecraft_version or neo_version`);
  const build = files.build;
  const mdg = /id\s+['"]net\.neoforged\.moddev['"]\s+version\s+['"]([^'"]+)['"]/.exec(build)?.[1];
  if (!mdg) throw new Error(`${repo}: no ModDevGradle plugin in build.gradle`);
  const java = Number(/JavaLanguageVersion\.of\((\d+)\)/.exec(build)?.[1]);
  if (!java) throw new Error(`${repo}: no Java toolchain in build.gradle`);
  const gradle = /gradle-([\d.]+)-(?:bin|all)\.zip/.exec(files.wrapper)?.[1];
  if (!gradle) throw new Error(`${repo}: no Gradle version in the wrapper`);
  const dataRun = /\bclientData\(\)/.test(build) ? 'clientData' : /\bdata\(\)/.test(build) ? 'data' : null;
  if (!dataRun) throw new Error(`${repo}: no data run in build.gradle`);
  const parchment = /\bparchment\s*\{/.test(build) && props.parchment_mappings_version ? { minecraft: props.parchment_minecraft_version ?? minecraft, version: props.parchment_mappings_version } : null;
  const modsToml = files.paths.includes('src/main/templates/META-INF/neoforge.mods.toml') ? 'neoforge.mods.toml' : files.paths.includes('src/main/templates/META-INF/mods.toml') ? 'mods.toml' : null;
  if (!modsToml) throw new Error(`${repo}: no mods.toml template`);
  const modContainer = /ModContainer\s+\w+\s*\)/.test(files.mainClass);
  const beta = /-beta$/.test(neo);
  return {
    id: `neoforge-${minecraft}`,
    schema: 1,
    loader: 'neoforge',
    minecraft,
    loaderVersion: neo,
    status: 'unverified',
    verificationNote: `Generated from ${ORG}/${repo}${beta ? ' (NeoForge beta)' : ''}. Not built yet.`,
    gradleVersion: gradle,
    plugin: { id: 'net.neoforged.moddev', version: mdg },
    mappings: parchment ? 'parchment' : 'none',
    ...(parchment ? { parchment } : {}),
    remap: false,
    javaRelease: java,
    gradleJavaMin: Math.max(21, java),
    runtimeJavaMin: java,
    neoforge: {
      modsToml,
      modContainer,
      clientEntrypoint: files.paths.some((p) => /ExampleModClient\.java$/.test(p)),
      loaderFields: 'loader_version_range' in props,
      dataRun,
      identifier
    },
    templateSource: `https://github.com/${ORG}/${repo}`,
    starters: ['empty', 'profiles'],
    bridge: { available: false }
  };
}

const BUILD_FIELDS = ['minecraft', 'loaderVersion', 'gradleVersion', 'plugin', 'mappings', 'parchment', 'remap', 'javaRelease', 'runtimeJavaMin', 'neoforge'];

export function merge(existing, generated) {
  if (!existing) return generated;
  if (existing.status === 'verified') return existing;
  const same = BUILD_FIELDS.every((k) => JSON.stringify(existing[k]) === JSON.stringify(generated[k]));
  if (same) return { ...generated, status: existing.status, verifiedOn: existing.verifiedOn, verificationNote: existing.verificationNote };
  return generated;
}

async function main() {
  const repos = [];
  for (let page = 1; ; page++) {
    const batch = await json(`https://api.github.com/orgs/${ORG}/repos?per_page=100&page=${page}`);
    repos.push(...batch.filter((r) => !r.archived && /^MDK-\d+(\.\d+)+-ModDevGradle$/.test(r.name)));
    if (batch.length < 100) break;
  }
  const catalog = JSON.parse(readFileSync(catalogFile, 'utf8'));
  const byId = new Map(catalog.entries.map((e) => [e.id, e]));
  const generated = [];
  for (const repo of repos.sort((a, b) => compareMinecraft(b.name.split('-')[1], a.name.split('-')[1]))) {
    const raw = `https://raw.githubusercontent.com/${ORG}/${repo.name}/${repo.default_branch}`;
    try {
      const tree = await json(`https://api.github.com/repos/${ORG}/${repo.name}/git/trees/${repo.default_branch}?recursive=1`);
      const paths = tree.tree.map((t) => t.path);
      const mainPath = paths.find((p) => /^src\/main\/java\/.+\/ExampleMod\.java$/.test(p));
      if (!mainPath) throw new Error(`${repo.name}: no ExampleMod.java`);
      const [props, build, wrapper, mainClass] = await Promise.all([text(`${raw}/gradle.properties`), text(`${raw}/build.gradle`), text(`${raw}/gradle/wrapper/gradle-wrapper.properties`), text(`${raw}/${mainPath}`)]);
      const minecraft = properties(props).minecraft_version;
      const identifier = byId.get(`fabric-${minecraft}`)?.fabric?.identifier ?? (byId.get(`fabric-${minecraft}`)?.mappings === 'mojang' ? 'ResourceLocation.fromNamespaceAndPath' : null);
      const entry = describeMdk(repo.name, { properties: props, build, wrapper, mainClass, paths }, identifier ?? null);
      generated.push(merge(byId.get(entry.id), entry));
      console.log(`${repo.name}: NeoForge ${entry.loaderVersion}, Java ${entry.javaRelease}, ${entry.neoforge.modsToml}, data run ${entry.neoforge.dataRun}${entry.parchment ? `, Parchment ${entry.parchment.version}` : ''}${entry.neoforge.identifier ? `, ${entry.neoforge.identifier}` : ''}`);
    } catch (err) {
      console.warn(`skipped ${err.message}`);
    }
  }
  const generatedIds = new Set(generated.map((e) => e.id));
  const kept = catalog.entries.filter((e) => e.loader === 'neoforge' && !generatedIds.has(e.id));
  const neo = [...generated, ...kept].sort((a, b) => compareMinecraft(b.minecraft, a.minecraft));
  const entries = [...catalog.entries.filter((e) => e.loader !== 'neoforge'), ...neo];
  const next = { ...catalog, entries };
  if (JSON.stringify(next.entries) !== JSON.stringify(catalog.entries)) next.updated = new Date().toISOString().slice(0, 10);
  if (dryRun) console.log(`${neo.length} NeoForge entries (dry run, nothing written)`);
  else {
    writeFileSync(catalogFile, JSON.stringify(next, null, 2) + '\n');
    console.log(`${generated.length} NeoForge entries written to ${path.relative(root, catalogFile)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
