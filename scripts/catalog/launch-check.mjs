import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const READY = /Sound engine started|Created: \d+x\d+x\d+ minecraft:textures\/atlas/;
const [bin, entryId, workArg, outFile] = process.argv.slice(2);
if (!bin || !entryId || !workArg) {
  console.error('Usage: node scripts/catalog/launch-check.mjs <modsmith-service binary> <catalog entry> <work dir> [result.json]');
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const work = path.resolve(workArg, entryId);
const resources = path.join(work, 'resources');
const env = { ...process.env, MODSMITH_DATA_DIR: path.join(work, 'data'), MODSMITH_RESOURCES_DIR: resources };
const project = path.join(work, 'project');
const started = Date.now();
const result = { id: entryId, ok: false, stage: 'service', seconds: null, java: null, readyAfter: null, error: null, date: new Date().toISOString().slice(0, 10) };

function cli(method, params = {}) {
  const r = spawnSync(bin, ['cli', 'call', method, JSON.stringify(params)], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${method} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 2000)}`);
  const text = r.stdout.trim();
  for (const start of [0, text.lastIndexOf('\n{') + 1, text.lastIndexOf('\n[') + 1]) {
    try {
      const value = JSON.parse(text.slice(start));
      if (value && typeof value === 'object' && !Array.isArray(value) && start > 0) Object.defineProperty(value, 'log', { value: text.slice(0, start), enumerable: false });
      return value;
    } catch {
      continue;
    }
  }
  return text;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tail = (log) => (log ?? '').split('\n').slice(-80).join('\n');

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`);
    await sleep(3000);
  }
}

async function main() {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  cpSync(path.join(root, 'resources'), resources, { recursive: true });
  const catalogFile = path.join(resources, 'catalog', 'compatibility.json');
  const catalog = JSON.parse(readFileSync(catalogFile, 'utf8'));
  const entry = catalog.entries.find((e) => e.id === entryId);
  if (!entry) throw new Error(`Unknown catalog entry ${entryId}`);
  if (entry.status === 'unverified') entry.status = 'tested';
  writeFileSync(catalogFile, JSON.stringify(catalog, null, 2));
  const service = spawn(bin, [], { env, stdio: 'ignore', detached: process.platform !== 'win32' });
  service.unref();
  await waitFor(() => existsSync(path.join(work, 'data', 'service.json')), 60000, 'the service to start');

  result.stage = 'create';
  const created = cli('project.create', {
    projectName: 'Launch Check',
    destination: project,
    modId: 'launchcheck',
    packageName: 'dev.modsmith.launchcheck',
    author: 'Modsmith',
    description: `Launch check for ${entryId}`,
    license: 'MIT',
    git: false,
    catalogEntryId: entryId,
    environment: 'both',
    starters: ['empty', 'profiles'],
    dependencies: [],
    runInitialBuild: true
  });
  if (created.status !== 'succeeded') throw new Error(`project.create ${created.status}: ${created.error ?? ''}\n${tail(created.log)}`);
  cli('workspace.trust', { path: project, trusted: true });
  if (process.env.CHECK_JAVA_HOME) {
    const manifestFile = path.join(project, 'modsmith.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    for (const p of manifest.profiles) if (p.id === 'dev-client') p.java = { ...p.java, home: process.env.CHECK_JAVA_HOME };
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  }

  result.stage = 'launch';
  let launched = cli('instance.launch', { path: project, profile: 'dev-client' });
  if (launched.status !== 'succeeded' && /Failed to download/.test(launched.log ?? '')) {
    result.retried = 'instance.launch after a download failure';
    await sleep(15000);
    launched = cli('instance.launch', { path: project, profile: 'dev-client' });
  }
  if (launched.status !== 'succeeded') throw new Error(`instance.launch ${launched.status}: ${launched.error ?? ''}\n${tail(launched.log)}`);
  const inst = await waitFor(() => cli('instance.list').find((i) => i.side === 'client'), 60000, 'the client instance');
  const launchedAt = Date.now();

  result.stage = 'title screen';
  let lines = [];
  await waitFor(() => {
    lines = cli('logs.read', { id: inst.id, limit: 3000 }).lines?.map((l) => l.text) ?? [];
    const status = cli('instance.status', { id: inst.id });
    if (['exited', 'crashed', 'failed'].includes(status.status)) throw new Error(`The game exited before the title screen (exit code ${status.exitCode}).\n${lines.slice(-60).join('\n')}`);
    return lines.some((l) => READY.test(l));
  }, 8 * 60000, 'the title screen');
  result.readyAfter = Math.round((Date.now() - launchedAt) / 1000);
  const javaLine = lines.find((l) => /Java version|java\.version|Java: |Running on Java/i.test(l));
  result.java = javaLine ? javaLine.replace(/^.*?(Java[^,]*?\d+(?:\.\d+)*[^,]*).*$/i, '$1').slice(0, 120) : null;
  result.stage = 'stop';
  cli('instance.stop', { id: inst.id, force: false });
  await waitFor(() => !cli('instance.list').some((i) => i.id === inst.id && i.status === 'running'), 60000, 'the game to stop');
  result.ok = true;
  result.stage = 'done';
}

main()
  .catch((err) => {
    result.error = String(err.message ?? err).slice(0, 6000);
  })
  .finally(() => {
    result.seconds = Math.round((Date.now() - started) / 1000);
    try {
      for (const i of cli('instance.list')) if (i.status === 'running') cli('instance.stop', { id: i.id, force: true });
      cli('service.shutdown', { stopInstances: true });
    } catch {
      result.cleanup = 'service shutdown failed';
    }
    console.log(JSON.stringify(result, null, 2));
    if (outFile) {
      mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
      writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');
    }
    process.exit(result.ok ? 0 : 1);
  });
