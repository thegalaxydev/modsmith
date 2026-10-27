export type Loader = 'fabric' | 'neoforge' | 'forge';
export type FieldKey = 'name' | 'version' | 'description' | 'authors' | 'license' | 'group' | 'homepage' | 'issues';

export interface SourceFile {
  path: string;
  content: string;
  mtime: number;
}

export interface MetaFiles {
  props?: SourceFile;
  fabric?: SourceFile;
  toml?: SourceFile;
}

export interface FieldLocation {
  file: string;
  kind: 'property' | 'json' | 'toml';
  key: string;
}

export interface Dependency {
  modId: string;
  versionRange: string;
  required: boolean;
  side?: string;
}

export interface ModMeta {
  modId: string | null;
  values: Record<FieldKey, string>;
  locations: Partial<Record<FieldKey, FieldLocation>>;
  dependencies: Dependency[];
  dependencyFile: string | null;
  metadataFile: string | null;
  problems: string[];
}

export const FABRIC_FILES = ['src/main/resources/fabric.mod.json'];
export const TOML_FILES = ['src/main/templates/META-INF/neoforge.mods.toml', 'src/main/resources/META-INF/neoforge.mods.toml', 'src/main/templates/META-INF/mods.toml', 'src/main/resources/META-INF/mods.toml'];

const FIELDS: FieldKey[] = ['name', 'version', 'description', 'authors', 'license', 'group', 'homepage', 'issues'];
const PLACEHOLDER = /^\$\{([A-Za-z0-9_.]+)\}$/;

export function parseProperties(text: string): Map<string, { value: string; line: number }> {
  const out = new Map<string, { value: string; line: number }>();
  text.split(/\r?\n/).forEach((raw, line) => {
    const t = raw.trim();
    if (!t || t.startsWith('#') || t.startsWith('!')) return;
    const m = /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(t);
    if (m) out.set(m[1], { value: m[2], line });
  });
  return out;
}

function eol(text: string) {
  return /\r\n/.test(text) ? '\r\n' : '\n';
}

export function setProperty(text: string, key: string, value: string): string {
  const nl = eol(text);
  const lines = text.split(/\r?\n/);
  const clean = value.replace(/[\r\n]+/g, ' ');
  const found = parseProperties(text).get(key);
  if (found) {
    lines[found.line] = lines[found.line].replace(/^(\s*[^=:\s]+\s*[=:]\s*).*$/, (_m, head: string) => head + clean.replace(/\$/g, '$$$$'));
    return lines.join(nl);
  }
  if (lines.length && lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, `${key}=${clean}`);
  else lines.push(`${key}=${clean}`);
  return lines.join(nl);
}

interface TomlEntry {
  key: string;
  value: string;
  start: number;
  end: number;
  rest: string;
}

interface TomlSection {
  header: string;
  start: number;
  end: number;
  entries: TomlEntry[];
}

function readTomlValue(lines: string[], i: number, after: string): { value: string; end: number; rest: string } | null {
  const v = after.trimStart();
  for (const q of ["'''", '"""']) {
    if (v.startsWith(q)) {
      let body = v.slice(3);
      let end = i;
      let close = body.indexOf(q);
      while (close < 0 && end + 1 < lines.length) {
        end++;
        body += '\n' + lines[end];
        close = body.indexOf(q);
      }
      if (close < 0) return null;
      const text = body.slice(0, close).replace(/^\r?\n/, '');
      return { value: q === '"""' ? unescapeBasic(text) : text, end, rest: body.slice(close + 3) };
    }
  }
  if (v.startsWith('"')) {
    let j = 1;
    while (j < v.length && v[j] !== '"') j += v[j] === '\\' ? 2 : 1;
    return { value: unescapeBasic(v.slice(1, j)), end: i, rest: v.slice(j + 1) };
  }
  if (v.startsWith("'")) {
    const j = v.indexOf("'", 1);
    return { value: v.slice(1, j < 0 ? v.length : j), end: i, rest: j < 0 ? '' : v.slice(j + 1) };
  }
  const m = /^([^#]*?)\s*(#.*)?$/.exec(v)!;
  return { value: m[1], end: i, rest: m[2] ? ` ${m[2]}` : '' };
}

function unescapeBasic(s: string) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_m, e: string) => {
    if (e[0] === 'u' || e[0] === 'U') return String.fromCodePoint(parseInt(e.slice(1), 16));
    return ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\' } as Record<string, string>)[e] ?? e;
  });
}

