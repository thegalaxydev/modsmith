import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { buildIndex, checkEntry, githubRepo, readRegistry } from '../site/registry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registryDir = path.join(root, 'registry');
const USAGE = `Usage:
  node scripts/extensions.mjs pack <folder> [--out <file.zip>]
      Check an extension folder and package it as a .zip for a GitHub release.
  node scripts/extensions.mjs manifest <release asset url> [--file <local copy.zip>]
      Write registry/extensions/<id>/<version>.json for a package attached to a GitHub release.
  node scripts/extensions.mjs check [--base <git ref>] [--offline]
      Check the registry. With --base, only new versions are downloaded and verified, and approved versions must not change.
  node scripts/extensions.mjs index [<out.json>]
      Build the index the app reads (the website build does this too).`;

function args(list) {
  const out = { _: [] };
  for (let i = 0; i < list.length; i++) {
    if (list[i].startsWith('--')) {
      const key = list[i].slice(2);
      out[key] = list[i + 1] && !list[i + 1].startsWith('--') ? list[++i] : true;
    } else out._.push(list[i]);
  }
  return out;
}

async function loadCore() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modsmith-ext-'));
  try {
    const file = path.join(tmp, 'core.cjs');
    await build({ entryPoints: [path.join(root, 'scripts', 'extension-entry.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: file, logLevel: 'silent', absWorkingDir: root });
    return createRequire(import.meta.url)(file);
  } finally {
    setTimeout(() => fs.rmSync(tmp, { recursive: true, force: true }), 0);
  }
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function collect(dir, base = dir, out = {}) {
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) collect(full, base, out);
    else if (!name.endsWith('.zip')) out[path.relative(base, full).replace(/\\/g, '/')] = new Uint8Array(fs.readFileSync(full));
  }
  return out;
}

async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'modsmith-extension-registry' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

function withTemp(bytes, fn) {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'modsmith-pkg-')), 'package.zip');
  fs.writeFileSync(tmp, bytes);
  try {
    return fn(tmp);
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

function entryFrom(manifest, url, bytes) {
  const e = { id: manifest.id, version: manifest.version, name: manifest.name, publisher: manifest.publisher };
  if (manifest.description) e.description = manifest.description;
  e.repository = manifest.repository;
  if (manifest.license) e.license = manifest.license;
  Object.assign(e, { url, sha256: sha256(bytes), size: bytes.length, modsmith: manifest.modsmith, permissions: manifest.permissions });
  return e;
}

async function pack(opts) {
  const dir = opts._[1];
  if (!dir) throw new Error(USAGE);
  const core = await loadCore();
  const bytes = zipSync(collect(path.resolve(dir)), { level: 9 });
  const pkg = withTemp(bytes, (f) => core.readPackage(f));
  const m = pkg.manifest;
  const out = path.resolve(opts.out ?? path.join(dir, '..', `${m.id}-${m.version}.zip`));
  fs.writeFileSync(out, bytes);
  console.log(`Packaged ${m.name} ${m.version} (${m.id})`);
  console.log(`  file:        ${out}`);
  console.log(`  size:        ${bytes.length} bytes`);
  console.log(`  sha256:      ${sha256(bytes)}`);
  console.log(`  permissions: ${m.permissions.join(', ') || 'none'}`);
  if (!m.repository) console.log('  note: add a "repository" link to extension.json before submitting it to the Verified registry');
}

async function manifest(opts) {
  const url = opts._[1];
  if (!url) throw new Error(USAGE);
  const core = await loadCore();
  const bytes = opts.file ? new Uint8Array(fs.readFileSync(opts.file)) : await download(url);
  const m = withTemp(bytes, (f) => core.readPackage(f)).manifest;
  const e = entryFrom(m, url, bytes);
  const rel = `registry/extensions/${e.id}/${e.version}.json`;
  const problems = checkEntry(e, rel);
  if (problems.length) throw new Error(problems.join('\n'));
  const file = path.join(root, rel);
  if (fs.existsSync(file)) throw new Error(`${rel} already exists; approved versions cannot be changed, so publish a new version instead`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(e, null, 2)}\n`);
  console.log(`Wrote ${rel}. Commit it and open a pull request to submit ${e.name} ${e.version} for review.`);
}

function changedFiles(base) {
  const r = spawnSync('git', ['diff', '--name-status', '--no-renames', `${base}...HEAD`, '--', 'registry/extensions'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git diff failed: ${r.stderr}`);
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, file] = line.split('\t');
      return { status, file };
    });
}

async function check(opts) {
  const { entries, problems } = readRegistry(registryDir);
  let targets = entries;
  if (opts.base) {
    const changes = changedFiles(opts.base);
    for (const c of changes) {
      if (c.status === 'M') problems.push(`${c.file}: approved versions cannot be changed; publish a new version instead`);
      if (c.status === 'D') console.log(`Note: ${c.file} is removed, so that version is no longer listed`);
    }
    const added = new Set(changes.filter((c) => c.status === 'A').map((c) => c.file));
    targets = entries.filter((e) => added.has(e.file));
  }
  if (!opts.offline && targets.length) {
    const core = await loadCore();
    for (const e of targets) {
      try {
        const bytes = await download(e.url);
        if (bytes.length !== e.size) problems.push(`${e.file}: the package is ${bytes.length} bytes, not ${e.size}`);
        if (sha256(bytes) !== e.sha256) problems.push(`${e.file}: the package SHA-256 is ${sha256(bytes)}, not ${e.sha256}`);
        const m = withTemp(bytes, (f) => core.readPackage(f)).manifest;
        const expected = entryFrom(m, e.url, bytes);
        for (const k of ['id', 'version', 'name', 'publisher', 'description', 'license', 'modsmith']) if ((expected[k] ?? null) !== (e[k] ?? null)) problems.push(`${e.file}: ${k} is ${JSON.stringify(e[k] ?? null)} but the package says ${JSON.stringify(expected[k] ?? null)}`);
        if (githubRepo(m.repository) !== githubRepo(e.repository)) problems.push(`${e.file}: repository is ${e.repository} but the package says ${m.repository ?? 'nothing'}`);
        if (JSON.stringify([...m.permissions].sort()) !== JSON.stringify([...e.permissions].sort())) problems.push(`${e.file}: permissions are ${e.permissions.join(', ') || 'none'} but the package asks for ${m.permissions.join(', ') || 'none'}`);
        console.log(`Checked ${e.id} ${e.version}: ${m.permissions.length ? `asks for ${m.permissions.join(', ')}` : 'asks for no permissions'}, main ${m.main ?? 'none'}`);
      } catch (err) {
        problems.push(`${e.file}: ${err.message}`);
      }
    }
  }
  if (problems.length) {
    console.error(problems.map((p) => `- ${p}`).join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(`The registry is valid: ${entries.length} version${entries.length === 1 ? '' : 's'} of ${new Set(entries.map((e) => e.id)).size} extension${new Set(entries.map((e) => e.id)).size === 1 ? '' : 's'}.`);
}

function index(opts) {
  const data = `${JSON.stringify(buildIndex(registryDir), null, 2)}\n`;
  if (opts._[1]) fs.writeFileSync(path.resolve(opts._[1]), data);
  else process.stdout.write(data);
}

const opts = args(process.argv.slice(2));
const commands = { pack, manifest, check, index };
const run = commands[opts._[0]];
if (!run) {
  console.log(USAGE);
  process.exitCode = opts._[0] ? 1 : 0;
} else {
  Promise.resolve(run(opts)).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
