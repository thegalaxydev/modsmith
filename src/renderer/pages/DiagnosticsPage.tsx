import { useEffect, useState } from 'react';
import { store, useAsync, useStore } from '../store';
import { profileLabel } from '../session';
import { Button, Kv, Notice, Section } from '../ui/controls';
import { ProjectMark } from '../ui/icons';
import { chooseProjectImage, clearProjectImage, useProjectImage } from '../projectImage';
import type { Capability, InstanceInfo } from '../../shared/types';

interface Launch {
  id: string;
  profile: string;
  side: string;
  mode: string;
  pid: number | null;
  started_at: number;
  ended_at: number | null;
  status: string;
  exit_code: number | null;
  log_file: string;
  crash_report: string | null;
}

export function DiagnosticsPage() {
  const ws = useStore((s) => s.workspace)!;
  const instances = useStore((s) => s.instances);
  const m = ws.manifest;
  const image = useProjectImage();
  const wsInstances = instances.filter((i) => i.workspace === ws.path);
  const [sel, setSel] = useState<string>(wsInstances[0]?.id ?? '');
  const inst = wsInstances.find((i) => i.id === sel) ?? wsInstances[0];
  const validation = useAsync(() => store.call<{ problems: { severity: string; message: string }[] }>('project.validate', { path: ws.path }, { quiet: true }), [ws.path, JSON.stringify(m)]);
  const caps = useAsync(() => store.call<{ id: string; name: string; capabilities: Capability[] }[]>('system.capabilities', {}, { quiet: true }), []);
  const history = useAsync(() => store.call<Launch[]>('instance.history', { path: ws.path }, { quiet: true }), [ws.path, wsInstances.map((i) => i.status).join()]);
  const adapter = caps.data?.find((c) => c.id === (m?.platform.loader ?? ws.detected?.loader));
  const profileName = (id: string) => {
    const p = m?.profiles.find((x) => x.id === id);
    return p ? profileLabel(p) : id;
  };

  return (
    <div className="page diag-page">
      <header className="page-head">
        <h1>Project details & diagnostics</h1>
        <div className="spacer" />
        <Button icon="openFolder" onClick={() => void window.workbench?.openPath(ws.path)}>
          Open folder
        </Button>
      </header>

      <Section title="Checks">
        {validation.data && !validation.data.problems.length && <div className="ok">No setup problems found.</div>}
        {validation.data?.problems.map((p, i) => (
          <Notice key={i} tone={p.severity === 'error' ? 'error' : p.severity === 'warning' ? 'warn' : 'info'}>
            {p.message}
          </Notice>
        ))}
        {ws.warnings.map((w, i) => (
          <Notice key={`w${i}`} tone="warn">
            {w}
          </Notice>
        ))}
      </Section>

      <Section title="Game session">
        {!wsInstances.length ? (
          <div className="dim">No game has run in this session yet.</div>
        ) : (
          <div className="col">
            <select value={inst?.id ?? ''} onChange={(e) => setSel(e.target.value)} aria-label="Session" className="fit">
              {wsInstances.map((i) => (
                <option key={i.id} value={i.id}>
                  {profileName(i.profileId)} · {i.status} · {new Date(i.startedAt).toLocaleTimeString()}
                </option>
              ))}
            </select>
            {inst && <SessionDetails inst={inst} />}
          </div>
        )}
      </Section>

      <Section title="Project">
        <Kv
          rows={[
            ['Folder', <span className="mono wrap-text">{ws.path}</span>],
            ['Manifest', m ? `modsmith.json, schema ${m.schemaVersion}` : 'none'],
            [
              'Image',
              <span className="row">
                <ProjectMark src={image} size={28} />
                <span className="dim">{m?.icon ?? 'Default mark'}</span>
                {m && (
                  <Button size="sm" onClick={() => void chooseProjectImage(ws.path)}>
                    Choose…
                  </Button>
                )}
                {m?.icon && (
                  <Button size="sm" onClick={() => void clearProjectImage(ws.path)}>
                    Use default
                  </Button>
                )}
              </span>
            ],
            ['Type', ws.type],
            ['Loader', m ? `${m.platform.loader} ${m.platform.loaderVersion}` : ws.detected?.loader ?? 'unknown'],
            ['Minecraft', m?.platform.minecraft ?? ws.detected?.minecraftHint ?? 'unknown'],
            ['Mod ID', <span className="mono">{m?.modId ?? '-'}</span>],
            ['Compatibility catalog', `${m?.platform.catalogEntry ?? 'none'}${ws.catalogStatus ? ` (${ws.catalogStatus})` : ''}`],
            ['Git', ws.gitRepo ? 'repository' : 'not a repository'],
            [
              'Trust',
              <span className="row">
                {ws.trusted ? 'Trusted: builds and launches may run project code' : 'Not trusted: nothing from this project has been run'}
                <Button size="sm" onClick={() => void store.call('workspace.trust', { path: ws.path, trusted: !ws.trusted }).then(() => store.refreshWorkspace())}>
                  {ws.trusted ? 'Revoke' : 'Trust'}
                </Button>
              </span>
            ]
          ]}
        />
      </Section>

      {ws.detected && (
        <Section title="Detected build setup" collapsible defaultOpen={false}>
          <Kv
            rows={[
              ['Build system', `${ws.detected.buildSystem}${ws.detected.gradleWrapper ? ' (wrapper present)' : ' (no wrapper)'}`],
              ['Gradle plugins', <span className="mono">{ws.detected.loaderPlugins.join(', ') || 'none found'}</span>],
              ['Build files', <span className="mono">{ws.detected.buildFiles.join(', ')}</span>],
              ['Mod metadata', <span className="mono wrap-text">{ws.detected.modMetadata.map((x) => `${x.file}${x.id ? ` (${x.id})` : ''}`).join(', ') || 'none'}</span>]
            ]}
          />
          {ws.detected.notes.map((n, i) => (
            <div key={i} className="small dim">
              {n}
            </div>
          ))}
        </Section>
      )}

      {adapter && (
        <Section title={`${adapter.name} support`} collapsible defaultOpen={false}>
          <table className="grid">
            <tbody>
              {adapter.capabilities.map((c) => (
                <tr key={c.id}>
                  <td className={c.state === 'supported' ? 'ok' : c.state === 'planned' ? 'warn' : 'err'} style={{ width: 90 }}>
                    {c.state}
                  </td>
                  <td>{c.label}</td>
                  <td className="dim">{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      <Section title="Run history" collapsible defaultOpen={false}>
        {!history.data?.length && <div className="dim">No runs recorded.</div>}
        {!!history.data?.length && (
          <table className="grid">
            <thead>
              <tr>
                <th>Started</th>
                <th>Profile</th>
                <th>Result</th>
                <th>Duration</th>
                <th>PID</th>
              </tr>
            </thead>
            <tbody>
              {history.data.slice(0, 50).map((h) => (
                <tr key={h.id}>
                  <td className="nowrap">{new Date(h.started_at).toLocaleString()}</td>
                  <td>
                    {profileName(h.profile)} <span className="mute">({h.mode})</span>
                  </td>
                  <td className={h.status === 'crashed' || h.status === 'failed' ? 'err' : ''}>
                    {h.status}
                    {h.exit_code !== null ? ` (exit ${h.exit_code})` : ''}
                  </td>
                  <td>{h.ended_at ? `${Math.max(1, Math.round((h.ended_at - h.started_at) / 1000))} s` : '-'}</td>
                  <td className="mono">{h.pid ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

interface CrashAnalysis {
  crashReport: string | null;
  observed: { description?: string; exception?: string; stackHead: string[]; suspectedModsFromReport: string[]; errorLines: string[]; exitCode?: number | null };
  hypotheses: { text: string; basis: string }[];
  recentChanges: string[];
  note: string;
}

function SessionDetails({ inst }: { inst: InstanceInfo }) {
  const [crash, setCrash] = useState<CrashAnalysis | null>(null);
  const [notes, setNotes] = useState('');
  const ended = ['exited', 'crashed', 'failed'].includes(inst.status);
  useEffect(() => {
    setCrash(null);
    if (inst.status === 'crashed' || inst.status === 'failed') void store.call<CrashAnalysis>('crash.inspect', { id: inst.id }, { quiet: true }).then(setCrash).catch(() => undefined);
  }, [inst.id, inst.status]);
  const game = inst.bridge.game as { minecraft?: string; loaderVersion?: string; bridgeVersion?: string; capabilities?: string[] } | undefined;
  return (
    <div className="col">
      <Kv
        rows={[
          ['Status', inst.status],
          ['Process ID', <span className="mono">{inst.pid ?? '-'}</span>],
          ['Java', <span className="mono wrap-text">{inst.javaExecutable ?? '-'}</span>],
          ['Game folder', <a className="mono wrap-text" onClick={() => void window.workbench?.openPath(inst.instanceDir)}>{inst.instanceDir}</a>],
          ['Session log', <a className="mono wrap-text" onClick={() => void window.workbench?.openPath(inst.logFile)}>{inst.logFile}</a>],
          ...(inst.exitCode !== undefined ? ([['Exit code', String(inst.exitCode)]] as [string, string][]) : []),
          ...(inst.debugPort ? ([['Debugger', `JDWP on 127.0.0.1:${inst.debugPort}`]] as [string, string][]) : []),
          ['Bridge', inst.bridge.connected ? `connected, protocol ${inst.bridge.protocol ?? 1}, Minecraft ${game?.minecraft}, loader ${game?.loaderVersion}, bridge ${game?.bridgeVersion}, ${game?.capabilities?.length ?? 0} methods` : ended ? 'closed' : 'not connected']
        ]}
      />
      {crash && (
        <div className="col">
          <h3>Crash analysis</h3>
          <div className="small dim">Observed facts</div>
          <Kv
            rows={[
              ['Crash report', crash.crashReport ? <a onClick={() => void window.workbench?.openPath(crash.crashReport!)}>{crash.crashReport.split(/[\\/]/).pop()}</a> : 'none written'],
              ...(crash.observed.description ? ([['Description', crash.observed.description]] as [string, string][]) : [])
            ]}
          />
          {crash.observed.exception && <pre className="code-block">{[crash.observed.exception, ...crash.observed.stackHead.map((s) => `  ${s}`)].join('\n')}</pre>}
          {crash.observed.suspectedModsFromReport.length > 0 && <div className="small">Minecraft lists as suspected: {crash.observed.suspectedModsFromReport.join(', ')}</div>}
          <div className="small dim">Automated hypotheses (may be wrong)</div>
          {crash.hypotheses.length ? crash.hypotheses.map((h, i) => <div key={i}>{h.text}</div>) : <div className="small mute">No known patterns matched.</div>}
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Reproduction notes" rows={3} />
          <div>
            <Button icon="export" onClick={() => void store.call<{ file: string }>('crash.bundle', { id: inst.id, notes }).then((r) => void window.workbench?.showItem(r.file))}>
              Create crash bundle
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
