import { store, useAsync, useStore } from '../store';
import { Ico, type IconName } from '../ui/icons';
import { IconButton } from '../ui/controls';
import { ConsolePanel } from '../panels/ConsolePanel';
import { ProblemsPanel } from '../panels/ProblemsPanel';
import { TasksPanel } from '../panels/TasksPanel';
import { ActivityPanel } from '../panels/ActivityPanel';
import type { LayoutPrefs } from '../session';

const TABS: { id: LayoutPrefs['drawerTab']; label: string; icon: IconName }[] = [
  { id: 'console', label: 'Console', icon: 'console' },
  { id: 'problems', label: 'Problems', icon: 'problems' },
  { id: 'tasks', label: 'Tasks', icon: 'loading' },
  { id: 'tests', label: 'Tests', icon: 'tests' },
  { id: 'activity', label: 'Activity', icon: 'activity' }
];

export function Drawer() {
  const ws = useStore((s) => s.workspace)!;
  const tab = useStore((s) => s.layout.drawerTab);
  const operations = useStore((s) => s.operations);
  const instances = useStore((s) => s.instances);
  const diagnostics = useStore((s) => s.diagnostics);
  const wsInstances = instances.filter((i) => i.workspace === ws.path);
  const selected = useStore((s) => s.selectedInstance);
  const current = wsInstances.find((i) => i.id === selected) ?? wsInstances.find((i) => ['starting', 'running', 'stopping'].includes(i.status)) ?? wsInstances[0];
  const wsOps = operations.filter((o) => o.workspace === ws.path || !o.workspace);
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const runningOps = wsOps.filter((o) => o.status === 'running').length;
  return (
    <div className="drawer">
      <div className="drawer-tabs" role="tablist" aria-label="Output">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => store.setLayout({ drawerTab: t.id })}>
            <Ico name={t.id === 'tasks' ? 'build' : t.icon} size={16} />
            {t.label}
            {t.id === 'problems' && errors > 0 && <span className="count err">{errors}</span>}
            {t.id === 'tasks' && runningOps > 0 && <span className="count">{runningOps}</span>}
          </button>
        ))}
        <div className="spacer" />
        <IconButton icon="close" label="Hide panel" onClick={() => store.setLayout({ drawer: false })} />
      </div>
      <div className="drawer-body">
        {tab === 'console' && <ConsolePanel instances={wsInstances} current={current} onOpenFile={(p) => store.openTab(`file:${p}`)} />}
        {tab === 'problems' && <ProblemsPanel onOpenFile={(p) => store.openTab(`file:${p}`)} />}
        {tab === 'tasks' && <TasksPanel operations={wsOps} />}
        {tab === 'tests' && <TestResults />}
        {tab === 'activity' && <ActivityPanel />}
      </div>
    </div>
  );
}

function TestResults() {
  const ws = useStore((s) => s.workspace)!;
  const ops = useStore((s) => s.operations.filter((o) => o.kind === 'scenario.run').length);
  const results = useAsync(() => store.call<{ scenario: string; startedAt: string; durationMs: number; passed: boolean; steps: { ok: boolean; action: string; detail: string }[] }[]>('scenario.results', { path: ws.path }, { quiet: true }), [ws.path, ops]);
  if (!results.data?.length)
    return (
      <div className="drawer-empty">
        No test results yet. <button type="button" className="link-btn" onClick={() => store.openTab('page:tests')}>Open Tests</button>
      </div>
    );
  return (
    <div className="scroll fill">
      <table className="grid">
        <tbody>
          {results.data.slice(0, 30).map((r, i) => (
            <tr key={i}>
              <td style={{ width: 70 }}>
                <span className={r.passed ? 'ok' : 'err'}>{r.passed ? 'Passed' : 'Failed'}</span>
              </td>
              <td>{r.scenario}</td>
              <td className="dim">{r.passed ? `${r.steps.length} steps` : r.steps.find((s) => !s.ok)?.detail}</td>
              <td className="mute nowrap">{new Date(r.startedAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
