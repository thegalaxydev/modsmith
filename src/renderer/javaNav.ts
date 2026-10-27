import { EditorState, Prec, StateEffect, StateField, Text, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, keymap, showPanel, showTooltip, type DecorationSet, type Panel, type Tooltip } from '@codemirror/view';
import { LSPPlugin, Workspace, jumpToDefinition, type LSPClient, type LSPClientExtension, type WorkspaceFile } from '@codemirror/lsp-client';
import { highlightCode } from '@lezer/highlight';
import { javaLanguage } from '@codemirror/lang-java';
import { store } from './store';
import { syntaxClasses } from './theme/editor';
import { parseJdtUri, projectRelative, fileUriToPath, sourceTabTitle } from './sourceUri';

interface LspPosition {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
interface LspLocation {
  uri: string;
  range: LspRange;
}
interface LocationLink {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange?: LspRange;
}

interface OpenFile extends WorkspaceFile {
  doc: Text;
  view: EditorView;
}

export interface NavContext {
  workspace: string;
  rootUri: string;
}

const views = new Map<string, EditorView>();
const viewWaiters = new Map<string, ((v: EditorView) => void)[]>();
const sourceCache = new Map<string, Promise<string>>();

export function registerEditorView(tab: string, view: EditorView) {
  views.set(tab, view);
  for (const w of viewWaiters.get(tab) ?? []) w(view);
  viewWaiters.delete(tab);
}

export function unregisterEditorView(tab: string, view: EditorView) {
  if (views.get(tab) === view) views.delete(tab);
}

function waitForView(tab: string, ms = 10000): Promise<EditorView | null> {
  const existing = views.get(tab);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      viewWaiters.set(
        tab,
        (viewWaiters.get(tab) ?? []).filter((w) => w !== done)
      );
      resolve(null);
    }, ms);
    const done = (v: EditorView) => {
      clearTimeout(timer);
      resolve(v);
    };
    viewWaiters.set(tab, [...(viewWaiters.get(tab) ?? []), done]);
  });
}

export function selectedText(tab: string): string {
  const view = views.get(tab);
  if (!view) return '';
  const r = view.state.selection.main;
  return r.empty ? '' : view.state.sliceDoc(r.from, r.to);
}

export async function revealMatch(file: string, line: number, column: number, length: number) {
  const tab = `file:${file}`;
  store.openTab(tab);
  const view = await waitForView(tab);
  if (!view) return;
  const l = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines));
  const from = Math.min(l.from + column, l.to);
  view.dispatch({ selection: { anchor: from, head: Math.min(from + length, l.to) }, scrollIntoView: true });
  view.focus();
}

export async function revealLine(file: string, line: number) {
  const tab = `file:${file}`;
  store.openTab(tab);
  const view = await waitForView(tab);
  if (!view) return;
  const l = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines));
  view.dispatch({ selection: { anchor: l.from }, scrollIntoView: true });
  view.focus();
}

export function sourceTabId(uri: string) {
  return `src:${uri}`;
}

export function tabForUri(ctx: NavContext, uri: string): string | null {
  if (uri.startsWith('jdt://')) return parseJdtUri(uri) ? sourceTabId(uri) : null;
  const rel = projectRelative(uri, ctx.rootUri);
  return rel ? `file:${rel}` : null;
}

export function lspToOffset(doc: Text, pos: LspPosition) {
  const line = doc.line(Math.min(Math.max(pos.line + 1, 1), doc.lines));
  return Math.min(line.to, line.from + Math.max(0, pos.character));
}

