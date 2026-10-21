import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InstanceInfo, OperationInfo } from '../shared/types';
import type { Services } from './context';
import type { OpContext } from './operations';
import type { WorkspaceService } from './workspace';
import { stateDir } from './workspace';
import type { LaunchService, Prepared } from './launch';
import type { Scenario, ScenarioService } from './scenarios';
import { enterWorld, prepareTestWorld, waitBridge, waitServerDone, waitTitleScreen } from './harness';

const WORLD = 'modsmith-benchmark';
const CLIENT_OPTIONS: [string, string][] = [['enableVsync', 'false'], ['maxFps', '260'], ['inactivityFpsLimit', '"minimized"']];

export interface Stats {
  mean: number;
  stdev: number;
  min: number;
  max: number;
  n: number;
}

export const METRICS: { key: string; label: string; unit: string; better: 'lower' | 'higher' }[] = [
  { key: 'startupMs', label: 'Startup', unit: 'ms', better: 'lower' },
  { key: 'worldMs', label: 'World load', unit: 'ms', better: 'lower' },
  { key: 'msptMean', label: 'Tick time', unit: 'ms', better: 'lower' },
  { key: 'msptP95', label: 'Tick time, 95th percentile', unit: 'ms', better: 'lower' },
  { key: 'fpsMean', label: 'Frame rate', unit: 'fps', better: 'higher' },
  { key: 'memoryMeanMb', label: 'Memory used', unit: 'MB', better: 'lower' },
  { key: 'memoryMaxMb', label: 'Peak memory', unit: 'MB', better: 'lower' }
];

export function round3(x: number): number {
  return (Math.sign(x) * Math.round(Math.abs(x) * 1000)) / 1000;
}

export function stats(values: number[]): Stats | null {
  if (!values.length) return null;
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1) : 0;
  return { mean: round3(mean), stdev: round3(Math.sqrt(variance)), min: round3(Math.min(...values)), max: round3(Math.max(...values)), n };
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

export function summarizeRuns(runs: Record<string, unknown>[]): Record<string, Stats> {
  const out: Record<string, Stats> = {};
  for (const m of METRICS) {
    const s = stats(runs.map((r) => r[m.key]).filter((v): v is number => typeof v === 'number'));
    if (s) out[m.key] = s;
  }
  return out;
}

interface BenchmarkFile {
  id: string;
  label: string;
  profile: string;
  side: string;
  summary: Record<string, Stats>;
  settings: Record<string, unknown>;
  commit: string | null;
  environment: Record<string, unknown>;
  createdAt: string;
}

export function compareBenchmarks(a: BenchmarkFile, b: BenchmarkFile) {
  const metrics = [];
  for (const m of METRICS) {
    const sa = a.summary[m.key];
    const sb = b.summary[m.key];
    if (!sa || !sb) continue;
    const delta = sb.mean - sa.mean;
    const noise = Math.max(2 * Math.sqrt((sa.stdev * sa.stdev) / sa.n + (sb.stdev * sb.stdev) / sb.n), 0.02 * Math.max(Math.abs(sa.mean), Math.abs(sb.mean)));
    const improved = m.better === 'lower' ? delta < 0 : delta > 0;
    const verdict = Math.abs(delta) <= noise ? 'same' : improved ? 'better' : 'worse';
    metrics.push({ key: m.key, label: m.label, unit: m.unit, better: m.better, a: sa.mean, b: sb.mean, delta: round3(delta), deltaPct: sa.mean ? round3((delta / sa.mean) * 100) : null, noise: round3(noise), verdict });
  }
  const warnings: string[] = [];
  if (a.side !== b.side) warnings.push('The two results are from different sides (client and server).');
  for (const k of ['runs', 'warmupSeconds', 'sampleSeconds', 'seed', 'flat', 'scenario']) {
    if (JSON.stringify(a.settings[k] ?? null) !== JSON.stringify(b.settings[k] ?? null)) warnings.push(`The benchmark settings differ (${k}).`);
  }
  if (JSON.stringify(a.environment) !== JSON.stringify(b.environment)) warnings.push('The Minecraft or loader versions differ.');
  if (Math.min(Number(a.settings.runs ?? 1), Number(b.settings.runs ?? 1)) < 2) warnings.push('With a single run there is no measure of run-to-run noise; small differences may not be real.');
  const head = (x: BenchmarkFile) => ({ id: x.id, label: x.label, profile: x.profile, createdAt: x.createdAt, commit: x.commit });
  return { a: head(a), b: head(b), metrics, warnings };
}

