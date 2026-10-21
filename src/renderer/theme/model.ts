import { contrast, luminance, mix, normalizeColor, opaque, withAlpha } from './color';

export type ThemeKind = 'dark' | 'light' | 'hc-dark' | 'hc-light';

export interface TokenRule {
  name?: string;
  scope?: string | string[];
  settings?: { foreground?: string; background?: string; fontStyle?: string };
}

export type SemanticValue = string | { foreground?: string; fontStyle?: string; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean };

export interface VsTheme {
  colors?: Record<string, string | null>;
  tokenColors?: TokenRule[];
  semanticTokenColors?: Record<string, SemanticValue>;
  semanticHighlighting?: boolean | null;
}

export interface ThemeSource {
  kind: 'builtin' | 'json' | 'vsix';
  file?: string;
  path?: string;
  extension?: { publisher: string; name: string; displayName: string; version: string } | null;
  attribution?: string;
}

export interface ThemeEntry {
  id: string;
  name: string;
  author: string | null;
  type: ThemeKind | null;
  source: ThemeSource;
  theme: VsTheme;
  warnings: string[];
  installedAt?: string;
}

export const APP_VARS = [
  'workspace', 'chrome', 'rail', 'surface', 'raised', 'input', 'hover', 'line', 'line-2', 'fg', 'fg-dim', 'fg-mute',
  'accent', 'accent-strong', 'accent-hover', 'accent-fg', 'link', 'warn', 'err', 'info', 'ok',
  'statusbar-bg', 'statusbar-fg', 'tab-bar', 'tab-active', 'tab-active-fg', 'tab-fg', 'tab-border',
  'selection', 'selection-fg', 'scrollbar', 'scrollbar-hover', 'shadow', 'focus-border', 'contrast', 'scrim', 'viewport'
] as const;
export type AppVar = (typeof APP_VARS)[number];

export const EDITOR_VARS = [
  'bg', 'fg', 'gutter-bg', 'gutter-fg', 'gutter-active-fg', 'line-highlight', 'selection', 'selection-inactive', 'cursor',
  'find-match', 'find-match-other', 'bracket-match', 'bracket-border', 'widget-bg', 'widget-fg', 'widget-border',
  'suggest-bg', 'suggest-fg', 'suggest-border', 'suggest-selected-bg', 'suggest-selected-fg', 'suggest-highlight',
  'hover-bg', 'hover-border', 'error', 'warning', 'info', 'link', 'accent'
] as const;
export type EditorVar = (typeof EDITOR_VARS)[number];

export interface TokenStyle {
  color: string;
  italic: boolean;
  bold: boolean;
  underline: boolean;
  strike: boolean;
}

export const CATEGORIES: Record<string, string[]> = {
  comment: ['comment.line.double-slash.java', 'comment.block.java', 'comment'],
  string: ['string.quoted.double.java', 'string.quoted', 'string'],
  escape: ['constant.character.escape.java', 'constant.character.escape'],
  regexp: ['string.regexp'],
  number: ['constant.numeric.decimal.java', 'constant.numeric'],
  constant: ['constant.language.java', 'constant.language'],
  keyword: ['keyword.other.java', 'keyword.other', 'keyword'],
  control: ['keyword.control.java', 'keyword.control', 'keyword'],
  module: ['keyword.other.import.java', 'keyword.other.package.java', 'keyword.other.import', 'keyword.other', 'keyword'],
  storage: ['storage.modifier.java', 'storage.modifier', 'storage.type', 'storage'],
  primitive: ['storage.type.primitive.java', 'storage.type.primitive', 'storage.type', 'support.type'],
  operator: ['keyword.operator.java', 'keyword.operator'],
  punctuation: ['punctuation.separator.delimiter.java', 'punctuation.separator', 'punctuation'],
  type: ['entity.name.type.class.java', 'entity.name.type', 'support.class', 'support.type', 'storage.type'],
  function: ['entity.name.function.java', 'entity.name.function', 'support.function'],
  variable: ['variable.other.readwrite.java', 'variable.other', 'variable'],
  definition: ['variable.other.definition.java', 'variable.other', 'variable'],
  property: ['support.type.property-name.json', 'variable.other.property', 'variable.other.object.property', 'support.type.property-name', 'variable'],
  self: ['variable.language.this.java', 'variable.language'],
  label: ['entity.name.label'],
  annotation: ['storage.type.annotation.java', 'meta.annotation', 'storage.type'],
  heading: ['entity.name.section', 'markup.heading'],
  tag: ['entity.name.tag'],
  invalid: ['invalid.illegal', 'invalid'],
  builtin: ['support.function', 'support.variable', 'support.constant'],
  link: ['markup.underline.link']
};
export type Category = keyof typeof CATEGORIES;