export function loadSource(client: LSPClient, ctx: NavContext, uri: string): Promise<string> {
  const tab = tabForUri(ctx, uri);
  const open = tab ? views.get(tab) : null;
  if (open) return Promise.resolve(open.state.doc.toString());
  let p = sourceCache.get(uri);
  if (p) return p;
  if (uri.startsWith('jdt://')) {
    p = client.request<{ uri: string }, string | null>('java/classFileContents', { uri }).then((text) => {
      if (typeof text !== 'string' || !text) throw new Error(`No source is available for ${sourceTabTitle(uri)}`);
      return text;
    });
  } else {
    const rel = projectRelative(uri, ctx.rootUri);
    if (!rel) return Promise.reject(new Error(`${fileUriToPath(uri) ?? uri} is outside the project`));
    p = store.call<{ content: string; binary: boolean }>('workspace.read_file', { path: ctx.workspace, file: rel }, { quiet: true }).then((r) => {
      if (r.binary) throw new Error(`${rel} is not a text file`);
      return r.content;
    });
    const expire = () => setTimeout(() => sourceCache.delete(uri), 2000);
    p.then(expire, expire);
  }
  sourceCache.set(uri, p);
  p.catch(() => sourceCache.delete(uri));
  return p;
}

export function forgetSources() {
  sourceCache.clear();
}

export async function openLocation(ctx: NavContext, uri: string, range?: LspRange): Promise<EditorView | null> {
  const tab = tabForUri(ctx, uri);
  if (!tab) {
    store.toast('info', `${fileUriToPath(uri) ?? sourceTabTitle(uri)} is outside the project and cannot be opened`);
    return null;
  }
  store.openTab(tab);
  const view = await waitForView(tab);
  if (view && range) {
    const pos = lspToOffset(view.state.doc, range.start);
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true, userEvent: 'select.definition' });
    view.focus();
  }
  return view;
}

export class ModsmithWorkspace extends Workspace {
  files: OpenFile[] = [];
  private versions: Record<string, number> = {};

  constructor(
    client: LSPClient,
    readonly ctx: NavContext
  ) {
    super(client);
  }

  private nextVersion(uri: string) {
    return (this.versions[uri] = (this.versions[uri] ?? -1) + 1);
  }

  syncFiles() {
    const result = [];
    for (const file of this.files) {
      const plugin = LSPPlugin.get(file.view);
      if (!plugin) continue;
      const changes = plugin.unsyncedChanges;
      if (!changes.empty) {
        result.push({ changes, file, prevDoc: file.doc });
        file.doc = file.view.state.doc;
        file.version = this.nextVersion(file.uri);
        plugin.clear();
      }
    }
    return result;
  }

  openFile(uri: string, languageId: string, view: EditorView) {
    const existing = this.getFile(uri);
    if (existing) {
      this.files = this.files.filter((f) => f !== existing);
      this.client.didClose(uri);
    }
    const file: OpenFile = { uri, languageId, version: this.nextVersion(uri), doc: view.state.doc, view, getView: () => view };
    this.files.push(file);
    this.client.didOpen(file);
  }

  closeFile(uri: string, view: EditorView) {
    const file = this.getFile(uri) as OpenFile | null;
    if (!file || (view && file.view !== view)) return;
    this.files = this.files.filter((f) => f !== file);
    this.client.didClose(uri);
  }

  override displayFile(uri: string): Promise<EditorView | null> {
    return openLocation(this.ctx, uri);
  }
}

export function navContext(client: LSPClient): NavContext | null {
  const w = client.workspace;
  return w instanceof ModsmithWorkspace ? w.ctx : null;
}

async function definitionsAt(view: EditorView, pos: number): Promise<LspLocation[]> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return [];
  plugin.client.sync();
  const r = await plugin.client.request<unknown, LspLocation | LspLocation[] | LocationLink[] | null>('textDocument/definition', {
    textDocument: { uri: plugin.uri },
    position: plugin.toPosition(pos)
  });
  const list = !r ? [] : Array.isArray(r) ? r : [r];
  return list.map((l) => ('targetUri' in l ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : l));
}

function linkRange(view: EditorView, x: number, y: number) {
  const pos = view.posAtCoords({ x, y }, false);
  if (pos == null) return null;
  const word = view.state.wordAt(pos);
  if (!word) return null;
  const coords = view.coordsAtPos(word.from);
  const end = view.coordsAtPos(word.to);
  if (!coords || !end || y < coords.top || y > coords.bottom || x < coords.left || x > end.right) return null;
  return word;
}

