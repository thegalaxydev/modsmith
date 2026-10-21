import { useMemo, useState } from 'react';
import { store, useAsync, useStore, waitForOperation, type ModRefView } from '../store';
import { plainIssue, profileLabel } from '../session';
import { Button, EmptyState, IconButton, Kv, Notice, Section, Switch } from '../ui/controls';
import { Ico, SourceIcon } from '../ui/icons';
import { ModrinthSearch } from '../components/ModrinthSearch';
import { LinkedPacks, useLinkedPacks } from '../components/LinkedPacks';
import { ImportedPacks } from '../components/ImportPack';
import type { OperationInfo } from '../../shared/types';
import { ask } from '../dialogs';

interface LockEntry {
  key: string;
  provider: string;
  projectId?: string;
  title: string;
  versionNumber?: string;
  fileName: string;
  sha1?: string;
  url?: string;
  manualUrl?: string;
  modIds: string[];
  license?: string;
  reason: string;
  required: boolean;
  environment?: { client: string; server: string };
  distribution?: string;
}

interface LockProfile {
  resolvedAt: string;
  entries: LockEntry[];
  issues: { severity: string; message: string }[];
}

interface Row {
  key: string;
  title: string;
  version?: string;
  source: string;
  ref?: ModRefView;
  entry?: LockEntry;
  requiredBy?: string;
  pack?: string;
  issues: { severity: string; message: string }[];
}

function refKey(r: ModRefView) {
  if (r.source === 'modrinth') return `modrinth:${r.projectId}`;
  if (r.source === 'curseforge') return `curseforge:${r.projectId}`;
  if (r.source === 'local') return `local:${r.path}`;
  return `maven:${r.coordinates}`;
}

function sourceLabel(s: string) {
  return s === 'modrinth' ? 'Modrinth' : s === 'curseforge' ? 'CurseForge' : s === 'local' ? 'Local JAR' : s === 'maven' ? 'Maven' : s;
}