export const SEMANTIC_TYPES: Record<string, string[]> = {
  namespace: ['entity.name.namespace'],
  type: ['entity.name.type'],
  class: ['entity.name.type.class'],
  enum: ['entity.name.type.enum'],
  interface: ['entity.name.type.interface'],
  struct: ['entity.name.type.struct'],
  typeParameter: ['entity.name.type.parameter'],
  parameter: ['variable.parameter'],
  variable: ['variable.other.readwrite'],
  property: ['variable.other.property'],
  enumMember: ['variable.other.enummember'],
  event: ['variable.other.event'],
  function: ['entity.name.function'],
  method: ['entity.name.function.member'],
  macro: ['entity.name.function.preprocessor'],
  label: ['entity.name.label'],
  comment: ['comment'],
  string: ['string'],
  keyword: ['keyword.control'],
  number: ['constant.numeric'],
  regexp: ['constant.regexp'],
  operator: ['keyword.operator'],
  decorator: ['entity.name.decorator'],
  annotation: ['storage.type.annotation'],
  annotationMember: ['entity.name.function.member'],
  modifier: ['storage.modifier'],
  record: ['entity.name.type.class'],
  recordComponent: ['variable.other.property']
};

const SEMANTIC_READONLY: Record<string, string[]> = {
  variable: ['variable.other.constant'],
  property: ['variable.other.constant.property'],
  parameter: ['variable.other.constant']
};

export interface ResolvedTheme {
  id: string;
  name: string;
  author: string | null;
  kind: ThemeKind;
  source: ThemeSource;
  app: Record<AppVar, string>;
  editor: Record<EditorVar, string>;
  syntax: Record<string, TokenStyle>;
  semanticCss: string;
  semanticHighlighting: boolean;
  compatibility: string[];
}

interface StatusDefaults {
  accent: string;
  warn: string;
  err: string;
  info: string;
  ok: string;
  shadow: string;
  scrim: string;
  viewport: string;
  findMatch: string;
  findMatchOther: string;
}

export const STATUS_DEFAULTS: Record<ThemeKind, StatusDefaults> = {
  dark: { accent: '#4fb3a0', warn: '#e0b45c', err: '#ec7a72', info: '#7ab0e0', ok: '#69c27a', shadow: '#00000073', scrim: '#0000008c', viewport: '#0a0c0e', findMatch: '#e0b45c59', findMatchOther: '#e0b45c26' },
  light: { accent: '#0f8a75', warn: '#9a6700', err: '#c62d2d', info: '#2266c4', ok: '#1f8a3a', shadow: '#00000029', scrim: '#00000059', viewport: '#0a0c0e', findMatch: '#f0c04d80', findMatchOther: '#f0c04d40' },
  'hc-dark': { accent: '#2fe0c0', warn: '#ffd166', err: '#ff7b72', info: '#7cc4ff', ok: '#7ee787', shadow: '#00000000', scrim: '#000000b3', viewport: '#000000', findMatch: '#f38518', findMatchOther: '#f3851866' },
  'hc-light': { accent: '#006b5c', warn: '#7a4d00', err: '#b5200d', info: '#0f4a85', ok: '#196c2e', shadow: '#00000000', scrim: '#00000066', viewport: '#000000', findMatch: '#0f4a85', findMatchOther: '#0f4a8540' }
};

