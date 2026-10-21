import { store, useAsync, useStore } from '../store';
import { Ico, ProjectMark } from '../ui/icons';
import { useProjectImage } from '../projectImage';
import { Button, IconButton, Menu, Popover } from '../ui/controls';
import { canLaunchLoader, derivePlayState, profileLabel } from '../session';
import { play, stop, restart, build, datagen, exportPack } from '../actions';
import { ApplyChanges } from './ApplyChanges';

export function TopBar({ onNewProject, onSettings }: { onNewProject: () => void; onSettings: () => void }) {
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

  return (
    <header className="topbar">
      <ProjectSwitcher onNewProject={onNewProject} />
      {manifest && manifest.profiles.length > 0 && (
        <label className="profile-picker" title="Test profile">
          <Ico name={profile?.side === 'server' ? 'server' : 'profiles'} size={16} />
          <select aria-label="Test profile" value={activeProfile ?? ''} onChange={(e) => store.selectProfile(e.target.value)} disabled={state.active}>
            {manifest.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {profileLabel(p)}
              </option>
            ))}
          </select>
        </label>
      )}
      {!state.active || state.phase === 'build-failed' || state.phase === 'launch-failed' ? (
        <Button variant="primary" size="lg" icon="play" onClick={() => void play()} disabled={!canPlay || !!buildOp} title={canPlay ? `Build if needed and start ${profile ? profileLabel(profile) : ''}` : 'This project cannot be launched yet'}>
          Play
        </Button>
      ) : (
        <Button variant="danger" size="lg" icon="stop" onClick={() => void stop()} disabled={state.phase === 'stopping'} title={state.op ? 'Cancel launch' : 'Stop Minecraft'}>
          {state.op ? 'Cancel' : 'Stop'}
        </Button>
      )}
      {state.phase === 'running' && <IconButton icon="restart" label="Restart Minecraft" onClick={() => void restart()} />}
      {state.phase === 'running' && <ApplyChanges />}
      <PlayStatus state={state} buildRunning={!!buildOp} />
      <div className="spacer" />
      <Menu
        label="More actions"
        trigger={(p) => <IconButton icon="more" label="More actions" onClick={p.onClick} />}
        items={[
          { label: 'Build', icon: 'build', onSelect: () => void build(), disabled: !canBuild || state.busy },
          { label: 'Clean build', icon: 'cleanBuild', onSelect: () => void build({ clean: true }), disabled: !canBuild || state.busy },
          { label: 'Run data generation', icon: 'datagen', onSelect: () => void datagen(), disabled: !canBuild || !ws.trusted },
          { separator: true, label: '' },
          { label: 'Export Modrinth pack', icon: 'modrinth', onSelect: () => void exportPack('mrpack'), disabled: !manifest },
          { label: 'Export CurseForge pack', icon: 'curseforge', onSelect: () => void exportPack('curseforge'), disabled: !manifest },
          { separator: true, label: '' },
          { label: 'Project details & diagnostics', icon: 'diagnostics', onSelect: () => store.openTab('page:diagnostics') },
          { label: 'Open project folder', icon: 'openFolder', onSelect: () => void window.workbench?.openPath(ws.path) },
          { label: 'Reset layout', icon: 'layout', onSelect: () => store.resetLayout() }
        ]}
      />
      <IconButton icon="settings" label="Settings" onClick={onSettings} />
    </header>
  );
}

function PlayStatus({ state, buildRunning }: { state: ReturnType<typeof derivePlayState>; buildRunning: boolean }) {
  const tone = state.phase === 'running' ? 'ok' : state.phase.endsWith('failed') ? 'err' : state.busy || buildRunning ? 'busy' : 'idle';
  const label = buildRunning && !state.active ? 'Building' : state.label;
  return (
    <button
      type="button"
      className={`play-status ${tone}`}
      title={state.detail ?? label}
      onClick={() => {
        if (state.phase.endsWith('failed')) store.showTool(store.state.diagnostics.some((d) => d.severity === 'error') ? 'problems' : 'tasks');
        else if (state.busy || buildRunning) store.showTool('tasks');
        else if (state.phase === 'running') store.set({ activeTab: 'minecraft' });
      }}
    >
      {state.busy || buildRunning ? <Ico name="loading" className="spin" /> : <span className={`dot ${tone}`} />}
      <span className="ellipsis">{label}</span>
      {state.busy && state.detail && <span className="mute ellipsis play-detail">{state.detail}</span>}
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
        <button type="button" className="project-switcher" onClick={p.onClick} aria-expanded={p['aria-expanded']} aria-label="Switch project">
          <ProjectMark src={image} size={28} />
          <span className="col tight">
            <b className="ellipsis">{ws.name}</b>
            <span className="mute ellipsis small">{m ? `Minecraft ${m.platform.minecraft} · ${loaderName(m.platform.loader)}` : 'Not set up'}</span>
          </span>
          <Ico name="chevronDown" size={14} />
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
