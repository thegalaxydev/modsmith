import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { store, useAsync, useStore } from '../store';
import type { CatalogEntry, JavaInstallation, OperationInfo } from '../../shared/types';
import { Ico, SourceIcon, type IconName } from '../ui/icons';
import { ModrinthSearch } from '../components/ModrinthSearch';
import { JavaDownloads } from '../components/JavaDownloads';
import { ensureJava, installJava } from '../java';
import { play } from '../actions';

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
  builtin?: boolean;
  catalogEntryId: string;
  starters: string[];
  dependencies: { projectId: string; title?: string; usage: 'compile' | 'runtime'; required: boolean; environment: 'both' | 'client' | 'server' }[];
}

interface Template {
  id: string;
  name: string;
  description: string;
  icon: IconName;
  starters: (supported: string[]) => string[];
  preset?: Preset;
}

const LICENSES = ['MIT', 'Apache-2.0', 'LGPL-3.0-only', 'GPL-3.0-only', 'MPL-2.0', 'CC0-1.0', 'All-Rights-Reserved'];
const STEPS = ['Template', 'Details', 'Configure', 'Create'];
const STEP_FIELDS: Record<number, string[]> = { 0: ['catalogEntryId'], 1: ['projectName', 'modId', 'packageName', 'destination', 'license'], 2: ['starters', 'dependencies'] };
const BASE = ['empty', 'bridge', 'profiles'];

const LOADER_NAME: Record<string, string> = { fabric: 'Fabric', neoforge: 'NeoForge', forge: 'Forge' };

function slug(name: string) {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[0-9_]+/, '');
  return id.length < 2 ? '' : id.slice(0, 64);
}

function joinPath(parent: string, child: string) {
  if (!parent) return '';
  return parent.replace(/[\\/]+$/, '') + (parent.includes('/') && !parent.includes('\\') ? '/' : '\\') + child;
}