export const isDark = (k: ThemeKind) => k === 'dark' || k === 'hc-dark';
export const isHighContrast = (k: ThemeKind) => k === 'hc-dark' || k === 'hc-light';

export function kindOf(entry: Pick<ThemeEntry, 'type' | 'theme'>): ThemeKind {
  if (entry.type) return entry.type;
  const bg = normalizeColor(entry.theme.colors?.['editor.background'] ?? null);
  return bg && luminance(bg) > 0.4 ? 'light' : 'dark';
}

function picker(colors: Record<string, string | null> | undefined) {
  return (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = normalizeColor(colors?.[k] ?? null);
      if (v) return v;
    }
    return null;
  };
}

function globalRule(rules: TokenRule[]) {
  let fg: string | null = null;
  let bg: string | null = null;
  for (const r of rules) {
    const scope = r.scope;
    const empty = scope === undefined || scope === '' || (Array.isArray(scope) && scope.length === 0);
    if (!empty) continue;
    fg = normalizeColor(r.settings?.foreground) ?? fg;
    bg = normalizeColor(r.settings?.background) ?? bg;
  }
  return { fg, bg };
}

export function resolveApp(entry: Pick<ThemeEntry, 'type' | 'theme'>): Record<AppVar, string> {
  const kind = kindOf(entry);
  const d = STATUS_DEFAULTS[kind];
  const pick = picker(entry.theme.colors);
  const g = globalRule(entry.theme.tokenColors ?? []);
  const W = pick('editor.background') ?? g.bg ?? (isDark(kind) ? '#111316' : '#f6f7f8');
  const F = pick('foreground', 'editor.foreground') ?? g.fg ?? (isDark(kind) ? '#e3e7eb' : '#1d2329');
  const dark = luminance(opaque(W, '#000000')) < 0.4;
  const chrome = pick('sideBar.background', 'editorGroupHeader.tabsBackground', 'titleBar.activeBackground') ?? mix(W, F, 0.035);
  const accent = pick('focusBorder', 'textLink.foreground', 'button.background', 'activityBarBadge.background') ?? d.accent;
  const accentStrong = pick('button.background') ?? mix(accent, W, 0.25);
  const fgDim = pick('sideBar.foreground', 'tab.inactiveForeground') ?? mix(F, W, 0.22);
  const out: Record<AppVar, string> = {
    workspace: W,
    chrome,
    rail: pick('activityBar.background') ?? chrome,
    surface: pick('editorWidget.background', 'menu.background', 'dropdown.background', 'quickInput.background') ?? mix(W, F, 0.06),
    raised: pick('button.secondaryBackground', 'list.inactiveSelectionBackground') ?? mix(W, F, 0.1),
    input: pick('input.background') ?? (dark ? mix(W, '#000000', 0.25) : mix(W, '#ffffff', 0.6)),
    hover: pick('list.hoverBackground') ?? mix(W, F, 0.07),
    line: pick('panel.border', 'sideBar.border', 'editorGroup.border', 'contrastBorder') ?? mix(W, F, 0.12),
    'line-2': pick('input.border', 'dropdown.border', 'contrastBorder') ?? mix(W, F, 0.2),
    fg: F,
    'fg-dim': fgDim,
    'fg-mute': pick('descriptionForeground', 'disabledForeground') ?? mix(F, W, 0.42),
    accent,
    'accent-strong': accentStrong,
    'accent-hover': pick('button.hoverBackground') ?? mix(accentStrong, F, 0.12),
    'accent-fg': pick('button.foreground') ?? (luminance(opaque(accentStrong, W)) > 0.45 ? '#000000' : '#ffffff'),
    link: pick('textLink.foreground') ?? accent,
    warn: pick('editorWarning.foreground', 'notificationsWarningIcon.foreground') ?? d.warn,
    err: pick('errorForeground', 'editorError.foreground') ?? d.err,
    info: pick('editorInfo.foreground', 'notificationsInfoIcon.foreground') ?? d.info,
    ok: pick('testing.iconPassed', 'terminal.ansiGreen', 'gitDecoration.addedResourceForeground') ?? d.ok,
    'statusbar-bg': pick('statusBar.background') ?? chrome,
    'statusbar-fg': pick('statusBar.foreground') ?? fgDim,
    'tab-bar': pick('editorGroupHeader.tabsBackground') ?? chrome,
    'tab-active': pick('tab.activeBackground') ?? W,
    'tab-active-fg': pick('tab.activeForeground') ?? F,
    'tab-fg': pick('tab.inactiveForeground') ?? fgDim,
    'tab-border': pick('tab.activeBorderTop', 'tab.activeBorder', 'focusBorder') ?? accent,
    selection: pick('list.activeSelectionBackground') ?? withAlpha(accent, 0.18),
    'selection-fg': pick('list.activeSelectionForeground') ?? F,
    scrollbar: pick('scrollbarSlider.background') ?? withAlpha(F, 0.18),
    'scrollbar-hover': pick('scrollbarSlider.hoverBackground') ?? withAlpha(F, 0.3),
    shadow: pick('widget.shadow') ?? d.shadow,
    'focus-border': pick('focusBorder') ?? accent,
    contrast: pick('contrastBorder') ?? '#00000000',
    scrim: d.scrim,
    viewport: d.viewport
  };
  return out;
}

