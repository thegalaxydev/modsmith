import { useEffect, useState } from 'react';
import { store, useAsync, useStore, waitForOperation } from '../store';
import type { OperationInfo } from '../../shared/types';
import { Button, IconButton, Notice, useOverlay } from '../ui/controls';
import { Ico } from '../ui/icons';
import { FABRIC_FILES, readMeta, TOML_FILES, type Loader, type MetaFiles, type SourceFile } from '../modmeta';

export type PublishProvider = 'modrinth' | 'curseforge';

export interface PublishStatus {
  storage: string | null;
  modrinth: { project: { id: string; slug?: string; title?: string; url: string } | null; token: string | null };
  curseforge: { project: { id: string; slug?: string; title?: string; url: string } | null; token: string | null };
}

interface Result {
  provider: PublishProvider;
  ok: boolean;
  id?: string;
  url?: string;
  error?: string;
}

export const PROVIDER_LABEL: Record<PublishProvider, string> = { modrinth: 'Modrinth', curseforge: 'CurseForge' };

async function read(ws: string, file: string): Promise<SourceFile | undefined> {
  try {
    const r = await store.call<{ content: string; mtime: number; binary: boolean }>('workspace.read_file', { path: ws, file }, { quiet: true });
    return r.binary ? undefined : { path: file, content: r.content, mtime: r.mtime };
  } catch {
    return undefined;
  }
}

async function projectVersion(ws: string, loader: Loader): Promise<string> {
  const first = async (paths: string[]) => {
    for (const p of paths) {
      const f = await read(ws, p);
      if (f) return f;
    }
    return undefined;
  };
  const files: MetaFiles = { props: await read(ws, 'gradle.properties'), fabric: loader === 'fabric' ? await first(FABRIC_FILES) : undefined, toml: loader === 'fabric' ? undefined : await first(TOML_FILES) };
  return readMeta(loader, files).values.version;
}

export function PublishDialog({ file, onClose }: { file: string; onClose: () => void }) {
  useOverlay(true);
  const ws = useStore((s) => s.workspace)!;
  const m = ws.manifest!;
  const status = useAsync(() => store.call<PublishStatus>('publish.status', { path: ws.path }, { quiet: true }), [ws.path]);
  const [targets, setTargets] = useState<PublishProvider[]>([]);
  const [version, setVersion] = useState('');
  const [name, setName] = useState('');
  const [releaseType, setReleaseType] = useState<'release' | 'beta' | 'alpha'>('release');
  const [gameVersions, setGameVersions] = useState(m.platform.minecraft);
  const [changelog, setChangelog] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Result[] | null>(null);

  useEffect(() => {
    void projectVersion(ws.path, m.platform.loader as Loader).then((v) => setVersion((cur) => cur || v));
  }, [ws.path]);

  useEffect(() => {
    const st = status.data;
    if (st) setTargets((['modrinth', 'curseforge'] as PublishProvider[]).filter((p) => st[p].project && st[p].token));
  }, [status.data]);

  const ready = (p: PublishProvider) => !!status.data?.[p].project && !!status.data?.[p].token;
  const missing = (p: PublishProvider) => (!status.data?.[p].project ? 'not linked' : !status.data?.[p].token ? 'no upload token' : null);
  const toggle = (p: PublishProvider, on: boolean) => setTargets((t) => (on ? [...t.filter((x) => x !== p), p] : t.filter((x) => x !== p)));
  const defaultName = `${m.name} ${version.trim()}`;

  const run = async () => {
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const op = await store.call<OperationInfo>('project.publish', {
        path: ws.path,
        file,
        targets,
        version: version.trim(),
        name: name.trim() || undefined,
        changelog,
        releaseType,
        gameVersions: gameVersions.split(',').map((v) => v.trim()).filter(Boolean)
      }, { quiet: true });
      const done = await waitForOperation(op.id);
      if (done.status === 'succeeded') setResults((done.result as { results: Result[] }).results);
      else setError(done.error ?? 'Publishing did not finish');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const goToSettings = () => {
    onClose();
    store.openTab('page:project');
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal publish-modal" role="dialog" aria-label="Publish the mod" onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}>
        <div className="modal-head">
          <h2>Publish {file}</h2>
          <div className="spacer" />
          <IconButton icon="close" label="Close" onClick={onClose} disabled={busy} />
        </div>
        <div className="modal-body col">
          <div className="small dim">Uploads this JAR as a new version of your linked projects. Each site shows the version to players as soon as it is processed.</div>
          <div className="publish-targets">
            {(['modrinth', 'curseforge'] as PublishProvider[]).map((p) => {
              const st = status.data?.[p];
              const why = missing(p);
              return (
                <label key={p} className={`publish-target ${why ? 'off' : ''}`}>
                  <input type="checkbox" checked={targets.includes(p)} disabled={!ready(p) || busy} onChange={(e) => toggle(p, e.target.checked)} />
                  <span className="col tight grow" style={{ minWidth: 0 }}>
                    <b>{PROVIDER_LABEL[p]}</b>
                    <span className="small dim ellipsis">{st?.project ? st.project.title ?? `Project ${st.project.id}` : 'Not linked'}{why && st?.project ? `, ${why}` : ''}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {status.data && !ready('modrinth') && !ready('curseforge') && (
            <Notice tone="info" action={<Button size="sm" onClick={goToSettings}>Project settings</Button>}>
              Link your Modrinth or CurseForge project and add an upload token in Project settings first.
            </Notice>
          )}
          <div className="row">
            <label className="field grow">
              <span>Version number</span>
              <input className="mono" value={version} onChange={(e) => setVersion(e.target.value)} disabled={busy} />
            </label>
            <label className="field">
              <span>Release type</span>
              <select value={releaseType} onChange={(e) => setReleaseType(e.target.value as typeof releaseType)} disabled={busy}>
                <option value="release">Release</option>
                <option value="beta">Beta</option>
                <option value="alpha">Alpha</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>Version name</span>
            <input value={name} placeholder={defaultName} onChange={(e) => setName(e.target.value)} disabled={busy} />
          </label>
          <label className="field">
            <span>Minecraft versions (separate with commas)</span>
            <input className="mono" value={gameVersions} onChange={(e) => setGameVersions(e.target.value)} disabled={busy} />
          </label>
          <label className="field">
            <span>Changelog (Markdown)</span>
            <textarea rows={5} value={changelog} placeholder="- What changed in this version" onChange={(e) => setChangelog(e.target.value)} disabled={busy} />
          </label>
          {results && (
            <div className="col tight">
              {results.map((r) => (
                <Notice key={r.provider} tone={r.ok ? 'success' : 'error'} action={r.ok && r.url ? <Button size="sm" icon="external" onClick={() => void window.workbench?.openExternal(r.url!)}>Open</Button> : undefined}>
                  {r.ok ? `Published to ${PROVIDER_LABEL[r.provider]}.` : `${PROVIDER_LABEL[r.provider]}: ${r.error}`}
                </Notice>
              ))}
            </div>
          )}
          {error && <Notice tone="error">{error}</Notice>}
        </div>
        <div className="modal-foot">
          <span className="small mute row tight">
            <Ico name="info" size={13} /> Uploads cannot be undone from Modsmith; remove a version on the site itself.
          </span>
          <div className="spacer" />
          <Button onClick={onClose} disabled={busy}>
            {results ? 'Done' : 'Cancel'}
          </Button>
          <Button variant="primary" icon="export" onClick={() => void run()} disabled={busy || !targets.length || !version.trim() || !!results?.every((r) => r.ok)} busy={busy}>
            Publish
          </Button>
        </div>
      </div>
    </div>
  );
}
