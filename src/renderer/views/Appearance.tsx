import { useEffect, useRef, useState } from 'react';
import { EditorView } from 'codemirror';
import { lineNumbers, highlightActiveLine, highlightActiveLineGutter, Decoration, ViewPlugin, type DecorationSet } from '@codemirror/view';
import { EditorState, RangeSetBuilder, type Extension } from '@codemirror/state';
import { bracketMatching, StreamLanguage } from '@codemirror/language';
import { setDiagnostics, lintGutter } from '@codemirror/lint';
import { java } from '@codemirror/lang-java';
import { json } from '@codemirror/lang-json';
import { groovy } from '@codemirror/legacy-modes/mode/groovy';
import { store } from '../store';
import { themes, useThemes } from '../theme';
import { themedEditor } from '../theme/editor';
import type { ResolvedTheme, ThemeEntry, ThemeKind } from '../theme/model';
import { Button, Notice, Segmented, Switch } from '../ui/controls';
import { Ico } from '../ui/icons';
import { ask } from '../dialogs';

type Slot = 'app' | 'code';
type Sample = 'java' | 'json' | 'gradle';

interface Inspection {
  kind: 'json' | 'vsix';
  extension: { publisher: string; name: string; displayName: string; version: string } | null;
  variants: { key: string; label: string; type: ThemeKind | null }[];
}

const KIND_LABEL: Record<ThemeKind, string> = { dark: 'Dark', light: 'Light', 'hc-dark': 'High contrast dark', 'hc-light': 'High contrast light' };

const SAMPLES: Record<Sample, string> = {
  java: `package com.example.forge;

import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.common.Mod;

@Mod(ExampleMod.MOD_ID)
public final class ExampleMod {
    public static final String MOD_ID = "examplemod";
    private static final int MAX_STACK = 64;

    public ExampleMod(IEventBus modEventBus) {
        // Register blocks and items
        modEventBus.addListener(this::setup);
        if (MAX_STACK > 32 && !modEventBus.isEmpty()) {
            System.out.println("Loaded " + MOD_ID + "\\n");
        }
        int missing = undefinedValue;
    }
}
`,
  json: `{
  "type": "minecraft:crafting_shaped",
  "pattern": ["##", "##"],
  "key": { "#": { "item": "minecraft:oak_planks" } },
  "result": { "id": "examplemod:crate", "count": 1 },
  "show_notification": true,
  "group": null
}
`,
  gradle: `plugins {
    id 'java-library'
    id 'net.neoforged.moddev' version '2.0.78'
}

version = '1.0.0'
def javaVersion = 21

dependencies {
    // Optional integrations
    implementation "com.example:library:\${version}"
}

java.toolchain.languageVersion = JavaLanguageVersion.of(javaVersion)
`
};

const SEMANTIC_SAMPLE: [RegExp, string][] = [
  [/\bExampleMod\b/g, 'sem sem-t-class'],
  [/\bIEventBus\b/g, 'sem sem-t-interface'],
  [/\bMod\b(?=\(|;)/g, 'sem sem-t-annotation'],
  [/\bMOD_ID\b/g, 'sem sem-t-variable sem-m-static sem-m-readonly'],
  [/\bMAX_STACK\b/g, 'sem sem-t-variable sem-m-static sem-m-readonly'],
  [/\bmodEventBus\b/g, 'sem sem-t-parameter'],
  [/\b(addListener|isEmpty|println)\b/g, 'sem sem-t-method'],
  [/\bsetup\b/g, 'sem sem-t-method'],
  [/\bString\b/g, 'sem sem-t-class sem-m-defaultLibrary'],
  [/\bSystem\b/g, 'sem sem-t-class sem-m-defaultLibrary'],
  [/\bout\b/g, 'sem sem-t-property sem-m-static sem-m-readonly'],
  [/\bmissing\b/g, 'sem sem-t-variable sem-m-declaration'],
  [/\bcom\.example\.forge\b/g, 'sem sem-t-namespace']
];

function sampleSemantics(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        const text = view.state.doc.toString();
        const marks: { from: number; to: number; cls: string }[] = [];
        for (const [re, cls] of SEMANTIC_SAMPLE) for (const m of text.matchAll(re)) marks.push({ from: m.index!, to: m.index! + m[0].length, cls });
        marks.sort((a, b) => a.from - b.from);
        const b = new RangeSetBuilder<Decoration>();
        for (const m of marks) b.add(m.from, m.to, Decoration.mark({ class: m.cls }));
        this.decorations = b.finish();
      }
    },
    { decorations: (p) => p.decorations }
  );
}