const setPeek = StateEffect.define<Tooltip | null>();
const peekField = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPeek)) return e.value;
    return tr.docChanged ? null : value;
  },
  provide: (f) => showTooltip.from(f)
});

function peekDom(text: string, title: string) {
  const dom = document.createElement('div');
  dom.className = 'cm-def-peek';
  const head = dom.appendChild(document.createElement('div'));
  head.className = 'cm-def-peek-title';
  head.textContent = title;
  const pre = dom.appendChild(document.createElement('pre'));
  const tree = javaLanguage.parser.parse(text);
  highlightCode(
    text,
    tree,
    syntaxClasses,
    (code, cls) => {
      if (!cls) pre.appendChild(document.createTextNode(code));
      else {
        const span = pre.appendChild(document.createElement('span'));
        span.className = cls;
        span.textContent = code;
      }
    },
    () => pre.appendChild(document.createTextNode('\n'))
  );
  return dom;
}

function excerpt(source: string, line: number) {
  const lines = source.split(/\r?\n/);
  let start = line;
  while (start > 0 && line - start < 6 && /^\s*(@|\/\/|\*|\/\*\*?)/.test(lines[start - 1] ?? '')) start--;
  const out = lines.slice(start, Math.min(lines.length, line + 12));
  const indent = Math.min(...out.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
  return out.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n').replace(/\s+$/, '');
}

const navPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    mod = false;
    pointer: { x: number; y: number } | null = null;
    hovered: { from: number; to: number } | null = null;
    timer: ReturnType<typeof setTimeout> | null = null;
    seq = 0;
    onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod !== this.mod) {
        this.mod = mod;
        this.refresh();
      }
    };
    onBlur = () => {
      this.mod = false;
      this.refresh();
    };

    constructor(readonly view: EditorView) {
      window.addEventListener('keydown', this.onKey, true);
      window.addEventListener('keyup', this.onKey, true);
      window.addEventListener('blur', this.onBlur);
    }

    refresh() {
      const word = this.mod && this.pointer && LSPPlugin.get(this.view) ? linkRange(this.view, this.pointer.x, this.pointer.y) : null;
      const same = word && this.hovered && word.from === this.hovered.from && word.to === this.hovered.to;
      if (same) return;
      this.hovered = word ? { from: word.from, to: word.to } : null;
      this.decorations = word ? Decoration.set([Decoration.mark({ class: 'cm-def-link' }).range(word.from, word.to)]) : Decoration.none;
      if (this.timer) clearTimeout(this.timer);
      this.seq++;
      const effects = this.view.state.field(peekField, false) ? [setPeek.of(null)] : [];
      this.view.dispatch({ effects });
      if (word) this.timer = setTimeout(() => void this.peek(word.from, this.seq), 450);
    }

    async peek(pos: number, seq: number) {
      const plugin = LSPPlugin.get(this.view);
      const ctx = plugin && navContext(plugin.client);
      if (!plugin || !ctx) return;
      try {
        const [loc] = await definitionsAt(this.view, pos);
        if (!loc || seq !== this.seq) return;
        const source = await loadSource(plugin.client, ctx, loc.uri);
        if (seq !== this.seq) return;
        const jdt = parseJdtUri(loc.uri);
        const title = jdt ? `${jdt.qualifiedName} · ${jdt.container}` : (projectRelative(loc.uri, ctx.rootUri) ?? sourceTabTitle(loc.uri));
        const text = excerpt(source, loc.range.start.line);
        this.view.dispatch({ effects: setPeek.of({ pos, above: true, create: () => ({ dom: peekDom(text, title) }) }) });
      } catch {
        return;
      }
    }

    destroy() {
      window.removeEventListener('keydown', this.onKey, true);
      window.removeEventListener('keyup', this.onKey, true);
      window.removeEventListener('blur', this.onBlur);
      if (this.timer) clearTimeout(this.timer);
    }
  },
  {
    decorations: (p) => p.decorations,
    eventHandlers: {
      mousemove(e) {
        this.pointer = { x: e.clientX, y: e.clientY };
        const mod = e.ctrlKey || e.metaKey;
        if (mod || this.mod) {
          this.mod = mod;
          this.refresh();
        }
      },
      mouseleave() {
        this.pointer = null;
        this.refresh();
      },
      mousedown(e, view) {
        if (e.button !== 0 || !(e.ctrlKey || e.metaKey) || !LSPPlugin.get(view)) return false;
        const word = linkRange(view, e.clientX, e.clientY);
        if (!word) return false;
        e.preventDefault();
        view.dispatch({ selection: { anchor: word.from }, effects: setPeek.of(null) });
        jumpToDefinition(view);
        return true;
      }
    }
  }
);