export function resolveEditor(entry: Pick<ThemeEntry, 'type' | 'theme'>): Record<EditorVar, string> {
  const kind = kindOf(entry);
  const d = STATUS_DEFAULTS[kind];
  const pick = picker(entry.theme.colors);
  const g = globalRule(entry.theme.tokenColors ?? []);
  const bg = pick('editor.background') ?? g.bg ?? (isDark(kind) ? '#111316' : '#ffffff');
  const fg = pick('editor.foreground', 'foreground') ?? g.fg ?? (isDark(kind) ? '#d6dde4' : '#1d2329');
  const accent = pick('focusBorder', 'editorCursor.foreground', 'textLink.foreground', 'button.background') ?? d.accent;
  const widgetBg = pick('editorWidget.background', 'editorSuggestWidget.background', 'editorHoverWidget.background') ?? mix(bg, fg, 0.06);
  const widgetBorder = pick('editorWidget.border', 'editorSuggestWidget.border', 'editorHoverWidget.border', 'contrastBorder') ?? mix(bg, fg, 0.18);
  const selection = pick('editor.selectionBackground') ?? withAlpha(accent, 0.3);
  return {
    bg,
    fg,
    'gutter-bg': pick('editorGutter.background') ?? bg,
    'gutter-fg': pick('editorLineNumber.foreground') ?? mix(fg, bg, 0.55),
    'gutter-active-fg': pick('editorLineNumber.activeForeground') ?? fg,
    'line-highlight': pick('editor.lineHighlightBackground') ?? withAlpha(fg, 0.05),
    selection,
    'selection-inactive': pick('editor.inactiveSelectionBackground') ?? withAlpha(selection, 0.55),
    cursor: pick('editorCursor.foreground') ?? fg,
    'find-match': pick('editor.findMatchBackground') ?? d.findMatch,
    'find-match-other': pick('editor.findMatchHighlightBackground') ?? d.findMatchOther,
    'bracket-match': pick('editorBracketMatch.background') ?? withAlpha(fg, 0.12),
    'bracket-border': pick('editorBracketMatch.border') ?? '#00000000',
    'widget-bg': widgetBg,
    'widget-fg': pick('editorWidget.foreground') ?? fg,
    'widget-border': widgetBorder,
    'suggest-bg': pick('editorSuggestWidget.background') ?? widgetBg,
    'suggest-fg': pick('editorSuggestWidget.foreground', 'editorWidget.foreground') ?? fg,
    'suggest-border': pick('editorSuggestWidget.border') ?? widgetBorder,
    'suggest-selected-bg': pick('editorSuggestWidget.selectedBackground', 'list.activeSelectionBackground') ?? withAlpha(accent, 0.25),
    'suggest-selected-fg': pick('editorSuggestWidget.selectedForeground', 'list.activeSelectionForeground') ?? fg,
    'suggest-highlight': pick('editorSuggestWidget.highlightForeground', 'list.highlightForeground') ?? accent,
    'hover-bg': pick('editorHoverWidget.background') ?? widgetBg,
    'hover-border': pick('editorHoverWidget.border') ?? widgetBorder,
    error: pick('editorError.foreground', 'errorForeground') ?? d.err,
    warning: pick('editorWarning.foreground') ?? d.warn,
    info: pick('editorInfo.foreground') ?? d.info,
    link: pick('editorLink.activeForeground', 'textLink.foreground') ?? accent,
    accent
  };
}

