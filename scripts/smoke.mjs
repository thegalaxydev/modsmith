import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.env.SMOKE_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mwb-smoke-'));
const projectDir = path.join(outDir, 'smoke-mod');
const entryId = process.env.SMOKE_ENTRY ?? 'fabric-1.21.1';
const loader = entryId.split('-')[0];
const external = loader === 'neoforge' ? { query: 'jei', slug: 'jei', modId: 'jei', label: 'JEI' } : { query: 'mod menu', slug: 'modmenu', modId: 'modmenu', label: 'Mod Menu' };
const report = { startedAt: new Date().toISOString(), projectDir, steps: [] };
const serviceExe = process.env.MODSMITH_SERVICE_BIN ?? path.join(root, 'target', 'release', process.platform === 'win32' ? 'modsmith-service.exe' : 'modsmith-service');
const mcpCommand = process.env.SMOKE_MCP === 'node' ? [process.execPath, path.join(root, 'dist', 'mcp', 'main.cjs')] : [serviceExe, 'mcp'];
const child = spawn(mcpCommand[0], mcpCommand.slice(1), { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (d) => process.stderr.write(`[mcp] ${d}`));
const pending = new Map();
let nextId = 1;
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.error('non-JSON line on stdout:', line);
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function tool(name, args) {
  const res = await rpc('tools/call', { name, arguments: args });
  if (res.error) throw new Error(`${name}: ${res.error.message}`);
  const r = res.result;
  const texts = r.content.filter((c) => c.type === 'text').map((c) => c.text);
  const images = r.content.filter((c) => c.type === 'image');
  if (r.isError) throw new Error(`${name}: ${texts.join(' ')}`);
  const body = texts[texts.length - 1].replace(/^Note: the following content[^\n]*\n/, '');
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    json = body;
  }
  return { json, images };
}

async function step(name, fn) {
  const t0 = Date.now();
  process.stdout.write(`- ${name} ... `);
  try {
    const detail = await fn();
    report.steps.push({ name, ok: true, ms: Date.now() - t0, detail });
    console.log(`ok (${((Date.now() - t0) / 1000).toFixed(1)} s)${detail ? ` ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 160)}` : ''}`);
  } catch (err) {
    report.steps.push({ name, ok: false, ms: Date.now() - t0, error: err.message });
    console.log(`FAILED: ${err.message}`);
    throw err;
  }
}

async function waitOp(id, timeoutMs = 900000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { json } = await tool('operation_wait', { id, timeoutMs: 30000 });
    if (json.status !== 'running') {
      if (json.status !== 'succeeded') throw new Error(`operation ${json.title} ${json.status}: ${json.error}`);
      return json;
    }
  }
  throw new Error('operation timed out');
}

async function until(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`timed out waiting for ${label}`);
}

