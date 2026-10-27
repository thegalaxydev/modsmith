import { useEffect, useMemo, useRef, useState } from 'react';
import { store, useAsync, useStore } from '../store';
import { Button, IconButton, Notice, Section, Switch } from '../ui/controls';
import { Ico } from '../ui/icons';
import { loaderName } from '../components/TopBar';
import { applyMeta, FABRIC_FILES, readMeta, TOML_FILES, type Dependency, type FieldKey, type Loader, type MetaFiles, type SourceFile } from '../modmeta';
import { ask } from '../dialogs';

const LABELS: Record<FieldKey, { label: string; help: string; placeholder?: string; wide?: boolean }> = {
  name: { label: 'Display name', help: 'The name players see in the mod list.' },
  version: { label: 'Version', help: 'Goes into the JAR file name and the mod list. Raise it for every release.', placeholder: '1.0.0' },
  group: { label: 'Group', help: 'The Maven group of the built JAR, usually your package name.', placeholder: 'com.example.mymod' },
  authors: { label: 'Authors', help: 'Separate several authors with commas.', placeholder: 'Alex, Sam' },
  license: { label: 'License', help: 'An SPDX identifier such as MIT, Apache-2.0 or All-Rights-Reserved.', placeholder: 'MIT' },
  homepage: { label: 'Homepage', help: 'A link shown in the mod list, for example your Modrinth or CurseForge page.', placeholder: 'https://modrinth.com/mod/…' },
  issues: { label: 'Issue tracker', help: 'Where players report bugs.', placeholder: 'https://github.com/you/mod/issues' },
  description: { label: 'Description', help: 'Shown in the mod list. Line breaks are kept.', wide: true }
};
const ORDER: FieldKey[] = ['name', 'version', 'group', 'license', 'authors', 'homepage', 'issues', 'description'];

async function readOptional(ws: string, file: string): Promise<SourceFile | undefined> {
  try {
    const r = await store.call<{ content: string; mtime: number; binary: boolean }>('workspace.read_file', { path: ws, file }, { quiet: true });
    return r.binary ? undefined : { path: file, content: r.content, mtime: r.mtime };
  } catch {
    return undefined;
  }
}

async function loadFiles(ws: string, loader: string): Promise<MetaFiles> {
  const first = async (paths: string[]) => {
    for (const p of paths) {
      const f = await readOptional(ws, p);
      if (f) return f;
    }
    return undefined;
  };
  return { props: await readOptional(ws, 'gradle.properties'), fabric: loader === 'fabric' ? await first(FABRIC_FILES) : undefined, toml: loader === 'fabric' ? undefined : await first(TOML_FILES) };
}

function where(kind: string, key: string, file: string) {
  if (kind === 'property') return `Saved as ${key} in ${file}`;
  return `Saved as ${key.replace(/^mods\./, '')} in ${file.split('/').pop()}`;
}

