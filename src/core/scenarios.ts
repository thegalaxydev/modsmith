import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { OperationInfo } from '../shared/types';
import type { Services } from './context';
import type { WorkspaceService } from './workspace';
import { stateDir } from './workspace';
import type { OpContext } from './operations';
import type { LaunchService } from './launch';
import type { SessionService } from './sessions';
import { enterWorld, prepareTestWorld, serverTestWorld, waitBridge, waitPlayersJoined, waitServerDone, waitTitleScreen, type TestWorld } from './harness';

const Player = z.string().regex(/^[A-Za-z0-9_]{3,16}$/, 'Player names are 3 to 16 letters, digits or underscores');
const As = { player: Player.optional() };

const Step = z.discriminatedUnion('action', [
  z.object({ action: z.literal('command'), command: z.string(), expectOutputContains: z.string().optional(), ...As }),
  z.object({ action: z.literal('give'), item: z.string(), count: z.number().int().min(1).default(1), ...As }),
  z.object({ action: z.literal('wait_ticks'), ticks: z.number().int().min(1).max(12000) }),
  z.object({ action: z.literal('assert_registry'), registry: z.string().default('item'), id: z.string() }),
  z.object({ action: z.literal('assert_block'), x: z.number().int(), y: z.number().int(), z: z.number().int(), block: z.string(), properties: z.record(z.string(), z.string()).optional() }),
  z.object({ action: z.literal('assert_inventory'), item: z.string(), minCount: z.number().int().min(1).default(1), ...As }),
  z.object({ action: z.literal('assert_log'), pattern: z.string(), absent: z.boolean().default(false), ...As }),
  z.object({ action: z.literal('screenshot'), label: z.string().optional(), ...As })
]);

export const ScenarioSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string(),
  description: z.string().optional(),
  profile: z.string(),
  server: z.string().optional(),
  players: z.array(Player).min(1).max(4).optional(),
  world: z.object({ seed: z.number().int().default(4242), flat: z.boolean().default(true) }).optional(),
  snapshot: z.string().optional(),
  requires: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(1000).max(3600000).default(120000),
  setup: z.array(Step).default([]),
  steps: z.array(Step).min(1),
  cleanup: z.array(Step).default([])
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export interface StepResult {
  phase: 'setup' | 'steps' | 'cleanup';
  index: number;
  action: string;
  ok: boolean;
  detail: string;
  durationMs: number;
}

export interface Targets {
  main: string;
  clients: Record<string, string>;
  players: string[];
}

export const TEST_WORLD = 'modsmith-test';

export function playersOf(scenario: Scenario): string[] {
  return scenario.players ?? (scenario.server ? ['Player1', 'Player2'] : []);
}

export function checkPlayers(scenario: Scenario) {
  const players = playersOf(scenario);
  if (scenario.players && !scenario.server) throw new Error('A scenario with players needs a server run configuration ("server")');
  if (new Set(players.map((p) => p.toLowerCase())).size !== players.length) throw new Error('Each player in a scenario needs a different name');
  for (const [phase, list] of [['setup', scenario.setup], ['steps', scenario.steps], ['cleanup', scenario.cleanup]] as const) {
    for (const [i, st] of list.entries()) {
      const p = 'player' in st ? st.player : undefined;
      if (!p) continue;
      if (!scenario.server) throw new Error(`${phase}[${i}] names player ${p}, but only multiplayer scenarios (with "server" and "players") can name players`);
      if (!players.includes(p)) throw new Error(`${phase}[${i}] names player ${p}, who is not one of the scenario's players (${players.join(', ')})`);
    }
  }
}

