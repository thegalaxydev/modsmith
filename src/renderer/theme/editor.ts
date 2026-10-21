import { ChangeSet, RangeSetBuilder, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { tagHighlighter, tags as t } from '@lezer/highlight';
import { LSPPlugin, type LSPClientExtension } from '@codemirror/lsp-client';

const v = (name: string) => `var(--ed-${name})`;

export const editorTheme = EditorView.theme({
  '&': { color: v('fg'), backgroundColor: v('bg') },
  '.cm-content': { caretColor: v('cursor') },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: v('cursor') },
  '.cm-selectionLayer .cm-selectionBackground': { backgroundColor: v('selection-inactive') },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection': { backgroundColor: v('selection') },
  '.cm-gutters': { backgroundColor: v('gutter-bg'), color: v('gutter-fg'), border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: v('line-highlight'), color: v('gutter-active-fg') },
  '.cm-activeLine': { backgroundColor: v('line-highlight') },
  '.cm-searchMatch': { backgroundColor: v('find-match-other'), outline: 'none' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: v('find-match') },
  '.cm-selectionMatch': { backgroundColor: v('find-match-other') },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: v('bracket-match'), outline: `1px solid ${v('bracket-border')}` },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'transparent', color: v('error') },
  '.cm-foldPlaceholder': { backgroundColor: v('widget-bg'), border: `1px solid ${v('widget-border')}`, color: v('gutter-fg') },
  '.cm-panels': { backgroundColor: v('widget-bg'), color: v('widget-fg') },
  '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${v('widget-border')}` },
  '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${v('widget-border')}` },
  '.cm-textfield': { backgroundColor: 'var(--input)', color: 'var(--fg)', border: '1px solid var(--line-2)', borderRadius: 'var(--radius-sm)' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--raised)', color: 'var(--fg)', border: '1px solid var(--line-2)', borderRadius: 'var(--radius-sm)' },
  '.cm-panel.cm-search label': { color: v('widget-fg') },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: `underline wavy ${v('error')}`, textUnderlineOffset: '3px' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: `underline wavy ${v('warning')}`, textUnderlineOffset: '3px' },
  '.cm-lintRange-info, .cm-lintRange-hint': { backgroundImage: 'none', textDecoration: `underline dotted ${v('info')}`, textUnderlineOffset: '3px' },
  '.cm-diagnostic-error': { borderLeftColor: v('error') },
  '.cm-diagnostic-warning': { borderLeftColor: v('warning') },
  '.cm-diagnostic-info, .cm-diagnostic-hint': { borderLeftColor: v('info') },
  '.cm-lint-marker-error': { content: 'none', width: '6px', height: '6px', margin: '5px 4px', borderRadius: '50%', backgroundColor: v('error') },
  '.cm-lint-marker-warning': { content: 'none', width: '6px', height: '6px', margin: '5px 4px', borderRadius: '50%', backgroundColor: v('warning') },
  '.cm-lint-marker-info': { content: 'none', width: '6px', height: '6px', margin: '5px 4px', borderRadius: '50%', backgroundColor: v('info') },
  '.cm-link, .cm-link *': { color: v('link') }
});

export const syntaxClasses = tagHighlighter([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: 'syn-comment' },
  { tag: [t.string, t.special(t.string), t.character, t.docString, t.attributeValue], class: 'syn-string' },
  { tag: t.escape, class: 'syn-escape' },
  { tag: t.regexp, class: 'syn-regexp' },
  { tag: [t.number, t.integer, t.float], class: 'syn-number' },
  { tag: [t.bool, t.null, t.atom, t.unit, t.color, t.constant(t.name), t.constant(t.variableName)], class: 'syn-constant' },
  { tag: [t.keyword, t.operatorKeyword], class: 'syn-keyword' },
  { tag: t.controlKeyword, class: 'syn-control' },
  { tag: t.moduleKeyword, class: 'syn-module' },
  { tag: [t.definitionKeyword, t.modifier], class: 'syn-storage' },
  { tag: t.standard(t.typeName), class: 'syn-primitive' },
  { tag: [t.operator, t.arithmeticOperator, t.logicOperator, t.bitwiseOperator, t.compareOperator, t.updateOperator, t.definitionOperator, t.typeOperator, t.controlOperator], class: 'syn-operator' },
  { tag: [t.punctuation, t.separator, t.bracket, t.angleBracket, t.squareBracket, t.paren, t.brace, t.derefOperator], class: 'syn-punctuation' },
  { tag: [t.typeName, t.className, t.namespace], class: 'syn-type' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], class: 'syn-function' },
  { tag: t.definition(t.variableName), class: 'syn-definition' },
  { tag: [t.variableName, t.name], class: 'syn-variable' },
  { tag: [t.propertyName, t.attributeName], class: 'syn-property' },
  { tag: t.self, class: 'syn-self' },
  { tag: t.labelName, class: 'syn-label' },
  { tag: [t.annotation, t.meta, t.processingInstruction], class: 'syn-annotation' },
  { tag: t.heading, class: 'syn-heading' },
  { tag: t.tagName, class: 'syn-tag' },
  { tag: t.invalid, class: 'syn-invalid' },
  { tag: [t.standard(t.variableName), t.special(t.variableName)], class: 'syn-builtin' },
  { tag: [t.link, t.url], class: 'syn-link' },
  { tag: t.strong, class: 'syn-strong' },
  { tag: t.emphasis, class: 'syn-emphasis' },
  { tag: t.strikethrough, class: 'syn-strike' }
]);