export function ProjectSettingsPage() {
  const ws = useStore((s) => s.workspace)!;
  const fileVersion = useStore((s) => s.fileVersion);
  const dirtyFiles = useStore((s) => s.dirtyFiles);
  const m = ws.manifest;
  const loader = (m?.platform.loader ?? 'fabric') as Loader;
  const [saving, setSaving] = useState(false);
  const [rev, setRev] = useState(0);
  const loaded = useAsync(() => loadFiles(ws.path, loader), [ws.path, loader, rev]);
  const files = loaded.data;
  const meta = useMemo(() => (files ? readMeta(loader, files) : null), [files, loader]);
  const [values, setValues] = useState<Record<FieldKey, string> | null>(null);
  const [deps, setDeps] = useState<Dependency[]>([]);
  const [newDep, setNewDep] = useState({ modId: '', versionRange: '*' });

  useEffect(() => {
    if (!meta) return;
    setValues(meta.values);
    setDeps(meta.dependencies);
  }, [meta]);

  const changes = useMemo(() => (files && meta && values ? applyMeta(loader, files, meta, values, deps) : {}), [files, meta, values, deps, loader]);
  const changed = Object.keys(changes);
  const dirty = changed.length > 0;

  const firstVersion = useRef(fileVersion);
  useEffect(() => {
    if (fileVersion !== firstVersion.current && !dirty) setRev((r) => r + 1);
  }, [fileVersion]);

  if (!m) return <div className="page">This folder is not set up as a Modsmith project yet.</div>;
  if (!files || !meta || !values) return <div className="page dim">{loaded.error ?? 'Loading project settings…'}</div>;

  const set = (k: FieldKey, v: string) => setValues({ ...values, [k]: v });
  const openFile = (file: string) => store.openTab(`file:${file}`);
  const metadataName = meta.metadataFile?.split('/').pop();
  const isFabric = loader === 'fabric';

  const save = async () => {
    const open = changed.filter((f) => dirtyFiles.includes(f));
    if (open.length && !(await ask(`${open.join(', ')} ${open.length === 1 ? 'has' : 'have'} unsaved changes in the editor. Save the settings anyway? The editor's unsaved changes to ${open.length === 1 ? 'that file' : 'those files'} will conflict.`, { yes: 'Save settings', no: 'Cancel' }))) return;
    setSaving(true);
    try {
      for (const [file, content] of Object.entries(changes)) {
        const original = [files.props, files.fabric, files.toml].find((f) => f?.path === file);
        await store.call('workspace.write_file', { path: ws.path, file, content, expectedMtime: original?.mtime });
      }
      store.toast('success', 'Project settings saved. They apply to the next build.');
      setRev((r) => r + 1);
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setValues(meta.values);
    setDeps(meta.dependencies);
  };

  const updateDep = (i: number, patch: Partial<Dependency>) => setDeps(deps.map((d, n) => (n === i ? { ...d, ...patch } : d)));
  const addDep = () => {
    const id = newDep.modId.trim();
    if (!id || deps.some((d) => d.modId === id)) return;
    setDeps([...deps, { modId: id, versionRange: newDep.versionRange.trim() || '*', required: true, ...(isFabric ? {} : { side: 'BOTH' }) }]);
    setNewDep({ modId: '', versionRange: '*' });
  };

  return (
    <div className="page settings-page">
      <header className="page-head">
        <h1>Project settings</h1>
        <span className="dim small">Changes are written to the project files and apply to the next build.</span>
        <div className="spacer" />
        {files.props && (
          <Button size="sm" icon="code" variant="ghost" onClick={() => openFile(files.props!.path)}>
            gradle.properties
          </Button>
        )}
        {meta.metadataFile && (
          <Button size="sm" icon="code" variant="ghost" onClick={() => openFile(meta.metadataFile!)}>
            {metadataName}
          </Button>
        )}
      </header>

      {meta.problems.map((p) => (
        <Notice key={p} tone="warn">
          {p}
        </Notice>
      ))}

      <Section title="Mod details">
        <div className="settings-grid">
          <div className="setting-card">
            <div className="setting-label">
              Mod ID
              <span className="setting-help" title="The mod ID is used in code, assets and data paths. Changing it means renaming folders and code, so it is not edited here.">
                <Ico name="info" size={13} />
              </span>
            </div>
            <input value={meta.modId ?? ''} readOnly className="mono" aria-label="Mod ID" />
          </div>
          {ORDER.map((k) => {
            const loc = meta.locations[k];
            const def = LABELS[k];
            const tip = `${def.help}${loc ? ` ${where(loc.kind, loc.key, loc.file)}.` : ''}`;
            return (
              <div key={k} className={`setting-card ${def.wide ? 'wide' : ''}`}>
                <label className="setting-label" htmlFor={`setting-${k}`}>
                  {def.label}
                  <span className="setting-help" title={tip}>
                    <Ico name="info" size={13} />
                  </span>
                </label>
                {def.wide ? (
                  <textarea id={`setting-${k}`} rows={3} value={values[k]} onChange={(e) => set(k, e.target.value)} disabled={!loc} />
                ) : (
                  <input id={`setting-${k}`} value={values[k]} placeholder={loc ? def.placeholder : 'Not available for this project'} onChange={(e) => set(k, e.target.value)} disabled={!loc} className={k === 'version' || k === 'group' ? 'mono' : undefined} />
                )}
                {k === 'version' && /\s/.test(values.version) && <span className="field-error">Versions cannot contain spaces.</span>}
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Platform">
        <div className="settings-grid">
          {[
            ['Minecraft', m.platform.minecraft],
            ['Loader', loaderName(m.platform.loader)],
            ['Loader version', m.platform.loaderVersion]
          ].map(([label, value]) => (
            <div key={label} className="setting-card">
              <div className="setting-label">{label}</div>
              <input value={value} readOnly aria-label={label} />
            </div>
          ))}
        </div>
        <div className="small mute">The Minecraft and loader versions come from the compatibility catalog entry the project was created from ({m.platform.catalogEntry ?? 'none'}), so they are not edited here.</div>
      </Section>

      <Section title={`Dependencies (${deps.length})`}>
        <div className="small dim">
          Declared in {metadataName ?? 'the mod metadata'}. The loader checks them when the game starts and refuses to load your mod if a required one is missing. {isFabric ? 'Optional dependencies are written as "recommends".' : ''}
        </div>
        <table className="grid deps-table">
          <thead>
            <tr>
              <th>Mod ID</th>
              <th>Version range</th>
              {!isFabric && <th>Side</th>}
              <th>Required</th>
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {deps.map((d, i) => (
              <tr key={d.modId}>
                <td className="mono">{d.modId}</td>
                <td>
                  <input className="mono" value={d.versionRange} onChange={(e) => updateDep(i, { versionRange: e.target.value })} aria-label={`Version range for ${d.modId}`} />
                </td>
                {!isFabric && (
                  <td>
                    <select value={d.side ?? 'BOTH'} onChange={(e) => updateDep(i, { side: e.target.value })} aria-label={`Side for ${d.modId}`}>
                      <option value="BOTH">Both</option>
                      <option value="CLIENT">Client</option>
                      <option value="SERVER">Server</option>
                    </select>
                  </td>
                )}
                <td>
                  <Switch checked={d.required} label={`${d.modId} is required`} onChange={(v) => updateDep(i, { required: v })} />
                </td>
                <td>
                  <IconButton icon="remove" label={`Remove ${d.modId}`} onClick={() => setDeps(deps.filter((_, n) => n !== i))} />
                </td>
              </tr>
            ))}
            <tr>
              <td>
                <input className="mono" value={newDep.modId} placeholder="modid" onChange={(e) => setNewDep({ ...newDep, modId: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && addDep()} aria-label="New dependency mod ID" />
              </td>
              <td>
                <input className="mono" value={newDep.versionRange} onChange={(e) => setNewDep({ ...newDep, versionRange: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && addDep()} aria-label="New dependency version range" />
              </td>
              {!isFabric && <td />}
              <td colSpan={2}>
                <Button size="sm" icon="add" onClick={addDep} disabled={!newDep.modId.trim() || deps.some((d) => d.modId === newDep.modId.trim())}>
                  Add
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
        <div className="small mute">{isFabric ? 'Version ranges use Fabric syntax, for example >=1.2.0, ~1.21.1 or *.' : 'Version ranges use Maven syntax, for example [1.2,) or [21.1,22).'} Declaring a dependency does not download it: add the mod on the Mods page to test with it.</div>
      </Section>

      {m.dependencies.length > 0 && (
        <Section title={`Build dependencies (${m.dependencies.length})`} collapsible defaultOpen={false}>
          <div className="small dim">Mods compiled into the project through Gradle, chosen when the project was created. They are listed in modsmith.dependencies.gradle.</div>
          {m.dependencies.map((d) => (
            <div key={`${d.source}:${d.projectId ?? d.path ?? d.coordinates}`} className="row">
              <span className="grow ellipsis">{d.title ?? d.projectId ?? d.coordinates ?? d.path}</span>
              <span className="small dim">{d.usage === 'compile' ? 'Compile' : 'Runtime'}</span>
            </div>
          ))}
          <button type="button" className="link-btn" onClick={() => openFile('modsmith.dependencies.gradle')}>
            Open modsmith.dependencies.gradle
          </button>
        </Section>
      )}

      {dirty && (
        <div className="row sticky-actions">
          <span className="grow small dim">
            Unsaved changes to {changed.map((f) => f.split('/').pop()).join(' and ')}.
          </span>
          <Button variant="ghost" onClick={discard}>
            Discard
          </Button>
          <Button variant="primary" icon="success" busy={saving} onClick={() => void save()} disabled={/\s/.test(values.version)}>
            Save changes
          </Button>
        </div>
      )}
    </div>
  );
}
