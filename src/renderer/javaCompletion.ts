import { LSPPlugin, findReferencesKeymap, formatKeymap, hoverTooltips, jumpToDefinitionKeymap, renameKeymap, serverDiagnostics, signatureHelp } from '@codemirror/lsp-client';
import { autocompletion, insertCompletionText, snippet, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { EditorState, type Extension } from '@codemirror/state';
import { keymap, type EditorView } from '@codemirror/view';

interface LspItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind: 'markdown' | 'plaintext'; value: string };
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: { newText: string; range?: LspRange; insert?: LspRange };
  textEditText?: string;
  additionalTextEdits?: { range: LspRange; newText: string }[];
  commitCharacters?: string[];
  data?: unknown;
}

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

interface LspList {
  isIncomplete?: boolean;
  items: LspItem[];
  itemDefaults?: { commitCharacters?: string[]; editRange?: LspRange | { insert: LspRange }; insertTextFormat?: number };
}

const KIND: Record<number, string> = { 1: 'text', 2: 'method', 3: 'function', 4: 'class', 5: 'property', 6: 'variable', 7: 'class', 8: 'interface', 9: 'namespace', 10: 'property', 11: 'keyword', 12: 'constant', 13: 'constant', 14: 'keyword', 16: 'constant', 20: 'constant', 21: 'constant', 22: 'class', 25: 'type' };

function triggerReason(plugin: LSPPlugin, ch: string): 'triggerCharacter' | 'identifier' | null {
  const triggers = (plugin.client.serverCapabilities as { completionProvider?: { triggerCharacters?: string[] } } | null)?.completionProvider?.triggerCharacters;
  if (triggers?.includes(ch)) return 'triggerCharacter';
  return /[a-zA-Z_]/.test(ch) ? 'identifier' : null;
}

function itemText(item: LspItem) {
  return item.textEdit?.newText || item.textEditText || item.insertText || item.label;
}

function prefixRegexp(items: LspItem[]): RegExp {
  const step = Math.ceil(items.length / 50);
  const prefixes: string[] = [];
  for (let i = 0; i < items.length; i += step) {
    const text = itemText(items[i]);
    if (!/^\w/.test(text)) {
      const prefix = /^[^\w]*/.exec(text)![0];
      if (!prefixes.includes(prefix)) prefixes.push(prefix);
    }
  }
  if (!prefixes.length) return /^\w*$/;
  return new RegExp(`^(?:${prefixes.map((p) => p.replace(/[^\w\s]/g, '\\$&')).join('|')})?\\w*$`);
}

export function shortDetail(label: string, detail: string): string {
  const at = detail.lastIndexOf(label);
  if (at > 0 && at + label.length === detail.length) return detail.slice(0, at).replace(/\.$/, '');
  return detail;
}

function lspToSnippet(text: string) {
  return text.replace(/\\([$}\\])|\$(\d+)/g, (_m, esc: string, field: string) => esc || `\${${field}}`);
}

function position(state: EditorState, p: { line: number; character: number }): number | null {
  if (p.line >= state.doc.lines) return null;
  const line = state.doc.line(p.line + 1);
  return line.from + p.character > line.to ? null : line.from + p.character;
}

function resultRange(cx: CompletionContext, list: LspList) {
  if (!list.items.length) return { from: cx.pos, to: cx.pos };
  const def = list.itemDefaults?.editRange;
  const first = list.items[0].textEdit;
  const range = def ? ('insert' in def ? def.insert : def) : first ? first.range ?? first.insert ?? null : null;
  if (!range) return cx.state.wordAt(cx.pos) ?? { from: cx.pos, to: cx.pos };
  const line = cx.state.doc.lineAt(cx.pos);
  return { from: line.from + range.start.character, to: line.from + range.end.character };
}

function docElement(plugin: LSPPlugin, item: LspItem): HTMLElement | null {
  if (!item.detail && !item.documentation) return null;
  const elt = document.createElement('div');
  elt.className = 'cm-lsp-documentation cm-lsp-completion-documentation';
  if (item.detail) {
    const head = document.createElement('div');
    head.className = 'cm-lsp-completion-detail';
    head.textContent = item.detail;
    elt.appendChild(head);
  }
  if (item.documentation) {
    const body = document.createElement('div');
    body.innerHTML = plugin.docToHTML(item.documentation);
    elt.appendChild(body);
  }
  return elt;
}