interface Compiled {
  selector: string;
  target: string;
  parents: string[];
  exclusion: boolean;
  index: number;
  fg: string | null;
  fontStyle: string | null;
}

function compile(rules: TokenRule[]): Compiled[] {
  const out: Compiled[] = [];
  rules.forEach((r, index) => {
    const scopes = typeof r.scope === 'string' ? r.scope.split(',') : Array.isArray(r.scope) ? r.scope : [];
    const fg = normalizeColor(r.settings?.foreground);
    const fontStyle = typeof r.settings?.fontStyle === 'string' ? r.settings.fontStyle : null;
    if (!fg && fontStyle === null) return;
    for (const raw of scopes) {
      const sel = String(raw).trim();
      if (!sel) continue;
      const exclusion = /\s-\s|^-/.test(sel);
      const base = sel.split(/\s-\s/)[0].trim();
      const parts = base.split(/\s+/).filter((p) => p !== '>');
      out.push({ selector: sel, target: parts[parts.length - 1], parents: parts.slice(0, -1), exclusion, index, fg, fontStyle });
    }
  });
  return out;
}

function scoreFor(rule: Compiled, scope: string): number {
  if (!(scope === rule.target || scope.startsWith(`${rule.target}.`))) return 0;
  if (rule.parents.some((p) => !/^(source|text)(\.|$)/.test(p))) return 0;
  return rule.target.split('.').length * 100 + rule.parents.length;
}

function best(rules: Compiled[], scopes: string[], prop: 'fg' | 'fontStyle') {
  for (const scope of scopes) {
    let found: Compiled | null = null;
    let score = 0;
    for (const r of rules) {
      if (r[prop] === null) continue;
      const s = scoreFor(r, scope);
      if (s > score || (s === score && s > 0 && found && r.index > found.index)) {
        found = r;
        score = s;
      }
    }
    if (found) return found;
  }
  return null;
}

function styleFrom(fontStyle: string | null) {
  const f = (fontStyle ?? '').toLowerCase();
  return { italic: /\bitalic\b/.test(f), bold: /\bbold\b/.test(f), underline: /\bunderline\b/.test(f), strike: /\bstrikethrough\b/.test(f) };
}

export function resolveSyntax(entry: Pick<ThemeEntry, 'type' | 'theme'>, editorFg: string): Record<string, TokenStyle> {
  const rules = compile(entry.theme.tokenColors ?? []);
  const out: Record<string, TokenStyle> = {};
  for (const [cat, scopes] of Object.entries(CATEGORIES)) {
    const fg = best(rules, scopes, 'fg');
    const fs = best(rules, scopes, 'fontStyle');
    out[cat] = { color: fg?.fg ?? editorFg, ...styleFrom(fs?.fontStyle ?? null) };
  }
  return out;
}

export function tokenCss(style: TokenStyle): string {
  return `color:${style.color};font-style:${style.italic ? 'italic' : 'normal'};font-weight:${style.bold ? '700' : 'inherit'};text-decoration:${[style.underline && 'underline', style.strike && 'line-through'].filter(Boolean).join(' ') || 'none'}`;
}

function semanticSelector(key: string): string | null {
  const [body, lang] = key.split(':');
  if (lang && lang !== 'java') return null;
  const [type, ...mods] = body.split('.');
  if (!type) return null;
  const safe = (s: string) => /^[A-Za-z][\w-]*$/.test(s);
  if ((type !== '*' && !safe(type)) || mods.some((m) => !safe(m))) return null;
  return `.cm-editor .sem${type === '*' ? '' : `.sem-t-${type}`}${mods.map((m) => `.sem-m-${m}`).join('')}`;
}