export function gitCommit(dir: string): string | null {
  try {
    const head = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return /^[0-9a-f]{40}$/.test(head) ? head : null;
    const ref = head.slice(5);
    const loose = path.join(dir, '.git', ...ref.split('/'));
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim() || null;
    const packed = path.join(dir, '.git', 'packed-refs');
    if (!fs.existsSync(packed)) return null;
    const line = fs.readFileSync(packed, 'utf8').split(/\r?\n/).find((l) => l.endsWith(` ${ref}`));
    return line ? line.split(' ')[0] : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PerfService {
  constructor(private s: Services, private ws: WorkspaceService, private launcher: LaunchService, private scenarios: ScenarioService) {}

  private dir(root: string) {
    return path.join(stateDir(this.ws.normalize(root)), 'benchmarks');
  }

  private read(root: string): BenchmarkFile[] {
    const d = this.dir(root);
    if (!fs.existsSync(d)) return [];
    return fs
      .readdirSync(d)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) as BenchmarkFile)
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt));
  }

  results(p: { path: string }) {
    return this.read(p.path);
  }

  compare(p: { path: string; a: string; b: string }) {
    const all = this.read(p.path);
    const find = (id: string) => {
      const r = all.find((x) => x.id === id);
      if (!r) throw new Error(`Unknown benchmark result ${id}`);
      return r;
    };
    return compareBenchmarks(find(p.a), find(p.b));
  }

  remove(p: { path: string; id: string }) {
    if (!/^[A-Za-z0-9-]+$/.test(p.id)) throw new Error(`Unknown benchmark result ${p.id}`);
    const file = path.join(this.dir(p.path), `${p.id}.json`);
    if (!fs.existsSync(file)) throw new Error(`Unknown benchmark result ${p.id}`);
    fs.rmSync(file);
    return { removed: p.id };
  }

  run(p: { path: string; profile: string; runs?: number; warmupSeconds?: number; sampleSeconds?: number; label?: string; scenario?: string; seed?: number; flat?: boolean }): OperationInfo {
    const prepared = this.launcher.prepareLaunch(p.path, p.profile);
    if (!prepared.profile.bridge) throw new Error(`Benchmarks read tick time, frame rate and memory through the development bridge. Turn on "Development bridge" for ${p.profile}.`);
    const scenario = p.scenario ? this.scenarios.load(prepared.dir, p.scenario) : null;
    const settings = { runs: p.runs ?? 3, warmupSeconds: p.warmupSeconds ?? 20, sampleSeconds: p.sampleSeconds ?? 30, seed: p.seed ?? 4242, flat: p.flat ?? false, scenario: p.scenario ?? null };
    return this.s.ops.start({ kind: 'perf.run', title: `Benchmark ${prepared.profile.name}`, workspace: prepared.dir }, async (ctx) => {
      const side = prepared.profile.side;
      const runs: Record<string, unknown>[] = [];
      for (let i = 0; i < settings.runs; i++) {
        ctx.throwIfCancelled();
        const at = (step: number, msg: string) => ctx.progress((i + step) / settings.runs, `Run ${i + 1} of ${settings.runs}: ${msg}`);
        at(0, 'starting');
        runs.push(await this.once(prepared, settings, scenario, at, ctx));
        ctx.log(`Run ${i + 1}: ${JSON.stringify(runs[i])}`);
      }
      const commit = gitCommit(prepared.dir);
      const result = {
        id: randomUUID().slice(0, 8),
        label: p.label?.trim() || `${prepared.profile.name}${commit ? ` @ ${commit.slice(0, 7)}` : ''}`,
        profile: prepared.profile.id,
        side,
        mode: prepared.mode,
        createdAt: new Date().toISOString(),
        commit,
        environment: { minecraft: prepared.manifest.platform.minecraft, loader: prepared.manifest.platform.loader, loaderVersion: prepared.manifest.platform.loaderVersion },
        settings,
        runs,
        summary: summarizeRuns(runs)
      };
      fs.mkdirSync(this.dir(prepared.dir), { recursive: true });
      fs.writeFileSync(path.join(this.dir(prepared.dir), `${result.id}.json`), JSON.stringify(result, null, 2));
      return result;
    });
  }

  private async once(prepared: Prepared, settings: { warmupSeconds: number; sampleSeconds: number; seed: number; flat: boolean }, scenario: Scenario | null, at: (step: number, msg: string) => void, ctx: OpContext) {
    const world = { name: WORLD, seed: settings.seed, flat: settings.flat };
    const restore = prepareTestWorld(prepared, world, CLIENT_OPTIONS);
    let inst: InstanceInfo | null = null;
    const run: Record<string, unknown> = {};
    try {
      inst = await this.launcher.runPrepared(prepared, undefined, ctx);
      if (prepared.profile.side === 'server') {
        at(0.2, 'waiting for the server');
        const done = await waitServerDone(this.s, ctx, inst);
        run.startupMs = done.ts - inst.startedAt;
        const reported = /Done \((\d+(?:\.\d+)?)s\)/.exec(done.text);
        if (reported) run.reportedStartupSeconds = Number(reported[1]);
        await waitBridge(this.s, ctx, inst);
      } else {
        at(0.2, 'waiting for the title screen');
        await waitTitleScreen(this.s, ctx, inst);
        run.startupMs = Date.now() - inst.startedAt;
        at(0.3, 'creating the benchmark world');
        run.worldMs = await enterWorld(this.s, ctx, inst, world);
      }
      if (scenario) {
        at(0.4, `running ${scenario.name}`);
        await this.scenarios.execute(prepared.dir, scenario, inst.id, ctx);
      }
      for (let w = 0; w < settings.warmupSeconds * 2; w++) {
        at(0.5, `warming up (${Math.ceil(settings.warmupSeconds - w / 2)} s)`);
        ctx.throwIfCancelled();
        await sleep(500);
      }
      const mspt: number[] = [];
      const fps: number[] = [];
      const memory: number[] = [];
      for (let k = 0; k < settings.sampleSeconds; k++) {
        ctx.throwIfCancelled();
        at(0.6 + (0.3 * k) / settings.sampleSeconds, `measuring (${settings.sampleSeconds - k} s)`);
        const tick = Date.now();
        const t = (await this.s.bridge.call(inst.id, 'game.telemetry', {}, 5000)) as { mspt?: number; memory?: { usedMb?: number } };
        if (typeof t.mspt === 'number') mspt.push(t.mspt);
        if (typeof t.memory?.usedMb === 'number') memory.push(t.memory.usedMb);
        if (prepared.profile.side === 'client') {
          const c = (await this.s.bridge.call(inst.id, 'client.status', {}, 5000)) as { fps?: number };
          if (typeof c.fps === 'number') fps.push(c.fps);
        }
        await sleep(Math.max(0, 1000 - (Date.now() - tick)));
      }
      run.samples = Math.max(mspt.length, memory.length);
      const mean = (l: number[]) => round3(l.reduce((a, b) => a + b, 0) / l.length);
      if (mspt.length) {
        run.msptMean = mean(mspt);
        run.msptP95 = round3(percentile(mspt, 0.95));
      }
      if (fps.length) run.fpsMean = mean(fps);
      if (memory.length) {
        run.memoryMeanMb = mean(memory);
        run.memoryMaxMb = round3(Math.max(...memory));
      }
    } finally {
      at(0.95, 'stopping');
      if (inst) await this.launcher.stop(inst.id, false).catch(() => undefined);
      restore();
    }
    return run;
  }
}