interface RefEntry {
  uri: string;
  range: LspRange;
  label: string;
  line: number;
  text: string;
}

const setRefs = StateEffect.define<{ title: string; entries: RefEntry[] } | null>();
const refsField = StateField.define<{ title: string; entries: RefEntry[] } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setRefs)) return e.value;
    return value;
  },
  provide: (f) => showPanel.from(f, (v) => (v ? (view) => referencePanel(view, v) : null))
});

function referencePanel(view: EditorView, data: { title: string; entries: RefEntry[] }): Panel {
  const dom = document.createElement('div');
  dom.className = 'cm-refs';
  dom.tabIndex = 0;
  const head = dom.appendChild(document.createElement('div'));
  head.className = 'cm-refs-head';
  const title = head.appendChild(document.createElement('span'));
  title.textContent = data.title;
  const close = head.appendChild(document.createElement('button'));
  close.type = 'button';
  close.className = 'cm-refs-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close references');
  close.onclick = () => view.dispatch({ effects: setRefs.of(null) });
  const list = dom.appendChild(document.createElement('div'));
  list.className = 'cm-refs-list';
  list.setAttribute('role', 'listbox');
  let group = '';
  const items: HTMLElement[] = [];
  data.entries.forEach((entry) => {
    if (entry.label !== group) {
      group = entry.label;
      const g = list.appendChild(document.createElement('div'));
      g.className = 'cm-refs-file';
      g.textContent = group;
    }
    const item = list.appendChild(document.createElement('div'));
    item.className = 'cm-refs-item';
    item.setAttribute('role', 'option');
    const ln = item.appendChild(document.createElement('span'));
    ln.className = 'cm-refs-line';
    ln.textContent = String(entry.line + 1);
    item.appendChild(document.createTextNode(entry.text));
    item.onclick = () => {
      items.forEach((i) => i.removeAttribute('aria-selected'));
      item.setAttribute('aria-selected', 'true');
      const plugin = LSPPlugin.get(view);
      const ctx = plugin && navContext(plugin.client);
      if (ctx) void openLocation(ctx, entry.uri, entry.range);
    };
    items.push(item);
  });
  dom.onkeydown = (e) => {
    if (e.key === 'Escape') {
      view.dispatch({ effects: setRefs.of(null) });
      view.focus();
    }
  };
  return { dom, top: false };
}

