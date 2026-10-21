import { useEffect, useRef, useState, type ReactNode } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { acceptCompletion, completeAnyWord } from '@codemirror/autocomplete';
import { keymap } from '@codemirror/view';
import { json } from '@codemirror/lang-json';
import { java } from '@codemirror/lang-java';
import { StreamLanguage } from '@codemirror/language';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { groovy } from '@codemirror/legacy-modes/mode/groovy';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { oneDark } from '@codemirror/theme-one-dark';
import JSON5 from 'json5';
import { parse as parseToml } from 'smol-toml';
import { store, useStore, waitForOperation } from '../store';
import { languageServerFor, lspStatus, useLspPhase, type LspStatus } from '../lsp';
import type { OperationInfo } from '../../shared/types';
import { Ico } from '../ui/icons';
import { Button, Notice } from '../ui/controls';
import { installJava } from '../java';
import { ask } from '../dialogs';
import { jsonIntelligence } from '../jsonIntel';
import { schemaFor } from '../jsonSchemas';

function languageFor(file: string) {
  if (/\.(json|mcmeta)$/.test(file)) return json();
  if (/\.json5$/.test(file)) return json();
  if (/\.java$/.test(file)) return java();
  if (/\.toml$/.test(file)) return StreamLanguage.define(toml);
  if (/\.(gradle|kts)$/.test(file)) return StreamLanguage.define(groovy);
  if (/\.(properties|cfg|lang)$/.test(file)) return StreamLanguage.define(properties);
  return [];
}

function wordCompletion(file: string) {
  if (/\.(toml|gradle|kts|properties|cfg|lang|txt|md)$/.test(file)) return EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]);
  return [];
}

