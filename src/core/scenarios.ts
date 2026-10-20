import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { OperationInfo } from '../shared/types';
import type { Services } from './context';
import type { WorkspaceService } from './workspace';
import { stateDir } from './workspace';
import type { OpContext } from './operations';

const Step = z.discriminatedUnion('action', [
  z.object({ action: z.literal('command'), command: z.string(), expectOutputContains: z.string().optional() }),
  z.object({ action: z.literal('give'), item: z.string(), count: z.number().int().min(1).default(1) }),
  z.object({ action: z.literal('wait_ticks'), ticks: z.number().int().min(1).max(12000) }),
  z.object({ action: z.literal('assert_registry'), registry: z.string().default('item'), id: z.string() }),
  z.object({ action: z.literal('assert_block'), x: z.number().int(), y: z.number().int(), z: z.number().int(), block: z.string(), properties: z.record(z.string(), z.string()).optional() }),
  z.object({ action: z.literal('assert_inventory'), item: z.string(), minCount: z.number().int().min(1).default(1) }),
  z.object({ action: z.literal('assert_log'), pattern: z.string(), absent: z.boolean().default(false) }),
  z.object({ action: z.literal('screenshot'), label: z.string().optional() })
]);

export const ScenarioSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string(),
  description: z.string().optional(),
  profile: z.string(),
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

export class ScenarioService {
  constructor(private s: Services, private ws: WorkspaceService) {}

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

  run(workspace: string, scenarioFile: string, instanceId?: string): OperationInfo {
    const dir = this.ws.normalize(workspace);
    const file = path.join(this.dir(dir), scenarioFile.endsWith('.json') ? scenarioFile : `${scenarioFile}.json`);
    if (!fs.existsSync(file)) throw new Error(`Scenario not found: ${scenarioFile}`);
    const scenario = ScenarioSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return this.s.ops.start({ kind: 'scenario.run', title: `Scenario ${scenario.name}`, workspace: dir }, (ctx) => this.execute(dir, scenario, instanceId, ctx));
  }

  private async execute(dir: string, scenario: Scenario, instanceId: string | undefined, ctx: OpContext) {
    const started = Date.now();
    const deadline = started + scenario.timeoutMs;
    const inst = instanceId ? this.s.instances.get(instanceId) : this.s.instances.list().find((i) => i.workspace === dir && i.profileId === scenario.profile && ['running', 'starting'].includes(i.status));
    if (!inst) throw new Error(`No running instance of profile ${scenario.profile}. Launch it first and enter a world.`);
    const id = inst.id;
    const status = this.s.bridge.status(id);
    if (!status.connected) throw new Error('Bridge is not connected for the instance');
    const caps = ((status.game as { capabilities?: string[] } | undefined)?.capabilities) ?? [];
    const missing = scenario.requires.filter((r) => !caps.includes(r));
    if (missing.length) throw new Error(`Instance bridge lacks required capabilities: ${missing.join(', ')}`);
    const gs = (await this.s.bridge.call(id, 'game.status', {})) as { worldLoaded?: boolean };
    if (!gs.worldLoaded) throw new Error('No world is loaded in the instance; enter a world before running scenarios');
    const results: StepResult[] = [];
    const artifacts: string[] = [];
    const logStart = this.s.instances.logs(id, { limit: 1 }).lastSeq;
    const runStep = async (phase: StepResult['phase'], index: number, step: z.infer<typeof Step>) => {
      if (Date.now() > deadline) throw new Error(`Scenario timed out after ${scenario.timeoutMs} ms`);
      ctx.throwIfCancelled();
      const t0 = Date.now();
      let ok = true;
      let detail = '';
      try {
        switch (step.action) {
          case 'command': {
            const r = (await this.s.bridge.call(id, 'world.run_command', { command: step.command })) as { output: string[]; result: number };
            detail = `result ${r.result}; ${r.output.join(' | ').slice(0, 300)}`;
            if (step.expectOutputContains && !r.output.join('\n').includes(step.expectOutputContains)) {
              ok = false;
              detail = `expected output containing "${step.expectOutputContains}", got: ${detail}`;
            }
            break;
          }
          case 'give': {
            const r = await this.s.bridge.call(id, 'world.give_item', { item: step.item, count: step.count });
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
            const r = (await this.s.bridge.call(id, 'player.inventory', {})) as { items: { item: string; count: number }[] };
            const count = r.items.filter((i) => i.item === step.item).reduce((a, b) => a + b.count, 0);
            ok = count >= step.minCount;
            detail = `${step.item} x${count}`;
            break;
          }
          case 'assert_log': {
            const re = new RegExp(step.pattern);
            const lines = this.s.instances.logs(id, { since: logStart, limit: 50000 }).lines;
            const hit = lines.find((l) => re.test(l.text));
            ok = step.absent ? !hit : !!hit;
            detail = hit ? `matched: ${hit.text.slice(0, 200)}` : 'no match';
            break;
          }
          case 'screenshot': {
            const r = (await this.s.bridge.call(id, 'client.screenshot', {}, 30000)) as { png: string };
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
    }
    const result = { scenario: scenario.name, profile: scenario.profile, instance: id, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, passed: !failed && results.every((r) => r.ok || r.phase === 'cleanup'), steps: results, artifacts };
    const outDir = path.join(stateDir(dir), 'results');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `${Date.now()}-${scenario.name.replace(/[^\w-]/g, '_')}.json`), JSON.stringify(result, null, 2));
    if (!result.passed) throw new Error(`Scenario failed: ${results.find((r) => !r.ok)?.detail ?? 'unknown'}`);
    return result;
  }
}