export function asPlayer(command: string, player: string | null): string {
  const c = command.replace(/^\//, '');
  return player ? `execute as ${player} at ${player} run ${c}` : c;
}

export class ScenarioService {
  constructor(
    private s: Services,
    private ws: WorkspaceService,
    private launcher?: LaunchService,
    private sessions?: SessionService
  ) {}

  dir(workspace: string): string {
    return path.join(this.ws.normalize(workspace), 'scenarios');
  }

  list(workspace: string) {
    const d = this.dir(workspace);
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => {
      const file = path.join(d, f);
      const res = ScenarioSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
      return { file: f, valid: res.success, scenario: res.success ? res.data : null, errors: res.success ? [] : res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
    });
  }

  results(workspace: string) {
    const d = path.join(stateDir(this.ws.normalize(workspace)), 'results');
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, 50).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')));
  }

  private fileName(file: string): string {
    const name = file.replace(/\.json$/, '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error('Scenario file names may only use letters, digits, - and _ (up to 64 characters)');
    return `${name}.json`;
  }

  save(workspace: string, file: string, input: unknown) {
    const dir = this.ws.normalize(workspace);
    const name = this.fileName(file);
    const res = ScenarioSchema.safeParse(input);
    if (!res.success) throw new Error(`Invalid scenario: ${res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    fs.mkdirSync(this.dir(dir), { recursive: true });
    fs.writeFileSync(path.join(this.dir(dir), name), JSON.stringify(res.data, null, 2) + '\n');
    return { file: name, scenario: res.data };
  }

  remove(workspace: string, file: string, confirm: boolean) {
    if (!confirm) throw new Error('Deleting a scenario is destructive; pass confirm: true');
    const dir = this.ws.normalize(workspace);
    const name = this.fileName(file);
    const target = path.join(this.dir(dir), name);
    if (!fs.existsSync(target)) throw new Error(`Scenario not found: ${file}`);
    fs.rmSync(target);
    return { removed: name };
  }

  load(dir: string, scenarioFile: string): Scenario {
    const file = path.join(this.dir(dir), scenarioFile.endsWith('.json') ? scenarioFile : `${scenarioFile}.json`);
    if (!fs.existsSync(file)) throw new Error(`Scenario not found: ${scenarioFile}`);
    return ScenarioSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  run(workspace: string, scenarioFile: string, opts: { instance?: string; keep?: boolean } = {}): OperationInfo {
    const dir = this.ws.normalize(workspace);
    const scenario = this.load(dir, scenarioFile);
    checkPlayers(scenario);
    const title = `Scenario ${scenario.name}`;
    const world: TestWorld = { name: TEST_WORLD, seed: scenario.world?.seed ?? 4242, flat: scenario.world?.flat ?? true };
    const start = (fn: (ctx: OpContext) => Promise<unknown>) => this.s.ops.start({ kind: 'scenario.run', title, workspace: dir }, fn);
    if (scenario.server) return this.runMultiplayer(dir, scenario, world, opts.keep === true, start);
    if (opts.instance) return start((ctx) => this.execute(dir, scenario, opts.instance!, ctx));
    const running = this.s.instances.list().find((i) => i.workspace === dir && i.profileId === scenario.profile && ['running', 'starting'].includes(i.status));
    if (running)
      return start(async (ctx) => {
        await this.ensureWorld(running.id, world, ctx);
        return this.execute(dir, scenario, running.id, ctx);
      });
    const prepared = this.launcher!.prepareLaunch(dir, scenario.profile);
    if (!prepared.profile.bridge) throw new Error(`Scenarios run their steps through the development bridge. Turn on "Development bridge" for ${scenario.profile}.`);
    return start(async (ctx) => {
      const restore = prepareTestWorld(prepared, world);
      let id: string | null = null;
      try {
        ctx.progress(0.02, `Starting ${prepared.profile.name}`);
        const inst = await this.launcher!.runPrepared(prepared, undefined, ctx);
        id = inst.id;
        if (inst.side === 'server') {
          await waitServerDone(this.s, ctx, inst);
          await waitBridge(this.s, ctx, inst);
        } else {
          await waitTitleScreen(this.s, ctx, inst);
          ctx.progress(0.1, 'Creating a test world');
          await enterWorld(this.s, ctx, inst, world);
        }
        return await this.execute(dir, scenario, inst.id, ctx, { launched: true });
      } finally {
        if (id && !opts.keep) await this.launcher!.stop(id, false).catch(() => undefined);
        restore();
      }
    });
  }

  private runMultiplayer(dir: string, scenario: Scenario, world: TestWorld, keep: boolean, start: (fn: (ctx: OpContext) => Promise<unknown>) => OperationInfo): OperationInfo {
    const players = playersOf(scenario);
    const manifest = this.ws.requireManifest(dir);
    const server = manifest.profiles.find((x) => x.id === scenario.server);
    if (server && !server.bridge) throw new Error(`Multiplayer scenarios run their steps through the server's development bridge. Turn on "Development bridge" for ${scenario.server}.`);
    const plan = this.sessions!.prepare({ path: dir, server: scenario.server!, client: scenario.profile, names: players });
    return start(async (ctx) => {
      const restore = serverTestWorld(plan.server.idir, world);
      try {
        ctx.progress(0.02, `Starting the server and ${players.join(', ')}`);
        const launched = await this.sessions!.launch(plan, ctx);
        const serverInst = this.s.instances.get(launched.server.instance)!;
        await waitBridge(this.s, ctx, serverInst);
        ctx.progress(0.1, `Waiting for ${players.join(', ')} to join`);
        await waitPlayersJoined(this.s, ctx, serverInst, players);
        const clients = Object.fromEntries(launched.clients.map((c) => [c.player, c.instance]));
        return await this.execute(dir, scenario, { main: serverInst.id, clients, players }, ctx, { launched: true });
      } finally {
        this.sessions!.release(plan.id);
        if (!keep) await this.sessions!.stop(plan.id).catch(() => undefined);
        restore();
      }
    });
  }

  private async ensureWorld(id: string, world: TestWorld, ctx: OpContext) {
    const inst = this.s.instances.get(id);
    if (!inst || inst.side !== 'client') return;
    await waitTitleScreen(this.s, ctx, inst).catch(() => undefined);
    const st = (await this.s.bridge.call(id, 'client.status', {}, 5000).catch(() => null)) as { inWorld?: boolean } | null;
    if (!st || st.inWorld) return;
    ctx.progress(0.05, 'Creating a test world');
    fs.rmSync(path.join(inst.instanceDir, 'saves', world.name), { recursive: true, force: true });
    await enterWorld(this.s, ctx, inst, world);
  }

  async execute(dir: string, scenario: Scenario, target: string | Targets, ctx: OpContext, meta: { launched?: boolean } = {}) {
    const t: Targets = typeof target === 'string' ? { main: target, clients: {}, players: [] } : target;
    const started = Date.now();
    const deadline = started + scenario.timeoutMs;
    const inst = this.s.instances.get(t.main);
    if (!inst) throw new Error(`No running instance of profile ${scenario.profile}. Launch it first and enter a world.`);
    const id = inst.id;
    const status = this.s.bridge.status(id);
    if (!status.connected) throw new Error('Bridge is not connected for the instance');
    const caps = ((status.game as { capabilities?: string[] } | undefined)?.capabilities) ?? [];
    const missing = scenario.requires.filter((r) => !caps.includes(r));
    if (missing.length) throw new Error(`Instance bridge lacks required capabilities: ${missing.join(', ')}`);
    const gs = (await this.s.bridge.call(id, 'game.status', {})) as { worldLoaded?: boolean };
    if (!gs.worldLoaded) throw new Error('No world is loaded in the instance; enter a world before running scenarios');
    const localPlayer = inst.side === 'client' && !t.players.length;
    const keepRunning = localPlayer && caps.includes('client.keep_running');
    if (keepRunning) await this.s.bridge.call(id, 'client.keep_running', { enabled: true }, 5000).catch(() => undefined);
    const logStart: Record<string, number> = {};
    for (const iid of [id, ...Object.values(t.clients)]) logStart[iid] = this.s.instances.logs(iid, { limit: 1 }).lastSeq;
    const clientOf = (player?: string) => (player ? t.clients[player] : t.players.length ? t.clients[t.players[0]] : id);
    const results: StepResult[] = [];
    const artifacts: string[] = [];
    const runStep = async (phase: StepResult['phase'], index: number, step: z.infer<typeof Step>) => {
      if (Date.now() > deadline) throw new Error(`Scenario timed out after ${scenario.timeoutMs} ms`);
      ctx.throwIfCancelled();
      const t0 = Date.now();
      let ok = true;
      let detail = '';
      try {
        switch (step.action) {
          case 'command': {
            const r = (await this.s.bridge.call(id, 'world.run_command', { command: asPlayer(step.command, step.player ?? (localPlayer ? '@p' : null)) })) as { output: string[]; result: number };
            detail = `result ${r.result}; ${r.output.join(' | ').slice(0, 300)}`;
            if (step.expectOutputContains && !r.output.join('\n').includes(step.expectOutputContains)) {
              ok = false;
              detail = `expected output containing "${step.expectOutputContains}", got: ${detail}`;
            }
            break;
          }
          case 'give': {
            const r = await this.s.bridge.call(id, 'world.give_item', { item: step.item, count: step.count, ...(step.player ? { player: step.player } : {}) });
            detail = JSON.stringify(r);
            break;
          }
          case 'wait_ticks':
            await this.s.bridge.call(id, 'game.wait_ticks', { ticks: step.ticks }, step.ticks * 100 + 10000);
            detail = `waited ${step.ticks} ticks`;
            break;
          case 'assert_registry': {
            const r = (await this.s.bridge.call(id, 'registry.search', { registry: step.registry, query: step.id, limit: 50 })) as { entries: { id: string }[] };
            ok = r.entries.some((e) => e.id === step.id);
            detail = ok ? `${step.id} is registered` : `${step.id} not found in ${step.registry}`;
            break;
          }
          case 'assert_block': {
            const r = (await this.s.bridge.call(id, 'world.block_at', { x: step.x, y: step.y, z: step.z })) as { block: string; properties: Record<string, string> };
            ok = r.block === step.block && Object.entries(step.properties ?? {}).every(([k, v]) => r.properties[k] === v);
            detail = `found ${r.block} ${JSON.stringify(r.properties)}`;
            break;
          }
          case 'assert_inventory': {
            const r = (await this.s.bridge.call(id, 'player.inventory', step.player ? { player: step.player } : {})) as { items: { item: string; count: number }[] };
            const count = r.items.filter((i) => i.item === step.item).reduce((a, b) => a + b.count, 0);
            ok = count >= step.minCount;
            detail = `${step.item} x${count}`;
            break;
          }
          case 'assert_log': {
            const re = new RegExp(step.pattern);
            const from = step.player ? t.clients[step.player] : id;
            const lines = this.s.instances.logs(from, { since: logStart[from], limit: 50000 }).lines;
            const hit = lines.find((l) => re.test(l.text));
            ok = step.absent ? !hit : !!hit;
            detail = hit ? `matched: ${hit.text.slice(0, 200)}` : 'no match';
            break;
          }
          case 'screenshot': {
            const r = (await this.s.bridge.call(clientOf(step.player), 'client.screenshot', {}, 30000)) as { png: string };
            const out = path.join(stateDir(dir), 'results', 'artifacts', `${Date.now()}-${(step.label ?? 'screenshot').replace(/[^\w-]/g, '_')}.png`);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, Buffer.from(r.png, 'base64'));
            artifacts.push(out);
            detail = out;
            break;
          }
        }
      } catch (err) {
        ok = false;
        detail = (err as Error).message;
      }
      results.push({ phase, index, action: step.action, ok, detail, durationMs: Date.now() - t0 });
      ctx.log(`${ok ? 'PASS' : 'FAIL'} ${phase}[${index}] ${step.action}: ${detail}`);
      return ok;
    };
    let failed = false;
    try {
      for (const [i, st] of scenario.setup.entries()) if (!(await runStep('setup', i, st))) {
        failed = true;
        break;
      }
      if (!failed) {
        for (const [i, st] of scenario.steps.entries()) {
          ctx.progress((i + 1) / scenario.steps.length, `Step ${i + 1}/${scenario.steps.length}`);
          if (!(await runStep('steps', i, st))) {
            failed = true;
            break;
          }
        }
      }
    } finally {
      for (const [i, st] of scenario.cleanup.entries()) await runStep('cleanup', i, st).catch(() => false);
      if (keepRunning) await this.s.bridge.call(id, 'client.keep_running', { enabled: false }, 5000).catch(() => undefined);
    }
    const result = { scenario: scenario.name, profile: scenario.profile, instance: id, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, passed: !failed && results.every((r) => r.ok || r.phase === 'cleanup'), launched: meta.launched === true, ...(t.players.length ? { players: t.players } : {}), steps: results, artifacts };
    const outDir = path.join(stateDir(dir), 'results');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `${Date.now()}-${scenario.name.replace(/[^\w-]/g, '_')}.json`), JSON.stringify(result, null, 2));
    if (!result.passed) throw new Error(`Scenario failed: ${results.find((r) => !r.ok)?.detail ?? 'unknown'}`);
    return result;
  }
}
