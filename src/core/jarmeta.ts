import fs from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import JSON5 from 'json5';
import { parse as parseToml } from 'smol-toml';

export interface ModMetadata {
  loader: 'fabric' | 'quilt' | 'neoforge' | 'forge' | 'unknown';
  id: string;
  version: string;
  name?: string;
  description?: string;
  license?: string;
  environment?: string;
  provides: string[];
  depends: Record<string, string>;
  recommends: Record<string, string>;
  breaks: Record<string, string>;
  conflicts: Record<string, string>;
  nested: ModMetadata[];
  file?: string;
}

function asRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = Array.isArray(val) ? val.map(String).join(' || ') : String(val);
  }
  return out;
}

export function escapeControlCharsInStrings(text: string): string {
  const named: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') {
        out += c + (text[i + 1] ?? '');
        i++;
        continue;
      }
      if (c === quote) quote = null;
      else if (named[c]) {
        out += named[c];
        continue;
      }
    } else if (c === '"' || c === "'") quote = c;
    out += c;
  }
  return out;
}

function parseLenientJson(text: string): Record<string, unknown> {
  const clean = text.replace(/^\uFEFF/, '');
  try {
    return JSON5.parse(clean) as Record<string, unknown>;
  } catch (err) {
    try {
      return JSON5.parse(escapeControlCharsInStrings(clean)) as Record<string, unknown>;
    } catch {
      throw err;
    }
  }
}

export function parseFabricModJson(text: string): Omit<ModMetadata, 'nested'> {
  const j = parseLenientJson(text);
  if (typeof j.id !== 'string') throw new Error('fabric.mod.json has no id');
  return {
    loader: 'fabric',
    id: j.id,
    version: String(j.version ?? ''),
    name: typeof j.name === 'string' ? j.name : undefined,
    description: typeof j.description === 'string' ? j.description : undefined,
    license: Array.isArray(j.license) ? j.license.join(', ') : typeof j.license === 'string' ? j.license : undefined,
    environment: typeof j.environment === 'string' ? j.environment : '*',
    provides: Array.isArray(j.provides) ? j.provides.map(String) : [],
    depends: asRecord(j.depends),
    recommends: asRecord(j.recommends),
    breaks: asRecord(j.breaks),
    conflicts: asRecord(j.conflicts)
  };
}

export function parseModsToml(text: string, loader: 'neoforge' | 'forge'): Omit<ModMetadata, 'nested'>[] {
  const t = parseToml(text) as Record<string, unknown>;
  const mods = (t.mods as Record<string, unknown>[] | undefined) ?? [];
  const deps = (t.dependencies as Record<string, Record<string, unknown>[]> | undefined) ?? {};
  return mods.map((m) => {
    const id = String(m.modId);
    const depends: Record<string, string> = {};
    const breaks: Record<string, string> = {};
    for (const d of deps[id] ?? []) {
      const type = String(d.type ?? (d.mandatory ? 'required' : 'optional')).toLowerCase();
      const range = String(d.versionRange ?? '*');
      if (type === 'required' || d.mandatory === true) depends[String(d.modId)] = range;
      if (type === 'incompatible') breaks[String(d.modId)] = range;
    }
    return { loader, id, version: String(m.version ?? ''), name: m.displayName ? String(m.displayName) : undefined, description: m.description ? String(m.description) : undefined, license: t.license ? String(t.license) : undefined, provides: [], depends, recommends: {}, breaks, conflicts: {} };
  });
}

export function readJarMetadata(file: string): ModMetadata[] {
  const buf = fs.readFileSync(file);
  return readJarBuffer(new Uint8Array(buf), file, 0);
}

function readJarBuffer(buf: Uint8Array, file: string, depth: number): ModMetadata[] {
  const wanted = new Set(['fabric.mod.json', 'quilt.mod.json', 'META-INF/neoforge.mods.toml', 'META-INF/mods.toml']);
  const nestedJar = (name: string) => (name.startsWith('META-INF/jars/') || name.startsWith('META-INF/jarjar/')) && name.endsWith('.jar');
  const entries = unzipSync(buf, { filter: (f) => wanted.has(f.name) || (depth < 2 && nestedJar(f.name)) });
  const out: ModMetadata[] = [];
  const nested: ModMetadata[] = [];
  for (const [name, data] of Object.entries(entries)) {
    if (nestedJar(name)) {
      try {
        nested.push(...readJarBuffer(data, `${file}!/${name}`, depth + 1));
      } catch {
        void 0;
      }
    }
  }
  if (entries['fabric.mod.json']) {
    out.push({ ...parseFabricModJson(strFromU8(entries['fabric.mod.json'])), nested, file });
  } else if (entries['quilt.mod.json']) {
    const q = JSON.parse(strFromU8(entries['quilt.mod.json'])) as { quilt_loader?: { id?: string; version?: string; metadata?: { name?: string } } };
    out.push({ loader: 'quilt', id: q.quilt_loader?.id ?? 'unknown', version: q.quilt_loader?.version ?? '', name: q.quilt_loader?.metadata?.name, provides: [], depends: {}, recommends: {}, breaks: {}, conflicts: {}, nested, file });
  } else if (entries['META-INF/neoforge.mods.toml']) {
    out.push(...parseModsToml(strFromU8(entries['META-INF/neoforge.mods.toml']), 'neoforge').map((m) => ({ ...m, nested, file })));
  } else if (entries['META-INF/mods.toml']) {
    out.push(...parseModsToml(strFromU8(entries['META-INF/mods.toml']), 'forge').map((m) => ({ ...m, nested, file })));
  } else if (nested.length) {
    return nested.map((m) => ({ ...m, file }));
  }
  return out;
}

export function allModIds(meta: ModMetadata[]): string[] {
  const ids = new Set<string>();
  const walk = (m: ModMetadata) => {
    ids.add(m.id);
    m.provides.forEach((p) => ids.add(p));
    m.nested.forEach(walk);
  };
  meta.forEach(walk);
  return [...ids];
}
