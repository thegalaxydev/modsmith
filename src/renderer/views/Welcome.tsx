import { useState } from 'react';
import { store, useAsync, useStore, waitForOperation } from '../store';
import { PRODUCT } from '../../shared/product';
import { AppMark, Ico } from '../ui/icons';
import { IconButton } from '../ui/controls';
import type { OperationInfo } from '../../shared/types';

interface Recent {
  path: string;
  name: string;
  type: string;
  openedAt: number;
  exists: boolean;
}

export function Welcome({ onNewProject, onSettings }: { onNewProject: () => void; onSettings: () => void }) {
  const connection = useStore((s) => s.connection);
  const recents = useAsync(() => (connection === 'connected' ? store.call<Recent[]>('workspace.list') : Promise.resolve([])), [connection]);
  const [importing, setImporting] = useState(false);
  const ready = connection === 'connected';

  const openFolder = async () => {
    const dir = await window.workbench?.chooseDirectory('Open a mod project or modpack folder');
    if (dir) await store.openWorkspace(dir);
  };

  const importPack = async () => {
    const file = await window.workbench?.chooseFile('Import modpack', [{ name: 'Modrinth or CurseForge pack', extensions: ['mrpack', 'zip'] }]);
    if (!file) return;
    const dest = await window.workbench?.chooseDirectory('Choose an empty folder for the modpack');
    if (!dest) return;
    setImporting(true);
    try {
      const op = await store.call<OperationInfo>(file.toLowerCase().endsWith('.zip') ? 'modpack.import_curseforge' : 'modpack.import_mrpack', { file, destination: dest });
      const done = await waitForOperation(op.id);
      if (done.status === 'succeeded') await store.openWorkspace((done.result as { path: string }).path);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="welcome">
      <div className="welcome-top">
        <div className="spacer" />
        <IconButton icon="settings" label="Settings" onClick={onSettings} />
      </div>
      <div className="welcome-body">
        <div className="welcome-hero">
          <AppMark size={52} />
          <div>
            <h1>{PRODUCT.name}</h1>
            <p className="dim">Build, play and inspect Minecraft mods and modpacks.</p>
          </div>
        </div>
        <div className="welcome-actions">
          <button type="button" className="welcome-action primary" onClick={onNewProject} disabled={!ready}>
            <Ico name="add" size={20} />
            <span className="col tight">
              <b>New mod</b>
              <span className="small">Start from a verified template</span>
            </span>
          </button>
          <button type="button" className="welcome-action" onClick={() => void openFolder()} disabled={!ready}>
            <Ico name="openFolder" size={20} />
            <span className="col tight">
              <b>Open folder</b>
              <span className="small dim">An existing mod or modpack</span>
            </span>
          </button>
          <button type="button" className="welcome-action" onClick={() => void importPack()} disabled={!ready || importing}>
            <Ico name={importing ? 'loading' : 'importJar'} size={20} className={importing ? 'spin' : ''} />
            <span className="col tight">
              <b>{importing ? 'Importing…' : 'Import modpack'}</b>
              <span className="small dim">Modrinth .mrpack or CurseForge .zip</span>
            </span>
          </button>
        </div>
        <section className="welcome-recent">
          <h2>Recent</h2>
          {recents.loading && ready && <div className="dim">Loading…</div>}
          {!recents.loading && !recents.data?.length && <div className="dim">Projects you open will appear here.</div>}
          <div className="list">
            {recents.data?.map((r) => (
              <button type="button" key={r.path} className="list-btn recent-row" disabled={!r.exists} onClick={() => void store.openWorkspace(r.path)} title={r.path}>
                <Ico name={r.type === 'modpack' ? 'mods' : 'code'} size={16} />
                <span className="col tight grow">
                  <span className="ellipsis">{r.name}</span>
                  <span className="mute small ellipsis">{r.exists ? r.path : 'Folder not found'}</span>
                </span>
                <span className="mute small nowrap">{new Date(r.openedAt).toLocaleDateString()}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
