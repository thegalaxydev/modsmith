import { store, useAsync, useStore } from '../store';
import { ConsolePanel } from '../panels/ConsolePanel';
import { ProblemsPanel } from '../panels/ProblemsPanel';
import { TasksPanel } from '../panels/TasksPanel';
import { ActivityPanel } from '../panels/ActivityPanel';

const openFile = (p: string) => store.openTab(`file:${p}`);

export function ConsoleTool() {
  const ws = useStore((s) => s.workspace)!;
  const instances = useStore((s) => s.instances);
  const selected = useStore((s) => s.selectedInstance);
  const wsInstances = instances.filter((i) => i.workspace === ws.path);
  const current = wsInstances.find((i) => i.id === selected) ?? wsInstances.find((i) => ['starting', 'running', 'stopping'].includes(i.status)) ?? wsInstances[0];
  return (
    <div className="tool-body">
      <ConsolePanel instances={wsInstances} current={current} onOpenFile={openFile} />
    </div>
  );
}

export function ProblemsTool() {
  return (
    <div className="tool-body">
      <ProblemsPanel onOpenFile={openFile} />
    </div>
  );
}

export function TasksTool() {
  const ws = useStore((s) => s.workspace)!;
  const operations = useStore((s) => s.operations);
  return (
    <div className="tool-body">
      <TasksPanel operations={operations.filter((o) => o.workspace === ws.path || !o.workspace)} />
    </div>
  );
}

export function ActivityTool() {
  return (
    <div className="tool-body">
      <ActivityPanel />
    </div>
  );
}

export function TestResultsTool() {
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