export async function findReferences(view: EditorView) {
  const plugin = LSPPlugin.get(view);
  const ctx = plugin && navContext(plugin.client);
  if (!plugin || !ctx) return false;
  plugin.client.sync();
  const pos = view.state.selection.main.head;
  const word = view.state.wordAt(pos);
  try {
    const locs = await plugin.client.request<unknown, LspLocation[] | null>('textDocument/references', {
      textDocument: { uri: plugin.uri },
      position: plugin.toPosition(pos),
      context: { includeDeclaration: true }
    });
    const entries: RefEntry[] = [];
    for (const loc of locs ?? []) {
      const source = await loadSource(plugin.client, ctx, loc.uri).catch(() => null);
      const lines = source?.split(/\r?\n/) ?? [];
      const jdt = parseJdtUri(loc.uri);
      entries.push({ uri: loc.uri, range: loc.range, label: jdt ? jdt.qualifiedName : (projectRelative(loc.uri, ctx.rootUri) ?? sourceTabTitle(loc.uri)), line: loc.range.start.line, text: (lines[loc.range.start.line] ?? '').trim() });
    }
    entries.sort((a, b) => a.label.localeCompare(b.label) || a.line - b.line);
    const name = word ? view.state.sliceDoc(word.from, word.to) : 'symbol';
    const files = new Set(entries.map((e) => e.label)).size;
    const title = entries.length ? `${entries.length} reference${entries.length === 1 ? '' : 's'} to ${name} in ${files} file${files === 1 ? '' : 's'}` : `No references to ${name}`;
    view.dispatch({ effects: setRefs.of({ title, entries }) });
  } catch (e) {
    store.toast('error', `Finding references failed: ${(e as Error).message}`);
  }
  return true;
}

export const navigationTheme = EditorView.baseTheme({
  '.cm-def-link': { textDecoration: 'underline', cursor: 'pointer', color: 'var(--ed-link)' },
  '.cm-def-link *': { color: 'var(--ed-link)' },
  '.cm-tooltip.cm-tooltip-above:has(.cm-def-peek), .cm-tooltip:has(> .cm-def-peek)': { padding: '0' },
  '.cm-def-peek': { maxWidth: 'min(720px, 80vw)', maxHeight: '320px', overflow: 'auto', fontSize: '12px' },
  '.cm-def-peek-title': { padding: '4px 10px', borderBottom: '1px solid var(--ed-widget-border)', fontFamily: 'var(--sans)', color: 'var(--fg-mute)', fontSize: '11.5px' },
  '.cm-def-peek pre': { margin: '0', padding: '6px 10px', fontFamily: 'var(--mono)' },
  '.cm-refs': { maxHeight: '220px', display: 'flex', flexDirection: 'column', fontSize: '12.5px', outline: 'none' },
  '.cm-refs-head': { display: 'flex', alignItems: 'center', padding: '3px 6px 3px 10px', color: 'var(--ed-widget-fg)', fontWeight: '600', borderBottom: '1px solid var(--ed-widget-border)' },
  '.cm-refs-head span': { flex: '1' },
  '.cm-refs-close': { border: 'none', background: 'transparent', color: 'inherit', fontSize: '15px', cursor: 'pointer', padding: '0 6px' },
  '.cm-refs-list': { overflow: 'auto' },
  '.cm-refs-file': { padding: '3px 10px', color: 'var(--fg-mute)', fontFamily: 'var(--sans)' },
  '.cm-refs-item': { padding: '1px 10px 1px 20px', fontFamily: 'var(--mono)', whiteSpace: 'pre', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis' },
  '.cm-refs-item:hover': { backgroundColor: 'var(--ed-line-highlight)' },
  '.cm-refs-item[aria-selected]': { backgroundColor: 'var(--ed-suggest-selected-bg)' },
  '.cm-refs-line': { display: 'inline-block', minWidth: '3.5em', color: 'var(--ed-gutter-fg)' }
});

export const javaNavigationKeys: Extension = Prec.high(
  keymap.of([
    { key: 'Shift-F12', run: (v) => (void findReferences(v), true), preventDefault: true },
    { key: 'Escape', run: (v) => (v.state.field(refsField, false) ? (v.dispatch({ effects: setRefs.of(null) }), true) : false) }
  ])
);

export function javaNavigation(): LSPClientExtension {
  return { editorExtension: [navPlugin, peekField, refsField, navigationTheme, javaNavigationKeys] };
}

export const readOnlySource: Extension = [EditorState.readOnly.of(true), EditorView.editable.of(true)];
