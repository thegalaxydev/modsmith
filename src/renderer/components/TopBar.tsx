import { useEffect, useState } from 'react';
import { store, useAsync, useStore } from '../store';
import { Ico, ProjectMark } from '../ui/icons';
import { useProjectImage } from '../projectImage';
import { IconButton, Menu, Popover } from '../ui/controls';
import { canLaunchLoader, derivePlayState, primaryLabel, profileLabel, uptime, type PlayState } from '../session';
import { play, stop, restart, exportPack, exportServerPack, exportServerProfile } from '../actions';
import { ApplyChanges } from './ApplyChanges';
import { MultiplayerDialog, SessionChip } from './MultiplayerSession';
import { DeployDialog } from './DeployDialog';
import { BuildControl } from './BuildControl';

export function TopBar({ onNewProject }: { onNewProject: () => void }) {
  const ws = useStore((s) => s.workspace)!;
  const activeProfile = useStore((s) => s.activeProfile);
  const operations = useStore((s) => s.operations);
  const instances = useStore((s) => s.instances);
  const manifest = ws.manifest;
  const profile = manifest?.profiles.find((p) => p.id === activeProfile);
  const state = derivePlayState(operations, instances, ws.path, activeProfile);
  const buildOp = operations.find((o) => o.workspace === ws.path && o.kind === 'project.build' && o.status === 'running');
  const canBuild = manifest?.source.kind === 'gradle' && canLaunchLoader(manifest.platform.loader);
  const canPlay = !!profile && canLaunchLoader(manifest?.platform.loader);
  const side = state.instance?.side ?? profile?.side;
  const [multiplayer, setMultiplayer] = useState(false);
  const [deploy, setDeploy] = useState(false);
  const canSession = canLaunchLoader(manifest?.platform.loader) && !!manifest?.profiles.some((p) => p.side === 'server') && !!manifest?.profiles.some((p) => p.side === 'client');

  return (
    <header className="topbar">
      <ProjectSwitcher onNewProject={onNewProject} />
      <div className="topbar-sep" />
      {manifest && manifest.profiles.length > 0 ? (
        <label className="config-picker" title={state.active ? 'Stop the running configuration to switch' : 'Run configuration'}>
          <Ico name={profile?.side === 'server' ? 'server' : 'minecraft'} size={15} />
          <select aria-label="Run configuration" value={activeProfile ?? ''} onChange={(e) => store.selectProfile(e.target.value)} disabled={state.active}>
            {manifest.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {profileLabel(p)}
              </option>
            ))}
          </select>
          <Ico name="chevronDown" size={13} className="config-caret" />
        </label>
      ) : (
        <span className="mute small">No run configurations</span>
      )}
      <PrimaryControl state={state} side={side} canPlay={canPlay} buildRunning={!!buildOp} />
      {manifest?.source.kind === 'gradle' && <BuildControl canBuild={!!canBuild} blocked={state.busy} />}
      <ProcessStatus state={state} buildRunning={!!buildOp} />
      {state.phase === 'running' && <IconButton icon="restart" label={side === 'server' ? 'Restart server' : 'Restart client'} onClick={() => void restart()} />}
      {state.phase === 'running' && <ApplyChanges />}
      {state.phase === 'running' && state.instance?.mode === 'development' && <DebugButton />}
      <SessionChip />
      <div className="spacer" />
      <Menu
        label="More actions"
        trigger={(p) => <IconButton icon="more" label="More actions" onClick={p.onClick} />}
        items={[
          { label: 'Multiplayer test…', icon: 'multiplayer', onSelect: () => setMultiplayer(true), disabled: !canSession },
          { separator: true, label: '' },
          { label: 'Export Modrinth pack', icon: 'modrinth', onSelect: () => void exportPack('mrpack'), disabled: !manifest },
          { label: 'Export CurseForge pack', icon: 'curseforge', onSelect: () => void exportPack('curseforge'), disabled: !manifest },
          { label: 'Export server pack', icon: 'server', onSelect: () => void exportServerPack(), disabled: !manifest || !exportServerProfile() },
          { label: 'Deploy to a server…', icon: 'export', onSelect: () => setDeploy(true), disabled: !manifest || !exportServerProfile() },
          { separator: true, label: '' },
          { label: 'Project settings', icon: 'settings', onSelect: () => store.openTab('page:project'), disabled: !manifest },
          { label: 'Project details & diagnostics', icon: 'diagnostics', onSelect: () => store.openTab('page:diagnostics') },
          { label: 'Open project folder', icon: 'openFolder', onSelect: () => void window.workbench?.openPath(ws.path) },
          { label: 'Reset layout', icon: 'layout', onSelect: () => store.resetLayout() }
        ]}
      />
      {multiplayer && <MultiplayerDialog onClose={() => setMultiplayer(false)} />}
      {deploy && <DeployDialog onClose={() => setDeploy(false)} />}
    </header>
  );
}