let instanceId;
try {
  await step('MCP initialize', async () => {
    const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'modsmith-smoke', version: '1' } });
    if (r.error) throw new Error(r.error.message);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return `${r.result.serverInfo.name} ${r.result.serverInfo.version}, protocol ${r.result.protocolVersion}`;
  });
  await step('tools/list', async () => {
    const r = await rpc('tools/list', {});
    const names = r.result.tools.map((t) => t.name);
    for (const n of ['project_create', 'instance_launch', 'registry_search', 'world_give_item', 'viewport_capture']) if (!names.includes(n)) throw new Error(`missing ${n}`);
    return `${names.length} tools`;
  });
  await step('argument validation rejects bad input', async () => {
    const r = await rpc('tools/call', { name: 'registry_search', arguments: { limit: 'many' } });
    const text = JSON.stringify(r.result ?? r.error);
    if (!(r.error || r.result?.isError)) throw new Error('invalid arguments were accepted');
    return text.slice(0, 120);
  });
  await step('1. create project in a clean directory (includes initial Gradle build)', async () => {
    const { json } = await tool('project_create', { projectName: 'Smoke Mod', destination: projectDir, modId: 'smokemod', packageName: 'dev.smoke.smokemod', author: 'Smoke', license: 'MIT', starters: ['empty', 'item', 'block', 'command', 'bridge', 'profiles'], catalogEntryId: entryId, git: true, runInitialBuild: true });
    const op = await waitOp(json.id);
    return op.result.steps.map((s) => s.step).join(' | ');
  });
  await step('2. build (incremental, through project_build)', async () => {
    const { json } = await tool('project_build', { path: projectDir });
    const op = await waitOp(json.id);
    return op.result.artifacts.map((a) => path.basename(a)).join(', ');
  });
  await step(`3. add a compatible external mod (${external.label} from Modrinth) and resolve`, async () => {
    const search = await tool('dependency_search', { query: external.query, loader, minecraft: '1.21.1', limit: 5 });
    const hit = search.json.hits.find((h) => h.slug === external.slug);
    if (!hit) throw new Error(`${external.slug} not found`);
    await tool('dependency_add', { path: projectDir, profile: 'dev-client', ref: { source: 'modrinth', projectId: hit.id } });
    const { json } = await tool('profile_resolve', { path: projectDir, id: 'dev-client' });
    const op = await waitOp(json.id);
    const errors = op.result.issues.filter((i) => i.severity === 'error');
    if (errors.length) throw new Error(errors.map((e) => e.message).join('; '));
    return op.result.entries.map((e) => `${e.title} ${e.versionNumber ?? ''}`.trim()).join(', ');
  });
  await step('4. launch the dev-client profile', async () => {
    const { json } = await tool('instance_launch', { path: projectDir, profile: 'dev-client' });
    const op = await waitOp(json.id);
    instanceId = op.result.id;
    return `instance ${instanceId}, pid ${op.result.pid}`;
  });
  await step('5. bridge connects', async () => {
    const st = await until(async () => {
      const { json } = await tool('bridge_status', { id: instanceId });
      return json.connected ? json : null;
    }, 180000, 'bridge');
    return `protocol ${st.protocol}, MC ${st.game.minecraft}, ${st.game.capabilities.length} capabilities`;
  });
  await step('6. registry query finds the generated item and block', async () => {
    const { json } = await tool('registry_search', { id: instanceId, registry: 'item', query: 'smokemod' });
    const ids = json.entries.map((e) => e.id);
    if (!ids.includes('smokemod:example_item') || !ids.includes('smokemod:example_block')) throw new Error(`got ${ids}`);
    const mods = await tool('game_mods', { id: instanceId });
    if (!mods.json.some((m) => m.id === external.modId)) throw new Error(`${external.modId} not loaded`);
    return `${ids.join(', ')}; ${external.modId} loaded`;
  });
  await step('7a. create a flat test world', async () => {
    await tool('world_open', { id: instanceId, name: 'smoke-world', create: true, flat: true });
    await until(async () => {
      const { json } = await tool('game_status', { id: instanceId });
      return json.inWorld && json.worldLoaded ? json : null;
    }, 180000, 'world');
    return 'in world';
  });
  await step('7b. give an item, place and inspect a real block', async () => {
    const give = await tool('world_give_item', { id: instanceId, item: 'smokemod:example_item', count: 3 });
    await tool('world_run_command', { id: instanceId, command: 'tp @s 0 -60 0 -90 35' });
    await tool('world_run_command', { id: instanceId, command: 'setblock 2 -60 0 smokemod:example_block' });
    const hello = await tool('world_run_command', { id: instanceId, command: 'smokemod hello' });
    await new Promise((r) => setTimeout(r, 1500));
    const target = await tool('world_inspect_target', { id: instanceId });
    if (target.json.block !== 'smokemod:example_block') throw new Error(`target was ${JSON.stringify(target.json).slice(0, 200)}`);
    const inv = await tool('bridge_call', { id: instanceId, method: 'player.inventory' });
    const count = inv.json.items.filter((i) => i.item === 'smokemod:example_item').reduce((a, b) => a + b.count, 0);
    if (count < 3) throw new Error(`inventory has ${count}`);
    return `gave ${give.json.count}; command output "${hello.json.output.join(' ')}"; targeted ${target.json.block} via ${target.json.source}`;
  });
  await step('8. capture logs and a screenshot', async () => {
    const shot = await tool('viewport_capture', { id: instanceId });
    if (!shot.images.length) throw new Error('no image content');
    const png = path.join(outDir, 'smoke-screenshot.png');
    fs.writeFileSync(png, Buffer.from(shot.images[0].data, 'base64'));
    const logs = await tool('logs_read', { id: instanceId, search: 'smokemod', limit: 50 });
    report.screenshot = png;
    return `${shot.json.width}x${shot.json.height} -> ${png}; ${logs.json.lines.length} matching log lines`;
  });
  await step('9. stop the instance cleanly', async () => {
    const { json } = await tool('instance_stop', { id: instanceId });
    if (json.status !== 'exited' || json.exitCode !== 0) throw new Error(`status ${json.status} exit ${json.exitCode}`);
    return `exit ${json.exitCode}`;
  });
  await step('10. activity history recorded the MCP actions', async () => {
    const { json } = await tool('activity_list', { source: 'mcp', limit: 200 });
    const actions = new Set(json.map((a) => a.action));
    for (const a of ['project.create', 'instance.launch', 'world.give_item', 'instance.stop']) if (!actions.has(a)) throw new Error(`missing ${a}`);
    return `${json.length} entries`;
  });
  report.ok = true;
} catch {
  report.ok = false;
  if (instanceId) await tool('instance_stop', { id: instanceId, force: true }).catch(() => undefined);
} finally {
  report.endedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, 'smoke-report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${report.ok ? 'SMOKE PASSED' : 'SMOKE FAILED'}; report ${path.join(outDir, 'smoke-report.json')}`);
  child.stdin.end();
  setTimeout(() => process.exit(report.ok ? 0 : 1), 500);
}