function semanticStyle(v: SemanticValue): string | null {
  if (typeof v === 'string') {
    const c = normalizeColor(v);
    return c ? `color:${c}` : null;
  }
  if (!v || typeof v !== 'object') return null;
  const parts: string[] = [];
  const c = normalizeColor(v.foreground);
  if (c) parts.push(`color:${c}`);
  const fs = typeof v.fontStyle === 'string' ? styleFrom(v.fontStyle) : null;
  const italic = v.italic ?? fs?.italic;
  const bold = v.bold ?? fs?.bold;
  const underline = v.underline ?? fs?.underline;
  const strike = v.strikethrough ?? fs?.strike;
  if (italic !== undefined) parts.push(`font-style:${italic ? 'italic' : 'normal'}`);
  if (bold !== undefined) parts.push(`font-weight:${bold ? '700' : 'inherit'}`);
  if (underline !== undefined || strike !== undefined) parts.push(`text-decoration:${[underline && 'underline', strike && 'line-through'].filter(Boolean).join(' ') || 'none'}`);
  return parts.length ? parts.join(';') : null;
}

const both = (sel: string) => `${sel},${sel} *`;

export function resolveSemantic(entry: Pick<ThemeEntry, 'theme'>): { enabled: boolean; css: string } {
  const enabled = entry.theme.semanticHighlighting === true;
  if (!enabled) return { enabled, css: '' };
  const rules = compile(entry.theme.tokenColors ?? []);
  const lines: string[] = [];
  for (const [type, scopes] of Object.entries(SEMANTIC_TYPES)) {
    const fg = best(rules, scopes, 'fg');
    const fs = best(rules, scopes, 'fontStyle');
    if (fg || fs) lines.push(`${both(`.cm-editor .sem.sem-t-${type}`)}{${[fg && `color:${fg.fg}`, fs && tokenCss({ color: fg?.fg ?? 'inherit', ...styleFrom(fs.fontStyle) }).split(';').slice(1).join(';')].filter(Boolean).join(';')}}`);
  }
  for (const [type, scopes] of Object.entries(SEMANTIC_READONLY)) {
    const fg = best(rules, scopes, 'fg');
    if (fg) lines.push(`${both(`.cm-editor .sem.sem-t-${type}.sem-m-readonly`)}{color:${fg.fg}}`);
  }
  for (const [key, value] of Object.entries(entry.theme.semanticTokenColors ?? {})) {
    const sel = semanticSelector(key);
    const style = semanticStyle(value);
    if (sel && style) lines.push(`${both(sel)}{${style}}`);
  }
  return { enabled, css: lines.join('\n') };
}

const MAPPED_COLORS = new Set([
  'editor.background', 'editor.foreground', 'foreground', 'sideBar.background', 'editorGroupHeader.tabsBackground', 'titleBar.activeBackground', 'activityBar.background',
  'editorWidget.background', 'menu.background', 'dropdown.background', 'quickInput.background', 'button.secondaryBackground', 'list.inactiveSelectionBackground', 'input.background',
  'list.hoverBackground', 'panel.border', 'sideBar.border', 'editorGroup.border', 'contrastBorder', 'input.border', 'dropdown.border', 'sideBar.foreground', 'tab.inactiveForeground',
  'descriptionForeground', 'disabledForeground', 'focusBorder', 'textLink.foreground', 'button.background', 'activityBarBadge.background', 'button.hoverBackground', 'button.foreground',
  'editorWarning.foreground', 'notificationsWarningIcon.foreground', 'errorForeground', 'editorError.foreground', 'editorInfo.foreground', 'notificationsInfoIcon.foreground',
  'testing.iconPassed', 'terminal.ansiGreen', 'gitDecoration.addedResourceForeground', 'statusBar.background', 'statusBar.foreground', 'tab.activeBackground', 'tab.activeForeground',
  'tab.activeBorderTop', 'tab.activeBorder', 'list.activeSelectionBackground', 'list.activeSelectionForeground', 'scrollbarSlider.background', 'scrollbarSlider.hoverBackground',
  'widget.shadow', 'editorGutter.background', 'editorLineNumber.foreground', 'editorLineNumber.activeForeground', 'editor.lineHighlightBackground', 'editor.selectionBackground',
  'editor.inactiveSelectionBackground', 'editorCursor.foreground', 'editor.findMatchBackground', 'editor.findMatchHighlightBackground', 'editorBracketMatch.background',
  'editorBracketMatch.border', 'editorWidget.foreground', 'editorWidget.border', 'editorSuggestWidget.background', 'editorSuggestWidget.border', 'editorHoverWidget.background',
  'editorHoverWidget.border', 'editorSuggestWidget.foreground', 'editorSuggestWidget.selectedBackground', 'editorSuggestWidget.selectedForeground', 'editorSuggestWidget.highlightForeground',
  'list.highlightForeground', 'editorLink.activeForeground'
]);