export function tomlString(value: string): string {
  if (value.includes('\n') && !value.includes("'''")) return `'''\n${value}'''`;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

export function parseToml(text: string): TomlSection[] {
  const lines = text.split(/\r?\n/);
  const sections: TomlSection[] = [{ header: '', start: 0, end: lines.length, entries: [] }];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const h = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(t);
    if (h) {
      sections[sections.length - 1].end = i;
      sections.push({ header: t.startsWith('[[') ? `[[${h[1]}]]` : `[${h[1]}]`, start: i, end: lines.length, entries: [] });
      continue;
    }
    const kv = /^\s*([A-Za-z0-9_\-."]+)\s*=(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const v = readTomlValue(lines, i, kv[2]);
    if (!v) continue;
    sections[sections.length - 1].entries.push({ key: kv[1].replace(/"/g, ''), value: v.value, start: i, end: v.end, rest: v.rest });
    i = v.end;
  }
  return sections;
}

export function setTomlValue(text: string, sectionIndex: number, key: string, raw: string): string {
  const nl = eol(text);
  const lines = text.split(/\r?\n/);
  const sections = parseToml(text);
  const section = sections[sectionIndex];
  const entry = section.entries.find((e) => e.key === key);
  if (entry) {
    const indent = /^\s*/.exec(lines[entry.start])![0];
    const head = new RegExp(`^\\s*"?${key.replace(/[.-]/g, '\\$&')}"?(\\s*)=(\\s*)`).exec(lines[entry.start]);
    const replacement = `${indent}${key}${head?.[1] ?? ''}=${head?.[2] ?? ''}${raw}${entry.rest.trim() ? ` ${entry.rest.trim()}` : ''}`;
    lines.splice(entry.start, entry.end - entry.start + 1, ...replacement.split('\n'));
    return lines.join(nl);
  }
  const at = section.entries.length ? section.entries[section.entries.length - 1].end + 1 : section.header ? section.start + 1 : 0;
  lines.splice(at, 0, ...`${key}=${raw}`.split('\n'));
  return lines.join(nl);
}

function placeholder(value: unknown): string | null {
  return typeof value === 'string' ? PLACEHOLDER.exec(value.trim())?.[1] ?? null : null;
}

function jsonIndent(text: string): string | number {
  const m = /\n([ \t]+)"/.exec(text);
  return m ? (m[1].startsWith('\t') ? '\t' : m[1].length) : 2;
}

function authorList(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return '';
  return v.map((a) => (typeof a === 'string' ? a : a && typeof a === 'object' && typeof (a as { name?: unknown }).name === 'string' ? (a as { name: string }).name : '')).filter(Boolean).join(', ');
}

const splitList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

function rangeText(v: unknown): string {
  if (Array.isArray(v)) return v.map(String).join(' || ');
  return typeof v === 'string' ? v : '*';
}

function modsSectionIndex(sections: TomlSection[]) {
  return sections.findIndex((s) => s.header === '[[mods]]');
}

function dependencySections(sections: TomlSection[]) {
  return sections.map((s, i) => ({ s, i })).filter(({ s }) => /^\[\[dependencies\.[^\]]+\]\]$/.test(s.header));
}

function tomlDependency(s: TomlSection): Dependency {
  const get = (k: string) => s.entries.find((e) => e.key === k)?.value;
  const type = get('type');
  const mandatory = get('mandatory');
  return { modId: get('modId') ?? '', versionRange: get('versionRange') ?? '*', required: type ? type.toLowerCase() === 'required' : mandatory !== 'false', side: get('side') };
}

export function readMeta(loader: Loader, files: MetaFiles): ModMeta {
  const props = files.props ? parseProperties(files.props.content) : new Map<string, { value: string; line: number }>();
  const values = Object.fromEntries(FIELDS.map((f) => [f, ''])) as Record<FieldKey, string>;
  const locations: Partial<Record<FieldKey, FieldLocation>> = {};
  const problems: string[] = [];
  let modId: string | null = null;
  let dependencies: Dependency[] = [];
  let dependencyFile: string | null = null;
  const prop = (field: FieldKey, key: string) => {
    if (!files.props) return false;
    values[field] = props.get(key)?.value ?? '';
    locations[field] = { file: files.props.path, kind: 'property', key };
    return true;
  };
  const firstProp = (...keys: string[]) => keys.find((k) => props.has(k));

  if (loader === 'fabric') {
    if (files.fabric) {
      let j: Record<string, unknown> | null = null;
      try {
        j = JSON.parse(files.fabric.content);
      } catch (err) {
        problems.push(`${files.fabric.path} is not valid JSON: ${(err as Error).message}`);
      }
      if (j) {
        modId = typeof j.id === 'string' ? j.id : null;
        const contact = (j.contact && typeof j.contact === 'object' ? j.contact : {}) as Record<string, unknown>;
        const json = (field: FieldKey, key: string, value: unknown) => {
          const ph = placeholder(value);
          if (ph && prop(field, ph === 'version' ? firstProp('mod_version', 'version') ?? 'version' : ph)) return;
          values[field] = field === 'authors' ? authorList(value) : field === 'license' ? (Array.isArray(value) ? value.join(', ') : String(value ?? '')) : String(value ?? '');
          locations[field] = { file: files.fabric!.path, kind: 'json', key };
        };
        json('name', 'name', j.name);
        json('version', 'version', j.version);
        json('description', 'description', j.description);
        json('authors', 'authors', j.authors);
        json('license', 'license', j.license);
        json('homepage', 'contact.homepage', contact.homepage);
        json('issues', 'contact.issues', contact.issues);
        const deps = (o: unknown, required: boolean) => Object.entries(o && typeof o === 'object' ? (o as Record<string, unknown>) : {}).map(([id, r]) => ({ modId: id, versionRange: rangeText(r), required }));
        dependencies = [...deps(j.depends, true), ...deps(j.recommends, false)];
        dependencyFile = files.fabric.path;
      }
    }
    if (files.props) prop('group', firstProp('maven_group', 'group', 'mod_group_id') ?? 'maven_group');
  } else if (files.toml) {
    const sections = parseToml(files.toml.content);
    const top = sections[0];
    const mi = modsSectionIndex(sections);
    const mods = mi >= 0 ? sections[mi] : null;
    if (!mods) problems.push(`${files.toml.path} has no [[mods]] section`);
    const toml = (field: FieldKey, section: TomlSection | null, key: string, sectionName: string) => {
      const entry = section?.entries.find((e) => e.key === key);
      const ph = placeholder(entry?.value);
      if (ph && prop(field, ph)) return;
      values[field] = entry?.value ?? '';
      if (section) locations[field] = { file: files.toml!.path, kind: 'toml', key: `${sectionName}${key}` };
    };
    const idEntry = mods?.entries.find((e) => e.key === 'modId')?.value;
    const idProp = placeholder(idEntry);
    modId = idProp ? props.get(idProp)?.value ?? null : idEntry ?? null;
    toml('name', mods, 'displayName', 'mods.');
    toml('version', mods, 'version', 'mods.');
    toml('description', mods, 'description', 'mods.');
    toml('authors', mods, 'authors', 'mods.');
    toml('license', top, 'license', '');
    toml('homepage', mods, 'displayURL', 'mods.');
    toml('issues', top, 'issueTrackerURL', '');
    if (files.props) prop('group', firstProp('mod_group_id', 'maven_group', 'group') ?? 'mod_group_id');
    dependencies = dependencySections(sections).map(({ s }) => tomlDependency(s));
    dependencyFile = files.toml.path;
  }
  if (loader === 'fabric' && !files.fabric) problems.push('No fabric.mod.json was found in src/main/resources');
  if (loader !== 'fabric' && !files.toml) problems.push('No mods.toml or neoforge.mods.toml was found in src/main/resources/META-INF or src/main/templates/META-INF');
  return { modId, values, locations, dependencies, dependencyFile, metadataFile: (loader === 'fabric' ? files.fabric : files.toml)?.path ?? null, problems };
}

function setJsonPath(obj: Record<string, unknown>, key: string, value: unknown) {
  const parts = key.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (value === '' && parts.length > 1) delete cur[last];
  else cur[last] = value;
}

function sameRange(a: string, b: unknown) {
  return rangeText(b) === a;
}

export function applyMeta(loader: Loader, files: MetaFiles, meta: ModMeta, values: Record<FieldKey, string>, dependencies: Dependency[]): Record<string, string> {
  const out: Record<string, string> = {};
  const current = (f: SourceFile) => out[f.path] ?? f.content;
  const changed = FIELDS.filter((f) => values[f] !== meta.values[f] && meta.locations[f]);
  const depsChanged = JSON.stringify(dependencies) !== JSON.stringify(meta.dependencies);

  for (const f of changed) {
    const loc = meta.locations[f]!;
    if (loc.kind === 'property' && files.props) out[files.props.path] = setProperty(current(files.props), loc.key, values[f]);
  }

  if (loader === 'fabric' && files.fabric && (changed.some((f) => meta.locations[f]!.kind === 'json') || depsChanged)) {
    const text = current(files.fabric);
    const j = JSON.parse(text) as Record<string, unknown>;
    for (const f of changed) {
      const loc = meta.locations[f]!;
      if (loc.kind !== 'json') continue;
      let v: unknown = values[f];
      if (f === 'authors') {
        const old = Array.isArray(j.authors) ? j.authors : [];
        v = splitList(values[f]).map((name) => old.find((a) => a && typeof a === 'object' && (a as { name?: string }).name === name) ?? name);
      }
      if (f === 'license') {
        const list = splitList(values[f]);
        v = list.length > 1 || Array.isArray(j.license) ? list : list[0] ?? '';
      }
      setJsonPath(j, loc.key, v);
    }
    if (depsChanged) {
      const was = { depends: (j.depends ?? {}) as Record<string, unknown>, recommends: (j.recommends ?? {}) as Record<string, unknown> };
      const depends: Record<string, unknown> = {};
      const recommends: Record<string, unknown> = {};
      for (const d of dependencies) {
        if (!d.modId) continue;
        const prev = d.required ? was.depends[d.modId] ?? was.recommends[d.modId] : was.recommends[d.modId] ?? was.depends[d.modId];
        (d.required ? depends : recommends)[d.modId] = prev !== undefined && sameRange(d.versionRange, prev) ? prev : d.versionRange.includes('||') ? d.versionRange.split('||').map((r) => r.trim()).filter(Boolean) : d.versionRange || '*';
      }
      if (Object.keys(depends).length || 'depends' in j) j.depends = depends;
      if (Object.keys(recommends).length) j.recommends = recommends;
      else delete j.recommends;
    }
    out[files.fabric.path] = JSON.stringify(j, null, jsonIndent(text)) + (/\n$/.test(text) ? eol(text) : '');
    if (eol(text) === '\r\n') out[files.fabric.path] = out[files.fabric.path].replace(/\r?\n/g, '\r\n');
  }

  if (loader !== 'fabric' && files.toml) {
    let text = current(files.toml);
    for (const f of changed) {
      const loc = meta.locations[f]!;
      if (loc.kind !== 'toml') continue;
      const sections = parseToml(text);
      const inMods = loc.key.startsWith('mods.');
      const idx = inMods ? modsSectionIndex(sections) : 0;
      if (idx < 0) continue;
      text = setTomlValue(text, idx, inMods ? loc.key.slice(5) : loc.key, tomlString(values[f]));
    }
    if (depsChanged) text = applyTomlDependencies(text, meta, dependencies);
    if (text !== files.toml.content) out[files.toml.path] = text;
  }
  for (const [p, t] of Object.entries(out)) {
    const original = [files.props, files.fabric, files.toml].find((f) => f?.path === p);
    if (original && original.content === t) delete out[p];
  }
  return out;
}

function applyTomlDependencies(text: string, meta: ModMeta, dependencies: Dependency[]): string {
  const nl = eol(text);
  const sections = parseToml(text);
  const blocks = dependencySections(sections);
  const owner = blocks[0]?.s.header.replace(/^\[\[dependencies\.|\]\]$/g, '') ?? (/\$\{mod_id\}/.test(text) ? '${mod_id}' : meta.modId ?? '${mod_id}');
  const usesType = blocks.some(({ s }) => s.entries.some((e) => e.key === 'type')) || (!blocks.some(({ s }) => s.entries.some((e) => e.key === 'mandatory')) && /neoforge\.mods\.toml$/.test(meta.dependencyFile ?? ''));
  let lines = text.split(/\r?\n/);
  const byId = new Map(blocks.map(({ s }) => [tomlDependency(s).modId, s]));
  const keep = new Set(dependencies.map((d) => d.modId));
  const removals = blocks.filter(({ s }) => !keep.has(tomlDependency(s).modId)).map(({ s }) => s).sort((a, b) => b.start - a.start);
  let working = lines.join('\n');
  for (const d of dependencies) {
    const s = byId.get(d.modId);
    if (!s) continue;
    const idx = parseToml(working).findIndex((x) => x.start === s.start && x.header === s.header);
    if (idx < 0) continue;
    const old = tomlDependency(s);
    if (old.versionRange !== d.versionRange) working = setTomlValue(working, idx, 'versionRange', tomlString(d.versionRange || '*'));
    if (old.required !== d.required) {
      const hasType = s.entries.some((e) => e.key === 'type');
      working = hasType || !s.entries.some((e) => e.key === 'mandatory') ? setTomlValue(working, idx, 'type', tomlString(d.required ? 'required' : 'optional')) : setTomlValue(working, idx, 'mandatory', d.required ? 'true' : 'false');
    }
    if ((old.side ?? '') !== (d.side ?? '') && d.side) working = setTomlValue(working, idx, 'side', tomlString(d.side));
  }
  lines = working.split('\n');
  for (const s of removals) {
    const fresh = parseToml(lines.join('\n')).find((x) => x.header === s.header && tomlDependency(x).modId === tomlDependency(s).modId);
    if (!fresh) continue;
    let end = fresh.end;
    while (end > fresh.start + 1 && /^\s*$/.test(lines[end - 1])) end--;
    let start = fresh.start;
    while (start > 0 && /^\s*$/.test(lines[start - 1])) start--;
    lines.splice(start, end - start, ...(start === 0 ? [] : ['']));
  }
  const added = dependencies.filter((d) => d.modId && !byId.has(d.modId));
  if (added.length) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (const d of added) {
      lines.push('', `[[dependencies.${owner}]]`, `modId=${tomlString(d.modId)}`, usesType ? `type=${tomlString(d.required ? 'required' : 'optional')}` : `mandatory=${d.required ? 'true' : 'false'}`, `versionRange=${tomlString(d.versionRange || '*')}`, 'ordering="NONE"', `side=${tomlString(d.side || 'BOTH')}`);
    }
    lines.push('');
  }
  return lines.join(nl);
}
