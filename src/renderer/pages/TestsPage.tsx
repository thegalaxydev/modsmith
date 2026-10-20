import { useStore } from '../store';
import { derivePlayState } from '../session';
import { TestsPanel } from '../panels/TestsPanel';

export function TestsPage() {
  const ws = useStore((s) => s.workspace)!;
  const operations = useStore((s) => s.operations);
  const instances = useStore((s) => s.instances);
  const activeProfile = useStore((s) => s.activeProfile);
  const state = derivePlayState(operations, instances, ws.path, activeProfile);
  return (
    <div className="page tests-page">
      <header className="page-head">
        <h1>Tests</h1>
      </header>
      <p className="dim">Scenarios run scripted checks against a running game. Snapshots save and restore test worlds. Bisection narrows down which mod causes a problem.</p>
      <div className="tests-body">
        <TestsPanel current={state.instance ?? instances.find((i) => i.workspace === ws.path)} />
      </div>
    </div>
  );
}