const resolved = new WeakMap<LspItem, Promise<LspItem>>();

function resolveItem(plugin: LSPPlugin, item: LspItem): Promise<LspItem> {
  const canResolve = (plugin.client.serverCapabilities as { completionProvider?: { resolveProvider?: boolean } } | null)?.completionProvider?.resolveProvider;
  if (!canResolve || item.documentation) return Promise.resolve(item);
  let pending = resolved.get(item);
  if (!pending) {
    pending = plugin.client.request<LspItem, LspItem>('completionItem/resolve', item).then(
      (r) => ({ ...item, ...r }),
      () => item
    );
    resolved.set(item, pending);
  }
  return pending;
}

function applyWithEdits(edits: { from: number; to: number; text: string }[], text: string) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    view.dispatch(insertCompletionText(view.state, text, from, to), { changes: edits.map((e) => ({ from: e.from, to: e.to, insert: e.text })) });
  };
}

export const javaCompletionSource: CompletionSource = async (context) => {
  const plugin = context.view && LSPPlugin.get(context.view);
  if (!plugin) return null;
  if ((plugin.client.serverCapabilities as { completionProvider?: unknown } | null)?.completionProvider === undefined) return null;
  const ch = context.state.sliceDoc(context.pos - 1, context.pos);
  const reason = context.explicit ? 'invoked' : triggerReason(plugin, ch);
  if (!reason) return null;
  plugin.client.sync();
  const params = { position: plugin.toPosition(context.pos), textDocument: { uri: plugin.uri }, context: reason === 'triggerCharacter' ? { triggerKind: 2, triggerCharacter: ch } : { triggerKind: 1 } };
  context.addEventListener('abort', () => plugin.client.cancelRequest(params));
  let raw: LspList | LspItem[] | null;
  try {
    raw = await plugin.client.request<typeof params, LspList | LspItem[] | null>('textDocument/completion', params);
  } catch (err) {
    if ((err as { code?: number }).code === -32800) return null;
    throw err;
  }
  if (!raw) return null;
  const list: LspList = Array.isArray(raw) ? { items: raw } : raw;
  const { from, to } = resultRange(context, list);
  const defaultCommit = list.itemDefaults?.commitCharacters;
  const result: CompletionResult = {
    from,
    to,
    commitCharacters: defaultCommit,
    validFor: list.isIncomplete ? undefined : prefixRegexp(list.items),
    options: list.items.map((item) => {
      const text = itemText(item);
      const option: Completion = { label: item.filterText || item.label, displayLabel: item.label, type: item.kind ? KIND[item.kind] : undefined };
      if (item.commitCharacters && item.commitCharacters !== defaultCommit) option.commitCharacters = item.commitCharacters;
      if (item.detail) option.detail = shortDetail(item.label, item.detail);
      if (item.sortText) option.sortText = item.sortText;
      const format = item.insertTextFormat ?? list.itemDefaults?.insertTextFormat;
      if (format === 2) option.apply = (view, c, f, t) => snippet(lspToSnippet(text))(view, c, f, t);
      else if (item.additionalTextEdits?.length) {
        const edits = item.additionalTextEdits.flatMap((e) => {
          const f = position(context.state, e.range.start);
          const t = position(context.state, e.range.end);
          return f !== null && t !== null ? [{ from: f, to: t, text: e.newText }] : [];
        });
        option.apply = applyWithEdits(edits, text);
      } else if (option.label !== text) option.apply = text;
      option.info = () => resolveItem(plugin, item).then((full) => docElement(plugin, full));
      return option;
    })
  };
  return result;
};

export function javaLanguageExtensions(): (Extension | ReturnType<typeof serverDiagnostics>)[] {
  return [
    autocompletion(),
    EditorState.languageData.of(() => [{ autocomplete: javaCompletionSource }]),
    hoverTooltips(),
    keymap.of([...formatKeymap, ...renameKeymap, ...jumpToDefinitionKeymap, ...findReferencesKeymap]),
    signatureHelp(),
    serverDiagnostics()
  ];
}

export const resolveCapability = { clientCapabilities: { textDocument: { completion: { completionItem: { resolveSupport: { properties: ['documentation'] } } } } } };
