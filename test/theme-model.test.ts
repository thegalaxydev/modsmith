import { describe, expect, it } from 'vitest';
import { APP_VARS, CATEGORIES, EDITOR_VARS, resolveSemantic, resolveSyntax, resolveTheme, themeOutput, type ThemeEntry, type ThemeOutput } from '../src/renderer/theme/model';
import { BUILTIN_THEMES, MODSMITH_DARK, MODSMITH_HIGH_CONTRAST, MODSMITH_LIGHT } from '../src/renderer/theme/builtins';
import { createThemeManager, type ThemeCatalog } from '../src/renderer/theme/manager';
import { contrast, opaque, parseColor } from '../src/renderer/theme/color';
import { decodeSemanticTokens } from '../src/renderer/theme/editor';
import { Text } from '@codemirror/state';

const imported = (id: string, type: ThemeEntry['type'], theme: ThemeEntry['theme'], name = id): ThemeEntry => ({
  id,
  name,
  author: 'Tester',
  type,
  source: { kind: 'json', file: `${id}.json` },
  theme,
  warnings: [],
  installedAt: '2026-10-21T00:00:00Z'
});

const RICH = imported('file.rich', 'dark', {
  colors: {
    'editor.background': '#101820',
    'editor.foreground': '#fafafa',
    'statusBar.background': '#ff0000',
    'activityBar.background': '#00ff00',
    'editorSuggestWidget.background': '#0000ff',
    'editor.lineHighlightBackground': '#123456',
    'tab.activeBorderTop': '#abcdef'
  },
  tokenColors: [
    { scope: 'keyword', settings: { foreground: '#111111' } },
    { scope: 'keyword.control', settings: { foreground: '#222222', fontStyle: 'italic' } },
    { scope: ['string', 'comment'], settings: { foreground: '#333333' } },
    { scope: 'string', settings: { foreground: '#444444' } },
    { scope: 'meta.class entity.name.type', settings: { foreground: '#555555' } },
    { scope: 'comment', settings: { fontStyle: 'bold' } }
  ],
  semanticHighlighting: true,
  semanticTokenColors: { 'variable.readonly:java': '#666666', '*.deprecated': { strikethrough: true }, 'class:typescript': '#777777', 'x}body{color:red': '#888888' }
});

const SPARSE = imported('file.sparse', 'light', { colors: { 'editor.background': '#fefefe' } });

const isColor = (v: string) => parseColor(v) !== null;

function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) };
}

function harness(installed: ThemeEntry[], storage = fakeStorage()) {
  const applied: ThemeOutput[] = [];
  let list = [...installed];
  const catalog: ThemeCatalog = {
    list: async () => list,
    remove: async (id) => {
      list = list.filter((t) => t.id !== id);
    }
  };
  const m = createThemeManager({ storage, target: { apply: (o) => void applied.push(o) }, catalog });
  return { m, applied, storage, last: () => applied[applied.length - 1] };
}

