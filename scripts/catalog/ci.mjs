import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const catalogFile = path.join(root, 'resources', 'catalog', 'compatibility.json');
const catalog = () => JSON.parse(readFileSync(catalogFile, 'utf8'));

const LOADERS = ['fabric', 'neoforge'];

function list(filter = 'all') {
  const entries = catalog().entries.filter((e) => LOADERS.includes(e.loader));
  const words = filter.split(/[\s,]+/).filter(Boolean);
  const wanted = entries.filter((e) => words.some((w) => w === 'all' || w === e.id || w === e.loader || (w === 'untested' && e.status === 'unverified')));
  if (!wanted.length) throw new Error(`No catalog entries match "${filter}"`);
  console.log(`ids=${JSON.stringify(wanted.map((e) => e.id))}`);
}

async function generator() {
  const { build } = await import('esbuild');
  const out = path.join(os.tmpdir(), `modsmith-generator-${process.pid}.mjs`);
  await build({
    stdin: { contents: "export { generateFabricProject } from './src/core/adapters/fabric';\nexport { generateNeoForgeProject } from './src/core/adapters/neoforge';", resolveDir: root, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: out,
    logLevel: 'error'
  });
  return import(pathToFileURL(out).href);
}

async function generate(id, outDir) {
  const entry = catalog().entries.find((e) => e.id === id);
  if (!entry) throw new Error(`Unknown catalog entry ${id}`);
  const { generateFabricProject, generateNeoForgeProject } = await generator();
  const dir = path.resolve(outDir, id);
  const opts = {
    projectName: 'Catalog Check',
    destination: dir,
    modId: 'catalogcheck',
    packageName: 'dev.modsmith.catalogcheck',
    author: 'Modsmith',
    description: `Build check for ${id}`,
    license: 'MIT',
    git: false,
    catalogEntryId: id,
    environment: 'both',
    starters: ['empty'],
    dependencies: []
  };
  for (const f of (entry.loader === 'neoforge' ? generateNeoForgeProject : generateFabricProject)(opts, entry)) {
    const target = path.join(dir, f.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, f.content);
  }
  const wrapper = path.join(root, 'resources', 'templates', 'gradle-wrapper');
  for (const f of ['gradlew', 'gradlew.bat', path.join('gradle', 'wrapper', 'gradle-wrapper.jar')]) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    copyFileSync(path.join(wrapper, f), path.join(dir, f));
  }
  chmodSync(path.join(dir, 'gradlew'), 0o755);
  console.log(`Generated ${id} in ${dir}`);
}

function results(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
}

function javaLabel(java) {
  const m = /(?:temurin|jdk|jre)-?(\d+)/i.exec(java ?? '') ?? /jre1\.(8)/i.exec(java ?? '');
  return m ? `Java ${m[1]}` : 'the selected Java';
}

const built = (r) => r.ok || ['launch', 'title screen', 'stop'].includes(r.stage);

function outcome(r) {
  if (r.ok) return `reached the title screen in ${r.readyAfter}s`;
  if (built(r)) return `**built, but ${r.stage === 'stop' ? 'did not stop cleanly' : 'did not reach the title screen'}**`;
  return `**failed at ${r.stage}**`;
}

function report(dir, outFile) {
  const all = results(dir);
  const byId = new Map(catalog().entries.map((e) => [e.id, e]));
  const order = (r) => catalog().entries.findIndex((e) => e.id === r.id);
  all.sort((a, b) => order(a) - order(b));
  const launched = all.filter((r) => r.ok).length;
  const md = [`## Catalog checks: ${all.filter(built).length} of ${all.length} built, ${launched} reached the title screen`, '', '| Entry | Bytecode Java | Runtime | Result | Total time |', '| --- | --- | --- | --- | --- |'];
  for (const r of all) md.push(`| ${r.id} | ${byId.get(r.id)?.javaRelease ?? ''} | ${(r.java ?? '').replace(/^Java: /, '').replace(/\|/g, '/')} | ${outcome(r)} | ${r.seconds ?? ''}s |`);
  for (const r of all.filter((x) => !x.ok)) md.push('', `### ${r.id}`, '', '```', (r.error ?? '').slice(-3000), '```');
  console.log(md.join('\n'));
  if (outFile) writeFileSync(outFile, JSON.stringify(all, null, 2) + '\n');
}

function apply(file) {
  const all = JSON.parse(readFileSync(file, 'utf8'));
  const data = catalog();
  let changed = 0;
  for (const r of all) {
    const e = data.entries.find((x) => x.id === r.id);
    if (!e || e.status === 'verified') continue;
    const branch = /tree\/(.+)$/.exec(e.templateSource)?.[1] ?? e.minecraft;
    const source = e.loader === 'neoforge' ? `Generated from ${new URL(e.templateSource).pathname.slice(1)}${/-beta$/.test(e.loaderVersion) ? ' (NeoForge beta)' : ''}.` : `Generated from FabricMC/fabric-example-mod branch ${branch}.`;
    if (r.ok) {
      e.status = 'tested';
      e.verifiedOn = r.date;
      e.verificationNote = `${source} In CI on ${r.date} an empty project built (Gradle on JDK 25) and its development client reached the title screen on Linux with ${javaLabel(r.java)}. Starter code beyond the empty mod is not tested.`;
    } else if (built(r)) {
      e.status = 'tested';
      e.verifiedOn = r.date;
      e.verificationNote = `${source} In CI on ${r.date} an empty project built, but its development client did not reach the title screen on Linux.`;
    } else {
      e.status = 'unverified';
      delete e.verifiedOn;
      e.verificationNote = `${source} The empty project failed in CI on ${r.date} (${r.stage}).`;
    }
    changed++;
  }
  data.updated = new Date().toISOString().slice(0, 10);
  writeFileSync(catalogFile, JSON.stringify(data, null, 2) + '\n');
  console.log(`Updated ${changed} entries`);
}

const [cmd, ...args] = process.argv.slice(2);
const commands = { list: () => list(args[0]), generate: () => generate(args[0], args[1] ?? 'out'), report: () => report(args[0], args[1]), apply: () => apply(args[0]) };
if (!commands[cmd]) {
  console.error('Usage: node scripts/catalog/ci.mjs list [all|untested|ids] | generate <id> [dir] | report <dir> [out.json] | apply <results.json>');
  process.exit(2);
}
Promise.resolve(commands[cmd]()).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
