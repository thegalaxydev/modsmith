import { store, useAsync, useStore } from '../store';
import { ago, canLaunchLoader, derivePlayState, profileLabel } from '../session';
import { ProjectMark } from '../ui/icons';
import { useProjectImage } from '../projectImage';
import { Button, Notice } from '../ui/controls';
import { fileIconUrl } from '../icons';
import { loaderName } from '../components/TopBar';
import { InitManifest } from './InitManifest';
import type { FileNode } from '../../shared/types';

interface Launch {
  id: string;
  profile: string;
  side: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  exit_code: number | null;
}

function duration(ms: number) {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'under a minute' : `${m} min`;
}

export function ProjectHome() {
  const ws = useStore((s) => s.workspace)!;
  const activeProfile = useStore((s) => s.activeProfile);
  const operations = useStore((s) => s.operations);
  const instances = useStore((s) => s.instances);
  const recent = useStore((s) => s.recentFiles[ws.path] ?? []);
  const m = ws.manifest;
  const image = useProjectImage();
  const profile = m?.profiles.find((p) => p.id === activeProfile);
  const state = derivePlayState(operations, instances, ws.path, activeProfile);
  const validation = useAsync(() => store.call<{ problems: { severity: string; message: string }[] }>('project.validate', { path: ws.path }, { quiet: true }), [ws.path, JSON.stringify(m)]);
  const history = useAsync(() => store.call<Launch[]>('instance.history', { path: ws.path }, { quiet: true }), [ws.path, instances.length, instances.map((i) => i.status).join()]);
  const tree = useAsync(() => store.call<FileNode[]>('workspace.tree', { path: ws.path, dir: 'src', depth: 8 }, { quiet: true }).catch(() => [] as FileNode[]), [ws.path]);
  const errors = validation.data?.problems.filter((p) => p.severity === 'error') ?? [];
  const unsupported = m && !canLaunchLoader(m.platform.loader);
  const last = history.data?.[0];
  const mainCode = findMainCode(tree.data ?? [], m?.modId);
  const keyFiles = recent.length ? recent : [mainCode, findFile(tree.data ?? [], /(fabric\.mod\.json|neoforge\.mods\.toml)$/)].filter(Boolean) as string[];

  const runName = (id: string) => {
    const p = m?.profiles.find((x) => x.id === id);
    return p ? profileLabel(p) : id;
  };

  return (
    <div className="page overview-page">
      <header className="overview-head">
        <ProjectMark src={image} size={32} />
        <div className="col tight grow">
          <h1>{ws.name}</h1>
          <div className="dim small">{m ? `Minecraft ${m.platform.minecraft} · ${loaderName(m.platform.loader)} ${m.platform.loaderVersion}${m.type === 'modpack' ? ' · Modpack' : ''}${m.modId ? ` · ${m.modId}` : ''}` : 'This folder is not set up as a Modsmith project yet.'}</div>
        </div>
      </header>

      {!m && (
        <section className="view-section">
          <h3>Set up this folder</h3>
          <p className="dim">Detection is static: nothing in this folder has been run.</p>
          <InitManifest />
        </section>
      )}

      {unsupported && <Notice tone="warn">{loaderName(m!.platform.loader)} projects can be browsed and edited, but building and launching are not available for this loader yet.</Notice>}
      {m && !ws.trusted && <Notice tone="info">This project has not been trusted yet. Building or launching asks first, because it runs the project's Gradle scripts.</Notice>}
      {errors.length > 0 && (
        <Notice tone="error" action={<Button size="sm" onClick={() => store.showTool('problems')}>Show problems</Button>}>
          {errors.length === 1 ? errors[0].message : `${errors.length} setup problems need attention.`}
        </Notice>
      )}

      {m && (
        <div className="overview-grid">
          <section className="view-section">
            <div className="section-head">
              <h3>Run configurations</h3>
              <button type="button" className="link-btn" onClick={() => store.openTab('page:profiles')}>
                Manage
              </button>
            </div>
            <table className="grid selectable">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Target</th>
                  <th>Build</th>
                  <th className="num">Extra mods</th>
                </tr>
              </thead>
              <tbody>
                {m.profiles.map((p) => {
                  const selected = p.id === activeProfile;
                  return (
                    <tr
                      key={p.id}
                      className={selected ? 'selected' : ''}
                      aria-selected={selected}
                      tabIndex={state.active ? -1 : 0}
                      onClick={() => !state.active && store.selectProfile(p.id)}
                      onKeyDown={(e) => {
                        if ((e.key === 'Enter' || e.key === ' ') && !state.active) {
                          e.preventDefault();
                          store.selectProfile(p.id);
                        }
                      }}
                      title={state.active ? 'Stop the running configuration to switch' : `Select ${profileLabel(p)}`}
                    >
                      <td>
                        <span className="row tight">
                          {selected && <span className={`dot ${state.tone}`} />}
                          {profileLabel(p)}
                        </span>
                      </td>
                      <td className="dim">{p.side === 'server' ? 'Dedicated server' : 'Client'}</td>
                      <td className="dim">{p.mode === 'production' ? 'Release JAR' : 'Development'}</td>
                      <td className="num dim">{p.mods.length}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {profile && <p className="small mute">Selected: {profileLabel(profile)}, {state.active || state.failed ? state.label.toLowerCase() : 'stopped'}. Start it from the toolbar.</p>}
          </section>

          <div className="col">
            <section className="view-section">
              <h3>Last run</h3>
              {last ? (
                <dl className="kv">
                  <dt>Configuration</dt>
                  <dd>{runName(last.profile)}</dd>
                  <dt>Result</dt>
                  <dd className={last.status === 'crashed' || last.status === 'failed' ? 'err' : ''}>
                    {last.status === 'exited' ? `Stopped normally after ${duration((last.ended_at ?? Date.now()) - last.started_at)}` : last.status === 'crashed' ? `Crashed${last.exit_code != null ? ` with exit code ${last.exit_code}` : ''}` : last.status === 'failed' ? 'Failed to start' : 'Running'}
                  </dd>
                  <dt>When</dt>
                  <dd>{ago(last.started_at)}</dd>
                </dl>
              ) : (
                <p className="mute small">Nothing has been run in this project yet.</p>
              )}
              <button type="button" className="link-btn" onClick={() => store.openTab('page:diagnostics')}>
                Run history and diagnostics
              </button>
            </section>

            <section className="view-section">
              <h3>{recent.length ? 'Recent files' : 'Start here'}</h3>
              {keyFiles.length ? (
                <div className="list">
                  {keyFiles.map((f) => (
                    <button type="button" key={f} className="list-btn" onClick={() => store.openTab(`file:${f}`)}>
                      <img className="file-icon" src={fileIconUrl(f.split('/').pop()!)} alt="" />
                      <span className="ellipsis">{f.split('/').pop()}</span>
                      <span className="mute small ellipsis">{f.split('/').slice(0, -1).join('/')}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <button type="button" className="link-btn" onClick={() => store.showTool('explorer')}>
                  Browse project files
                </button>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

function walk(nodes: FileNode[], out: string[] = []) {
  for (const n of nodes) {
    if (n.dir) walk(n.children ?? [], out);
    else out.push(n.path);
  }
  return out;
}

function findMainCode(nodes: FileNode[], modId?: string) {
  const files = walk(nodes).filter((f) => /\.(java|kt)$/.test(f) && /src\/main\//.test(f));
  files.sort((a, b) => a.split('/').length - b.split('/').length);
  return files.find((f) => modId && f.toLowerCase().includes(modId.replace(/_/g, ''))) ?? files[0];
}

function findFile(nodes: FileNode[], re: RegExp) {
  return walk(nodes).find((f) => re.test(f));
}