function PreviewEditor({ sample }: { sample: Sample }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const doc = SAMPLES[sample];
    const lang = sample === 'java' ? [java(), sampleSemantics()] : sample === 'json' ? json() : StreamLanguage.define(groovy);
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc,
        extensions: [lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), bracketMatching(), lintGutter(), themedEditor, lang, EditorState.readOnly.of(true), EditorView.editable.of(false)]
      })
    });
    if (sample === 'java') {
      const at = (s: string) => doc.indexOf(s);
      view.dispatch(
        setDiagnostics(view.state, [
          { from: at('undefinedValue'), to: at('undefinedValue') + 'undefinedValue'.length, severity: 'error', message: 'undefinedValue cannot be resolved to a variable' },
          { from: at('missing'), to: at('missing') + 'missing'.length, severity: 'warning', message: 'The value of the local variable missing is not used' }
        ])
      );
      const sel = at('addListener');
      view.dispatch({ selection: { anchor: sel, head: sel + 'addListener'.length } });
    }
    return () => view.destroy();
  }, [sample]);
  return <div className="theme-preview-editor cm-host" ref={host} />;
}

function Swatch({ theme }: { theme: ResolvedTheme }) {
  const s = theme.syntax;
  return (
    <span className="theme-swatch" style={{ background: theme.editor.bg, color: theme.editor.fg, borderColor: theme.app.line }} aria-hidden>
      <span style={{ color: s.storage.color }}>class</span> <span style={{ color: s.type.color }}>Mod</span> <span style={{ color: s.punctuation.color }}>{'{'}</span> <span style={{ color: s.function.color }}>run</span>
      <span style={{ color: s.punctuation.color }}>(</span>
      <span style={{ color: s.string.color }}>"ok"</span>
      <span style={{ color: s.punctuation.color }}>)</span>
    </span>
  );
}

function sourceLabel(t: ThemeEntry) {
  if (t.source.kind === 'builtin') return 'Built-in';
  if (t.source.kind === 'vsix') {
    const x = t.source.extension;
    return x ? `Extension ${x.publisher}.${x.name}${x.version ? ` ${x.version}` : ''}` : 'VS Code extension';
  }
  return `Theme file ${t.source.file ?? ''}`.trim();
}

