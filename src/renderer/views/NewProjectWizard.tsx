import { useEffect, useMemo, useRef, useState } from 'react';
import { store, useAsync, useStore } from '../store';
import type { CatalogEntry, JavaInstallation, OperationInfo } from '../../shared/types';
import { SourceIcon } from '../ui/icons';
import { ModrinthSearch } from '../components/ModrinthSearch';

interface Starter {
  id: string;
  label: string;
  description: string;
  state: 'supported' | 'planned';
}

interface DepRow {
  source: 'modrinth' | 'curseforge' | 'local' | 'maven';
  projectId?: string;
  path?: string;
  coordinates?: string;
  title: string;
  usage: 'compile' | 'runtime';
  required: boolean;
  environment: 'both' | 'client' | 'server';
}

interface PlanItem {
  title: string;
  status: 'ok' | 'error' | 'warning';
  detail: string;
  coordinates?: string;
}

interface Preset {
  id: string;
  name: string;
  description: string;
  catalogEntryId: string;
  starters: string[];
  dependencies: { projectId: string; title?: string; usage: 'compile' | 'runtime'; required: boolean; environment: 'both' | 'client' | 'server' }[];
}

const LICENSES = ['MIT', 'Apache-2.0', 'LGPL-3.0-only', 'GPL-3.0-only', 'MPL-2.0', 'CC0-1.0', 'All-Rights-Reserved'];
const STEPS = ['Identity', 'Platform', 'Starter content', 'Dependencies', 'Review'];

function slug(name: string) {
  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[0-9_]+/, '');
  return id.length < 2 ? '' : id.slice(0, 64);
}

function joinPath(parent: string, child: string) {
  if (!parent) return '';
  return parent.replace(/[\\/]+$/, '') + (parent.includes('/') && !parent.includes('\\') ? '/' : '\\') + child;
}

