import { useState } from 'react';
import { store, useAsync, useStore, waitForOperation } from '../store';
import type { InstanceInfo, OperationInfo } from '../../shared/types';
import { ask } from '../dialogs';

interface ScenarioRow {
  file: string;
  valid: boolean;
  scenario: { name: string; description?: string; profile: string; steps: unknown[] } | null;
  errors: string[];
}

interface Result {
  scenario: string;
  startedAt: string;
  durationMs: number;
  passed: boolean;
  steps: { phase: string; index: number; action: string; ok: boolean; detail: string }[];
  artifacts: string[];
}

interface Bisect {
  profile: string;
  bisectProfile: string;
  units: { key: string; title: string; requires: string[] }[];
  candidates: string[];
  current: string[] | null;
  attempts: { tested: string[]; outcome: string }[];
  done: boolean;
  conclusion?: string;
}

const EXAMPLE = (profile: string, modId: string) =>
  JSON.stringify(
    {
      schemaVersion: 1,
      name: 'smoke',
      description: 'Registry and inventory smoke test',
      profile,
      requires: ['registry.search', 'world.give_item', 'world.run_command'],
      timeoutMs: 60000,
      setup: [{ action: 'command', command: 'clear @s' }],
      steps: [
        { action: 'assert_registry', registry: 'item', id: 'minecraft:diamond' },
        { action: 'give', item: 'minecraft:diamond', count: 2 },
        { action: 'wait_ticks', ticks: 5 },
        { action: 'assert_inventory', item: 'minecraft:diamond', minCount: 2 },
        { action: 'command', command: 'setblock ~ ~-1 ~ minecraft:gold_block' },
        { action: 'assert_log', pattern: `${modId}`, absent: false },
        { action: 'screenshot', label: 'after-setup' }
      ],
      cleanup: [{ action: 'command', command: 'clear @s' }]
    },
    null,
    2
  );

