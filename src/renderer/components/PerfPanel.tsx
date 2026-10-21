import { useState } from 'react';
import { store, useAsync, useStore, waitForOperation } from '../store';
import type { OperationInfo } from '../../shared/types';
import { Button, IconButton, Notice } from '../ui/controls';
import { ask } from '../dialogs';
import { profileLabel } from '../session';

interface Stats {
  mean: number;
  stdev: number;
  n: number;
}

interface Benchmark {
  id: string;
  label: string;
  profile: string;
  side: string;
  createdAt: string;
  commit: string | null;
  settings: { runs: number; warmupSeconds: number; sampleSeconds: number; scenario: string | null };
  summary: Record<string, Stats>;
}

interface Comparison {
  metrics: { key: string; label: string; unit: string; a: number; b: number; delta: number; deltaPct: number | null; noise: number; verdict: 'better' | 'worse' | 'same' }[];
  warnings: string[];
}

const SHOWN: [string, string, string][] = [
  ['startupMs', 'Startup', 'ms'],
  ['msptMean', 'Tick', 'ms'],
  ['fpsMean', 'FPS', ''],
  ['memoryMeanMb', 'Memory', 'MB']
];

function fmt(v: number, unit: string) {
  if (unit === 'ms' && Math.abs(v) >= 1000) return `${(v / 1000).toFixed(2)} s`;
  return `${Number.isInteger(v) ? v : v.toFixed(Math.abs(v) < 10 ? 2 : 1)}${unit ? ` ${unit}` : ''}`;
}

