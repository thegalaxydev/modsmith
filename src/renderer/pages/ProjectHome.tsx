import { store, useAsync, useStore } from '../store';
import { canLaunchLoader, derivePlayState, profileDescription, profileLabel } from '../session';
import { play } from '../actions';
import { Ico, ProjectMark } from '../ui/icons';
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

function ago(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
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

  return (
    <div className="page home-page">
      <header className="home-head">
        <ProjectMark src={image} size={48} />
        <div className="col tight grow">
          <h1>{ws.name}</h1>
          <div className="dim">{m ? `Minecraft ${m.platform.minecraft} · ${loaderName(m.platform.loader)} ${m.platform.loaderVersion}${m.type === 'modpack' ? ' · Modpack' : ''}` : 'This folder is not set up as a Modsmith project yet.'}</div>
        </div>
      </header>

      {!m && (
        <section className="home-block">
          <h2>Set up this folder</h2>
          <p className="dim">Detection is static: nothing in this folder has been run.</p>
          <InitManifest />
        </section>
      )}

      {m && (
        <section className="home-play">
          <div className="col tight grow">
            <div className="label">Test profile</div>
            <select aria-label="Test profile" value={activeProfile ?? ''} onChange={(e) => store.selectProfile(e.target.value)} disabled={state.active} className="profile-select-lg">
              {m.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {profileLabel(p)}
                </option>
              ))}
            </select>
            {profile && <div className="small dim">{profileDescription(profile, m)}</div>}
          </div>
          <div className="col tight end">
            {state.active && !state.phase.endsWith('failed') ? (
              <Button size="lg" icon="minecraft" onClick={() => store.set({ activeTab: 'minecraft' })}>
                {state.label}
              </Button>
            ) : (
              <Button size="lg" variant="primary" icon="play" onClick={() => void play()} disabled={!profile || !!unsupported}>
                Play
              </Button>
            )}
            <span className="small dim">{state.phase === 'idle' ? (ws.trusted ? 'Ready to play' : 'You will be asked to trust this project') : state.label}</span>
          </div>
        </section>
      )}

      {unsupported && <Notice tone="warn">{loaderName(m!.platform.loader)} projects can be browsed and edited, but building and launching are not available for this loader yet.</Notice>}
      {errors.length > 0 && (
        <Notice tone="error" action={<Button size="sm" onClick={() => store.showTool('problems')}>Show</Button>}>
          {errors.length === 1 ? errors[0].message : `${errors.length} setup problems need attention.`}
        </Notice>
      )}

      <div className="home-actions">
        <button type="button" className="home-action" onClick={() => (mainCode ? store.openTab(`file:${mainCode}`) : store.showTool('explorer'))}>
          <Ico name="code" size={20} />
          <span className="col tight">
            <b>Open code</b>
            <span className="small dim">{mainCode ? mainCode.split('/').pop() : 'Browse project files'}</span>
          </span>
        </button>
        <button type="button" className="home-action" onClick={() => store.openTab('page:mods')} disabled={!m}>
          <Ico name="mods" size={20} />
          <span className="col tight">
            <b>Manage mods</b>
            <span className="small dim">{profile ? `${profile.mods.length} extra mod${profile.mods.length === 1 ? '' : 's'} in ${profileLabel(profile)}` : 'Add mods for testing'}</span>
          </span>
        </button>
        <button type="button" className="home-action" onClick={() => store.openTab('page:profiles')} disabled={!m}>
          <Ico name="profiles" size={20} />
          <span className="col tight">
            <b>Test profiles</b>
            <span className="small dim">{m ? `${m.profiles.length} profile${m.profiles.length === 1 ? '' : 's'}` : ''}</span>
          </span>
        </button>
      </div>

      <div className="home-columns">
        {keyFiles.length > 0 && (
          <section className="home-block">
            <h2>{recent.length ? 'Recent files' : 'Start here'}</h2>
            <div className="list">
              {keyFiles.map((f) => (
                <button type="button" key={f} className="list-btn" onClick={() => store.openTab(`file:${f}`)}>
                  <img className="file-icon" src={fileIconUrl(f.split('/').pop()!)} alt="" />
                  <span className="ellipsis">{f.split('/').pop()}</span>
                  <span className="mute small ellipsis">{f.split('/').slice(0, -1).join('/')}</span>
                </button>
              ))}
            </div>
          </section>
        )}
        {last && (
          <section className="home-block">
            <h2>Last run</h2>
            <div className="row">
              <span className={`dot ${last.status === 'exited' ? 'ok' : last.status === 'crashed' || last.status === 'failed' ? 'err' : 'busy'}`} />
              <span>
                {profileLabel({ name: m?.profiles.find((p) => p.id === last.profile)?.name ?? last.profile, side: last.side as 'client', mode: 'development' })} · {ago(last.started_at)}
              </span>
            </div>
            <div className="small dim">
              {last.status === 'exited' ? `Closed normally after ${duration((last.ended_at ?? Date.now()) - last.started_at)}.` : last.status === 'crashed' ? `Crashed (exit code ${last.exit_code}).` : last.status === 'failed' ? 'Failed to start.' : 'Still running.'}
            </div>
            <button type="button" className="link-btn" onClick={() => store.openTab('page:diagnostics')}>
              Run history and diagnostics
            </button>
          </section>
        )}
      </div>
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