export function TestsPanel({ current }: { current?: InstanceInfo }) {
  const ws = useStore((s) => s.workspace)!;
  const activeProfile = useStore((s) => s.activeProfile);
  const [tab, setTab] = useState<'scenarios' | 'snapshots' | 'bisect'>('scenarios');
  const [n, setN] = useState(0);
  const scenarios = useAsync(() => store.call<ScenarioRow[]>('scenario.list', { path: ws.path }, { quiet: true }), [ws.path, n]);
  const results = useAsync(() => store.call<Result[]>('scenario.results', { path: ws.path }, { quiet: true }), [ws.path, n]);
  const snapshots = useAsync(() => store.call<{ id: string; name: string; profile: string; world: string; createdAt: string; sizeBytes: number }[]>('world.snapshots', { path: ws.path }, { quiet: true }), [ws.path, n]);
  const bisect = useAsync(() => store.call<Bisect | null>('bisect.status', { path: ws.path }, { quiet: true }), [ws.path, n]);
  const refresh = () => setN((x) => x + 1);
  const running = current && ['running', 'starting'].includes(current.status);

  const run = async (file: string) => {
    const op = await store.call<OperationInfo>('scenario.run', { path: ws.path, scenario: file, instance: current?.id });
    await waitForOperation(op.id);
    refresh();
  };

  return (
    <div className="col" style={{ flex: 1, minHeight: 0, gap: 0 }}>
      <div className="toolbar">
        {(['scenarios', 'snapshots', 'bisect'] as const).map((t) => (
          <button key={t} className={`small ${tab === t ? 'primary' : ''}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
        <div className="spacer" />
        <button className="small ghost" onClick={refresh}>
          Refresh
        </button>
      </div>
      <div className="panel-body">
        {tab === 'scenarios' && (
          <div className="row" style={{ alignItems: 'stretch', gap: 0, minHeight: '100%' }}>
            <div style={{ width: 360, borderRight: '1px solid var(--line)' }}>
              {!scenarios.data?.length && (
                <div className="empty">
                  No scenarios in scenarios/*.json.
                  <div style={{ marginTop: 8 }}>
                    <button
                      className="small"
                      onClick={() => void store.call('workspace.write_file', { path: ws.path, file: 'scenarios/smoke.json', content: EXAMPLE(activeProfile ?? 'dev-client', ws.manifest?.modId ?? 'minecraft'), create: true }).then(refresh)}
                    >
                      Create example scenario
                    </button>
                  </div>
                </div>
              )}
              {scenarios.data?.map((s) => (
                <div key={s.file} className="list-item">
                  <div className="grow">
                    <div>{s.scenario?.name ?? s.file}</div>
                    <div className="mute" style={{ fontSize: 11.5 }}>
                      {s.valid ? `${s.scenario!.steps.length} steps · profile ${s.scenario!.profile}` : s.errors.join('; ')}
                    </div>
                  </div>
                  <button className="small" disabled={!s.valid || !running} onClick={() => void run(s.file)} title={running ? 'Run against the selected instance' : 'Launch the profile and enter a world first'}>
                    Run
                  </button>
                </div>
              ))}
            </div>
            <div className="grow" style={{ padding: 8 }}>
              {!results.data?.length && <div className="mute">No results yet.</div>}
              {results.data?.map((r, i) => (
                <details key={i} open={i === 0} style={{ marginBottom: 6 }}>
                  <summary>
                    <span className={r.passed ? 'ok' : 'err'}>{r.passed ? 'PASS' : 'FAIL'}</span> {r.scenario} · {new Date(r.startedAt).toLocaleString()} · {(r.durationMs / 1000).toFixed(1)} s
                  </summary>
                  {r.steps.map((s, j) => (
                    <div key={j} className="mono" style={{ fontSize: 12, paddingLeft: 12 }}>
                      <span className={s.ok ? 'ok' : 'err'}>{s.ok ? '✓' : '✗'}</span> {s.phase}[{s.index}] {s.action}: <span className="dim">{s.detail}</span>
                    </div>
                  ))}
                  {r.artifacts.map((a) => (
                    <div key={a} style={{ paddingLeft: 12 }}>
                      <a onClick={() => void window.workbench?.openPath(a)}>{a.split(/[\\/]/).pop()}</a>
                    </div>
                  ))}
                </details>
              ))}
            </div>
          </div>
        )}
        {tab === 'snapshots' && (
          <div style={{ padding: 8 }}>
            <div className="row" style={{ marginBottom: 8 }}>
              <button className="small" disabled={!activeProfile} onClick={() => void store.call<OperationInfo>('world.snapshot', { path: ws.path, profile: activeProfile }).then((op) => waitForOperation(op.id)).then(refresh)}>
                Snapshot world of {activeProfile}
              </button>
              <span className="hint">Saves the world first through the bridge when the instance is running.</span>
            </div>
            <table className="grid">
              <tbody>
                {snapshots.data?.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td className="dim">
                      {s.profile} · {s.world}
                    </td>
                    <td className="dim">{(s.sizeBytes / 1048576).toFixed(1)} MB</td>
                    <td>
                      <button className="small" onClick={() => void ask(`Replace world ${s.world} of ${s.profile} with this snapshot?`).then(async (ok) => {
                          if (ok) {
                            await store.call('world.restore', { path: ws.path, profile: s.profile, snapshot: s.id, confirm: true });
                            store.toast('success', 'Snapshot restored');
                          }
                        })}>
                        Restore
                      </button>
                    </td>
                  </tr>
                ))}
                {!snapshots.data?.length && (
                  <tr>
                    <td className="mute">No snapshots.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {tab === 'bisect' && (
          <div style={{ padding: 8 }} className="col">
            {!bisect.data && (
              <>
                <div className="callout info">
                  Dependency-aware bisection splits the resolved external mods of a profile into halves, keeping each mod together with its required dependencies. For every attempt, launch the generated bisect profile and classify whether the problem reproduced.
                </div>
                <button className="small" style={{ alignSelf: 'flex-start' }} disabled={!activeProfile} onClick={() => void store.call('bisect.start', { path: ws.path, profile: activeProfile }).then(refresh)}>
                  Start bisection of {activeProfile}
                </button>
              </>
            )}
            {bisect.data && (
              <>
                <div className="kv">
                  <span>Profile</span>
                  <span>
                    {bisect.data.profile} → test profile <b>{bisect.data.bisectProfile}</b>
                  </span>
                  <span>Candidates</span>
                  <span>{bisect.data.candidates.map((c) => bisect.data!.units.find((u) => u.key === c)?.title ?? c).join(', ')}</span>
                  <span>Attempts</span>
                  <span>{bisect.data.attempts.map((a) => a.outcome).join(', ') || 'none'}</span>
                </div>
                {bisect.data.current && (
                  <div>
                    <h4>Current attempt includes</h4>
                    <div className="dim">{bisect.data.current.map((c) => bisect.data!.units.find((u) => u.key === c)?.title ?? c).join(', ')}</div>
                    <div className="row" style={{ marginTop: 8 }}>
                      <button className="small" onClick={() => store.set({ activeProfile: bisect.data!.bisectProfile })}>
                        Select bisect profile
                      </button>
                      <button className="small danger" onClick={() => void store.call('bisect.record', { path: ws.path, outcome: 'bad' }).then(refresh)}>
                        Problem reproduced
                      </button>
                      <button className="small" onClick={() => void store.call('bisect.record', { path: ws.path, outcome: 'good' }).then(refresh)}>
                        Did not reproduce
                      </button>
                      <button className="small ghost" onClick={() => void store.call('bisect.record', { path: ws.path, outcome: 'skip' }).then(refresh)}>
                        Inconclusive
                      </button>
                    </div>
                  </div>
                )}
                {bisect.data.conclusion && <div className="callout">{bisect.data.conclusion}</div>}
                <button className="small ghost" style={{ alignSelf: 'flex-start' }} onClick={() => void store.call('bisect.reset', { path: ws.path }).then(refresh)}>
                  End bisection
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
