import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type { Services } from './context';

const MAX_THEME_FILE = 5 * 1024 * 1024;
const MAX_PACKAGE = 100 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const MAX_UNPACKED = 300 * 1024 * 1024;
const MAX_DEPTH = 16;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

export function stripJsonc(text: string): string {
  const chars = [...text.replace(/^﻿/, '')];
  let out = '';
  let i = 0;
  let inString = false;
  while (i < chars.length) {
    const c = chars[i];
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < chars.length) {
        out += chars[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && chars[i + 1] === '/') {
      while (i < chars.length && chars[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && chars[i + 1] === '*') {
      i += 2;
      while (i + 1 < chars.length && !(chars[i] === '*' && chars[i + 1] === '/')) {
        if (chars[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      let trailing = false;
      for (;;) {
        while (j < chars.length && /\s/.test(chars[j])) j++;
        if (chars[j] === '/' && chars[j + 1] === '/') {
          while (j < chars.length && chars[j] !== '\n') j++;
          continue;
        }
        if (chars[j] === '/' && chars[j + 1] === '*') {
          j += 2;
          while (j + 1 < chars.length && !(chars[j] === '*' && chars[j + 1] === '/')) j++;
          j += 2;
          continue;
        }
        if (chars[j] === '}' || chars[j] === ']') trailing = true;
        break;
      }
      if (!trailing) out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function parseJsonc(text: string, label: string): Json {
  try {
    return JSON.parse(stripJsonc(text)) as Json;
  } catch {
    throw new Error(`${label} is not valid JSON or JSONC`);
  }
}

export function slug(text: string): string {
  let out = '';
  for (const c of text.toLowerCase()) {
    if (/[a-z0-9]/.test(c)) out += c;
    else if (out && !out.endsWith('-')) out += '-';
  }
  const trimmed = out.replace(/-+$/, '');
  return trimmed ? [...trimmed].slice(0, 60).join('') : 'theme';
}

function validId(id: string) {
  return !!id && id.length <= 200 && /^[a-z0-9.-]+$/.test(id) && !id.startsWith('.') && !id.includes('..');
}

export function normalizeRel(baseDir: string, relIn: string, root: string, what: string): string {
  const rel = relIn.replace(/\\/g, '/');
  if (rel.startsWith('/') || rel.includes(':')) throw new Error(`${rel} points outside the ${what}`);
  const parts = baseDir.split('/').filter(Boolean);
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) throw new Error(`${rel} points outside the ${what}`);
      parts.pop();
    } else parts.push(seg);
  }
  const joined = parts.join('/');
  if (root && !joined.startsWith(`${root}/`)) throw new Error(`${rel} points outside the ${what}`);
  return joined;
}

const dirname = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

interface Source {
  what: string;
  root: string;
  read(rel: string): Buffer;
}

function dirSource(root: string): Source {
  return {
    what: 'theme folder',
    root: '',
    read(rel) {
      const file = path.join(root, rel);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        throw new Error(`${rel} is missing`);
      }
      if (!stat.isFile()) throw new Error(`${rel} is missing`);
      if (stat.size > MAX_THEME_FILE) throw new Error(`${rel} is too large; theme files are limited to 5 MB`);
      return fs.readFileSync(file);
    }
  };
}

function packageSource(files: Map<string, Buffer>): Source {
  return {
    what: 'extension',
    root: 'extension',
    read(rel) {
      const b = files.get(rel);
      if (!b) throw new Error(`${rel} is missing`);
      return b;
    }
  };
}

interface Loaded {
  theme: Obj;
  files: string[];
  warnings: string[];
}

const isObj = (v: Json | undefined): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function load(src: Source, rel: string, stack: string[]): Loaded {
  if (stack.includes(rel)) throw new Error(`Include cycle: ${[...stack, rel].join(' -> ')}`);
  if (stack.length >= MAX_DEPTH) throw new Error(`Includes are nested more than ${MAX_DEPTH} levels deep at ${rel}`);
  const value = parseJsonc(src.read(rel).toString('utf8'), rel);
  if (!isObj(value)) throw new Error(`${rel} is not a VS Code color theme (expected an object with colors or tokenColors)`);
  stack.push(rel);
  const dir = dirname(rel);
  const out: Loaded = { theme: {}, files: [rel], warnings: [] };
  const colors: Obj = {};
  const tokenColors: Json[] = [];
  const semantic: Obj = {};
  let semanticOn: Json = null;
  if ('include' in value) {
    if (typeof value.include !== 'string') {
      stack.pop();
      throw new Error(`${rel} has an include that is not a file path`);
    }
    const target = normalizeRel(dir, value.include, src.root, src.what);
    const base = load(src, target, stack);
    if (isObj(base.theme.colors)) Object.assign(colors, base.theme.colors);
    if (Array.isArray(base.theme.tokenColors)) tokenColors.push(...base.theme.tokenColors);
    if (isObj(base.theme.semanticTokenColors)) Object.assign(semantic, base.theme.semanticTokenColors);
    if (typeof base.theme.semanticHighlighting === 'boolean') semanticOn = base.theme.semanticHighlighting;
    for (const k of ['name', 'type']) if (k in base.theme) out.theme[k] = base.theme[k];
    out.files.push(...base.files);
    out.warnings.push(...base.warnings);
  }
  if ('colors' in value) {
    if (isObj(value.colors)) {
      for (const [k, v] of Object.entries(value.colors)) if (typeof v === 'string' || v === null) colors[k] = v;
    } else out.warnings.push(`${rel}: colors is not an object and was ignored`);
  }
  const tc = value.tokenColors;
  if (Array.isArray(tc)) tokenColors.push(...tc.filter(isObj));
  else if (typeof tc === 'string') {
    const target = normalizeRel(dir, tc, src.root, src.what);
    if (target.endsWith('.json') || target.endsWith('.jsonc')) {
      const v = parseJsonc(src.read(target).toString('utf8'), target);
      const rules = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.tokenColors) ? v.tokenColors : [];
      tokenColors.push(...rules.filter(isObj));
      out.files.push(target);
    } else out.warnings.push(`${rel}: tokenColors from ${tc} were skipped because .tmTheme files are not supported`);
  } else if (tc !== undefined) out.warnings.push(`${rel}: tokenColors is not a list and was ignored`);
  if (isObj(value.semanticTokenColors)) Object.assign(semantic, value.semanticTokenColors);
  if (typeof value.semanticHighlighting === 'boolean') semanticOn = value.semanticHighlighting;
  for (const k of ['name', 'type']) if (typeof value[k] === 'string') out.theme[k] = value[k];
  out.theme.colors = colors;
  out.theme.tokenColors = tokenColors;
  out.theme.semanticTokenColors = semantic;
  out.theme.semanticHighlighting = semanticOn;
  stack.pop();
  return out;
}

const isPackage = (f: string) => f.toLowerCase().endsWith('.vsix');
const isJson = (f: string) => /\.jsonc?$/i.test(f);
const unsupported = () => new Error('Choose a VS Code color theme (.json or .jsonc) or a theme extension (.vsix)');

function uiType(ui: string): string | null {
  return ({ vs: 'light', 'vs-dark': 'dark', 'hc-black': 'hc-dark', 'hc-light': 'hc-light' } as Record<string, string>)[ui] ?? null;
}

function jsonType(t: Json | undefined): string | null {
  const v = typeof t === 'string' ? t.toLowerCase() : '';
  if (v === 'light' || v === 'vs') return 'light';
  if (v === 'dark' || v === 'vs-dark') return 'dark';
  if (['hc', 'hc-black', 'hcdark', 'hc-dark'].includes(v)) return 'hc-dark';
  if (v === 'hclight' || v === 'hc-light') return 'hc-light';
  return null;
}

interface Variant {
  key: string;
  label: string;
  ui: string | null;
}

function readPackage(file: string) {
  if (fs.statSync(file).size > MAX_PACKAGE) throw new Error('The package is too large; .vsix files are limited to 100 MB');
  let count = 0;
  let total = 0;
  let problem: Error | null = null;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(fs.readFileSync(file)), {
      filter(f) {
        if (problem) return false;
        count++;
        if (count > MAX_ENTRIES) problem = new Error('The package has too many files');
        else if (f.name.startsWith('/') || f.name.includes('\\') || f.name.includes(':') || f.name.split('/').includes('..')) problem = new Error(`The package has an unsafe file path: ${f.name}`);
        else {
          total += f.originalSize;
          if (total > MAX_UNPACKED) problem = new Error('The package unpacks to more than 300 MB');
        }
        if (problem) return false;
        if (!(f.name.startsWith('extension/') && /\.jsonc?$/.test(f.name))) return false;
        if (f.originalSize > MAX_THEME_FILE) {
          if (f.name === 'extension/package.json') problem = new Error(`${f.name} is too large; theme files are limited to 5 MB`);
          return false;
        }
        return true;
      }
    });
  } catch {
    throw new Error('The package is not a valid .vsix archive');
  }
  if (problem) throw problem;
  const files = new Map(Object.entries(entries).map(([k, v]) => [k, Buffer.from(v)]));
  const manifest = files.get('extension/package.json');
  if (!manifest) throw new Error('The package has no extension/package.json');
  const pkg = parseJsonc(manifest.toString('utf8'), 'extension/package.json') as Obj;
  const contributes = isObj(pkg.contributes) ? pkg.contributes : {};
  const themes = Array.isArray(contributes.themes) ? contributes.themes : [];
  const variants: Variant[] = [];
  for (const t of themes) {
    if (!isObj(t) || typeof t.path !== 'string') continue;
    const key = normalizeRel('extension', t.path, 'extension', 'extension');
    const label = typeof t.label === 'string' ? t.label : typeof t.id === 'string' ? t.id : t.path;
    variants.push({ key, label, ui: uiType(typeof t.uiTheme === 'string' ? t.uiTheme : '') });
  }
  if (!variants.length) throw new Error('This extension does not contribute any color themes');
  const str = (v: Json | undefined) => (typeof v === 'string' ? v : '');
  const extension = { publisher: str(pkg.publisher), name: str(pkg.name), displayName: str(pkg.displayName) || str(pkg.name), version: str(pkg.version) };
  return { extension, variants, files };
}

function record(id: string, name: string, author: string | null, type: string | null, source: Obj, loaded: Loaded) {
  const theme = { ...loaded.theme };
  const ty = type ?? jsonType(theme.type);
  delete theme.name;
  delete theme.type;
  return { id, name, author, type: ty, source, installedAt: new Date().toISOString(), theme, warnings: loaded.warnings };
}

export class ThemeService {
  constructor(private s: Services) {}

  private dir() {
    return path.join(this.s.paths.data, 'themes');
  }

  inspect(file: string) {
    const p = path.resolve(file);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`${p} does not exist`);
    if (isPackage(p)) {
      const pkg = readPackage(p);
      return { kind: 'vsix', extension: pkg.extension, variants: pkg.variants.map((v) => ({ key: v.key, label: v.label, type: v.ui })) };
    }
    if (!isJson(p)) throw unsupported();
    const rel = path.basename(p);
    const loaded = load(dirSource(path.dirname(p)), rel, []);
    const label = typeof loaded.theme.name === 'string' ? loaded.theme.name : rel.replace(/\.jsonc$/, '').replace(/\.json$/, '');
    return { kind: 'json', extension: null, variants: [{ key: 'theme', label, type: jsonType(loaded.theme.type) }] };
  }

  install(file: string, variants?: string[]) {
    const p = path.resolve(file);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`${p} does not exist`);
    const prepared: { rec: ReturnType<typeof record>; files: [string, Buffer][] }[] = [];
    if (isPackage(p)) {
      const pkg = readPackage(p);
      const wanted = variants?.length
        ? variants.map((k) => {
            const v = pkg.variants.find((x) => x.key === k);
            if (!v) throw new Error(`${k} is not a theme in this package`);
            return v;
          })
        : pkg.variants;
      const src = packageSource(pkg.files);
      for (const v of wanted) {
        const loaded = load(src, v.key, []);
        const id = `${slug(pkg.extension.publisher)}.${slug(pkg.extension.name)}.${slug(v.label)}`;
        const rec = record(id, v.label, pkg.extension.publisher || null, v.ui, { kind: 'vsix', file: p, extension: pkg.extension, path: v.key }, loaded);
        const files: [string, Buffer][] = [['extension/package.json', pkg.files.get('extension/package.json') ?? Buffer.alloc(0)]];
        for (const f of loaded.files) {
          const b = pkg.files.get(f);
          if (b) files.push([f, b]);
        }
        prepared.push({ rec, files });
      }
    } else if (isJson(p)) {
      const rel = path.basename(p);
      const src = dirSource(path.dirname(p));
      const loaded = load(src, rel, []);
      const label = typeof loaded.theme.name === 'string' ? loaded.theme.name : rel.replace(/\.jsonc$/, '').replace(/\.json$/, '');
      const rec = record(`file.${slug(label)}`, label, null, null, { kind: 'json', file: p, extension: null, path: rel }, loaded);
      prepared.push({ rec, files: loaded.files.map((f) => [f, src.read(f)] as [string, Buffer]) });
    } else throw unsupported();
    const dir = this.dir();
    fs.mkdirSync(dir, { recursive: true });
    const installed: ReturnType<typeof record>[] = [];
    const updated: string[] = [];
    for (const { rec, files } of prepared) {
      if (!validId(rec.id)) throw new Error(`Could not derive a safe id for ${rec.name}`);
      const target = path.join(dir, rec.id);
      const part = path.join(dir, `${rec.id}.part`);
      fs.rmSync(part, { recursive: true, force: true });
      fs.mkdirSync(path.join(part, 'source'), { recursive: true });
      for (const [rel, bytes] of files) {
        const dest = path.join(part, 'source', rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, bytes);
      }
      fs.writeFileSync(path.join(part, 'theme.json'), JSON.stringify(rec, null, 2));
      if (fs.existsSync(target)) {
        updated.push(rec.id);
        fs.rmSync(target, { recursive: true, force: true });
      }
      fs.renameSync(part, target);
      installed.push(rec);
    }
    return { installed, updated };
  }

  list() {
    const dir = this.dir();
    if (!fs.existsSync(dir)) return [];
    const out: { id: string; name: string; theme: Obj }[] = [];
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name.endsWith('.part') || !fs.statSync(full).isDirectory()) continue;
      try {
        const v = JSON.parse(fs.readFileSync(path.join(full, 'theme.json'), 'utf8'));
        if (typeof v.id === 'string' && isObj(v.theme)) out.push(v);
      } catch {
        continue;
      }
    }
    return out.sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.id.localeCompare(b.id));
  }

  remove(id: string) {
    const target = path.join(this.dir(), id);
    if (!validId(id) || !fs.existsSync(path.join(target, 'theme.json'))) throw new Error(`No imported theme ${id}`);
    fs.rmSync(target, { recursive: true, force: true });
    return { removed: id };
  }
}
