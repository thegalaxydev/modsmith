import { useEffect, useState } from 'react';
import { store, useAsync, useStore, waitForOperation } from '../store';
import type { CatalogEntry, OperationInfo } from '../../shared/types';
import { Button, IconButton, Notice, useOverlay } from '../ui/controls';
import { ask } from '../dialogs';

interface Plan {
  folder: string;
  project: string;
  convert: boolean;
  currentFolder?: string;
  moves: string[];
  backup: 'git' | 'copy';
  gradle?: { from: string; to: string };
  issues: string[];
}

interface Result {
  folder: string;
  project: string;
  converted: boolean;
  currentFolder: string | null;
  backup: string | null;
  skipped: string[];
}

const LOADER: Record<string, string> = { fabric: 'Fabric', neoforge: 'NeoForge', forge: 'Forge' };

function listed(names: string[]) {
  return names.length > 6 ? `${names.slice(0, 5).join(', ')} and ${names.length - 5} more` : names.join(', ');
}

export function AddTargetDialog({ onClose }: { onClose: () => void }) {
  useOverlay(true);
  const ws = useStore((s) => s.workspace)!;
  const catalog = useAsync(() => store.call<{ entries: CatalogEntry[] }>('catalog.list'), []);
  const caps = useAsync(() => store.call<{ id: string; name: string; implemented: boolean }[]>('system.capabilities'), []);
  const have = new Set((ws.detected?.targets ?? []).map((t) => `${t.loader}-${t.minecraft}`));
  if (!ws.detected?.targets?.length && ws.manifest) have.add(`${ws.manifest.platform.loader}-${ws.manifest.platform.minecraft}`);
  const current = ws.manifest?.platform;
  const [loader, setLoader] = useState(current?.loader === 'neoforge' ? 'forge' : 'neoforge');
  const [entryId, setEntryId] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Result | null>(null);
  const [added, setAdded] = useState('');

  const label = (e: CatalogEntry) => `${LOADER[e.loader] ?? e.loader} ${e.minecraft}`;
  const loaders = caps.data?.filter((c) => c.implemented) ?? [];
  const options = catalog.data?.entries.filter((e) => e.loader === loader && e.status !== 'unverified' && !have.has(`${e.loader}-${e.minecraft}`)) ?? [];
  const free = (l: string) => catalog.data?.entries.some((e) => e.loader === l && e.status !== 'unverified' && !have.has(`${e.loader}-${e.minecraft}`)) ?? false;
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (touched || !catalog.data || !loaders.length || free(loader)) return;
    const next = loaders.find((c) => free(c.id));
    if (next) setLoader(next.id);
  }, [catalog.data, loaders.length, loader, touched]);
  const pick = options.find((e) => e.id === entryId) ?? options.find((e) => e.minecraft === current?.minecraft) ?? options[0];

  useEffect(() => {
    if (done) return;
    setPlan(null);
    setError(null);
    if (!pick) return;
    let live = true;
    store
      .call<Plan>('project.plan_add_target', { path: ws.path, catalogEntryId: pick.id }, { quiet: true })
      .then((p) => live && setPlan(p))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [ws.path, pick?.id, done]);

  const add = async () => {
    if (!pick || !plan) return;
    setBusy(true);
    setError(null);
    setAdded(label(pick));
    try {
      if (!ws.trusted) {
        if (!(await ask("Adding a target changes this project's Gradle scripts. Trust this project?"))) return;
        await store.call('workspace.trust', { path: ws.path, trusted: true });
      }
      const op = await store.call<OperationInfo>('project.add_target', { path: ws.path, catalogEntryId: pick.id });
      const finished = await waitForOperation(op.id);
      if (finished.status !== 'succeeded') throw new Error(finished.error ?? 'Adding the target failed');
      await store.refreshWorkspace();
      setDone(finished.result as Result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal deploy-modal" role="dialog" aria-label="Add a target" onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}>
        <div className="modal-head">
          <h2>Add a target</h2>
          <div className="spacer" />
          <IconButton icon="close" label="Close" onClick={onClose} disabled={busy} />
        </div>
        <div className="modal-body col">
          {done ? (
            <>
              <Notice tone="success">
                {added} was added in the folder {done.folder}. Pick it in the target menu in the toolbar to build and run it.
              </Notice>
              {done.converted && <div className="small dim">Your existing code is now in the folder {done.currentFolder}. Code you want every target to share can go in common/src/main/java.</div>}
              {done.backup && <div className="small dim">A copy of the files from before the change is in {done.backup}.</div>}
              {done.skipped.length > 0 && <Notice tone="warn">These dependencies have no version for the new target on Modrinth, so they were left out of it: {done.skipped.join(', ')}.</Notice>}
            </>
          ) : (
            <>
              <div className="small dim">Builds the same mod for another loader or Minecraft version. The new target gets its own Gradle subproject with an entrypoint and mod metadata, and your current target stays selected.</div>
              <div className="row wrap">
                <label className="field grow">
                  <span>Loader</span>
                  <select value={loader} onChange={(e) => (setLoader(e.target.value), setEntryId(''), setTouched(true))} disabled={busy}>
                    {loaders.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field grow">
                  <span>Minecraft version</span>
                  <select value={pick?.id ?? ''} onChange={(e) => setEntryId(e.target.value)} disabled={busy || !options.length}>
                    {!options.length && <option value="">None left</option>}
                    {options.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.minecraft}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {plan && plan.issues.length > 0 && (
                <Notice tone="warn">
                  {plan.issues.map((i) => (
                    <div key={i}>{i}</div>
                  ))}
                </Notice>
              )}
              {plan && !plan.issues.length && plan.convert && (
                <Notice tone="info">
                  This project is a single Gradle project now, so it gets converted first. {listed(plan.moves)} move into the folder {plan.currentFolder}, and the root build files are rewritten to include both targets.{' '}
                  {plan.backup === 'git' ? 'You can undo the move with Git.' : `A copy of the files that change is saved in .modsmith/backups first.`}
                </Notice>
              )}
              {plan && !plan.issues.length && !plan.convert && pick && <div className="small dim">{label(pick)} is added in the folder {plan.folder}.</div>}
              {plan?.gradle && !plan.issues.length && (
                <div className="small dim">
                  The Gradle wrapper is updated from {plan.gradle.from} to {plan.gradle.to}, which {pick ? label(pick) : 'the new target'} needs.
                </div>
              )}
            </>
          )}
          {error && <Notice tone="error">{error}</Notice>}
        </div>
        <div className="modal-foot">
          <div className="spacer" />
          <Button onClick={onClose} disabled={busy}>
            {done ? 'Done' : 'Cancel'}
          </Button>
          {!done && (
            <Button variant="primary" icon="add" onClick={() => void add()} disabled={busy || !plan || plan.issues.length > 0} busy={busy}>
              Add target
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