describe('theme model', () => {
  it('resolves every app, editor and syntax value for built-in and sparse themes', () => {
    for (const entry of [...BUILTIN_THEMES, SPARSE, imported('file.empty', null, {})]) {
      const r = resolveTheme(entry);
      for (const k of APP_VARS) expect(isColor(r.app[k]), `${entry.id} ${k}=${r.app[k]}`).toBe(true);
      for (const k of EDITOR_VARS) expect(isColor(r.editor[k]), `${entry.id} ed-${k}=${r.editor[k]}`).toBe(true);
      expect(Object.keys(r.syntax).sort()).toEqual(Object.keys(CATEGORIES).sort());
    }
    expect(resolveTheme(imported('file.guess', null, { colors: { 'editor.background': '#ffffff' } })).kind).toBe('light');
  });

  it('does not leak colors from a previously applied theme', () => {
    const rich = resolveTheme(RICH);
    const sparse = resolveTheme(SPARSE);
    const after = themeOutput(sparse, sparse, false);
    const fresh = themeOutput(resolveTheme(SPARSE), resolveTheme(SPARSE), false);
    expect(after).toEqual(fresh);
    expect(rich.app['statusbar-bg']).toBe('#ff0000');
    for (const v of Object.values(after.vars)) for (const leaked of ['#ff0000', '#00ff00', '#0000ff', '#123456', '#abcdef']) expect(v).not.toBe(leaked);
    expect(sparse.syntax.keyword.color).toBe(sparse.editor.fg);
    expect(after.semanticCss).toBe('');
    expect(after.colorScheme).toBe('light');
  });

  it('matches TextMate scopes by specificity and resolves font styles separately', () => {
    const s = resolveSyntax(RICH, '#fafafa');
    expect(s.keyword.color).toBe('#111111');
    expect(s.control).toMatchObject({ color: '#222222', italic: true });
    expect(s.string.color).toBe('#444444');
    expect(s.comment).toMatchObject({ color: '#333333', bold: true, italic: false });
    expect(s.type.color).toBe('#fafafa');
    const ordered = resolveSyntax(imported('file.order', 'dark', { tokenColors: [{ scope: 'storage.modifier', settings: { foreground: '#0000aa' } }, { scope: 'storage.type', settings: { foreground: '#aa0000' } }] }), '#ffffff');
    expect(ordered.storage.color).toBe('#0000aa');
    expect(ordered.type.color).toBe('#aa0000');
    expect(ordered.primitive.color).toBe('#aa0000');
  });

  it('builds semantic rules only when the theme enables semantic highlighting', () => {
    const on = resolveSemantic(RICH);
    expect(on.enabled).toBe(true);
    expect(on.css).toContain('.cm-editor .sem.sem-t-variable.sem-m-readonly,.cm-editor .sem.sem-t-variable.sem-m-readonly *{color:#666666}');
    expect(on.css).toContain('.cm-editor .sem.sem-m-deprecated');
    expect(on.css).toContain('.cm-editor .sem.sem-t-keyword');
    expect(on.css).not.toContain('#777777');
    expect(on.css).not.toContain('body');
    expect(resolveSemantic({ theme: { ...RICH.theme, semanticHighlighting: false } })).toEqual({ enabled: false, css: '' });
  });

  it('keeps built-in code themes readable', () => {
    for (const entry of BUILTIN_THEMES) {
      const r = resolveTheme(entry);
      const min = r.kind.startsWith('hc') ? 7 : 4.5;
      expect(contrast(r.editor.fg, r.editor.bg)).toBeGreaterThanOrEqual(min);
      expect(contrast(r.app.fg, r.app.workspace)).toBeGreaterThanOrEqual(min);
      for (const [cat, style] of Object.entries(r.syntax)) if (cat !== 'punctuation' && cat !== 'comment') expect(contrast(opaque(style.color, r.editor.bg), r.editor.bg), `${entry.id} ${cat}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('match mode colors the app from the code theme', () => {
    const app = resolveTheme(MODSMITH_LIGHT);
    const code = resolveTheme(RICH);
    const matched = themeOutput(app, code, true);
    expect(matched.vars['--statusbar-bg']).toBe('#ff0000');
    expect(matched.vars['--rail']).toBe('#00ff00');
    expect(matched.colorScheme).toBe('dark');
    const separate = themeOutput(app, code, false);
    expect(separate.vars['--workspace']).toBe(app.app.workspace);
    expect(separate.vars['--ed-bg']).toBe('#101820');
  });
});

describe('semantic tokens', () => {
  it('decodes relative LSP tokens into document ranges with modifiers', () => {
    const doc = Text.of(['class Foo {', '  int bar = BAZ;', '}']);
    const legend = { tokenTypes: ['class', 'variable', 'bad type'], tokenModifiers: ['declaration', 'static', 'readonly'] };
    const data = [0, 6, 3, 0, 1, 1, 6, 3, 1, 1, 0, 6, 3, 1, 6, 0, 0, 1, 2, 0, 5, 0, 99, 1, 0];
    expect(decodeSemanticTokens(data, legend, doc)).toEqual([
      { from: 6, to: 9, type: 'class', mods: ['declaration'] },
      { from: 18, to: 21, type: 'variable', mods: ['declaration'] },
      { from: 24, to: 27, type: 'variable', mods: ['static', 'readonly'] }
    ]);
  });
});

describe('theme manager', () => {
  it('previews without saving and restores the saved themes on cancel', async () => {
    const h = harness([RICH]);
    h.m.init();
    await h.m.refresh();
    const saved = h.last();
    h.m.preview({ code: RICH.id });
    expect(h.last().vars['--ed-bg']).toBe('#101820');
    expect(h.storage.data['mwb.theme']).toBe(JSON.stringify({ app: MODSMITH_DARK.id, code: MODSMITH_DARK.id, match: false }));
    h.m.preview({ app: MODSMITH_LIGHT.id, match: true });
    h.m.cancelPreview();
    expect(h.m.state.preview).toBeNull();
    expect(h.last()).toEqual(saved);
  });

  it('persists the selection and applies a cached imported theme before the service answers', async () => {
    const h = harness([RICH]);
    h.m.init();
    await h.m.refresh();
    h.m.commit({ code: RICH.id, app: MODSMITH_HIGH_CONTRAST.id });
    const committed = h.last();
    const again = harness([RICH], fakeStorage(h.storage.data));
    again.m.init();
    expect(again.m.current()).toEqual({ app: MODSMITH_HIGH_CONTRAST.id, code: RICH.id, match: false });
    expect(again.last()).toEqual(committed);
  });

  it('falls back to a built-in of the same kind when the active imported theme is removed', async () => {
    const h = harness([RICH, SPARSE]);
    h.m.init();
    await h.m.refresh();
    h.m.commit({ app: SPARSE.id, code: RICH.id });
    await h.m.remove(RICH.id);
    expect(h.m.current()).toEqual({ app: SPARSE.id, code: MODSMITH_DARK.id, match: false });
    await h.m.remove(SPARSE.id);
    expect(h.m.current()).toEqual({ app: MODSMITH_LIGHT.id, code: MODSMITH_DARK.id, match: false });
    expect(JSON.parse(h.storage.data['mwb.theme'])).toEqual({ app: MODSMITH_LIGHT.id, code: MODSMITH_DARK.id, match: false });
    expect(JSON.parse(h.storage.data['mwb.theme.cache'])).toEqual({});
    await expect(h.m.remove(MODSMITH_DARK.id)).rejects.toThrow('Built-in themes cannot be removed');
    expect(h.last()).toEqual(themeOutput(resolveTheme(MODSMITH_LIGHT), resolveTheme(MODSMITH_DARK), false));
  });

  it('repairs a saved selection whose imported theme disappeared from storage', async () => {
    const storage = fakeStorage({ 'mwb.theme': JSON.stringify({ app: 'gone.theme', code: RICH.id, match: true }), 'mwb.theme.cache': JSON.stringify({ 'gone.theme': { ...SPARSE, id: 'gone.theme' } }) });
    const h = harness([RICH], storage);
    h.m.init();
    await h.m.refresh();
    expect(h.m.current()).toEqual({ app: MODSMITH_LIGHT.id, code: RICH.id, match: true });
  });

  it('keeps working with built-in themes when the theme list cannot be read', async () => {
    const storage = fakeStorage({ 'mwb.theme': '{not json' });
    const m = createThemeManager({ storage, target: { apply: () => undefined }, catalog: { list: async () => Promise.reject(new Error('Not connected')), remove: async () => undefined } });
    m.init();
    await m.refresh();
    expect(m.state.error).toBe('Not connected');
    expect(m.current()).toEqual({ app: MODSMITH_DARK.id, code: MODSMITH_DARK.id, match: false });
  });
});
