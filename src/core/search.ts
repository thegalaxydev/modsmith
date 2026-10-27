import fs from 'node:fs';
import path from 'node:path';
import { resolveWithin, writeFileAtomic } from './manifest-helpers';

const SKIPPED_DIRS = new Set(['.git', '.gradle', 'build', 'node_modules', 'out', 'bin', '.idea', '.vscode', 'run', '.modsmith']);
const MAX_FILE = 1024 * 1024;
const LONG_LINE = 300;

export interface SearchQuery {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  include?: string;
  exclude?: string;
}

export interface SearchMatch {
  line: number;
  column: number;
  length: number;
  text: string;
  offset: number;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export function compileQuery(q: SearchQuery): RegExp {
  if (!q.query) throw new Error('Enter text to search for');
  let source = q.regex ? q.query : escapeRegex(q.query);
  if (q.wholeWord) source = `\\b(?:${source})\\b`;
  try {
    return new RegExp(source, `g${q.caseSensitive ? '' : 'i'}u`);
  } catch (err) {
    throw new Error(`Invalid regular expression: ${(err as Error).message.replace(/^Invalid regular expression: /, '')}`);
  }
}

function globSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      out += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += escapeRegex(c);
  }
  return out;
}

export function compileGlobs(list: string | undefined): RegExp[] {
  return (list ?? '')
    .split(',')
    .map((g) => g.trim().replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, ''))
    .filter(Boolean)
    .map((g) => new RegExp(`(^|/)${globSource(g)}(/.*)?$`, 'i'));
}

function walk(root: string, dir: string, out: string[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIPPED_DIRS.has(e.name)) walk(root, full, out);
    } else if (e.isFile()) out.push(path.relative(root, full).replace(/\\/g, '/'));
  }
}

export function candidateFiles(root: string, q: SearchQuery, only?: string[]): string[] {
  const include = compileGlobs(q.include);
  const exclude = compileGlobs(q.exclude);
  let files: string[];
  if (only) files = only.map((f) => path.relative(root, resolveWithin(root, f)).replace(/\\/g, '/'));
  else {
    files = [];
    walk(root, root, files);
  }
  return files.filter((f) => (!include.length || include.some((r) => r.test(f))) && !exclude.some((r) => r.test(f))).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function readText(file: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_FILE) return null;
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) return null;
  return buf.toString('utf8');
}

function lineMatches(re: RegExp, line: string): { index: number; text: string; groups: (string | undefined)[]; named: Record<string, string | undefined> }[] {
  const out: { index: number; text: string; groups: (string | undefined)[]; named: Record<string, string | undefined> }[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m[0].length === 0) {
      re.lastIndex = m.index + (line.codePointAt(m.index)! > 0xffff ? 2 : 1);
      if (m.index >= line.length) break;
      continue;
    }
    out.push({ index: m.index, text: m[0], groups: [...m], named: m.groups ?? {} });
  }
  return out;
}

function preview(line: string, column: number, length: number): { text: string; offset: number } {
  if (line.length <= LONG_LINE) return { text: line, offset: 0 };
  const start = Math.max(0, column - 100);
  return { text: line.slice(start, column + length + 150), offset: start };
}

export function search(root: string, q: SearchQuery & { maxResults?: number }) {
  const re = compileQuery(q);
  const max = q.maxResults ?? 5000;
  const files: { file: string; matches: SearchMatch[] }[] = [];
  let matchCount = 0;
  let searched = 0;
  let truncated = false;
  for (const rel of candidateFiles(root, q)) {
    const text = readText(path.join(root, rel));
    if (text === null) continue;
    searched++;
    const matches: SearchMatch[] = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && !truncated; i++) {
      const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
      for (const m of lineMatches(re, line)) {
        if (matchCount >= max) {
          truncated = true;
          break;
        }
        const p = preview(line, m.index, m.text.length);
        matches.push({ line: i + 1, column: m.index, length: m.text.length, text: p.text, offset: p.offset });
        matchCount++;
      }
    }
    if (matches.length) files.push({ file: rel, matches });
    if (truncated) break;
  }
  return { files, fileCount: files.length, matchCount, searchedFiles: searched, truncated };
}

export function expandReplacement(template: string, groups: (string | undefined)[], named: Record<string, string | undefined>): string {
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    const next = template[i + 1];
    if (c === '\\' && next !== undefined) {
      if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === '\\') out += '\\';
      else out += c + next;
      i++;
    } else if (c === '$' && next !== undefined) {
      if (next === '$') {
        out += '$';
        i++;
      } else if (next === '&') {
        out += groups[0] ?? '';
        i++;
      } else if (/[0-9]/.test(next)) {
        const two = template.slice(i + 1, i + 3);
        const n = /^[0-9]{2}$/.test(two) && Number(two) < groups.length ? two : next;
        if (Number(n) < groups.length) {
          out += groups[Number(n)] ?? '';
          i += n.length;
        } else out += c;
      } else if (next === '<' || next === '{') {
        const close = template.indexOf(next === '<' ? '>' : '}', i + 2);
        const name = close > 0 ? template.slice(i + 2, close) : '';
        if (close > 0 && /^\w+$/.test(name)) {
          out += /^[0-9]+$/.test(name) ? groups[Number(name)] ?? '' : named[name] ?? '';
          i = close;
        } else out += c;
      } else out += c;
    } else out += c;
  }
  return out;
}

export function replace(root: string, q: SearchQuery & { replacement: string; files?: string[]; match?: { file: string; line: number; column: number } }) {
  const re = compileQuery(q);
  const changed: { file: string; replacements: number }[] = [];
  const targets = q.match ? candidateFiles(root, { ...q, include: undefined, exclude: undefined }, [q.match.file]) : candidateFiles(root, q, q.files);
  for (const rel of targets) {
    const abs = path.join(root, rel);
    const text = readText(abs);
    if (text === null) continue;
    let count = 0;
    const lines = text.split('\n').map((raw, i) => {
      const cr = raw.endsWith('\r');
      const line = cr ? raw.slice(0, -1) : raw;
      if (q.match && q.match.line !== i + 1) return raw;
      let out = '';
      let last = 0;
      for (const m of lineMatches(re, line)) {
        if (q.match && m.index !== q.match.column) continue;
        out += line.slice(last, m.index) + (q.regex ? expandReplacement(q.replacement, m.groups, m.named) : q.replacement);
        last = m.index + m.text.length;
        count++;
      }
      return out + line.slice(last) + (cr ? '\r' : '');
    });
    if (!count) continue;
    writeFileAtomic(abs, lines.join('\n'));
    changed.push({ file: rel, replacements: count });
  }
  if (q.match && !changed.length) throw new Error(`The match in ${q.match.file} on line ${q.match.line} is no longer there; search again`);
  return { files: changed, replacements: changed.reduce((n, f) => n + f.replacements, 0) };
}
