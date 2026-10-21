import { useState } from 'react';
import { store, useAsync, useStore, waitForOperation } from '../store';
import type { OperationInfo } from '../../shared/types';
import { Button, Notice, Section } from '../ui/controls';
import { ask } from '../dialogs';

interface ModUpdate {
  key: string;
  title: string;
  direct: boolean;
  pinned: boolean;
  from: { versionNumber?: string };
  to: { versionNumber: string };
}

type Issue = { severity: string; message: string };

interface LockDiff {
  changed: { key: string; title: string; from?: string; to?: string }[];
  added: { key: string; title: string; version?: string }[];
  removed: { key: string; title: string; version?: string }[];
  newIssues: Issue[];
  fixedIssues: Issue[];
}

interface HistoryPoint {
  id: string;
  createdAt: string;
  rolledBackAt: string | null;
  diff: LockDiff;
}

async function run<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const op = await store.call<OperationInfo>(method, params);
  const done = await waitForOperation(op.id);
  if (done.status !== 'succeeded') throw new Error(done.error ?? 'The task did not finish');
  return done.result as T;
}

export function summarize(d: LockDiff): string {
  const parts = [d.changed.length && `${d.changed.length} updated`, d.added.length && `${d.added.length} added`, d.removed.length && `${d.removed.length} removed`].filter(Boolean);
  return parts.length ? parts.join(', ') : 'No version changes';
}

function DiffView({ diff }: { diff: LockDiff }) {
  return (
    <div className="update-diff col">
      {diff.changed.map((c) => (
        <div key={c.key} className="row small">
          <span className="grow ellipsis">{c.title}</span>
          <span className="mono dim">
            {c.from ?? '?'} → {c.to ?? '?'}
          </span>
        </div>
      ))}
      {diff.added.map((c) => (
        <div key={c.key} className="row small">
          <span className="grow ellipsis">{c.title}</span>
          <span className="ok">added {c.version ?? ''}</span>
        </div>
      ))}
      {diff.removed.map((c) => (
        <div key={c.key} className="row small">
          <span className="grow ellipsis">{c.title}</span>
          <span className="warn">removed {c.version ?? ''}</span>
        </div>
      ))}
      {diff.newIssues.length > 0 && (
        <Notice tone={diff.newIssues.some((i) => i.severity === 'error') ? 'error' : 'warn'}>
          New problems:
          {diff.newIssues.map((i) => (
            <div key={i.message} className="small">
              {i.message}
            </div>
          ))}
        </Notice>
      )}
      {diff.fixedIssues.length > 0 && <div className="small ok">Fixes {diff.fixedIssues.length === 1 ? 'one problem' : `${diff.fixedIssues.length} problems`}: {diff.fixedIssues.map((i) => i.message).join('; ')}</div>}
    </div>
  );
}

export function ModUpdates({ profileId, onChanged }: { profileId: string; onChanged: () => void }) {
  const ws = useStore((s) => s.workspace)!;
  const [updates, setUpdates] = useState<ModUpdate[] | null>(null);
  const [failed, setFailed] = useState<{ title: string; error: string }[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<LockDiff | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  const history = useAsync(() => store.call<HistoryPoint[]>('profile.update_history', { path: ws.path, id: profileId }, { quiet: true }), [ws.path, profileId, rev]);
  const keys = [...picked];
  const base = { path: ws.path, id: profileId };

  const step = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const check = () =>
    step('check', async () => {
      const r = await run<{ updates: ModUpdate[]; failed: { title: string; error: string }[] }>('profile.check_updates', base);
      setUpdates(r.updates);
      setFailed(r.failed);
      setPicked(new Set(r.updates.map((u) => u.key)));
      setPreview(null);
    });

  const previewUpdates = () =>
    step('preview', async () => {
      setPreview((await run<{ diff: LockDiff }>('profile.preview_update', { ...base, keys })).diff);
    });

  const apply = () =>
    step('apply', async () => {
      const r = await run<{ diff: LockDiff }>('profile.apply_update', { ...base, keys });
      store.toast('success', `${summarize(r.diff)}. You can roll this back under Update history.`);
      setUpdates(null);
      setPreview(null);
      setRev((n) => n + 1);
      onChanged();
    });

  const rollback = (p: HistoryPoint) =>
    step(`rollback:${p.id}`, async () => {
      if (!(await ask(`Return the mods to the versions they had before the update of ${new Date(p.createdAt).toLocaleString()}?`))) return;
      const r = await run<{ diff: LockDiff }>('profile.rollback_update', { path: ws.path, rollback: p.id });
      store.toast('success', `Rolled back: ${summarize(r.diff)}`);
      setRev((n) => n + 1);
      onChanged();
    });

  const toggle = (k: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      setPreview(null);
      return n;
    });

  return (
    <Section
      title="Updates"
      actions={
        <Button size="sm" busy={busy === 'check'} disabled={!!busy} onClick={() => void check()}>
          Check for updates
        </Button>
      }
    >
      <div className="small dim">Launches keep the versions in the lock file. Updating is a separate step you can preview and roll back.</div>
      {error && <Notice tone="error">{error}</Notice>}
      {updates && !updates.length && <div className="small">Every mod is on its newest version for this Minecraft version and loader.</div>}
      {failed.length > 0 && <Notice tone="warn">Could not check {failed.map((f) => `${f.title} (${f.error})`).join(', ')}</Notice>}
      {updates && updates.length > 0 && (
        <div className="col">
          <div className="mod-list" role="list" aria-label="Available updates">
            {updates.map((u) => (
              <label key={u.key} role="listitem" className="update-row row">
                <input type="checkbox" checked={picked.has(u.key)} onChange={() => toggle(u.key)} disabled={!!busy} />
                <span className="grow ellipsis">
                  {u.title}
                  <span className="small dim">{u.pinned ? ' · pinned' : u.direct ? '' : ' · dependency'}</span>
                </span>
                <span className="mono small">
                  {u.from.versionNumber ?? '?'} → {u.to.versionNumber}
                </span>
              </label>
            ))}
          </div>
          {preview && <DiffView diff={preview} />}
          <div className="row">
            <Button size="sm" busy={busy === 'preview'} disabled={!!busy || !keys.length} onClick={() => void previewUpdates()}>
              Preview changes
            </Button>
            <Button size="sm" variant="primary" busy={busy === 'apply'} disabled={!!busy || !keys.length} onClick={() => void apply()}>
              Update {keys.length === updates.length ? 'all' : keys.length}
            </Button>
          </div>
        </div>
      )}
      {!!history.data?.length && (
        <Section title={`Update history (${history.data.length})`} collapsible defaultOpen={false}>
          {history.data.map((p) => (
            <div key={p.id} className="update-point col">
              <div className="row small">
                <span className="grow">
                  {new Date(p.createdAt).toLocaleString()} · {summarize(p.diff)}
                </span>
                {p.rolledBackAt ? (
                  <span className="dim">Rolled back</span>
                ) : (
                  <Button size="sm" busy={busy === `rollback:${p.id}`} disabled={!!busy} onClick={() => void rollback(p)}>
                    Roll back
                  </Button>
                )}
              </div>
              <DiffView diff={{ ...p.diff, newIssues: [], fixedIssues: [] }} />
            </div>
          ))}
        </Section>
      )}
    </Section>
  );
}