function versionNote(e: CatalogEntry, contentStarters: boolean) {
  if (e.status === 'verified') return 'Tested by hand with every starter.';
  if (e.status === 'tested') return `Builds and launches in automated checks.${contentStarters ? '' : ' Starters beyond the empty mod are not available for this version yet.'}`;
  return 'Not tested yet, so it cannot be used.';
}

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="wizard-field">
      <span className="wizard-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
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
  const [templateId, setTemplateId] = useState('empty');
  const [starters, setStarters] = useState<string[]>(BASE);
  const [deps, setDeps] = useState<DepRow[]>([]);
  const [plan, setPlan] = useState<PlanItem[] | null>(null);
  const [planning, setPlanning] = useState(false);
  const [issues, setIssues] = useState<{ field: string; message: string }[]>([]);
  const [runBuild, setRunBuild] = useState(true);
  const [opId, setOpId] = useState<string | null>(null);
  const [javaBusy, setJavaBusy] = useState(false);
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

  const loaders = caps.data?.filter((c) => c.implemented) ?? [];
  const versions = catalog.data?.entries.filter((e) => e.loader === loader) ?? [];
  const supported = starterOpts.data?.filter((s) => s.state === 'supported').map((s) => s.id) ?? BASE;
  const contentAvailable = supported.some((s) => !BASE.includes(s));
  const loaderName = LOADER_NAME[loader] ?? loader;

  const templates = useMemo<Template[]>(() => {
    const entryLoader = (p: Preset) => catalog.data?.entries.find((e) => e.id === p.catalogEntryId)?.loader;
    const extra = (presets.data ?? []).filter((p) => entryLoader(p) === loader && (!p.builtin || p.dependencies.length > 0));
    return [
      { id: 'empty', name: 'Empty mod', description: 'The mod entrypoint, metadata and test configurations. Start from a clean slate.', icon: 'code', starters: (sup) => BASE.filter((s) => sup.includes(s)) },
      { id: 'content', name: 'Content mod', description: 'An example item, block, command, config screen and data generation.', icon: 'mods', starters: (sup) => sup },
      ...extra.map((p) => ({ id: `preset:${p.id}`, name: p.name.replace(/\s*\((Fabric|NeoForge|Forge)\)$/, '').replace(/^(Fabric|NeoForge|Forge)\s+(with\s+)?/, ''), description: p.description, icon: 'addMod' as IconName, starters: (sup: string[]) => p.starters.filter((s) => sup.includes(s)), preset: p }))
    ];
  }, [presets.data, catalog.data, loader]);
  const template = templates.find((t) => t.id === templateId) ?? templates[0];

  useEffect(() => {
    if (!starterOpts.data) return;
    setStarters(template.starters(supported));
  }, [templateId, starterOpts.data]);

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

  const chooseLoader = (next: string) => {
    if (next === loader) return;
    setLoader(next);
    setTemplateId('empty');
    setDeps([]);
    const options = catalog.data?.entries.filter((e) => e.loader === next) ?? [];
    const pick = options.find((e) => e.status === 'verified') ?? options.find((e) => e.status !== 'unverified');
    if (pick) setEntryId(pick.id);
  };

  const chooseTemplate = (t: Template) => {
    setTemplateId(t.id);
    setDeps((t.preset?.dependencies ?? []).map((d) => ({ source: 'modrinth', projectId: d.projectId, title: d.title ?? d.projectId, usage: d.usage, required: d.required, environment: d.environment })));
    setPlan(null);
  };

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
      presetId: template.preset?.id
    }),
    [name, destination, modId, pkg, author, description, license, git, entryId, environment, starters, deps, runBuild, template]
  );

  const fieldIssue = (f: string) => issues.filter((i) => i.field === f).map((i) => i.message).join('; ');
  const identifierIssue = ['modId', 'packageName'].some((f) => fieldIssue(f)) || (!!fieldIssue('destination') && folderEdited);

  const validateStep = async (s: number) => {
    const res = await store.call<{ issues: { field: string; message: string }[] }>('project.validate_create', { input });
    const relevant = s >= 3 ? res.issues : res.issues.filter((i) => STEP_FIELDS[s]?.includes(i.field));
    setIssues(res.issues.filter((i) => s >= 3 || Object.entries(STEP_FIELDS).some(([k, f]) => Number(k) <= s && f.includes(i.field))));
    return relevant.length === 0;
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

  const next = async () => {
    if (!(await validateStep(step))) return;
    if (step === 1) {
      localStorage.setItem('mwb.lastParent', parentDir);
      localStorage.setItem('mwb.author', author);
    }
    if (step === 2) await runPlan();
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  };

  const create = async () => {
    if (!(await validateStep(3))) return;
    setJavaBusy(true);
    const ready = await ensureJava({ catalogEntryId: entryId }).catch(() => false);
    setJavaBusy(false);
    javas.reload();
    if (!ready) return;
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
      if (profile) await play(profile.id);
    }
  };

  const javaFor = (min: number) => javas.data?.filter((j) => j.isJdk && j.major >= min) ?? [];
  const blocked = step === 0 ? (!entry ? 'Choose a Minecraft version' : null) : step === 1 ? (!name.trim() ? 'Enter a project name' : !parentDir ? 'Choose where to create the project' : null) : null;
  const platformText = entry ? `${loaderName} ${entry.loaderVersion} on Minecraft ${entry.minecraft}${entry.loader === 'fabric' && entry.fabricApiVersion ? `, Fabric API ${entry.fabricApiVersion}` : ''}` : '';

  return (
    <div className="modal-backdrop">
      <div className="modal wizard">
        <div className="modal-head">
          <h2>New mod</h2>
          <ol className="wizard-steps">
            {STEPS.map((s, i) => (
              <li key={s} className={i === step ? 'active' : i < step ? 'done' : ''}>
                <span className="wizard-step-num">{i < step ? <Ico name="success" size={14} /> : i + 1}</span>
                {s}
              </li>
            ))}
          </ol>
          <div className="spacer" />
          <button className="ghost" onClick={onClose} disabled={op?.status === 'running'}>
            Close
          </button>
        </div>
        <div className="modal-body">
          {step === 0 && (
            <div className="wizard-page">
              <div className="wizard-row">
                <div className="wizard-field">
                  <span className="wizard-label">Loader</span>
                  <div className="segmented wizard-loader" role="radiogroup" aria-label="Loader">
                    {loaders.map((c) => (
                      <button key={c.id} type="button" role="radio" aria-checked={loader === c.id} className={loader === c.id ? 'on' : ''} onClick={() => chooseLoader(c.id)}>
                        {c.name}
                      </button>
                    ))}
                  </div>
                </div>
                <Field label="Minecraft version" error={fieldIssue('catalogEntryId')} hint={entry ? versionNote(entry, contentAvailable) : undefined}>
                  <select value={entryId} onChange={(e) => setEntryId(e.target.value)}>
                    {versions.map((e) => (
                      <option key={e.id} value={e.id} disabled={e.status === 'unverified'}>
                        {e.minecraft}
                        {e.status === 'unverified' ? ' (not available yet)' : ''}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="wizard-field">
                <span className="wizard-label">Start from</span>
                <div className="template-grid" role="radiogroup" aria-label="Template">
                  {templates.map((t) => {
                    const unavailable = t.id === 'content' && !contentAvailable;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        role="radio"
                        aria-checked={t.id === template.id}
                        className={`template-card ${t.id === template.id ? 'selected' : ''}`}
                        disabled={unavailable}
                        title={unavailable ? `The content starters are not available for Minecraft ${entry?.minecraft} yet` : undefined}
                        onClick={() => chooseTemplate(t)}
                      >
                        <Ico name={t.icon} size={18} />
                        <span className="col tight">
                          <b>{t.name}</b>
                          <span className="small dim">{unavailable ? `Not available for Minecraft ${entry?.minecraft} yet.` : t.description}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <span className="hint">You can change the starter content and dependencies in the Configure step.</span>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="wizard-page narrow">
              <Field label="Project name" error={fieldIssue('projectName')}>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Cool Mod" autoFocus />
              </Field>
              <Field label="Location" error={folderEdited ? undefined : fieldIssue('destination')} hint={destination ? <span className="mono">{destination}</span> : 'The project gets its own folder here.'}>
                <div className="row">
                  <input value={parentDir} onChange={(e) => setParentDir(e.target.value)} placeholder="Parent folder" className="grow mono" />
                  <button type="button" onClick={async () => setParentDir((await window.workbench?.chooseDirectory('Choose where to create the project')) ?? parentDir)}>
                    Browse…
                  </button>
                </div>
              </Field>
              <details className="wizard-more" open={identifierIssue || undefined}>
                <summary>Identifiers</summary>
                <div className="wizard-more-body">
                  <Field label="Folder name" error={folderEdited ? fieldIssue('destination') : undefined}>
                    <input
                      value={folder}
                      onChange={(e) => {
                        setFolder(e.target.value);
                        setFolderEdited(true);
                      }}
                      className="mono"
                    />
                  </Field>
                  <Field label="Mod ID" error={fieldIssue('modId')} hint="Lowercase letters, digits and underscores. Used as the resource namespace.">
                    <input
                      value={modId}
                      onChange={(e) => {
                        setModId(e.target.value);
                        setModIdEdited(true);
                      }}
                      className="mono"
                    />
                  </Field>
                  <Field label="Java package" error={fieldIssue('packageName')}>
                    <input
                      value={pkg}
                      onChange={(e) => {
                        setPkg(e.target.value);
                        setPkgEdited(true);
                      }}
                      className="mono"
                    />
                  </Field>
                </div>
              </details>
              <details className="wizard-more" open={!!fieldIssue('license') || undefined}>
                <summary>More options</summary>
                <div className="wizard-more-body">
                  <Field label="Author">
                    <input value={author} onChange={(e) => setAuthor(e.target.value)} />
                  </Field>
                  <Field label="Description">
                    <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} style={{ fontFamily: 'inherit' }} />
                  </Field>
                  <div className="wizard-row">
                    <Field label="License" error={fieldIssue('license')}>
                      <select value={license} onChange={(e) => setLicense(e.target.value)}>
                        {LICENSES.map((l) => (
                          <option key={l}>{l}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Runs on">
                      <select value={environment} onChange={(e) => setEnvironment(e.target.value as 'both')}>
                        <option value="both">Client and server</option>
                        <option value="client">Client only</option>
                        <option value="server">Server only</option>
                      </select>
                    </Field>
                  </div>
                  <label className="check">
                    <input type="checkbox" checked={git} onChange={(e) => setGit(e.target.checked)} /> Initialize a Git repository
                  </label>
                </div>
              </details>
            </div>
          )}

          {step === 2 && entry && (
            <div className="wizard-page">
              {!javaFor(entry.gradleJavaMin).length && (
                <div className="callout err">
                  No JDK {entry.gradleJavaMin}+ is installed. Modsmith can download Eclipse Temurin {entry.gradleJavaMin} for you, or install one yourself and refresh Java in Settings.{' '}
                  <button
                    className="small"
                    disabled={javaBusy}
                    onClick={async () => {
                      setJavaBusy(true);
                      await installJava(entry.gradleJavaMin).catch(() => null);
                      setJavaBusy(false);
                      javas.reload();
                    }}
                  >
                    {javaBusy ? 'Downloading…' : `Download JDK ${entry.gradleJavaMin}`}
                  </button>
                  <JavaDownloads />
                </div>
              )}
              <section className="wizard-section">
                <h3>Starter content</h3>
                <div className="option-grid">
                  {starterOpts.data?.map((s) => (
                    <label key={s.id} className={`option-card ${s.state !== 'supported' ? 'disabled' : ''} ${starters.includes(s.id) ? 'checked' : ''}`}>
                      <input
                        type="checkbox"
                        disabled={s.state !== 'supported' || s.id === 'empty'}
                        checked={starters.includes(s.id)}
                        onChange={(e) => setStarters((st) => (e.target.checked ? [...st, s.id] : st.filter((x) => x !== s.id)))}
                      />
                      <span className="col tight">
                        <b>{s.label}</b>
                        <span className="hint">{s.state === 'supported' || /not implemented/i.test(s.description) ? s.description : `Not available for Minecraft ${entry.minecraft} yet.`}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {fieldIssue('starters') && <div className="field-error">{fieldIssue('starters')}</div>}
              </section>

              <section className="wizard-section">
                <h3>Dependencies</h3>
                <p className="hint">
                  Compile dependencies go on the Gradle classpath through the Modrinth Maven repository; CurseForge mods are runtime only. Runtime dependencies are only added to development test instances. Search results are limited to {loaderName} {entry.minecraft}.
                </p>
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Dependency</th>
                      <th>Usage</th>
                      <th>Required</th>
                      <th>Side</th>
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
                          <input type="checkbox" aria-label={`${d.title} is required`} checked={d.required} onChange={(e) => setDeps((x) => x.map((y, j) => (j === i ? { ...y, required: e.target.checked } : y)))} />
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
                          No extra dependencies.{entry.loader === 'fabric' ? ' Fabric API is always included by the template.' : ''}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                <div className="row wrap">
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
              </section>

              <details className="wizard-more">
                <summary>Template details</summary>
                <div className="wizard-more-body">
                  <div className="kv">
                    <span>Loader version</span>
                    <span className="mono">{entry.loaderVersion}</span>
                    {entry.loader === 'fabric' && (
                      <>
                        <span>Fabric API</span>
                        <span className="mono">{entry.fabricApiVersion}</span>
                      </>
                    )}
                    <span>Mappings</span>
                    <span>{entry.mappings === 'mojang' ? 'Official Mojang mappings' : 'None (unobfuscated)'}</span>
                    <span>Gradle plugin</span>
                    <span className="mono">
                      {entry.plugin.id} {entry.plugin.version}
                    </span>
                    <span>Gradle wrapper</span>
                    <span className="mono">{entry.gradleVersion}</span>
                    <span>Java</span>
                    <span>
                      Bytecode {entry.javaRelease}; Gradle needs JDK {entry.gradleJavaMin}+{javaFor(entry.gradleJavaMin)[0] ? ` (uses ${javaFor(entry.gradleJavaMin)[0].vendor} ${javaFor(entry.gradleJavaMin)[0].version})` : ''}; the game needs Java {entry.runtimeJavaMin}+
                    </span>
                    <span>Published {loaderName} versions</span>
                    <span>
                      {meta.loading
                        ? 'Checking…'
                        : meta.error
                          ? `Unavailable: ${meta.error}`
                          : `${meta.data?.versions.length ?? 0} for ${entry.minecraft}, newest stable ${meta.data?.versions.find((v) => v.stable)?.version ?? 'n/a'}${meta.data?.stale ? ' (offline cache)' : ''}. The template uses ${entry.loaderVersion}.`}
                    </span>
                    <span>Source</span>
                    <a onClick={() => void window.workbench?.openExternal(entry.templateSource)}>{entry.templateSource}</a>
                  </div>
                </div>
              </details>
            </div>
          )}

          {step === 3 && entry && (
            <div className="wizard-page">
              {!op && (
                <>
                  <div className="kv">
                    <span>Project</span>
                    <span>
                      {name} <span className="mono mute">({modId})</span>
                    </span>
                    <span>Template</span>
                    <span>{template.name}</span>
                    <span>Platform</span>
                    <span>{platformText}</span>
                    <span>Location</span>
                    <span className="mono">{destination}</span>
                    <span>Package</span>
                    <span className="mono">{pkg}</span>
                    <span>Starters</span>
                    <span>{starterOpts.data?.filter((s) => starters.includes(s.id)).map((s) => s.label).join(', ')}</span>
                    <span>Git</span>
                    <span>{git ? 'Yes' : 'No'}</span>
                  </div>
                  {(planning || (plan && plan.length > 0)) && (
                    <section className="wizard-section">
                      <h3>Dependencies</h3>
                      {planning && <div className="mute">Checking availability…</div>}
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
                    </section>
                  )}
                  <label className="check">
                    <input type="checkbox" checked={runBuild} onChange={(e) => setRunBuild(e.target.checked)} /> Run the first Gradle build now (downloads Minecraft and the toolchain, about 1–3 minutes)
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
              <div className="spacer">{javaBusy && <JavaDownloads />}</div>
              {blocked && <span className="hint wizard-blocked">{blocked}</span>}
              {step < STEPS.length - 1 && (
                <button className="primary" onClick={() => void next()} disabled={!!blocked}>
                  Next
                </button>
              )}
              {step === STEPS.length - 1 && (
                <button className="primary" onClick={() => void create()} disabled={javaBusy || planning || plan?.some((p) => p.status === 'error')}>
                  {javaBusy ? 'Preparing Java…' : 'Create project'}
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