export function AppearanceSettings() {
  const st = useThemes();
  const sel = st.preview ?? st.saved;
  const [slot, setSlot] = useState<Slot>('code');
  const [query, setQuery] = useState('');
  const [focus, setFocus] = useState(sel.code);
  const [sample, setSample] = useState<Sample>('java');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ file: string; info: Inspection; chosen: string[] } | null>(null);

  useEffect(() => () => themes.cancelPreview(), []);
  useEffect(() => {
    if (st.loaded) return;
    void themes.refresh();
  }, [st.loaded]);

  const all = themes.all();
  const q = query.trim().toLowerCase();
  const shown = all.filter((t) => !q || [t.name, t.author ?? '', sourceLabel(t), KIND_LABEL[themes.resolve(t.id).kind]].some((x) => x.toLowerCase().includes(q)));
  const focused = themes.find(focus) ?? all[0];
  const resolvedFocus = themes.resolve(focused.id);
  const activeSlot: Slot = sel.match ? 'code' : slot;
  const chosenId = activeSlot === 'app' ? sel.app : sel.code;
  const changed = !!st.preview && (st.preview.app !== st.saved.app || st.preview.code !== st.saved.code || st.preview.match !== st.saved.match);
  const nameOf = (id: string) => themes.find(id)?.name ?? id;

  const choose = (id: string) => {
    setFocus(id);
    setError(null);
    themes.preview(activeSlot === 'app' ? { app: id } : { code: id });
  };

  const install = async (file: string, variants?: string[]) => {
    setBusy(true);
    try {
      const r = await store.call<{ installed: ThemeEntry[]; updated: string[] }>('theme.install', variants ? { file, variants } : { file }, { quiet: true });
      await themes.refresh();
      setPending(null);
      const first = r.installed[0];
      if (first) choose(first.id);
      const added = r.installed.length - r.updated.length;
      store.toast('success', [added && `Imported ${added} theme${added === 1 ? '' : 's'}`, r.updated.length && `updated ${r.updated.length}`].filter(Boolean).join(', ') || 'Theme imported');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const importTheme = async () => {
    setError(null);
    const file = await window.workbench?.chooseFile('Import a VS Code color theme', [{ name: 'VS Code color theme or extension', extensions: ['json', 'jsonc', 'vsix'] }]);
    if (!file) return;
    setBusy(true);
    try {
      const info = await store.call<Inspection>('theme.inspect', { file }, { quiet: true });
      setBusy(false);
      if (info.variants.length > 1) setPending({ file, info, chosen: info.variants.map((v) => v.key) });
      else await install(file);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const remove = async (t: ThemeEntry) => {
    if (!(await ask(`Remove the theme ${t.name}?`))) return;
    try {
      await themes.remove(t.id);
      const now = themes.current();
      setFocus(now.code);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="appearance">
      <div className="appearance-slots">
        <button type="button" className={`slot-card ${activeSlot === 'app' ? 'on' : ''}`} disabled={sel.match} onClick={() => (setSlot('app'), setFocus(sel.app))}>
          <span className="small dim">Application theme</span>
          <b>{sel.match ? `${nameOf(sel.code)} (matches code)` : nameOf(sel.app)}</b>
        </button>
        <button type="button" className={`slot-card ${activeSlot === 'code' ? 'on' : ''}`} onClick={() => (setSlot('code'), setFocus(sel.code))}>
          <span className="small dim">Code theme</span>
          <b>{nameOf(sel.code)}</b>
        </button>
        <label className="toggle-row match-row">
          <Switch checked={sel.match} label="Match application to code theme" onChange={(v) => themes.preview({ match: v })} />
          <span className="col tight">
            <span>Match application to code theme</span>
            <span className="small dim">Colors the whole app from the code theme's workbench colors.</span>
          </span>
        </label>
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {st.error && !error && <Notice tone="warn">Imported themes could not be loaded: {st.error}</Notice>}

      {pending && (
        <div className="card theme-variants">
          <b>{pending.info.extension?.displayName ?? 'Theme package'} contains {pending.info.variants.length} themes</b>
          <div className="col tight">
            {pending.info.variants.map((v) => (
              <label key={v.key} className="check">
                <input
                  type="checkbox"
                  checked={pending.chosen.includes(v.key)}
                  onChange={(e) => setPending({ ...pending, chosen: e.target.checked ? [...pending.chosen, v.key] : pending.chosen.filter((k) => k !== v.key) })}
                />
                {v.label} <span className="mute">{v.type ? KIND_LABEL[v.type] : ''}</span>
              </label>
            ))}
          </div>
          <div className="row">
            <Button variant="primary" busy={busy} disabled={!pending.chosen.length} onClick={() => void install(pending.file, pending.chosen)}>
              Import selected
            </Button>
            <Button variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="appearance-main">
        <div className="theme-list-col">
          <div className="row">
            <label className="search-field grow">
              <Ico name="search" size={14} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search themes" aria-label="Search themes" />
            </label>
            <Button icon="download" busy={busy && !pending} onClick={() => void importTheme()}>
              Import Theme…
            </Button>
          </div>
          <div className="theme-list" role="listbox" aria-label={activeSlot === 'app' ? 'Application themes' : 'Code themes'}>
            {shown.map((t) => {
              const r = themes.resolve(t.id);
              return (
                <button key={t.id} type="button" role="option" aria-label={`${t.name}, ${KIND_LABEL[r.kind]}`} aria-selected={chosenId === t.id} className={`theme-item ${chosenId === t.id ? 'chosen' : ''} ${focused.id === t.id ? 'focused' : ''}`} onClick={() => choose(t.id)}>
                  <Swatch theme={r} />
                  <span className="col tight grow theme-item-text">
                    <span className="ellipsis">{t.name}</span>
                    <span className="small mute ellipsis">
                      {KIND_LABEL[r.kind]} · {t.source.kind === 'builtin' ? 'Built-in' : (t.author ?? 'Imported')}
                    </span>
                  </span>
                  {chosenId === t.id && <Ico name="success" size={14} />}
                </button>
              );
            })}
            {!shown.length && <div className="mute theme-empty">No themes match “{query}”.</div>}
          </div>
        </div>

        <div className="theme-detail">
          <div className="row">
            <span className="col tight grow">
              <h3>{focused.name}</h3>
              <span className="small dim">
                {[focused.author, KIND_LABEL[resolvedFocus.kind], sourceLabel(focused)].filter(Boolean).join(' · ')}
              </span>
            </span>
            <Button variant="danger" size="sm" icon="remove" disabled={focused.source.kind === 'builtin'} title={focused.source.kind === 'builtin' ? 'Built-in themes cannot be removed' : undefined} onClick={() => void remove(focused)}>
              Remove
            </Button>
          </div>
          <Segmented<Sample>
            value={sample}
            label="Preview sample"
            onChange={setSample}
            options={[
              { value: 'java', label: 'Java' },
              { value: 'json', label: 'JSON' },
              { value: 'gradle', label: 'Gradle' }
            ]}
          />
          <PreviewEditor sample={sample} />
          {focused.source.attribution && <div className="small dim">{focused.source.attribution}</div>}
          {resolvedFocus.compatibility.length > 0 && (
            <ul className="theme-notes small dim">
              {resolvedFocus.compatibility.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="appearance-foot">
        <span className="grow small dim">
          {changed ? 'Previewing. Open files, edits and cursors are kept; apply to keep these themes.' : `Application: ${sel.match ? nameOf(sel.code) : nameOf(sel.app)} · Code: ${nameOf(sel.code)}`}
        </span>
        <Button variant="ghost" disabled={!changed} onClick={() => themes.cancelPreview()}>
          Cancel preview
        </Button>
        <Button variant="primary" disabled={!changed} onClick={() => (themes.commit(), store.toast('success', 'Theme applied'))}>
          Apply
        </Button>
      </div>
    </div>
  );
}
