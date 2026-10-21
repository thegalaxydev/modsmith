import { store, useStore } from '../store';
import { Ico } from '../ui/icons';
import { derivePlayState, profileLabel } from '../session';
import { OUTPUT_TOOLS } from '../dock';

export function StatusBar() {
  const ws = useStore((s) => s.workspace)!;
  const operations = useStore((s) => s.operations);
  const instances = useStore((s) => s.instances);
  const diagnostics = useStore((s) => s.diagnostics);
  const activeProfile = useStore((s) => s.activeProfile);
  const drawer = useStore((s) => OUTPUT_TOOLS.some((t) => s.openPanels.includes(t)));
  const inspector = useStore((s) => s.openPanels.includes('inspector'));
  const state = derivePlayState(operations, instances, ws.path, activeProfile);
  const running = operations.filter((o) => o.status === 'running' && (o.workspace === ws.path || !o.workspace));
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
  const profile = ws.manifest?.profiles.find((p) => p.id === (state.instance?.profileId ?? activeProfile));
  const open = (tab: 'console' | 'problems' | 'tasks') => store.showTool(tab);
  return (
    <footer className="statusbar">
      <button type="button" className="sb-item" onClick={() => open('console')} title="Show console">
        <span className={`dot ${state.phase === 'running' ? 'ok' : state.phase.endsWith('failed') ? 'err' : state.busy ? 'busy' : ''}`} />
        {profile ? profileLabel(profile) : 'No profile'}: {state.label}
        {state.instance?.bridge.connected && <span className="mute"> · bridge connected</span>}
      </button>
      {running.length > 0 && (
        <button type="button" className="sb-item" onClick={() => open('tasks')} title="Show tasks">
          <Ico name="loading" size={14} className="spin" />
          <span className="ellipsis">
            {running[0].title}
            {running[0].message ? ` · ${running[0].message}` : ''}
          </span>
          {running.length > 1 && <span className="mute">+{running.length - 1}</span>}
        </button>
      )}
      <div className="spacer" />
      <button type="button" className="sb-item" onClick={() => open('problems')} title="Show problems" aria-label={`${errors} errors, ${warnings} warnings`}>
        <Ico name="problems" size={14} className={errors ? 'err' : ''} /> {errors}
        <Ico name="warning" size={14} className={warnings ? 'warn' : ''} /> {warnings}
      </button>
      <button type="button" className={`sb-item ${inspector ? 'on' : ''}`} onClick={() => store.toggleTool('inspector')} aria-pressed={inspector} title="Toggle inspector">
        <Ico name="inspector" size={14} />
      </button>
      <button type="button" className={`sb-item ${drawer ? 'on' : ''}`} onClick={() => store.toggleOutput()} aria-pressed={drawer} title={drawer ? 'Hide console and problems' : 'Show console and problems'}>
        <Ico name="drawer" size={14} />
      </button>
    </footer>
  );
}