export function PerfPanel() {
  const ws = useStore((s) => s.workspace)!;
  const activeProfile = useStore((s) => s.activeProfile);
  const profiles = (ws.manifest?.profiles ?? []).filter((p) => p.bridge);
  const [profile, setProfile] = useState(profiles.find((p) => p.id === activeProfile)?.id ?? profiles[0]?.id ?? '');
  const [runs, setRuns] = useState(3);
  const [warmup, setWarmup] = useState(20);
  const [sample, setSample] = useState(30);
  const [label, setLabel] = useState('');
  const [scenario, setScenario] = useState('');
  const [opId, setOpId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [n, setN] = useState(0);
  const op = useStore((s) => (opId ? s.operations.find((o) => o.id === opId) : undefined));
  const results = useAsync(() => store.call<Benchmark[]>('perf.results', { path: ws.path }, { quiet: true }), [ws.path, n]);
  const scenarios = useAsync(() => store.call<{ file: string; valid: boolean }[]>('scenario.list', { path: ws.path }, { quiet: true }), [ws.path]);
  const [a, b] = picked;
  const comparison = useAsync(() => (a && b ? store.call<Comparison>('perf.compare', { path: ws.path, a, b }, { quiet: true }) : Promise.resolve(null)), [ws.path, a, b, n]);

  const start = async () => {
    setError(null);
    try {
      const started = await store.call<OperationInfo>('perf.run', { path: ws.path, profile, runs, warmupSeconds: warmup, sampleSeconds: sample, label: label || undefined, scenario: scenario || undefined });
      setOpId(started.id);
      const done = await waitForOperation(started.id);
      if (done.status !== 'succeeded') setError(done.error ?? 'The benchmark did not finish');
      setN((x) => x + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOpId(null);
    }
  };

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)));
  const remove = async (r: Benchmark) => {
    if (!(await ask(`Delete the benchmark result "${r.label}"?`))) return;
    await store.call('perf.delete', { path: ws.path, id: r.id });
    setPicked((p) => p.filter((x) => x !== r.id));
    setN((x) => x + 1);
  };
  const minutes = Math.ceil((runs * (warmup + sample + 60)) / 60);

  return (
    <div className="perf col">
      <div className="small dim">
        Each run starts the configuration, creates the same fresh world from a fixed seed, optionally runs a scenario as the workload, warms up, then samples tick time, memory and frame rate once a second before stopping the game. Compare two results to see which differences are larger than the run-to-run noise.
      </div>
      {!profiles.length ? (
        <Notice tone="warn">Benchmarks need a run configuration with the development bridge turned on.</Notice>
      ) : (
        <div className="perf-form row wrap">
          <label className="field">
            <span>Configuration</span>
            <select value={profile} onChange={(e) => setProfile(e.target.value)} disabled={!!opId}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {profileLabel(p)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Runs</span>
            <input type="number" min={1} max={10} value={runs} onChange={(e) => setRuns(Math.min(10, Math.max(1, Number(e.target.value) || 1)))} disabled={!!opId} />
          </label>
          <label className="field">
            <span>Warm-up (s)</span>
            <input type="number" min={0} max={600} value={warmup} onChange={(e) => setWarmup(Math.min(600, Math.max(0, Number(e.target.value) || 0)))} disabled={!!opId} />
          </label>
          <label className="field">
            <span>Measure (s)</span>
            <input type="number" min={5} max={600} value={sample} onChange={(e) => setSample(Math.min(600, Math.max(5, Number(e.target.value) || 5)))} disabled={!!opId} />
          </label>
          <label className="field">
            <span>Workload</span>
            <select value={scenario} onChange={(e) => setScenario(e.target.value)} disabled={!!opId}>
              <option value="">None (idle world)</option>
              {scenarios.data?.filter((s) => s.valid).map((s) => (
                <option key={s.file} value={s.file}>
                  Scenario {s.file}
                </option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span>Label</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name and commit by default" disabled={!!opId} />
          </label>
          <Button variant="primary" icon="play" busy={!!opId} disabled={!!opId || !profile} onClick={() => void start()} title={`Takes about ${minutes} minutes`}>
            Run benchmark
          </Button>
        </div>
      )}
      {opId && (
        <div className="col">
          <div className="small">{op?.message ?? 'Starting'}</div>
          <progress max={1} value={op?.progress ?? 0} />
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {!results.data?.length ? (
        <div className="small mute">No benchmark results yet.</div>
      ) : (
        <table className="perf-table">
          <thead>
            <tr>
              <th />
              <th>Result</th>
              <th>Runs</th>
              {SHOWN.map(([, l]) => (
                <th key={l}>{l}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {results.data.map((r) => (
              <tr key={r.id} className={picked.includes(r.id) ? 'selected' : ''}>
                <td>
                  <input type="checkbox" aria-label={`Compare ${r.label}`} checked={picked.includes(r.id)} onChange={() => toggle(r.id)} />
                </td>
                <td>
                  <div className="ellipsis">{r.label}</div>
                  <div className="small dim">
                    {new Date(r.createdAt).toLocaleString()} · {r.profile}
                    {r.settings.scenario ? ` · ${r.settings.scenario}` : ''}
                    {picked[0] === r.id ? ' · A' : picked[1] === r.id ? ' · B' : ''}
                  </div>
                </td>
                <td>{r.settings.runs}</td>
                {SHOWN.map(([k, , unit]) => (
                  <td key={k} className="mono" title={r.summary[k] ? `± ${r.summary[k].stdev}` : undefined}>
                    {r.summary[k] ? fmt(r.summary[k].mean, unit) : '–'}
                  </td>
                ))}
                <td>
                  <IconButton icon="remove" label={`Delete ${r.label}`} onClick={() => void remove(r)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {picked.length === 1 && <div className="small mute">Pick a second result to compare. The first one picked is the baseline (A).</div>}
      {comparison.data && (
        <div className="col">
          <table className="perf-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>A</th>
                <th>B</th>
                <th>Change</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {comparison.data.metrics.map((m) => (
                <tr key={m.key}>
                  <td>{m.label}</td>
                  <td className="mono">{fmt(m.a, m.unit === 'fps' ? '' : m.unit)}</td>
                  <td className="mono">{fmt(m.b, m.unit === 'fps' ? '' : m.unit)}</td>
                  <td className="mono">
                    {m.delta > 0 ? '+' : ''}
                    {fmt(m.delta, m.unit === 'fps' ? '' : m.unit)}
                    {m.deltaPct !== null ? ` (${m.deltaPct > 0 ? '+' : ''}${m.deltaPct.toFixed(1)}%)` : ''}
                  </td>
                  <td className={m.verdict === 'better' ? 'ok' : m.verdict === 'worse' ? 'err' : 'dim'} title={`Noise threshold ${fmt(m.noise, m.unit === 'fps' ? '' : m.unit)}`}>
                    {m.verdict === 'same' ? 'Within noise' : m.verdict === 'better' ? 'Better' : 'Worse'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {comparison.data.warnings.map((w) => (
            <Notice key={w} tone="warn">
              {w}
            </Notice>
          ))}
        </div>
      )}
    </div>
  );
}