export function compatibility(entry: ThemeEntry): string[] {
  const notes: string[] = [];
  if (entry.source.kind !== 'builtin') {
    notes.push("Syntax colors come from the theme's TextMate rules, matched to Modsmith's highlighting categories. Grammar-specific scopes are approximated, so some tokens can differ from VS Code.");
    const unused = Object.keys(entry.theme.colors ?? {}).filter((k) => !MAPPED_COLORS.has(k)).length;
    if (unused) notes.push(`${unused} workbench color${unused === 1 ? ' has' : 's have'} no Modsmith equivalent and ${unused === 1 ? 'is' : 'are'} not used.`);
    const rules = compile(entry.theme.tokenColors ?? []);
    if (rules.some((r) => r.exclusion || r.parents.some((p) => !/^(source|text)(\.|$)/.test(p)))) notes.push('Rules that depend on parent scopes or exclusions are skipped.');
  }
  if (entry.theme.semanticHighlighting === true) notes.push('Semantic colors apply to Java files while the Java language server runs.');
  else if (Object.keys(entry.theme.semanticTokenColors ?? {}).length) notes.push('This theme turns semantic highlighting off, so its semantic token colors are not used.');
  notes.push(...entry.warnings);
  return notes;
}

export function resolveTheme(entry: ThemeEntry): ResolvedTheme {
  const kind = kindOf(entry);
  const editor = resolveEditor(entry);
  const semantic = resolveSemantic(entry);
  return {
    id: entry.id,
    name: entry.name,
    author: entry.author,
    kind,
    source: entry.source,
    app: resolveApp(entry),
    editor,
    syntax: resolveSyntax(entry, editor.fg),
    semanticCss: semantic.css,
    semanticHighlighting: semantic.enabled,
    compatibility: compatibility(entry)
  };
}

export function syntaxCss(syntax: Record<string, TokenStyle>): string {
  return Object.entries(syntax)
    .map(([cat, s]) => `.cm-editor .syn-${cat}{${tokenCss(s)}}`)
    .join('\n');
}

export interface ThemeOutput {
  vars: Record<string, string>;
  colorScheme: 'dark' | 'light';
  syntaxCss: string;
  semanticCss: string;
  semantic: boolean;
}

export function themeOutput(app: ResolvedTheme, code: ResolvedTheme, match: boolean): ThemeOutput {
  const appTheme = match ? code : app;
  const vars: Record<string, string> = {};
  for (const k of APP_VARS) vars[`--${k}`] = appTheme.app[k];
  if (match) {
    for (const k of ['accent', 'accent-strong', 'accent-hover', 'accent-fg'] as const) vars[`--${k}`] = code.app[k];
  }
  for (const k of EDITOR_VARS) vars[`--ed-${k}`] = code.editor[k];
  return { vars, colorScheme: isDark(appTheme.kind) ? 'dark' : 'light', syntaxCss: syntaxCss(code.syntax), semanticCss: code.semanticCss, semantic: code.semanticHighlighting };
}

export function readable(fg: string, bg: string) {
  return contrast(opaque(fg, bg), opaque(bg, '#000000')) >= 3;
}