export function ModsPage() {
  const ws = useStore((s) => s.workspace)!;
  const activeProfile = useStore((s) => s.activeProfile);
  const m = ws.manifest;
  const [profileId, setProfileId] = useState(activeProfile ?? m?.profiles[0]?.id ?? '');
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const lock = useAsync(() => store.call<{ profiles: Record<string, LockProfile> }>('profile.lock', { path: ws.path }, { quiet: true }), [ws.path, ws.lockProfiles.join(), checking]);
  const profile = m?.profiles.find((p) => p.id === profileId);
  const locked = lock.data?.profiles[profileId];
  const links = useLinkedPacks(profile?.id);

  const rows: Row[] = useMemo(() => {
    if (!profile) return [];
    const out: Row[] = [];
    const seen = new Set<string>();
    for (const e of locked?.entries ?? []) {
      if (e.provider === 'bridge') continue;
      const ref = profile.mods.find((r) => refKey(r) === e.key) ?? m?.dependencies.find((r) => refKey(r) === e.key);
      const issues = (locked?.issues ?? []).filter((i) => i.severity !== 'info' && i.message.includes(e.title));
      out.push({ key: e.key, title: e.title, version: e.versionNumber, source: e.provider, ref, entry: e, requiredBy: e.reason.startsWith('required by ') ? e.reason.slice(12) : undefined, pack: ref?.from ?? (e.reason.startsWith('linked pack ') ? e.reason.slice(12) : undefined), issues });
      seen.add(e.key);
    }
    for (const r of profile.mods) {
      const k = refKey(r);
      if (seen.has(k)) continue;
      out.push({ key: k, title: r.title ?? r.slug ?? r.projectId ?? r.path?.split(/[\\/]/).pop() ?? k, source: r.source, ref: r, pack: r.from, issues: (locked?.issues ?? []).filter((i) => i.severity !== 'info' && r.title && i.message.includes(r.title)) });
    }
    return out;
  }, [profile, locked, m]);

  if (!m) return <div className="page"><EmptyState icon="mods" title="Set up the project first">Mods are managed per run configuration once the project is set up.</EmptyState></div>;

  const q = filter.trim().toLowerCase();
  const shown = rows.filter((r) => !q || r.title.toLowerCase().includes(q));
  const own = shown.filter((r) => !r.pack);
  const packGroups = [...new Set(shown.filter((r) => r.pack).map((r) => r.pack!))].map((name) => ({ name, rows: shown.filter((r) => r.pack === name) }));
  const sel = rows.find((r) => r.key === selected);
  const projectDeps = m.dependencies;

  const check = async () => {
    setChecking(true);
    try {
      const op = await store.call<OperationInfo>('profile.resolve', { path: ws.path, id: profileId });
      await waitForOperation(op.id);
    } finally {
      setChecking(false);
    }
  };

  const add = async (ref: Record<string, unknown>) => {
    await store.call('dependency.add', { path: ws.path, profile: profileId, ref: { ...ref, usage: 'runtime' } });
    store.toast('success', `Added ${String(ref.title ?? '')}. Check compatibility to download it and its dependencies.`);
  };

  const importJar = async () => {
    const f = await window.workbench?.chooseFile('Import a mod JAR', [{ name: 'Java archive', extensions: ['jar'] }]);
    if (f) await add({ source: 'local', path: f, title: f.split(/[\\/]/).pop() });
  };

  const needsCheck = profile && profile.mods.some((r) => r.enabled !== false && !rows.find((x) => x.key === refKey(r))?.entry);

  const renderRow = (r: Row) => {
    const disabled = r.ref?.enabled === false;
    const worst = r.issues.find((i) => i.severity === 'error') ?? r.issues[0];
    return (
      <div key={r.key} role="listitem" className={`mod-row ${selected === r.key ? 'selected' : ''} ${disabled ? 'disabled' : ''}`}>
        <button type="button" className="mod-main" onClick={() => setSelected(r.key)}>
          <span className={`dot ${worst ? (worst.severity === 'error' ? 'err' : 'warn') : r.entry ? 'ok' : ''}`} />
          <span className="col tight grow">
            <b className="ellipsis">{r.title}</b>
            <span className="small dim ellipsis">
              {r.version ? `${r.version} · ` : ''}
              <span className="source-tag">
                <SourceIcon source={r.source} size={12} />
                {r.pack && !r.ref ? 'From the linked modpack' : sourceLabel(r.source)}
              </span>
              {r.requiredBy ? ` · needed by ${r.requiredBy}` : ''}
            </span>
          </span>
          <span className={`small ${worst ? (worst.severity === 'error' ? 'err' : 'warn') : 'dim'} mod-status`}>{disabled ? 'Disabled' : worst ? plainIssue(worst.message) : r.entry ? 'No problems found' : 'Not checked yet'}</span>
        </button>
        {r.ref && profile && <Switch checked={!disabled} label={`${disabled ? 'Enable' : 'Disable'} ${r.title}`} onChange={(v) => void store.call('dependency.set_enabled', { path: ws.path, profile: profile.id, key: refKey(r.ref!), enabled: v })} />}
        {r.ref && profile && profile.mods.includes(r.ref) && <IconButton icon="remove" label={`Remove ${r.title}`} onClick={() => void ask(`Remove ${r.title} from ${profileLabel(profile)}?`).then((ok) => ok && store.call('dependency.remove', { path: ws.path, profile: profile.id, key: refKey(r.ref!) }))} />}
      </div>
    );
  };

  return (
    <div className="page split-page">
      <div className="page-main">
        <header className="page-head">
          <h1>Mods</h1>
          <label className="inline-select">
            <span className="dim">for</span>
            <select aria-label="Profile" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              {m.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {profileLabel(p)}
                </option>
              ))}
            </select>
          </label>
          <div className="spacer" />
          <Button icon="addMod" variant="primary" onClick={() => setAdding((a) => !a)}>
            Add mods
          </Button>
          <Button icon="importJar" onClick={() => void importJar()}>
            Import JAR
          </Button>
          <Button icon="success" busy={checking} onClick={() => void check()} title="Download mods and their dependencies and check metadata">
            Check compatibility
          </Button>
        </header>
        {adding && (
          <div className="add-panel">
            <ModrinthSearch loader={m.platform.loader} minecraft={m.platform.minecraft} actionLabel="Add" onPick={(h) => void add({ source: h.provider, projectId: h.id, title: h.title })} />
          </div>
        )}
        {needsCheck && <Notice tone="info" action={<Button size="sm" busy={checking} onClick={() => void check()}>Check now</Button>}>Some mods have not been downloaded and checked yet. They are also checked automatically when you press Play.</Notice>}
        <label className="search-field wide">
          <Ico name="search" size={14} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search installed mods" aria-label="Search installed mods" />
        </label>
        {!own.length ? (
          <EmptyState icon="mods" title="No extra mods in this configuration" actions={<Button icon="addMod" onClick={() => setAdding(true)}>Add mods</Button>}>
            The project{m.source.kind === 'gradle' ? "'s own code and its build dependencies are" : ' itself is'} always included. Add mods here to test compatibility.
          </EmptyState>
        ) : (
          <div className="mod-list" role="list">
            {own.map(renderRow)}
          </div>
        )}
        {packGroups.map((g) => (
          <Section key={g.name} title={`From ${g.name} (${g.rows.length})`} collapsible defaultOpen={false}>
            <div className="small dim">{g.rows.some((r) => r.ref) ? 'Imported modpack. Switch off any mod that causes trouble; import the pack again to update it.' : 'Loaded from a linked modpack folder each time you press Play.'}</div>
            <div className="mod-list" role="list">
              {g.rows.map(renderRow)}
            </div>
          </Section>
        ))}
        <Section title={`Modpacks (${(profile?.imports?.length ?? 0) + (links.data?.length ?? 0)})`}>
          {profile && <ImportedPacks profile={profile} />}
          {profile && <LinkedPacks key={profile.id} profileId={profile.id} />}
        </Section>
        {locked && <div className="small mute">Checked {new Date(locked.resolvedAt).toLocaleString()}. Checks use published metadata; they cannot prove mods work together at runtime.</div>}
        {m.source.kind === 'gradle' && (
          <Section title={`Build dependencies (${projectDeps.length})`} collapsible defaultOpen={false}>
            {!projectDeps.length && <div className="small dim">None besides the loader API. Build dependencies are compiled into the project through Gradle (modsmith.dependencies.gradle).</div>}
            {projectDeps.map((d) => (
              <div key={refKey(d)} className="row">
                <span className="grow ellipsis">{d.title ?? refKey(d)}</span>
                <span className="small dim">{d.usage === 'compile' ? 'Compile' : 'Runtime'}</span>
              </div>
            ))}
          </Section>
        )}
      </div>
      {rows.length > 0 && <aside className="page-detail">
        {!sel ? (
          <div className="detail-empty dim">Select a mod to see its details and dependencies.</div>
        ) : (
          <ModDetails row={sel} rows={rows} />
        )}
      </aside>}
    </div>
  );
}

