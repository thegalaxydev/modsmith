import { useRef } from 'react';
import { store, useAsync, useStore } from '../store';
import { Ico } from '../ui/icons';
import { IconButton, Popover } from '../ui/controls';
import { fileIconUrl } from '../icons';
import { ago } from '../session';
import { build, datagen } from '../actions';

export interface Artifact {
  name: string;
  path: string;
  size: number;
  mtime: number;
  kind: 'mod' | 'sources' | 'javadoc' | 'dev';
}

const KIND: Record<Artifact['kind'], string> = { mod: 'Mod JAR', sources: 'Source code', javadoc: 'Javadoc', dev: 'Development only' };

function size(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function saveArtifactCopy(a: Artifact) {
  const ws = store.state.workspace;
  if (!ws) return;
  const out = await window.workbench?.chooseSave('Save a copy of the JAR', a.name, [{ name: 'Java archive', extensions: ['jar'] }]);
  if (!out) return;
  const r = await store.call<{ output: string }>('project.export_artifact', { path: ws.path, name: a.name, output: out });
  store.toast('success', `Saved ${a.name} to ${r.output}`);
  void window.workbench?.showItem(r.output);
}

export function BuildControl({ canBuild, blocked }: { canBuild: boolean; blocked: boolean }) {
  const ws = useStore((s) => s.workspace)!;
  const building = useStore((s) => s.operations.some((o) => o.workspace === ws.path && (o.kind === 'project.build' || o.kind === 'project.datagen') && o.status === 'running'));
  const toggle = useRef<{ open: () => void; expanded: boolean }>({ open: () => undefined, expanded: false });

  const run = async (opts: { clean?: boolean } = {}) => {
    const done = await build(opts);
    if (done?.status === 'succeeded' && !toggle.current.expanded) toggle.current.open();
  };

  const title = !canBuild ? 'This project cannot be built here' : building ? 'A build is running. Click to see its output.' : blocked ? 'Stop the game or wait for it to start before building' : 'Build the mod JAR with Gradle';

  return (
    <div className={`split-btn ${building ? 'busy' : ''}`}>
      <button type="button" className="split-main" onClick={() => (building ? store.showTool('tasks') : void run())} disabled={!canBuild || (blocked && !building)} title={title}>
        <Ico name={building ? 'loading' : 'build'} size={14} className={building ? 'spin' : undefined} />
        <span>{building ? 'Building' : 'Build'}</span>
      </button>
      <Popover
        label="Build and built JARs"
        width={380}
        trigger={(p) => {
          toggle.current = { open: p.onClick, expanded: p['aria-expanded'] };
          return (
            <button type="button" className="split-caret" onClick={p.onClick} aria-expanded={p['aria-expanded']} aria-label="Build options and built JARs" title="Build options and built JARs">
              <Ico name="chevronDown" size={13} />
            </button>
          );
        }}
      >
        {(close) => <BuildMenu canBuild={canBuild} busy={building || blocked} close={close} onBuild={(o) => void run(o)} />}
      </Popover>
    </div>
  );
}

function BuildMenu({ canBuild, busy, close, onBuild }: { canBuild: boolean; busy: boolean; close: () => void; onBuild: (o: { clean?: boolean }) => void }) {
  const ws = useStore((s) => s.workspace)!;
  const finished = useStore((s) => s.operations.filter((o) => o.workspace === ws.path && o.kind === 'project.build' && o.status !== 'running').length);
  const loader = ws.manifest?.platform.loader;
  const list = useAsync(() => store.call<{ folder: string; exists: boolean; files: Artifact[] }>('project.artifacts', { path: ws.path }, { quiet: true }), [ws.path, finished]);
  const files = list.data?.files ?? [];
  const mods = files.filter((f) => f.kind === 'mod');
  const other = files.filter((f) => f.kind !== 'mod');
  const item = (label: string, icon: 'build' | 'cleanBuild' | 'datagen', onSelect: () => void, disabled: boolean) => (
    <button
      type="button"
      className="menu-item"
      disabled={disabled}
      onClick={() => {
        close();
        onSelect();
      }}
    >
      <span className="menu-icon">
        <Ico name={icon} />
      </span>
      {label}
    </button>
  );
  const row = (a: Artifact) => (
    <div key={a.name} className={`artifact-row ${a.kind === 'mod' ? 'primary' : ''}`}>
      <img className="file-icon" src={fileIconUrl(a.name)} alt="" />
      <span className="col tight grow" style={{ minWidth: 0 }}>
        <span className="ellipsis artifact-name" title={a.path}>
          {a.name}
        </span>
        <span className="small dim">
          {KIND[a.kind]}, {size(a.size)}, built {ago(a.mtime)}
        </span>
      </span>
      <IconButton icon="download" label={`Save a copy of ${a.name}`} onClick={() => void saveArtifactCopy(a)} />
      <IconButton icon="openFolder" label={`Show ${a.name} in its folder`} onClick={() => void window.workbench?.showItem(a.path)} />
    </div>
  );
  return (
    <div className="col build-menu">
      <div className="list compact">
        {item('Build', 'build', () => onBuild({}), !canBuild || busy)}
        {item('Clean build', 'cleanBuild', () => onBuild({ clean: true }), !canBuild || busy)}
        {item('Run data generation', 'datagen', () => void datagen(), !canBuild || busy || !ws.trusted)}
      </div>
      <div className="menu-sep" />
      <div className="popover-title">Built JARs</div>
      {list.loading && !list.data ? (
        <div className="small dim pad-x">Loading…</div>
      ) : !files.length ? (
        <div className="small dim pad-x">Nothing has been built yet. Build the project to create the mod JAR in build/libs.</div>
      ) : (
        <div className="col tight">
          {mods.map(row)}
          {other.length > 0 && <div className="small mute pad-x">Other files from the build. Players only need the mod JAR.</div>}
          {other.map(row)}
        </div>
      )}
      {mods.length > 0 && loader === 'forge' && <div className="small mute pad-x">This is the reobfuscated JAR for players. The development copy in build/devlibs only works inside Modsmith.</div>}
      {list.data?.exists && (
        <button
          type="button"
          className="link-btn pad-x"
          onClick={() => {
            close();
            void window.workbench?.openPath(list.data!.folder);
          }}
        >
          Open the build/libs folder
        </button>
      )}
    </div>
  );
}