export const themedEditor: Extension = [editorTheme, syntaxHighlighting(syntaxClasses)];

export const SEMANTIC_TOKEN_TYPES = [
  'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter', 'variable', 'property', 'enumMember', 'event',
  'function', 'method', 'macro', 'keyword', 'modifier', 'comment', 'string', 'number', 'regexp', 'operator', 'decorator', 'annotation',
  'annotationMember', 'record', 'recordComponent'
];
export const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async', 'modification', 'documentation', 'defaultLibrary',
  'public', 'private', 'protected', 'native', 'generic', 'typeArgument', 'importDeclaration', 'constructor'
];

interface Legend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

const safe = (s: string) => /^[A-Za-z][\w-]*$/.test(s);
const markCache = new Map<string, Decoration>();

function markFor(type: string, mods: string[]) {
  const key = `${type}|${mods.join(' ')}`;
  let m = markCache.get(key);
  if (!m) {
    m = Decoration.mark({ class: ['sem', `sem-t-${type}`, ...mods.map((x) => `sem-m-${x}`)].join(' ') });
    markCache.set(key, m);
  }
  return m;
}

export function decodeSemanticTokens(data: number[], legend: Legend, doc: Text): { from: number; to: number; type: string; mods: string[] }[] {
  const out: { from: number; to: number; type: string; mods: string[] }[] = [];
  let line = 0;
  let char = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const dl = data[i];
    const dc = data[i + 1];
    const len = data[i + 2];
    line += dl;
    char = dl === 0 ? char + dc : dc;
    if (line + 1 > doc.lines) break;
    const type = legend.tokenTypes[data[i + 3]];
    if (!type || !safe(type)) continue;
    const mods: string[] = [];
    let bits = data[i + 4];
    for (let b = 0; bits && b < legend.tokenModifiers.length; b++, bits >>>= 1) {
      if (bits & 1 && safe(legend.tokenModifiers[b])) mods.push(legend.tokenModifiers[b]);
    }
    const l = doc.line(line + 1);
    const from = Math.min(l.to, l.from + char);
    const to = Math.min(l.to, from + len);
    if (to > from) out.push({ from, to, type, mods });
  }
  return out;
}

const semanticPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    timer: ReturnType<typeof setTimeout> | null = null;
    pending: ChangeSet | null = null;
    attempts = 0;
    destroyed = false;

    constructor(readonly view: EditorView) {
      this.schedule(300);
    }

    update(u: ViewUpdate) {
      if (!u.docChanged) return;
      this.decorations = this.decorations.map(u.changes);
      if (this.pending) this.pending = this.pending.compose(u.changes);
      this.schedule(600);
    }

    schedule(ms: number) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.request(), ms);
    }

    async request() {
      this.timer = null;
      const plugin = LSPPlugin.get(this.view);
      const provider = plugin?.client.serverCapabilities?.semanticTokensProvider as { legend?: Legend; full?: unknown } | undefined;
      if (!plugin || !provider) {
        if (this.attempts++ < 60) this.schedule(2000);
        return;
      }
      if (!provider.legend || !provider.full) return;
      plugin.client.sync();
      const doc = plugin.syncedDoc;
      this.pending = ChangeSet.empty(doc.length);
      let result: { data?: number[] } | null = null;
      try {
        result = await plugin.client.request<{ textDocument: { uri: string } }, { data?: number[] } | null>('textDocument/semanticTokens/full', { textDocument: { uri: plugin.uri } });
      } catch {
        result = null;
      }
      if (this.destroyed) return;
      const changes: ChangeSet | null = this.pending;
      this.pending = null;
      if (!result?.data?.length) {
        if (this.attempts++ < 60) this.schedule(3000);
        return;
      }
      if (!changes || changes.length !== doc.length) return;
      const builder = new RangeSetBuilder<Decoration>();
      for (const tok of decodeSemanticTokens(result.data, provider.legend, doc)) builder.add(tok.from, tok.to, markFor(tok.type, tok.mods));
      this.decorations = builder.finish().map(changes);
      this.view.dispatch({});
    }

    destroy() {
      this.destroyed = true;
      if (this.timer) clearTimeout(this.timer);
    }
  },
  { decorations: (p) => p.decorations }
);

export function semanticTokens(): LSPClientExtension {
  return {
    clientCapabilities: {
      textDocument: {
        semanticTokens: {
          dynamicRegistration: false,
          requests: { full: true },
          tokenTypes: SEMANTIC_TOKEN_TYPES,
          tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
          formats: ['relative'],
          overlappingTokenSupport: false,
          multilineTokenSupport: false
        }
      }
    },
    editorExtension: semanticPlugin
  };
}