export function validateContent(file: string, text: string): string | null {
  try {
    if (/\.(json|mcmeta)$/.test(file)) JSON.parse(text);
    else if (/\.json5$/.test(file)) JSON5.parse(text);
    else if (/\.toml$/.test(file)) parseToml(text);
    if (/fabric\.mod\.json$/.test(file)) {
      const j = JSON.parse(text);
      if (j.schemaVersion !== 1) return 'fabric.mod.json: schemaVersion must be 1';
      if (typeof j.id !== 'string' || !/^[a-z][a-z0-9-_]{1,63}$/.test(j.id)) return 'fabric.mod.json: id must match ^[a-z][a-z0-9-_]{1,63}$';
      if (typeof j.version !== 'string') return 'fabric.mod.json: version is required';
    }
    if (/\/lang\/[a-z_]+\.json$/.test(file)) {
      const j = JSON.parse(text);
      for (const [k, v] of Object.entries(j)) if (typeof v !== 'string') return `Translation ${k} must be a string`;
    }
    if (/\/(recipe|recipes)\/.+\.json$/.test(file) && !JSON.parse(text).type) return 'Recipe is missing "type"';
    if (/\/loot_table\/.+\.json$/.test(file) && !JSON.parse(text).type) return 'Loot table is missing "type"';
    if (/\/tags\/.+\.json$/.test(file) && !Array.isArray(JSON.parse(text).values)) return 'Tag file needs a "values" array';
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

export function EditorPane({ file, visible = true }: { file: string; visible?: boolean }) {
  const ws = useStore((s) => s.workspace)!;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [meta, setMeta] = useState<{ mtime: number; binary: boolean; size: number } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const saveRef = useRef<() => void>(() => undefined);
  const lspSlot = useRef(new Compartment());
  const [javaLsp, setJavaLsp] = useState<LspStatus | null>(null);
  const [lspError, setLspError] = useState<string | null>(null);
  const isJava = /\.java$/.test(file);
  const phase = useLspPhase(ws.path);
  const attached = useRef(false);
  const [setupBusy, setSetupBusy] = useState<string | null>(null);
  const [bannerHidden, setBannerHidden] = useState(() => {
    try {
      return localStorage.getItem('mwb.lsp.notNow') === '1';
    } catch {
      return false;
    }
  });

  const attachJava = async () => {
    setLspError(null);
    try {
      const st = await lspStatus(ws.path);
      setJavaLsp(st);
      if (!st.installed || !st.trusted || !st.java) return;
      if (attached.current) return;
      attached.current = true;
      const ext = await languageServerFor(ws.path, file);
      view.current?.dispatch({ effects: lspSlot.current.reconfigure(ext) });
    } catch (e) {
      attached.current = false;
      setLspError((e as Error).message);
    }
  };

  useEffect(() => {
    if (!isJava || attached.current || !view.current) return;
    if (phase.phase === 'starting' || phase.phase === 'importing' || phase.phase === 'ready') void attachJava();
  }, [phase.phase, isJava]);

  const setUpJava = async () => {
    const st = javaLsp ?? (await lspStatus(ws.path));
    try {
      if (!st.trusted) {
        if (!(await ask("Java completion imports the project's Gradle build, which runs its build scripts. Trust this project?"))) return;
        await store.call('workspace.trust', { path: ws.path, trusted: true });
        await store.refreshWorkspace();
      }
      if (!st.installed) {
        setSetupBusy(`Downloading the ${st.server} (${Math.round(st.size / 1e6)} MB)…`);
        const op = await store.call<OperationInfo>('lsp.install', { language: 'java' });
        const done = await waitForOperation(op.id);
        if (done.status !== 'succeeded') {
          setLspError(done.error ?? 'The download did not finish');
          return;
        }
      }
      setSetupBusy(null);
      attached.current = false;
      await attachJava();
    } finally {
      setSetupBusy(null);
    }
  };

  const installJavaForLsp = async (major: number) => {
    setSetupBusy(`Downloading Java ${major}…`);
    try {
      await installJava(major);
      attached.current = false;
      await attachJava();
    } finally {
      setSetupBusy(null);
    }
  };

  const notNow = () => {
    setBannerHidden(true);
    try {
      localStorage.setItem('mwb.lsp.notNow', '1');
    } catch {
      return;
    }
  };

  useEffect(() => {
    store.setDirty(file, dirty);
  }, [dirty, file]);

  useEffect(() => {
    let alive = true;
    setError(null);
    setImage(null);
    store
      .call<{ content: string; binary: boolean; mtime: number; size: number }>('workspace.read_file', { path: ws.path, file }, { quiet: true })
      .then((r) => {
        if (!alive) return;
        setMeta({ mtime: r.mtime, binary: r.binary, size: r.size });
        if (r.binary) {
          if (/\.png$/i.test(file)) setImage(`data:image/png;base64,${r.content}`);
          return;
        }
        view.current?.destroy();
        view.current = new EditorView({
          parent: host.current!,
          state: EditorState.create({
            doc: r.content,
            extensions: [
              basicSetup,
              oneDark,
              languageFor(file),
              jsonIntelligence(file),
              wordCompletion(file),
              lspSlot.current.of([]),
              Prec.highest(keymap.of([{ key: 'Tab', run: acceptCompletion }])),
              keymap.of([{ key: 'Mod-s', run: () => (saveRef.current(), true) }]),
              EditorView.updateListener.of((u) => {
                if (u.docChanged) {
                  setDirty(true);
                  setProblem(validateContent(file, u.state.doc.toString()));
                }
              })
            ]
          })
        });
        setProblem(validateContent(file, r.content));
        setDirty(false);
        if (/\.java$/.test(file)) void attachJava();
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
      view.current?.destroy();
      view.current = null;
    };
  }, [ws.path, file]);

  const save = async () => {
    if (!view.current || !meta) return;
    const text = view.current.state.doc.toString();
    const p = validateContent(file, text);
    if (p && !(await ask(`This file does not validate:\n${p}\n\nSave anyway?`))) return;
    const r = await store.call<{ mtime: number }>('workspace.write_file', { path: ws.path, file, content: text, expectedMtime: meta.mtime });
    setMeta({ ...meta, mtime: r.mtime });
    setDirty(false);
  };
  saveRef.current = () => void save();
  const schema = schemaFor(file);

  return (
    <div className="editor" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="editor-bar">
        <span className="crumbs ellipsis" title={file}>
          {file.split('/').map((seg, i, arr) => (
            <span key={i} className={i === arr.length - 1 ? 'crumb-last' : 'crumb'}>
              {seg}
              {i < arr.length - 1 && <span className="crumb-sep">/</span>}
            </span>
          ))}
        </span>
        {problem && (
          <span className="editor-problem" title={problem}>
            <Ico name="problems" size={14} /> {problem.slice(0, 80)}
          </span>
        )}
        {schema && (
          <span className="editor-schema" title={schema.checked ? `Completion, hover and checks from the ${schema.label} schema` : `Completion and hover from the ${schema.label} schema. Its checks are off because the schema lags behind current Minecraft versions.`}>
            {schema.label}
            {!schema.checked && ' (hints)'}
          </span>
        )}
        {isJava && javaLsp && <JavaLspChip status={javaLsp} phase={phase.phase} message={lspError ?? phase.message} bannerShown={!bannerHidden} onSetUp={() => void setUpJava()} onRetry={() => void attachJava()} />}
        <Button size="sm" icon="success" onClick={() => void save()} disabled={!dirty} title="Save (Ctrl+S)">
          {dirty ? 'Save' : 'Saved'}
        </Button>
      </div>
      {isJava && javaLsp && (
        <JavaLspBanner
          status={javaLsp}
          phase={phase.phase}
          message={lspError ?? phase.message}
          busy={setupBusy}
          hidden={bannerHidden}
          onSetUp={() => void setUpJava()}
          onInstallJava={(m) => void installJavaForLsp(m)}
          onRetry={() => {
            attached.current = false;
            void attachJava();
          }}
          onNotNow={notNow}
        />
      )}
      {error && <div className="pad err">{error}</div>}
      {image && (
        <div className="col" style={{ padding: 16, alignItems: 'flex-start' }}>
          <img src={image} style={{ imageRendering: 'pixelated', width: 256, background: 'repeating-conic-gradient(#333 0 25%, #222 0 50%) 0 0/16px 16px', border: '1px solid var(--line)' }} />
          <span className="mute small">Texture preview (nearest-neighbour scaling). In-game rendering, tinting and animation may differ.</span>
        </div>
      )}
      {meta?.binary && !image && <div className="empty">Binary file ({meta.size} bytes) is not editable here.</div>}
      <div ref={host} className="cm-host" style={{ flex: 1, minHeight: 0, display: meta?.binary ? 'none' : undefined }} />
    </div>
  );
}

function JavaLspBanner({ status, phase, message, busy, hidden, onSetUp, onInstallJava, onRetry, onNotNow }: { status: LspStatus; phase: string; message: string; busy: string | null; hidden: boolean; onSetUp: () => void; onInstallJava: (major: number) => void; onRetry: () => void; onNotNow: () => void }) {
  const actions = (primary: ReactNode) => (
    <div className="row tight nowrap">
      {primary}
      <Button size="sm" variant="ghost" onClick={onNotNow}>
        Not now
      </Button>
    </div>
  );
  if (busy) {
    return (
      <div className="editor-banner">
        <Notice tone="info">
          <span className="row tight">
            <Ico name="loading" size={14} className="spin" /> {busy}
          </span>
        </Notice>
      </div>
    );
  }
  const ready = status.installed && status.trusted && !!status.java;
  if (ready && (phase === 'error' || phase === 'stopped')) {
    return (
      <div className="editor-banner">
        <Notice tone="error" action={<Button size="sm" onClick={onRetry}>Restart</Button>}>
          <b>Java completion stopped.</b> {message}
        </Notice>
      </div>
    );
  }
  if (ready && (phase === 'starting' || phase === 'importing')) {
    return (
      <div className="editor-banner slim">
        <Ico name="loading" size={13} className="spin" />
        <span>{phase === 'importing' ? 'Loading the Gradle project for Java completion. The first time takes a minute or two.' : 'Starting Java completion…'}</span>
      </div>
    );
  }
  if (ready || hidden) return null;
  if (!status.java) {
    return (
      <div className="editor-banner">
        <Notice tone="warn" action={actions(<Button size="sm" variant="primary" onClick={() => onInstallJava(status.javaMin)}>Download Java {status.javaMin}</Button>)}>
          <b>Java completion needs Java {status.javaMin} or newer.</b> Modsmith can download Eclipse Temurin {status.javaMin} for it.
        </Notice>
      </div>
    );
  }
  if (!status.installed) {
    return (
      <div className="editor-banner">
        <Notice tone="info" action={actions(<Button size="sm" variant="primary" onClick={onSetUp}>Turn on</Button>)}>
          <b>Turn on Java completion.</b> Suggestions as you type, documentation on hover and error checking for Minecraft and your mods, from the {status.server} ({Math.round(status.size / 1e6)} MB download, checked against a pinned hash). It stays on for every project.
        </Notice>
      </div>
    );
  }
  return (
    <div className="editor-banner">
      <Notice tone="info" action={actions(<Button size="sm" variant="primary" onClick={onSetUp}>Trust and turn on</Button>)}>
        <b>Java completion is off for this project.</b> It loads the project's Gradle build, which runs its build scripts, so the project needs to be trusted first.
      </Notice>
    </div>
  );
}

function JavaLspChip({ status, phase, message, bannerShown, onSetUp, onRetry }: { status: LspStatus; phase: string; message: string; bannerShown: boolean; onSetUp: () => void; onRetry: () => void }) {
  if (bannerShown && !(status.installed && status.trusted && status.java && phase === 'ready')) return null;
  if (!status.java) return <span className="editor-schema" title={`${status.server} needs Java ${status.javaMin} or newer. Add one in Settings > Java.`}>Java completion needs Java {status.javaMin}+</span>;
  if (!status.installed || !status.trusted) {
    return (
      <button type="button" className="editor-chip" onClick={onSetUp} title={!status.trusted ? 'Trust the project and start the Java language server' : `Download ${status.server} ${status.version}`}>
        <Ico name="code" size={13} /> Set up Java completion
      </button>
    );
  }
  if (phase === 'error' || phase === 'stopped') {
    return (
      <button type="button" className="editor-chip err" onClick={onRetry} title={message}>
        <Ico name="problems" size={13} /> Java completion stopped · Retry
      </button>
    );
  }
  if (phase === 'ready') return <span className="editor-schema" title={`${status.server} ${status.version}`}>Java</span>;
  return (
    <span className="editor-schema" title={message}>
      <Ico name="loading" size={12} className="spin" /> {phase === 'importing' ? 'Importing project' : 'Starting Java'}
    </span>
  );
}
