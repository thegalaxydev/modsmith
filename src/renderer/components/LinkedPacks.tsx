import { store, useAsync, useStore } from '../store';
import { loaderName } from './TopBar';
import { Button, IconButton, Notice, Popover, Switch } from '../ui/controls';
import { AppMark, Ico, type IconName } from '../ui/icons';

export interface PackView {
  path: string;
  kind: 'curseforge' | 'modrinth' | 'prism' | 'modsmith' | 'folder';
  name: string;
  minecraft: string | null;
  loader: string | null;
  mods: number;
  disabledMods: number;
  configFolders: string[];
  problems: string[];
  compatible: boolean;
}

export interface LinkView extends PackView {
  enabled: boolean;
  configs: boolean;
  found: boolean;
}

const KIND_LABEL: Record<PackView['kind'], string> = {
  curseforge: 'CurseForge app',
  modrinth: 'Modrinth App',
  prism: 'Prism Launcher',
  modsmith: 'Modsmith modpack',
  folder: 'Folder'
};

const KIND_ICON: Record<Exclude<PackView['kind'], 'modsmith'>, IconName> = {
  curseforge: 'curseforge',
  modrinth: 'modrinth',
  prism: 'openFolder',
  folder: 'openFolder'
};

export function PackIcon({ kind, size = 20 }: { kind: PackView['kind']; size?: number }) {
  if (kind === 'modsmith') return <AppMark size={size} />;
  return <Ico name={KIND_ICON[kind]} size={size} />;
}

function packMeta(p: PackView): string {
  const parts = [KIND_LABEL[p.kind]];
  if (p.minecraft) parts.push(`Minecraft ${p.minecraft}`);
  if (p.loader) parts.push(loaderName(p.loader));
  parts.push(`${p.mods} mod${p.mods === 1 ? '' : 's'}${p.disabledMods ? ` (${p.disabledMods} disabled in the pack)` : ''}`);
  return parts.join(' · ');
}

export function useLinkedPacks(profileId: string | undefined) {
  const ws = useStore((s) => s.workspace);
  return useAsync(() => (ws && profileId ? store.call<LinkView[]>('profile.linked_packs', { path: ws.path, profile: profileId }, { quiet: true }) : Promise.resolve([])), [ws?.path, profileId, JSON.stringify(ws?.manifest), ws?.lockProfiles.join()]);
}

export function LinkedPacks({ profileId }: { profileId: string }) {
  const ws = useStore((s) => s.workspace)!;
  const links = useLinkedPacks(profileId);
  const update = (folder: string, patch: { enabled?: boolean; configs?: boolean }) => void store.call('profile.link_pack', { path: ws.path, profile: profileId, folder, ...patch }).then(links.reload);
  const unlink = (folder: string) => void store.call('profile.unlink_pack', { path: ws.path, profile: profileId, folder }).then(links.reload);
  return (
    <div className="col">
      <div className="small dim">Or link a modpack folder you already play in the CurseForge app, Modrinth App, Prism Launcher or another Modsmith project. It is read again every time the configuration launches and is never changed.</div>
      {links.data?.map((l) => (
        <div key={l.path} className={`pack-row ${l.enabled ? '' : 'off'}`}>
          <div className="row">
            <span className="pack-icon">
              <PackIcon kind={l.kind} />
            </span>
            <span className="col tight grow">
              <b className="ellipsis">{l.name}</b>
              <span className="small dim ellipsis">{l.found ? packMeta(l) : 'Folder not found'}</span>
              <a className="small mute mono ellipsis" title={l.path} onClick={() => void window.workbench?.openPath(l.path)}>
                {l.path}
              </a>
            </span>
            <Switch checked={l.enabled} label={`${l.enabled ? 'Stop loading' : 'Load'} ${l.name}`} onChange={(v) => update(l.path, { enabled: v })} />
            <IconButton icon="remove" label={`Unlink ${l.name}`} onClick={() => unlink(l.path)} />
          </div>
          {l.found && l.configFolders.length > 0 && (
            <label className="check small">
              <input type="checkbox" checked={l.configs} onChange={(e) => update(l.path, { configs: e.target.checked })} />
              Also copy its {l.configFolders.join(', ')} {l.configFolders.length === 1 ? 'folder' : 'folders'} into the test game
            </label>
          )}
          {l.problems.map((p) => (
            <Notice key={p} tone="warn">
              {p}
            </Notice>
          ))}
        </div>
      ))}
      <div className="row">
        <LinkPackPicker profileId={profileId} onLinked={links.reload} />
      </div>
    </div>
  );
}

function LinkPackPicker({ profileId, onLinked }: { profileId: string; onLinked: () => void }) {
  const ws = useStore((s) => s.workspace)!;
  const link = async (folder: string, close: () => void) => {
    close();
    await store.call('profile.link_pack', { path: ws.path, profile: profileId, folder });
    onLinked();
  };
  const choose = async (close: () => void) => {
    const dir = await window.workbench?.chooseDirectory('Choose a modpack instance folder');
    if (dir) await link(dir, close);
    else close();
  };
  return (
    <Popover
      label="Link a modpack"
      width={420}
      trigger={(t) => (
        <button type="button" className="btn btn-default btn-md" {...t}>
          <Ico name="link" size={16} />
          Link a modpack folder…
        </button>
      )}
    >
      {(close) => <PackList profileId={profileId} onPick={(f) => void link(f, close)} onChoose={() => void choose(close)} />}
    </Popover>
  );
}

function PackList({ profileId, onPick, onChoose }: { profileId: string; onPick: (folder: string) => void; onChoose: () => void }) {
  const ws = useStore((s) => s.workspace)!;
  const found = useAsync(() => store.call<PackView[]>('profile.discover_packs', { path: ws.path, profile: profileId }, { quiet: true }), [ws.path, profileId]);
  const m = ws.manifest!;
  return (
    <div className="col pack-picker">
      <div className="small dim">
        Modpacks found on this computer for Minecraft {m.platform.minecraft} with {loaderName(m.platform.loader)}:
      </div>
      {found.loading && <div className="small mute">Looking for modpacks…</div>}
      {!found.loading && !found.data?.length && <div className="small mute">No CurseForge, Modrinth App or Prism Launcher modpacks were found in their default folders.</div>}
      <div className="list pack-options">
        {found.data?.map((p) => (
          <button key={p.path} type="button" className="list-btn pack-option" disabled={!p.compatible} title={p.compatible ? p.path : p.problems.join('; ')} onClick={() => onPick(p.path)}>
            <span className="pack-icon">
              <PackIcon kind={p.kind} size={16} />
            </span>
            <span className="col tight grow">
              <span className="ellipsis">{p.name}</span>
              <span className="small dim ellipsis">{p.compatible ? packMeta(p) : p.problems[0]}</span>
            </span>
          </button>
        ))}
      </div>
      <Button icon="openFolder" onClick={onChoose}>
        Choose a folder…
      </Button>
    </div>
  );
}