function ModDetails({ row, rows }: { row: Row; rows: Row[] }) {
  const e = row.entry;
  const deps = rows.filter((r) => r.requiredBy === row.title);
  return (
    <div className="col">
      <h2>{row.title}</h2>
      {row.issues.length > 0 && (
        <div className="col">
          {row.issues.map((i, n) => (
            <Notice key={n} tone={i.severity === 'error' ? 'error' : 'warn'}>
              {plainIssue(i.message)}
            </Notice>
          ))}
        </div>
      )}
      {e?.distribution === 'manual' && e.manualUrl && (
        <Notice tone="warn" action={<Button size="sm" icon="external" onClick={() => void window.workbench?.openExternal(e.manualUrl!)}>Open page</Button>}>
          The author only allows downloads from CurseForge. Download the file, then use Provide downloaded file below.
        </Notice>
      )}
      <Kv
        rows={[
          ['Version', row.version ?? 'not checked yet'],
          ['Source', <span className="source-tag"><SourceIcon source={row.source} />{sourceLabel(row.source)}</span>],
          ['Why it is here', row.requiredBy ? `Needed by ${row.requiredBy}` : 'Added to this configuration'],
          ...(e?.environment ? ([['Runs on', [e.environment.client !== 'unsupported' && 'client', e.environment.server !== 'unsupported' && 'server'].filter(Boolean).join(' and ') || 'unknown']] as [string, string][]) : []),
          ...(e?.license ? ([['License', e.license]] as [string, string][]) : [])
        ]}
      />
      <div>
        <div className="label">Dependencies</div>
        {deps.length ? deps.map((d) => <div key={d.key}>{d.title}</div>) : <div className="small dim">{e ? 'No required dependencies were added for it.' : 'Check compatibility to load dependency information.'}</div>}
      </div>
      {e?.distribution === 'manual' && (
        <Button
          icon="importJar"
          onClick={async () => {
            const f = await window.workbench?.chooseFile('Choose the downloaded JAR', [{ name: 'Java archive', extensions: ['jar'] }]);
            if (!f) return;
            const r = await store.call<{ matches: { title: string }[] }>('dependency.provide_file', { file: f });
            store.toast(r.matches.length ? 'success' : 'error', r.matches.length ? `Matched ${r.matches.map((x) => x.title).join(', ')}` : 'That file does not match the expected download (SHA-1 differs).');
          }}
        >
          Provide downloaded file
        </Button>
      )}
      <Section title="Advanced details" collapsible defaultOpen={false}>
        <Kv
          rows={[
            ['Key', <span className="mono">{row.key}</span>],
            ...(e ? ([['File', <span className="mono">{e.fileName}</span>], ['Mod IDs', <span className="mono">{e.modIds.join(', ') || 'none found'}</span>], ['SHA-1', <span className="mono">{e.sha1 ?? '-'}</span>], ['Download', <span className="mono wrap-text">{e.url ?? e.manualUrl ?? '-'}</span>]] as [string, React.ReactNode][]) : [])
          ]}
        />
        {row.issues.length > 0 && <pre className="code-block">{row.issues.map((i) => `${i.severity}: ${i.message}`).join('\n')}</pre>}
      </Section>
    </div>
  );
}
