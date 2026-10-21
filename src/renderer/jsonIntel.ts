import { EditorState, type Extension } from '@codemirror/state';
import { hoverTooltip } from '@codemirror/view';
import { linter, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { snippet, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { CompletionItemKind, DiagnosticSeverity, InsertTextFormat, type CompletionItem, type Hover } from 'vscode-json-languageservice';
import { isJsonFile, jsonService, parse, schemaFor, validateJson } from './jsonSchemas';
import { registryCompletion, registryHover } from './registryComplete';
import { store } from './store';

const escapeBraces = (s: string) => s.replace(/[{}]/g, (c) => `\\${c}`);

export function toCmSnippet(vs: string): string {
  let out = '';
  let i = 0;
  while (i < vs.length) {
    const c = vs[i];
    if (c === '\\' && i + 1 < vs.length && '$}\\'.includes(vs[i + 1])) {
      out += escapeBraces(vs[i + 1]);
      i += 2;
    } else if (c === '$' && /\d/.test(vs[i + 1] ?? '')) {
      const m = /^\d+/.exec(vs.slice(i + 1))!;
      out += `\${${m[0]}}`;
      i += 1 + m[0].length;
    } else if (c === '$' && vs[i + 1] === '{') {
      const end = vs.indexOf('}', i);
      const body = vs.slice(i + 2, end < 0 ? vs.length : end);
      const m = /^(\d+)(?::(.*)|\|([^,|]*)[^|]*\|)?$/s.exec(body);
      out += m ? (m[2] ?? m[3] ? `\${${m[1]}:${escapeBraces(m[2] ?? m[3])}}` : `\${${m[1]}}`) : escapeBraces(body);
      i = end < 0 ? vs.length : end + 1;
    } else {
      out += escapeBraces(c);
      i += 1;
    }
  }
  return out;
}

const KIND: Partial<Record<CompletionItemKind, Completion['type']>> = {
  [CompletionItemKind.Property]: 'property',
  [CompletionItemKind.Value]: 'constant',
  [CompletionItemKind.EnumMember]: 'enum',
  [CompletionItemKind.Enum]: 'enum',
  [CompletionItemKind.Keyword]: 'keyword',
  [CompletionItemKind.Snippet]: 'text',
  [CompletionItemKind.Module]: 'namespace',
  [CompletionItemKind.Class]: 'class'
};

function docText(doc: CompletionItem['documentation']): string | undefined {
  if (!doc) return undefined;
  return typeof doc === 'string' ? doc : doc.value;
}

function completionSource(file: string) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const { doc, json } = parse(file, ctx.state.doc.toString());
    const list = await jsonService().doComplete(doc, doc.positionAt(ctx.pos), json);
    if (!list?.items.length) return null;
    const edit = list.items.find((it) => it.textEdit && 'range' in it.textEdit)?.textEdit;
    const range = edit && 'range' in edit ? edit.range : null;
    const from = range ? doc.offsetAt(range.start) : ctx.pos;
    const to = range ? doc.offsetAt(range.end) : ctx.pos;
    if (!ctx.explicit && from === to && !/["{,[:\s]$/.test(ctx.state.sliceDoc(Math.max(0, ctx.pos - 1), ctx.pos))) return null;
    const quoted = ctx.state.sliceDoc(from, from + 1) === '"' && from < ctx.pos;
    const start = quoted ? from + 1 : from;
    const options = list.items.map((it): Completion => {
      const text = (it.textEdit && 'newText' in it.textEdit ? it.textEdit.newText : undefined) ?? it.insertText ?? it.label;
      const isSnippet = it.insertTextFormat === InsertTextFormat.Snippet;
      return {
        label: it.label.replace(/^"(.*)"$/, '$1'),
        detail: it.detail,
        info: docText(it.documentation),
        type: it.kind !== undefined ? KIND[it.kind] : undefined,
        apply: (view, completion, f, t) => {
          const a = quoted && view.state.sliceDoc(f - 1, f) === '"' ? f - 1 : f;
          const b = Math.max(t, to + (t - ctx.pos));
          if (isSnippet) snippet(toCmSnippet(text))(view, completion, a, b);
          else view.dispatch({ changes: { from: a, to: b, insert: text }, selection: { anchor: a + text.length }, userEvent: 'input.complete' });
        }
      };
    });
    return { from: start, options, validFor: /^[\w:./*-]*$/ };
  };
}

const RESOURCE_FILE = /(?:^|\/)(assets|data)\/[a-z0-9_.-]+\/.+\.json$/;

async function assetProblems(file: string, content: string): Promise<{ line: number; severity: 'error' | 'warning' | 'info'; message: string; code: string }[]> {
  const ws = store.state.workspace?.path;
  const rel = file.replace(/\\/g, '/');
  if (!ws || !RESOURCE_FILE.test(rel)) return [];
  try {
    const r = await store.call<{ problems: { line: number; severity: 'error' | 'warning' | 'info'; message: string; code: string }[] }>('assets.validate', { path: ws, file: rel, content }, { quiet: true });
    return r.problems;
  } catch {
    return [];
  }
}

function hoverText(h: Hover): string {
  const parts = Array.isArray(h.contents) ? h.contents : [h.contents];
  return parts
    .map((p) => (typeof p === 'string' ? p : p.value))
    .join('\n\n')
    .replace(/```\w*\n?/g, '')
    .replace(/(?<!\\)(\*\*?|__|`)/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1')
    .trim();
}

const SEVERITY: Record<number, CmDiagnostic['severity']> = {
  [DiagnosticSeverity.Error]: 'error',
  [DiagnosticSeverity.Warning]: 'warning',
  [DiagnosticSeverity.Information]: 'info',
  [DiagnosticSeverity.Hint]: 'hint'
};

export function jsonIntelligence(file: string): Extension {
  if (!isJsonFile(file)) return [];
  const schema = schemaFor(file);
  const lint = linter(
    async (view) => {
      const text = view.state.doc.toString();
      const { doc } = parse(file, text);
      const [diags, assets] = await Promise.all([validateJson(file, text), assetProblems(file, text)]);
      const out: CmDiagnostic[] = diags.map((d) => ({
        from: doc.offsetAt(d.range.start),
        to: Math.max(doc.offsetAt(d.range.end), doc.offsetAt(d.range.start) + 1),
        severity: SEVERITY[d.severity ?? DiagnosticSeverity.Error] ?? 'error',
        message: typeof d.message === 'string' ? d.message : d.message.value,
        source: schema && d.severity !== DiagnosticSeverity.Error ? schema.label : 'JSON'
      }));
      for (const p of assets) {
        if (p.code === 'json') continue;
        const line = view.state.doc.line(Math.min(Math.max(p.line, 1), view.state.doc.lines));
        const text = line.text;
        const start = text.search(/\S/);
        out.push({ from: line.from + Math.max(0, start), to: Math.max(line.to, line.from + 1), severity: p.severity, message: p.message, source: 'Assets' });
      }
      return out;
    },
    { delay: 400 }
  );
  const registryIds = registryCompletion(file);
  const registry = [EditorState.languageData.of(() => [{ autocomplete: registryIds }]), registryHover(file)];
  if (!schema) return [lint, registry];
  const hover = hoverTooltip(async (view, pos) => {
    const { doc, json } = parse(file, view.state.doc.toString());
    const h = await jsonService().doHover(doc, doc.positionAt(pos), json);
    const text = h ? hoverText(h) : '';
    if (!h || !text) return null;
    const from = h.range ? doc.offsetAt(h.range.start) : pos;
    const to = h.range ? doc.offsetAt(h.range.end) : pos;
    return {
      pos: from,
      end: to,
      above: true,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-json-hover';
        dom.textContent = text;
        return { dom };
      }
    };
  });
  const complete = completionSource(file);
  return [lint, hover, EditorState.languageData.of(() => [{ autocomplete: complete }]), registry];
}
