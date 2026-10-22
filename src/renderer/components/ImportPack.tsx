import { useEffect, useState } from 'react';
import { store, useAsync, useStore, waitForOperation, type ProfileView } from '../store';
import { profileLabel } from '../session';
import { Button, IconButton, Notice, Segmented, useOverlay } from '../ui/controls';
import { Ico, SourceIcon } from '../ui/icons';
import { loaderName } from './TopBar';
import type { OperationInfo } from '../../shared/types';
import { ask } from '../dialogs';

interface PackHit {
  id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  iconUrl: string | null;
}

interface ImportResult {
  profile: string;
  pack: string;
  version: string | null;
  added: number;
  replaced: number;
  skipped: string[];
  localFiles: number;
  overrides: number;
  manual: string[];
  warnings: string[];
}

type Source = { file: string } | { modrinth: { project: string } } | { curseforge: { project: string } };

function newProfileId(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'pack';
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
}

export function ImportPackButton({ profileId, size = 'md' }: { profileId?: string; size?: 'sm' | 'md' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon="importJar" size={size} onClick={() => setOpen(true)}>
        Import a modpack…
      </Button>
      {open && <ImportPackDialog profileId={profileId} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ImportPackDialog({ profileId, onClose }: { profileId?: string; onClose: () => void }) {
  useOverlay(true);
  const ws = useStore((s) => s.workspace)!;
  const m = ws.manifest!;
  const [provider, setProvider] = useState<'modrinth' | 'curseforge'>('modrinth');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PackHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [target, setTarget] = useState<string>(profileId ?? '');
  const [opId, setOpId] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const op = useStore((s) => (opId ? s.operations.find((o) => o.id === opId) : undefined));
  const status = useAsync(() => store.call<{ providers: { id: string; usable: boolean }[] }>('provider.status', {}, { quiet: true }), []);
  const cfReady = status.data?.providers.find((p) => p.id === 'curseforge')?.usable ?? false;

  useEffect(() => {
    if (provider === 'curseforge' && !cfReady) {
      setHits([]);
      return;
    }
    const t = setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const r = await store.call<{ hits: PackHit[] }>('modpack.search', { provider, query, loader: m.platform.loader, minecraft: m.platform.minecraft, limit: 20 }, { quiet: true });
        setHits(r.hits);
      } catch (err) {
        setSearchError((err as Error).message);
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [provider, query, cfReady]);

  const run = async (source: Source, packTitle: string) => {
    setError(null);
    setResult(null);
    const profile = target || newProfileId(packTitle, m.profiles.map((p) => p.id));
    const name = target ? undefined : `${packTitle} test`;
    try {
      const started = await store.call<OperationInfo>('profile.import_pack', { path: ws.path, profile, name, ...source });
      setOpId(started.id);
      const done = await waitForOperation(started.id);
      if (done.status === 'succeeded') {
        const r = done.result as ImportResult;
        setResult(r);
        store.selectProfile(r.profile);
      } else setError(done.error ?? 'The import did not finish');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setOpId(null);
    }
  };

  const chooseFile = async () => {
    const file = await window.workbench?.chooseFile('Import a modpack file', [{ name: 'Modrinth or CurseForge modpack', extensions: ['mrpack', 'zip'] }]);
    if (file) void run({ file }, file.split(/[\\/]/).pop()!.replace(/\.(mrpack|zip)$/i, ''));
  };

  const busy = !!opId;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal import-modal" role="dialog" aria-label="Import a modpack" onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}>
        <div className="modal-head">
          <h2>Import a modpack</h2>
          <div className="spacer" />
          <IconButton icon="close" label="Close" onClick={onClose} disabled={busy} />
        </div>
        <div className="modal-body col">
          <div className="small dim">
            Adds the mods of a modpack for Minecraft {m.platform.minecraft} with {loaderName(m.platform.loader)} to a run configuration, next to this project. Each mod can be turned off on its own afterwards, and this project’s own mod always comes from the development build.
          </div>
          <label className="field">
            <span>Add to</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy || !!result}>
              <option value="">A new run configuration named after the pack</option>
              {m.profiles.map((p: ProfileView) => (
                <option key={p.id} value={p.id}>
                  {profileLabel(p)}
                </option>
              ))}
            </select>
          </label>
          {result ? (
            <ImportSummary result={result} onClose={onClose} />
          ) : busy ? (
            <div className="import-progress col">
              <div className="row">
                <Ico name="loading" size={16} className="spin" />
                <b>{op?.message ?? 'Importing…'}</b>
              </div>
              <progress max={1} value={op?.progress ?? 0} />
            </div>
          ) : (
            <>
              {error && <Notice tone="error">{error}</Notice>}
              <div className="row">
                <Segmented
                  label="Modpack source"
                  value={provider}
                  options={[
                    { value: 'modrinth', label: 'Modrinth', icon: 'modrinth' },
                    { value: 'curseforge', label: 'CurseForge', icon: 'curseforge' }
                  ]}
                  onChange={setProvider}
                />
                <label className="search-field grow">
                  <Ico name="search" size={14} />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search modpacks" aria-label="Search modpacks" autoFocus />
                </label>
                <Button icon="openFolder" onClick={() => void chooseFile()}>
                  From a file…
                </Button>
              </div>
              {provider === 'curseforge' && !cfReady && <Notice tone="info">Searching CurseForge needs your own API key (Settings › Providers). You can still import a CurseForge .zip from a file.</Notice>}
              {searchError && <Notice tone="error">{searchError}</Notice>}
              <div className="list pack-results">
                {searching && !hits.length && <div className="small mute">Searching…</div>}
                {!searching && !hits.length && !searchError && (provider === 'modrinth' || cfReady) && <div className="small mute">No modpacks for this Minecraft version and loader match the search.</div>}
                {hits.map((h) => (
                  <div key={h.id} className="pack-result">
                    {h.iconUrl ? (
                      <img src={h.iconUrl} alt="" width={36} height={36} />
                    ) : (
                      <span className="pack-result-icon">
                        <SourceIcon source={provider} size={20} />
                      </span>
                    )}
                    <span className="col tight grow">
                      <span>
                        <b>{h.title}</b> <span className="small mute">by {h.author}</span>
                      </span>
                      <span className="small dim clamp-2">{h.description}</span>
                      <span className="small mute">{h.downloads.toLocaleString()} downloads</span>
                    </span>
                    <Button size="sm" onClick={() => void run(provider === 'modrinth' ? { modrinth: { project: h.id } } : { curseforge: { project: h.id } }, h.title)}>
                      Import
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ImportSummary({ result, onClose }: { result: ImportResult; onClose: () => void }) {
  return (
    <div className="col">
      <Notice tone="success">
        Imported {result.pack}
        {result.version ? ` ${result.version}` : ''}: {result.added} mod{result.added === 1 ? '' : 's'} added
        {result.replaced ? ` (replacing ${result.replaced} from the previous import)` : ''}
        {result.localFiles ? `, ${result.localFiles} extra files downloaded` : ''}
        {result.overrides ? `, ${result.overrides} config and override files` : ''}.
      </Notice>
      {result.skipped.length > 0 && <div className="small dim">Already in the profile: {result.skipped.map((s) => s.replace(/ is already in the profile$/, '')).join(', ')}</div>}
      {result.manual.length > 0 && (
        <Notice tone="warn">
          {result.manual.length} mod{result.manual.length === 1 ? '' : 's'} can only be downloaded from the CurseForge website. Press Play or Check compatibility and Modsmith will say which files to provide.
        </Notice>
      )}
      {result.warnings.map((w) => (
        <Notice key={w} tone="warn">
          {w}
        </Notice>
      ))}
      <div className="small dim">Press Play to download the mods and start the game. You can switch individual mods off on the Mods page.</div>
      <div className="row">
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
        <Button
          icon="mods"
          onClick={() => {
            store.openTab('page:mods');
            onClose();
          }}
        >
          Show mods
        </Button>
      </div>
    </div>
  );
}

export function ImportedPacks({ profile }: { profile: ProfileView }) {
  const ws = useStore((s) => s.workspace)!;
  const counts = new Map<string, number>();
  for (const mod of profile.mods) if (mod.from) counts.set(mod.from, (counts.get(mod.from) ?? 0) + 1);
  const remove = async (name: string) => {
    if (!(await ask(`Remove the ${counts.get(name) ?? 0} mods imported from ${name} from ${profileLabel(profile)}? Its config files stay in the project folder.`, { yes: 'Remove', no: 'Cancel', danger: true }))) return;
    void store.call('profile.remove_pack', { path: ws.path, profile: profile.id, pack: name });
  };
  return (
    <div className="col">
      {(profile.imports ?? []).map((i) => (
        <div key={i.name} className="pack-row">
          <div className="row">
            <span className="pack-icon">{i.provider === 'file' ? <Ico name="importJar" size={20} /> : <SourceIcon source={i.provider} size={20} />}</span>
            <span className="col tight grow">
              <b className="ellipsis">{i.name}</b>
              <span className="small dim ellipsis">
                Imported{i.versionName ? ` ${i.versionName}` : ''} from {i.provider === 'file' ? 'a file' : i.provider === 'modrinth' ? 'Modrinth' : 'CurseForge'} · {counts.get(i.name) ?? 0} mods · {new Date(i.importedAt).toLocaleDateString()}
              </span>
            </span>
            <IconButton icon="remove" label={`Remove ${i.name}`} onClick={() => void remove(i.name)} />
          </div>
        </div>
      ))}
      <div className="row">
        <ImportPackButton profileId={profile.id} />
      </div>
    </div>
  );
}