function DebugButton() {
  const debug = useStore((s) => s.debug);
  const label = debug.status === 'paused' ? 'Paused in the debugger' : debug.status === 'idle' ? 'Debug' : 'Debugging';
  return <IconButton icon="debug" label={label} active={debug.status !== 'idle'} tone={debug.status === 'paused' ? 'accent' : undefined} onClick={() => store.showTool('debug')} />;
}

function PrimaryControl({ state, side, canPlay, buildRunning }: { state: PlayState; side?: 'client' | 'server'; canPlay: boolean; buildRunning: boolean }) {
  const label = primaryLabel(state, side);
  if (state.phase === 'running') {
    return (
      <button type="button" className="run-btn stop" onClick={() => void stop()} title={side === 'server' ? 'Stop the server' : 'Stop the client'}>
        <Ico name="stop" size={14} />
        <span>{label}</span>
      </button>
    );
  }
  if (state.busy) {
    const cancellable = !!state.op && state.phase !== 'stopping';
    return (
      <button type="button" className="run-btn busy" onClick={cancellable ? () => void stop() : undefined} disabled={!cancellable} title={cancellable ? `${label}. Click to cancel.` : label} aria-busy>
        <Ico name="loading" size={14} className="spin" />
        <span>{label}</span>
      </button>
    );
  }
  const blocked = !canPlay || buildRunning;
  return (
    <button type="button" className="run-btn start" onClick={() => void play()} disabled={blocked} title={!canPlay ? 'This project cannot be launched yet' : buildRunning ? 'A build is running' : `Build if needed and ${side === 'server' ? 'start the server' : 'launch the client'}`}>
      <Ico name="play" size={14} />
      <span>{label}</span>
    </button>
  );
}

function ProcessStatus({ state, buildRunning }: { state: PlayState; buildRunning: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (state.phase !== 'running') return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [state.phase]);
  const building = buildRunning && !state.active;
  const tone = building ? 'busy' : state.tone;
  let text = building ? 'Building project' : state.label;
  if (state.phase === 'running' && state.instance) text = `Running · ${uptime(Date.now() - state.instance.startedAt)}`;
  if (state.busy && state.detail) text = state.detail;
  const open = () => {
    if (state.phase === 'build-failed') store.showTool(store.state.diagnostics.some((d) => d.severity === 'error') ? 'problems' : 'tasks');
    else if (state.phase === 'launch-failed' || state.busy || building) store.showTool('tasks');
    else store.showTool('console');
  };
  return (
    <button type="button" className={`process-status ${tone}`} title={state.detail ?? text} onClick={open}>
      <span className={`dot ${tone}`} />
      <span className="ellipsis">{text}</span>
    </button>
  );
}

function ProjectSwitcher({ onNewProject }: { onNewProject: () => void }) {
  const ws = useStore((s) => s.workspace)!;
  const recents = useAsync(() => store.call<{ path: string; name: string; exists: boolean }[]>('workspace.list', {}, { quiet: true }), [ws.path]);
  const m = ws.manifest;
  const image = useProjectImage();
  return (
    <Popover
      label="Projects"
      width={320}
      trigger={(p) => (
        <button type="button" className="project-switcher" onClick={p.onClick} aria-expanded={p['aria-expanded']} aria-label={`Project ${ws.name}. Switch project`} title="Switch project">
          <ProjectMark src={image} size={24} />
          <b className="ellipsis">{ws.name}</b>
          <span className="mute ellipsis small">{m ? `Minecraft ${m.platform.minecraft} · ${loaderName(m.platform.loader)}` : 'Not set up'}</span>
          <Ico name="chevronDown" size={13} />
        </button>
      )}
    >
      {(close) => (
        <div className="col">
          <div className="popover-title">Recent projects</div>
          <div className="list compact">
            {recents.data
              ?.filter((r) => r.exists)
              .slice(0, 8)
              .map((r) => (
                <button
                  type="button"
                  key={r.path}
                  className={`list-btn ${r.path === ws.path ? 'selected' : ''}`}
                  onClick={() => {
                    close();
                    if (r.path !== ws.path) void store.openWorkspace(r.path);
                  }}
                >
                  <span className="ellipsis">{r.name}</span>
                </button>
              ))}
          </div>
          <div className="menu-sep" />
          <button
            type="button"
            className="menu-item"
            onClick={async () => {
              close();
              const dir = await window.workbench?.chooseDirectory('Open a mod project or modpack folder');
              if (dir) await store.openWorkspace(dir);
            }}
          >
            <span className="menu-icon">
              <Ico name="openFolder" />
            </span>
            Open folder…
          </button>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              close();
              onNewProject();
            }}
          >
            <span className="menu-icon">
              <Ico name="add" />
            </span>
            New project…
          </button>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              close();
              void store.closeWorkspace();
            }}
          >
            <span className="menu-icon">
              <Ico name="close" />
            </span>
            Close project
          </button>
        </div>
      )}
    </Popover>
  );
}

export function loaderName(l: string) {
  return l === 'neoforge' ? 'NeoForge' : l === 'forge' ? 'Forge' : 'Fabric';
}
