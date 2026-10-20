import { useEffect, useRef, useState } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
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
import { store, useStore } from '../store';
import { Ico } from '../ui/icons';
import { Button } from '../ui/controls';
import { ask } from '../dialogs';

function languageFor(file: string) {
  if (/\.(json|mcmeta)$/.test(file)) return json();
  if (/\.json5$/.test(file)) return json();
  if (/\.java$/.test(file)) return java();
  if (/\.toml$/.test(file)) return StreamLanguage.define(toml);
  if (/\.(gradle|kts)$/.test(file)) return StreamLanguage.define(groovy);
  if (/\.(properties|cfg|lang)$/.test(file)) return StreamLanguage.define(properties);
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
        <Button size="sm" icon="success" onClick={() => void save()} disabled={!dirty} title="Save (Ctrl+S)">
          {dirty ? 'Save' : 'Saved'}
        </Button>
      </div>
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
