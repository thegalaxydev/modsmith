import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const catalogFile = path.join(root, 'resources', 'catalog', 'compatibility.json');
const catalog = () => JSON.parse(readFileSync(catalogFile, 'utf8'));

function list(filter = 'all') {
  const fabric = catalog().entries.filter((e) => e.loader === 'fabric');
  const wanted = filter === 'all' ? fabric : filter === 'untested' ? fabric.filter((e) => e.status === 'unverified') : fabric.filter((e) => filter.split(/[\s,]+/).includes(e.id));
  if (!wanted.length) throw new Error(`No Fabric catalog entries match "${filter}"`);
  console.log(`ids=${JSON.stringify(wanted.map((e) => e.id))}`);
}

async function generator() {
  const out = path.join(os.tmpdir(), `modsmith-generator-${process.pid}.mjs`);
  await build({
    stdin: { contents: "export { generateFabricProject } from './src/core/adapters/fabric';", resolveDir: root, loader: 'ts' },
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
  const { generateFabricProject } = await generator();
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
  for (const f of generateFabricProject(opts, entry)) {
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

function record(id, code, seconds, logFile, outFile) {
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  const lines = log.split(/\r?\n/);
  const errorAt = lines.findIndex((l) => /^\* What went wrong:|error:|FAILURE:/.test(l));
  const tail = errorAt >= 0 ? lines.slice(errorAt, errorAt + 25) : lines.slice(-25);
  const gradle = /Gradle ([\d.]+)/.exec(log)?.[1] ?? null;
  const result = { id, ok: Number(code) === 0, seconds: Number(seconds) || null, gradle, java: process.env.JAVA_VERSION ?? null, date: new Date().toISOString().slice(0, 10), error: Number(code) === 0 ? null : tail.join('\n').slice(0, 4000) };
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');
  console.log(`${id}: ${result.ok ? 'built' : 'failed'} in ${result.seconds}s`);
}

function results(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')));
}

function report(dir, outFile) {
  const all = results(dir);
  const byId = new Map(catalog().entries.map((e) => [e.id, e]));
  const order = (r) => catalog().entries.findIndex((e) => e.id === r.id);
  all.sort((a, b) => order(a) - order(b));
  const ok = all.filter((r) => r.ok).length;
  const md = [`## Catalog builds: ${ok} of ${all.length} built`, '', '| Entry | Java | Result | Time |', '| --- | --- | --- | --- |'];
  for (const r of all) md.push(`| ${r.id} | ${byId.get(r.id)?.javaRelease ?? ''} | ${r.ok ? 'built' : '**failed**'} | ${r.seconds ?? ''}s |`);
  for (const r of all.filter((x) => !x.ok)) md.push('', `### ${r.id}`, '', '```', r.error ?? '', '```');
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
    if (r.ok) {
      e.status = 'tested';
      e.verifiedOn = r.date;
      e.verificationNote = `Generated from FabricMC/fabric-example-mod branch ${branch}. An empty project built in CI on ${r.date} (Gradle ${r.gradle ?? e.gradleVersion}, JDK 25). Starter code and launching have not been tested.`;
    } else {
      e.status = 'unverified';
      delete e.verifiedOn;
      e.verificationNote = `Generated from FabricMC/fabric-example-mod branch ${branch}. The empty project failed to build in CI on ${r.date}.`;
    }
    changed++;
  }
  data.updated = new Date().toISOString().slice(0, 10);
  writeFileSync(catalogFile, JSON.stringify(data, null, 2) + '\n');
  console.log(`Updated ${changed} entries`);
}

const [cmd, ...args] = process.argv.slice(2);
const commands = { list: () => list(args[0]), generate: () => generate(args[0], args[1] ?? 'out'), record: () => record(...args), report: () => report(args[0], args[1]), apply: () => apply(args[0]) };
if (!commands[cmd]) {
  console.error('Usage: node scripts/catalog/ci.mjs list [all|untested|ids] | generate <id> [dir] | record <id> <code> <seconds> <log> <out> | report <dir> [out.json] | apply <results.json>');
  process.exit(2);
}
Promise.resolve(commands[cmd]()).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