export function NewProjectWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [parentDir, setParentDir] = useState(localStorage.getItem('mwb.lastParent') ?? '');
  const [folder, setFolder] = useState('');
  const [folderEdited, setFolderEdited] = useState(false);
  const [modId, setModId] = useState('');
  const [modIdEdited, setModIdEdited] = useState(false);
  const [pkg, setPkg] = useState('');
  const [pkgEdited, setPkgEdited] = useState(false);
  const [author, setAuthor] = useState(localStorage.getItem('mwb.author') ?? '');
  const [description, setDescription] = useState('');
  const [license, setLicense] = useState('MIT');
  const [git, setGit] = useState(true);
  const [loader, setLoader] = useState('fabric');
  const [entryId, setEntryId] = useState('fabric-1.21.1');
  const [environment, setEnvironment] = useState<'both' | 'client' | 'server'>('both');
  const [starters, setStarters] = useState<string[]>(['empty', 'bridge', 'profiles']);
  const [deps, setDeps] = useState<DepRow[]>([]);
  const [plan, setPlan] = useState<PlanItem[] | null>(null);
  const [planning, setPlanning] = useState(false);
  const [issues, setIssues] = useState<{ field: string; message: string }[]>([]);
  const [runBuild, setRunBuild] = useState(true);
  const [presetId, setPresetId] = useState('');
  const [presetNote, setPresetNote] = useState<string | null>(null);
  const [opId, setOpId] = useState<string | null>(null);
  const op = useStore((s) => s.operations.find((o) => o.id === opId));
  const [opLog, setOpLog] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);

  const catalog = useAsync(() => store.call<{ entries: CatalogEntry[] }>('catalog.list'), []);
  const caps = useAsync(() => store.call<{ id: string; name: string; implemented: boolean }[]>('system.capabilities'), []);
  const javas = useAsync(() => store.call<JavaInstallation[]>('java.list'), []);
  const presets = useAsync(() => store.call<Preset[]>('preset.list'), []);
  const entry = catalog.data?.entries.find((e) => e.id === entryId);
  const starterOpts = useAsync(() => (entryId ? store.call<Starter[]>('catalog.starters', { entryId }) : Promise.resolve([])), [entryId]);
  const meta = useAsync(() => store.call<{ versions: { version: string; stable: boolean }[]; fetchedAt: number; stale: boolean; error?: string }>('meta.loader_versions', { loader, minecraft: entry?.minecraft ?? '1.21.1' }, { quiet: true }), [loader, entry?.minecraft]);

  useEffect(() => {
    if (!modIdEdited) setModId(slug(name));
    if (!folderEdited) setFolder(name.trim().replace(/[<>:"/\\|?*]+/g, '').replace(/\s+/g, '-'));
  }, [name]);
  useEffect(() => {
    if (!pkgEdited && modId) {
      const a = author.toLowerCase().replace(/[^a-z0-9]+/g, '');
      setPkg(`${a && /^[a-z]/.test(a) ? `io.github.${a}` : 'com.example'}.${modId}`);
    }
  }, [modId, author]);
  useEffect(() => {
    const unsub = (id: string, line: string) => {
      if (id === opId) setOpLog((l) => [...l.slice(-800), line]);
    };
    store.opLogListeners.add(unsub);
    return () => void store.opLogListeners.delete(unsub);
  }, [opId]);
  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [opLog]);

  const destination = joinPath(parentDir, folder);
  const input = useMemo(
    () => ({
      projectName: name.trim(),
      destination,
      modId,
      packageName: pkg,
      author,
      description,
      license,
      git,
      catalogEntryId: entryId,
      environment,
      starters,
      dependencies: deps.map((d) => ({ source: d.source, projectId: d.projectId, path: d.path, coordinates: d.coordinates, title: d.title, usage: d.usage, required: d.required, environment: d.environment })),
      runInitialBuild: runBuild,
      presetId: presetId || undefined
    }),
    [name, destination, modId, pkg, author, description, license, git, entryId, environment, starters, deps, runBuild, presetId]
  );

  const fieldIssue = (f: string) => issues.filter((i) => i.field === f).map((i) => i.message).join('; ');

  const validateStep = async (s: number) => {
    const res = await store.call<{ issues: { field: string; message: string }[] }>('project.validate_create', { input });
    const fields: Record<number, string[]> = { 0: ['projectName', 'modId', 'packageName', 'destination', 'license'], 1: ['catalogEntryId'], 2: ['starters'], 3: ['dependencies'] };
    const relevant = s >= 4 ? res.issues : res.issues.filter((i) => fields[s]?.includes(i.field));
    setIssues(res.issues);
    return relevant.length === 0;
  };

  const next = async () => {
    if (!(await validateStep(step))) return;
    if (step === 0) {
      localStorage.setItem('mwb.lastParent', parentDir);
      localStorage.setItem('mwb.author', author);
    }
    if (step === 3) await runPlan();
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  };

  const runPlan = async () => {
    if (!entry) return;
    setPlanning(true);
    try {
      const refs = input.dependencies.map((d) => ({ ...d }));
      setPlan(await store.call<PlanItem[]>('project.plan_dependencies', { minecraft: entry.minecraft, loader: entry.loader, refs }));
    } finally {
      setPlanning(false);
    }
  };

  const applyPreset = async (id: string) => {
    setPresetId(id);
    setPresetNote(null);
    if (!id) return;
    const res = await store.call<{ usable: boolean; reason: string | null; preset: Preset; dependencies: { title?: string; available: boolean; detail: string }[] }>('preset.check', { id });
    const lines = res.dependencies.map((d) => `${d.title}: ${d.detail}`);
    if (!res.usable) {
      setPresetNote(`Preset not applied. ${res.reason ?? ''}${lines.length ? ` (${lines.join('; ')})` : ''}`);
      setPresetId('');
      return;
    }
    setEntryId(res.preset.catalogEntryId);
    setStarters(res.preset.starters);
    setDeps(res.preset.dependencies.map((d, i) => ({ source: 'modrinth', projectId: d.projectId, title: d.title ?? d.projectId, usage: d.usage, required: d.required, environment: d.environment, available: res.dependencies[i]?.available } as DepRow)).filter((_, i) => res.dependencies[i]?.available));
    setPresetNote(`Applied ${res.preset.name}.${lines.length ? ` ${lines.join('; ')}` : ''}`);
  };

  const create = async () => {
    if (!(await validateStep(4))) return;
    setOpLog([]);
    const o = await store.call<OperationInfo>('project.create', input);
    setOpId(o.id);
  };

  const result = op?.status === 'succeeded' ? (op.result as { path: string }) : null;

  const openCreated = async (launch: boolean) => {
    if (!result) return;
    await store.openWorkspace(result.path);
    onClose();
    if (launch) {
      const profile = store.state.workspace?.manifest?.profiles.find((p) => p.side === 'client');
      if (profile) await store.call('instance.launch', { path: result.path, profile: profile.id });
    }
  };

  const javaFor = (min: number) => javas.data?.filter((j) => j.isJdk && j.major >= min) ?? [];

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-head">
          <h2>New mod project</h2>
          <div className="steps">
            {STEPS.map((s, i) => (
              <span key={s} className={`step ${i === step ? 'active' : i < step ? 'done' : ''}`}>
                {i + 1}. {s}
              </span>
            ))}
          </div>
          <div className="spacer" />
          <button className="ghost" onClick={onClose} disabled={op?.status === 'running'}>
            Close
          </button>
        </div>
        <div className="modal-body">
          {step === 0 && (
            <div className="form-grid">
              <label>Preset</label>
              <div>
                <select value={presetId} onChange={(e) => void applyPreset(e.target.value)} style={{ width: 360 }}>
                  <option value="">None</option>
                  {presets.data?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <div className="hint">{presetNote ?? 'Presets bundle platform, starters and dependencies. Dependencies are checked against Modrinth before a preset is applied.'}</div>
              </div>
              <label>Project name</label>
              <div>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Cool Mod" style={{ width: 360 }} autoFocus />
                {fieldIssue('projectName') && <div className="field-error">{fieldIssue('projectName')}</div>}
              </div>
              <label>Location</label>
              <div>
                <div className="row">
                  <input value={parentDir} onChange={(e) => setParentDir(e.target.value)} placeholder="Parent folder" className="grow mono" />
                  <button onClick={async () => setParentDir((await window.workbench?.chooseDirectory('Choose parent folder')) ?? parentDir)}>Browse</button>
                </div>
                <div className="row" style={{ marginTop: 6 }}>
                  <span className="mute">Folder</span>
                  <input
                    value={folder}
                    onChange={(e) => {
                      setFolder(e.target.value);
                      setFolderEdited(true);
                    }}
                    className="mono"
                    style={{ width: 260 }}
                  />
                </div>
                <div className="hint mono">{destination || 'Choose a location'}</div>
                {fieldIssue('destination') && <div className="field-error">{fieldIssue('destination')}</div>}
              </div>
              <label>Mod ID</label>
              <div>
                <input
                  value={modId}
                  onChange={(e) => {
                    setModId(e.target.value);
                    setModIdEdited(true);
                  }}
                  className="mono"
                  style={{ width: 260 }}
                />
                {fieldIssue('modId') ? <div className="field-error">{fieldIssue('modId')}</div> : <div className="hint">Lowercase letters, digits and underscores. Used as the resource namespace.</div>}
              </div>
              <label>Java package</label>
              <div>
                <input
                  value={pkg}
                  onChange={(e) => {
                    setPkg(e.target.value);
                    setPkgEdited(true);
                  }}
                  className="mono"
                  style={{ width: 360 }}
                />
                {fieldIssue('packageName') && <div className="field-error">{fieldIssue('packageName')}</div>}
              </div>
              <label>Author</label>
              <input value={author} onChange={(e) => setAuthor(e.target.value)} style={{ width: 260 }} />
              <label>Description</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} style={{ fontFamily: 'inherit' }} />
              <label>License</label>
              <div>
                <select value={license} onChange={(e) => setLicense(e.target.value)}>
                  {LICENSES.map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </select>
                {fieldIssue('license') && <div className="field-error">{fieldIssue('license')}</div>}
              </div>
              <label>Git</label>
              <label className="row" style={{ paddingTop: 4 }}>
                <input type="checkbox" checked={git} onChange={(e) => setGit(e.target.checked)} /> Initialize a Git repository
              </label>
            </div>
          )}

          {step === 1 && (
            <div className="form-grid">
              <label>Loader</label>
              <div>
                <select value={loader} onChange={(e) => setLoader(e.target.value)}>
                  {caps.data?.map((c) => (
                    <option key={c.id} value={c.id} disabled={!c.implemented}>
                      {c.name}
                      {c.implemented ? '' : ' (planned, not implemented)'}
                    </option>
                  ))}
                </select>
              </div>
              <label>Minecraft version</label>
              <div>
                <select value={entryId} onChange={(e) => setEntryId(e.target.value)}>
                  {catalog.data?.entries
                    .filter((e) => e.loader === loader)
                    .map((e) => (
                      <option key={e.id} value={e.id} disabled={e.status !== 'verified'}>
                        {e.minecraft} {e.status === 'verified' ? '' : `(${e.status})`}
                      </option>
                    ))}
                </select>
                <div className="hint">Only combinations verified in the compatibility catalog can be generated.</div>
                {fieldIssue('catalogEntryId') && <div className="field-error">{fieldIssue('catalogEntryId')}</div>}
              </div>
              {entry && (
                <>
                  <label>Template combination</label>
                  <div className="kv">
                    <span>Loader version</span>
                    <span className="mono">{entry.loaderVersion}</span>
                    <span>Fabric API</span>
                    <span className="mono">{entry.fabricApiVersion}</span>
                    <span>Mappings</span>
                    <span>{entry.mappings === 'mojang' ? 'Official Mojang mappings (loom.officialMojangMappings)' : 'None (unobfuscated)'}</span>
                    <span>Gradle plugin</span>
                    <span className="mono">
                      {entry.plugin.id} {entry.plugin.version}
                    </span>
                    <span>Gradle wrapper</span>
                    <span className="mono">{entry.gradleVersion}</span>
                    <span>Java</span>
                    <span>
                      Bytecode {entry.javaRelease}; Gradle needs JDK {entry.gradleJavaMin}+; game runtime Java {entry.runtimeJavaMin}+
                    </span>
                    <span>Source</span>
                    <a onClick={() => void window.workbench?.openExternal(entry.templateSource)}>{entry.templateSource}</a>
                    <span>Status</span>
                    <span>
                      <span className={`badge ${entry.status === 'verified' ? 'ok' : 'warn'}`}>{entry.status}</span> {entry.verificationNote}
                    </span>
                  </div>
                  <label>Loader metadata</label>
                  <div className="hint" style={{ marginTop: 6 }}>
                    {meta.loading
                      ? 'Fetching Fabric metadata...'
                      : meta.error
                        ? `Fabric metadata unavailable: ${meta.error}`
                        : `${meta.data?.versions.length ?? 0} loader versions published for ${entry.minecraft}; newest stable ${meta.data?.versions.find((v) => v.stable)?.version ?? 'n/a'}. Fetched ${meta.data ? new Date(meta.data.fetchedAt).toLocaleString() : ''}${meta.data?.stale ? ' (stale cache, offline)' : ''}. The template uses the verified ${entry.loaderVersion}.`}
                  </div>
                  <label>Java toolchain</label>
                  <div>
                    {javaFor(entry.gradleJavaMin).length ? (
                      <div className="hint" style={{ marginTop: 6 }}>
                        Gradle will run on {javaFor(entry.gradleJavaMin)[0].vendor} {javaFor(entry.gradleJavaMin)[0].version} ({javaFor(entry.gradleJavaMin)[0].home}).
                      </div>
                    ) : (
                      <div className="callout err">No JDK {entry.gradleJavaMin}+ detected. Install one (for example Eclipse Temurin {entry.gradleJavaMin}) and refresh Java in Settings.</div>
                    )}
                  </div>
                  <label>Environment</label>
                  <select value={environment} onChange={(e) => setEnvironment(e.target.value as 'both')} style={{ width: 260 }}>
                    <option value="both">Client and server</option>
                    <option value="client">Client only</option>
                    <option value="server">Server only</option>
                  </select>
                </>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="col">
              <div className="option-grid">
                {starterOpts.data?.map((s) => (
                  <label key={s.id} className={`option-card ${s.state !== 'supported' ? 'disabled' : ''}`}>
                    <input
                      type="checkbox"
                      disabled={s.state !== 'supported' || s.id === 'empty'}
                      checked={starters.includes(s.id)}
                      onChange={(e) => setStarters((st) => (e.target.checked ? [...st, s.id] : st.filter((x) => x !== s.id)))}
                    />
                    <div>
                      <div>
                        <b>{s.label}</b> {s.state !== 'supported' && <span className="badge warn">not implemented</span>}
                      </div>
                      <div className="hint">{s.description}</div>
                    </div>
                  </label>
                ))}
              </div>
              {fieldIssue('starters') && <div className="field-error">{fieldIssue('starters')}</div>}
            </div>
          )}

          {step === 3 && entry && (
            <div className="col" style={{ gap: 14 }}>
              <div className="callout info">
                <b>Compile</b> dependencies are added to the Gradle compile classpath through the Modrinth Maven repository (CurseForge mods are runtime-only). <b>Runtime</b> dependencies are only placed in development test instances. Results are constrained to {entry.loader} {entry.minecraft}.
              </div>
              <table className="grid">
                <thead>
                  <tr>
                    <th>Dependency</th>
                    <th>Usage</th>
                    <th>Required</th>
                    <th>Environment</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {deps.map((d, i) => (
                    <tr key={i}>
                      <td>
                        <SourceIcon source={d.source} /> {d.title} <span className="mute mono">{d.source === 'modrinth' || d.source === 'curseforge' ? `${d.source}:${d.projectId}` : d.source === 'local' ? d.path : d.coordinates}</span>
                      </td>
                      <td>
                        <select value={d.usage} disabled={d.source === 'local' || d.source === 'curseforge'} onChange={(e) => setDeps((x) => x.map((y, j) => (j === i ? { ...y, usage: e.target.value as 'compile' } : y)))}>
                          <option value="compile">compile</option>
                          <option value="runtime">runtime only</option>
                        </select>
                      </td>
                      <td>
                        <input type="checkbox" checked={d.required} onChange={(e) => setDeps((x) => x.map((y, j) => (j === i ? { ...y, required: e.target.checked } : y)))} />
                      </td>
                      <td>
                        <select value={d.environment} onChange={(e) => setDeps((x) => x.map((y, j) => (j === i ? { ...y, environment: e.target.value as 'both' } : y)))}>
                          <option value="both">both</option>
                          <option value="client">client</option>
                          <option value="server">server</option>
                        </select>
                      </td>
                      <td>
                        <button className="small ghost" onClick={() => setDeps((x) => x.filter((_, j) => j !== i))}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!deps.length && (
                    <tr>
                      <td colSpan={5} className="mute">
                        No dependencies. Fabric API is always included by the template.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <div className="row">
                <button
                  onClick={async () => {
                    const f = await window.workbench?.chooseFile('Choose a mod JAR', [{ name: 'Java archive', extensions: ['jar'] }]);
                    if (f) setDeps((d) => [...d, { source: 'local', path: f, title: f.split(/[\\/]/).pop() ?? f, usage: 'runtime', required: true, environment: 'both' }]);
                  }}
                >
                  Add local JAR
                </button>
                <MavenAdd onAdd={(c) => setDeps((d) => [...d, { source: 'maven', coordinates: c, title: c, usage: 'compile', required: true, environment: 'both' }])} />
              </div>
              <ModrinthSearch
                loader={entry.loader}
                minecraft={entry.minecraft}
                actionLabel="Add"
                onPick={(hit) => setDeps((d) => (d.some((x) => x.projectId === hit.id && x.source === hit.provider) ? d : [...d, { source: hit.provider, projectId: hit.id, title: hit.title, usage: hit.provider === 'curseforge' ? 'runtime' : 'compile', required: true, environment: 'both' }]))}
              />
            </div>
          )}

          {step === 4 && entry && (
            <div className="col" style={{ gap: 14 }}>
              {!op && (
                <>
                  <div className="kv">
                    <span>Project</span>
                    <span>
                      {name} <span className="mono mute">({modId})</span>
                    </span>
                    <span>Destination</span>
                    <span className="mono">{destination}</span>
                    <span>Package</span>
                    <span className="mono">{pkg}</span>
                    <span>Platform</span>
                    <span>
                      Fabric {entry.loaderVersion} on Minecraft {entry.minecraft}, Fabric API {entry.fabricApiVersion}, Gradle {entry.gradleVersion}
                    </span>
                    <span>Starters</span>
                    <span>{starters.join(', ')}</span>
                    <span>Git</span>
                    <span>{git ? 'yes' : 'no'}</span>
                  </div>
                  <div>
                    <h4>Resolved dependency plan</h4>
                    {planning && <div className="mute">Resolving...</div>}
                    {plan && !plan.length && <div className="mute">No extra dependencies.</div>}
                    {plan && plan.length > 0 && (
                      <table className="grid">
                        <tbody>
                          {plan.map((p, i) => (
                            <tr key={i}>
                              <td>
                                <span className={`dot ${p.status === 'ok' ? 'ok' : p.status === 'warning' ? 'warn' : 'err'}`} /> {p.title}
                              </td>
                              <td className="dim">{p.detail}</td>
                              <td className="mono mute">{p.coordinates}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                  <label className="row">
                    <input type="checkbox" checked={runBuild} onChange={(e) => setRunBuild(e.target.checked)} /> Run the initial Gradle build (the first build downloads Minecraft and Loom, about 1-3 minutes)
                  </label>
                  {issues.length > 0 && <div className="callout err">{issues.map((i) => `${i.field}: ${i.message}`).join('\n')}</div>}
                </>
              )}
              {op && (
                <div className="col">
                  <div className="row">
                    <b>{op.message}</b>
                    <div className="spacer" />
                    <span className={`badge ${op.status === 'succeeded' ? 'ok' : op.status === 'failed' ? 'err' : 'info'}`}>{op.status}</span>
                  </div>
                  <div className={`progress ${op.progress === null ? 'indeterminate' : ''}`} style={{ width: '100%' }}>
                    <div style={{ width: `${Math.round((op.progress ?? 0) * 100)}%` }} />
                  </div>
                  <pre className="block" ref={logRef} style={{ height: 320 }}>
                    {(opLog.length ? opLog : op.logTail).join('\n')}
                  </pre>
                  {op.status === 'failed' && <div className="callout err">{op.error} Files and logs created so far were kept in the destination folder (.modsmith/logs).</div>}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="modal-foot">
          {!op && (
            <>
              <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
                Back
              </button>
              <div className="spacer" />
              {step < STEPS.length - 1 && (
                <button className="primary" onClick={() => void next()} disabled={!name || !parentDir}>
                  Next
                </button>
              )}
              {step === STEPS.length - 1 && (
                <button className="primary" onClick={() => void create()} disabled={planning || plan?.some((p) => p.status === 'error')}>
                  Create project
                </button>
              )}
            </>
          )}
          {op && (
            <>
              <div className="spacer" />
              {op.status === 'running' && (
                <button className="danger" onClick={() => void store.call('operation.cancel', { id: op.id })}>
                  Cancel
                </button>
              )}
              {op.status === 'failed' && (
                <>
                  <button onClick={() => setOpId(null)}>Back to review</button>
                  <button onClick={() => window.workbench?.openPath(destination)}>Open folder</button>
                </>
              )}
              {result && (
                <>
                  <button onClick={() => void openCreated(false)}>Open project</button>
                  <button className="primary" onClick={() => void openCreated(true)}>
                    Open and launch client
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MavenAdd({ onAdd }: { onAdd: (coords: string) => void }) {
  const [v, setV] = useState('');
  const ok = /^[^:\s]+:[^:\s]+:[^:\s]+(:[^:\s]+)?$/.test(v);
  return (
    <div className="row">
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder="group:artifact:version" className="mono" style={{ width: 280 }} />
      <button
        disabled={!ok}
        onClick={() => {
          onAdd(v);
          setV('');
        }}
      >
        Add Maven
      </button>
    </div>
  );
}
