import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type { Services } from './context';
import type { WorkspaceService } from './workspace';
import { readLock } from './manifest';
import { stateDir } from './workspace';
import { ClientInstaller } from './clientinstall';

const MAX_ENTRY = 8 * 1024 * 1024;
const TAG_REGISTRIES: Record<string, string> = { item: 'item', items: 'item', block: 'block', blocks: 'block', entity_type: 'entity_type', entity_types: 'entity_type', fluid: 'fluid', fluids: 'fluid' };

const P = {
  namespace: /^(?:assets|data)\/([a-z0-9_.-]+)\//,
  model: /^assets\/([a-z0-9_.-]+)\/models\/([a-z0-9_./-]+)\.json$/,
  texture: /^assets\/([a-z0-9_.-]+)\/textures\/([a-z0-9_./-]+)\.png$/,
  lang: /^assets\/[a-z0-9_.-]+\/lang\/en_us\.json$/,
  blockstate: /^assets\/([a-z0-9_.-]+)\/blockstates\/([a-z0-9_./-]+)\.json$/,
  itemDef: /^assets\/([a-z0-9_.-]+)\/items\/([a-z0-9_./-]+)\.json$/,
  itemModel: /^assets\/([a-z0-9_.-]+)\/models\/item\/([a-z0-9_./-]+)\.json$/,
  tag: /^data\/([a-z0-9_.-]+)\/tags\/(item|items|block|blocks|entity_type|entity_types|fluid|fluids)\/([a-z0-9_./-]+)\.json$/,
  key: /^(item|block|entity)\.([a-z0-9_-]+)\.([a-z0-9_/]+)$/
};

export interface Scan {
  namespaces: Set<string>;
  models: Set<string>;
  textures: Set<string>;
  lang: Map<string, string>;
  blocks: Set<string>;
  itemDefs: Set<string>;
  itemModels: Set<string>;
  tags: Map<string, string[]>;
}

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function tagValues(bytes: Uint8Array | null): string[] {
  if (!bytes) return [];
  try {
    const v = JSON.parse(Buffer.from(bytes).toString('utf8')) as { values?: unknown };
    if (!Array.isArray(v.values)) return [];
    return v.values.flatMap((x) => (typeof x === 'string' ? [x] : x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string' ? [(x as { id: string }).id] : []));
  } catch {
    return [];
  }
}

export function scanFiles(names: string[], read: (name: string) => Uint8Array | null): Scan {
  const s: Scan = { namespaces: new Set(), models: new Set(), textures: new Set(), lang: new Map(), blocks: new Set(), itemDefs: new Set(), itemModels: new Set(), tags: new Map() };
  for (const name of names) {
    let m: RegExpExecArray | null;
    const ns = P.namespace.exec(name);
    if (ns) s.namespaces.add(ns[1]);
    const mt = P.model.exec(name) ?? P.texture.exec(name);
    if (mt) (name.endsWith('.png') ? s.textures : s.models).add(`${mt[1]}:${mt[2]}`);
    if (P.lang.test(name)) {
      const bytes = read(name);
      if (!bytes) continue;
      try {
        const v = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          for (const [k, t] of Object.entries(v)) if (typeof t === 'string' && !s.lang.has(k)) s.lang.set(k, t);
        }
      } catch {
        continue;
      }
    } else if ((m = P.blockstate.exec(name))) s.blocks.add(`${m[1]}:${m[2]}`);
    else if ((m = P.itemDef.exec(name))) s.itemDefs.add(`${m[1]}:${m[2]}`);
    else if ((m = P.itemModel.exec(name))) s.itemModels.add(`${m[1]}:${m[2]}`);
    else if ((m = P.tag.exec(name))) {
      const key = `${TAG_REGISTRIES[m[2]]}|${m[1]}:${m[3]}`;
      const list = s.tags.get(key) ?? [];
      for (const v of tagValues(read(name))) if (!list.includes(v)) list.push(v);
      s.tags.set(key, list);
    }
  }
  return s;
}

const wanted = (name: string) => P.lang.test(name) || P.tag.test(name);

function scanJar(file: string): Scan | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  const names: string[] = [];
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buf, {
      filter: (f) => {
        names.push(f.name);
        return wanted(f.name) && f.originalSize <= MAX_ENTRY;
      }
    });
  } catch {
    return null;
  }
  names.sort(byKey);
  return scanFiles(names, (n) => files[n] ?? null);
}

function walk(root: string, dir: string, out: string[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(root, p, out);
    else out.push(path.relative(root, p).replace(/\\/g, '/'));
  }
}

export function scanDir(dir: string): Scan {
  const names: string[] = [];
  for (const top of ['assets', 'data']) walk(dir, path.join(dir, top), names);
  names.sort(byKey);
  return scanFiles(names, (n) => {
    const f = path.join(dir, n);
    try {
      if (fs.statSync(f).size > MAX_ENTRY) return null;
      return fs.readFileSync(f);
    } catch {
      return null;
    }
  });
}

const jarCache = new Map<string, Scan>();

function cachedJar(file: string): Scan | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const key = `${file}|${st.size}|${Math.floor(st.mtimeMs)}`;
  const hit = jarCache.get(key);
  if (hit) return hit;
  const scan = scanJar(file);
  if (scan) jarCache.set(key, scan);
  return scan;
}

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p: string) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

export function projectRoots(dir: string): string[] {
  const src = path.join(dir, 'src');
  let sets: string[] = [];
  try {
    sets = fs
      .readdirSync(src, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(src, e.name))
      .sort(byKey);
  } catch {
    sets = [];
  }
  const out: string[] = [];
  for (const set of sets) for (const sub of ['resources', 'generated']) {
    const p = path.join(set, sub);
    if (isDir(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

function specJars(dir: string): string[] {
  const out: string[] = [];
  for (const run of ['runClient', 'runServer']) {
    let v: { runs?: Record<string, { classpath?: unknown }> };
    try {
      v = JSON.parse(fs.readFileSync(path.join(stateDir(dir), 'launch', `${run}.json`), 'utf8'));
    } catch {
      continue;
    }
    const cp = v.runs?.[run]?.classpath;
    if (!Array.isArray(cp)) continue;
    for (const c of cp) if (typeof c === 'string' && c.toLowerCase().endsWith('.jar') && isFile(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

const stem = (p: string) => path.basename(p).replace(/(\.jar)+$/, '');

export class Merged {
  lang = new Map<string, string>();
  models = new Set<string>();
  textures = new Set<string>();
  itemDefs = new Set<string>();
  namespaces = new Set<string>();
  items = new Map<string, string>();
  blocks = new Map<string, string>();
  entities = new Map<string, string>();
  tags = new Map<string, { values: string[]; source: string }>();
  sources: { label: string; kind: string; items: number; blocks: number; entities: number; tags: number }[] = [];
  private queued: { scan: Scan; label: string; kind: string }[] = [];

  add(scan: Scan, label: string, kind: string) {
    this.queued.push({ scan, label, kind });
  }

  finish() {
    const queued = this.queued;
    this.queued = [];
    const ns = (set: Set<string>) => [...set].map((i) => i.split(':')[0]);
    const known = { namespaces: new Set<string>(), defNamespaces: new Set<string>(), modelNamespaces: new Set<string>(), models: new Set<string>() };
    for (const { scan } of queued) {
      for (const m of scan.models) this.models.add(m);
      for (const t of scan.textures) this.textures.add(t);
      for (const d of scan.itemDefs) this.itemDefs.add(d);
      for (const n of scan.namespaces) this.namespaces.add(n);
      for (const n of scan.namespaces) known.namespaces.add(n);
      for (const n of ns(scan.itemDefs)) known.defNamespaces.add(n);
      for (const n of ns(scan.itemModels)) known.modelNamespaces.add(n);
      for (const m of scan.itemModels) known.models.add(m);
    }
    for (const q of queued) this.apply(q.scan, q.label, q.kind, known);
  }

  private apply(scan: Scan, label: string, kind: string, known: { namespaces: Set<string>; defNamespaces: Set<string>; modelNamespaces: Set<string>; models: Set<string> }) {
    for (const [k, v] of scan.lang) if (!this.lang.has(k)) this.lang.set(k, v);
    const items = new Set<string>(scan.itemDefs);
    const entities = new Set<string>();
    for (const [key, value] of scan.lang) {
      const c = P.key.exec(key);
      if (!c || !known.namespaces.has(c[2])) continue;
      const id = `${c[2]}:${c[3]}`;
      if (c[1] === 'item' && !known.defNamespaces.has(c[2]) && (!known.modelNamespaces.has(c[2]) || known.models.has(id))) items.add(id);
      else if (c[1] === 'entity' && !value.includes('%')) entities.add(id);
    }
    for (const m of scan.itemModels) {
      const i = m.indexOf(':');
      const ns = m.slice(0, i);
      const p = m.slice(i + 1);
      if (known.defNamespaces.has(ns)) continue;
      const prefix = `item.${ns}.${p}.`;
      if (scan.blocks.has(m) || [...scan.lang.keys()].some((k) => k.startsWith(prefix))) items.add(m);
    }
    let ni = 0;
    let nb = 0;
    let ne = 0;
    let nt = 0;
    for (const id of items) if (!this.items.has(id)) (this.items.set(id, label), ni++);
    for (const id of scan.blocks) {
      const i = id.indexOf(':');
      const named = (kind: string) => scan.lang.has(`${kind}.${id.slice(0, i)}.${id.slice(i + 1)}`);
      if (!named('block') && (named('item') || named('entity'))) continue;
      if (!this.blocks.has(id)) (this.blocks.set(id, label), nb++);
    }
    for (const id of entities) if (!this.entities.has(id)) (this.entities.set(id, label), ne++);
    for (const [key, values] of scan.tags) {
      const known = this.tags.get(key);
      if (known) {
        for (const v of values) if (!known.values.includes(v)) known.values.push(v);
      } else {
        this.tags.set(key, { values: [...values], source: label });
        nt++;
      }
    }
    if (ni + nb + ne + nt > 0) this.sources.push({ label, kind, items: ni, blocks: nb, entities: ne, tags: nt });
  }

  name(kind: string, id: string) {
    const i = id.indexOf(':');
    if (i < 0) return undefined;
    return this.lang.get(`${kind}.${id.slice(0, i)}.${id.slice(i + 1)}`);
  }

  entries(map: Map<string, string>, kinds: string[]) {
    return [...map.keys()].sort(byKey).map((id) => {
      let name: string | undefined;
      for (const k of kinds) {
        name = this.name(k, id);
        if (name !== undefined) break;
      }
      return name === undefined ? { id, source: map.get(id)! } : { id, name, source: map.get(id)! };
    });
  }
}

function lockedJars(dir: string, downloads: string): string[] {
  let lock: { profiles?: Record<string, { entries?: { key?: string; fileName?: string; sha1?: string; provider?: string }[] }> } = {};
  try {
    lock = readLock(dir) as typeof lock;
  } catch {
    lock = {};
  }
  const out: string[] = [];
  for (const name of Object.keys(lock.profiles ?? {}).sort(byKey)) {
    for (const e of lock.profiles![name].entries ?? []) {
      const file = e.fileName ?? '';
      let candidate: string | null = null;
      if (e.key?.startsWith('local:')) {
        const rest = e.key.slice(6);
        candidate = path.isAbsolute(rest) ? rest : path.join(dir, rest);
      } else if (e.sha1 && e.sha1.length > 2) {
        const direct = path.join(downloads, e.provider ?? '', e.sha1.slice(0, 2), e.sha1, file);
        if (isFile(direct)) candidate = direct;
        else {
          const manual = path.join(downloads, 'manual', e.sha1);
          try {
            candidate =
              fs
                .readdirSync(manual)
                .map((f) => path.join(manual, f))
                .filter((f) => f.toLowerCase().endsWith('.jar'))
                .sort(byKey)[0] ?? null;
          } catch {
            candidate = null;
          }
        }
      }
      if (candidate && isFile(candidate) && candidate.toLowerCase().endsWith('.jar') && !out.includes(candidate)) out.push(candidate);
    }
  }
  return out;
}

export type Src = { kind: 'dir' | 'jar'; path: string };

export interface Collected {
  dir: string;
  vanilla: boolean;
  minecraft: string;
  merged: Merged;
  warnings: string[];
  pending: string | null;
  sources: Src[];
  roots: string[];
}

export const modernItems = (c: Collected) => [...c.merged.itemDefs].some((i) => i.startsWith('minecraft:'));

const jarBuffers = new Map<string, Buffer>();

export function readResource(sources: Src[], rel: string): Buffer | null {
  for (const s of sources) {
    if (s.kind === 'dir') {
      const f = path.join(s.path, rel);
      if (isFile(f)) {
        try {
          return fs.readFileSync(f);
        } catch {
          continue;
        }
      }
      continue;
    }
    let buf = jarBuffers.get(s.path);
    if (!buf) {
      try {
        buf = fs.readFileSync(s.path);
      } catch {
        continue;
      }
      jarBuffers.set(s.path, buf);
    }
    try {
      const out = unzipSync(buf, { filter: (f) => f.name === rel && f.originalSize <= MAX_ENTRY });
      if (out[rel]) return Buffer.from(out[rel]);
    } catch {
      continue;
    }
  }
  return null;
}

export class RegistryIndexService {
  private downloads = new Map<string, string>();

  constructor(
    private s: Services,
    private ws: WorkspaceService
  ) {}

  index(root: string) {
    const { minecraft, merged, warnings, pending } = this.collect(root);
    const tags: Record<string, { id: string; values: string[]; source: string }[]> = {};
    for (const reg of ['item', 'block', 'entity_type', 'fluid']) {
      tags[reg] = [...merged.tags.keys()]
        .filter((k) => k.startsWith(`${reg}|`))
        .map((k) => k.slice(reg.length + 1))
        .sort(byKey)
        .map((id) => {
          const t = merged.tags.get(`${reg}|${id}`)!;
          return { id, values: t.values, source: t.source };
        });
    }
    return {
      minecraft,
      sources: merged.sources,
      items: merged.entries(merged.items, ['item', 'block']),
      blocks: merged.entries(merged.blocks, ['block']),
      entities: merged.entries(merged.entities, ['entity']),
      tags,
      warnings,
      pending
    };
  }

  collect(root: string): Collected {
    const dir = this.ws.normalize(root);
    const m = this.ws.requireManifest(root);
    const minecraft = m.platform.minecraft ?? '';
    const installer = new ClientInstaller(this.s.http, path.join(this.s.paths.cache, 'minecraft'));
    const jar = installer.clientJarPath(minecraft);
    const merged = new Merged();
    const warnings: string[] = [];
    let pending: string | null = null;
    let vanilla = false;
    if (isFile(jar)) {
      const scan = cachedJar(jar);
      if (scan) (merged.add(scan, `Minecraft ${minecraft}`, 'vanilla'), (vanilla = true));
      else warnings.push(`The Minecraft ${minecraft} client jar could not be read`);
    } else if (minecraft) {
      pending = this.vanillaDownload(minecraft);
      warnings.push(`Downloading Minecraft ${minecraft} data for completion`);
    }
    const label = m.name || 'Project';
    const roots = projectRoots(dir);
    const sources: Src[] = roots.map((r) => ({ kind: 'dir', path: r }));
    for (const r of roots) merged.add(scanDir(r), label, 'project');
    for (const j of lockedJars(dir, this.s.paths.downloads)) {
      const scan = cachedJar(j);
      if (scan) (merged.add(scan, stem(j), 'mod'), sources.push({ kind: 'jar', path: j }));
    }
    for (const j of specJars(dir)) {
      if (j === jar) continue;
      const scan = cachedJar(j);
      if (scan) (merged.add(scan, stem(j), 'library'), sources.push({ kind: 'jar', path: j }));
    }
    if (isFile(jar)) sources.push({ kind: 'jar', path: jar });
    merged.finish();
    return { dir, vanilla, minecraft, merged, warnings, pending, sources, roots };
  }

  private vanillaDownload(minecraft: string): string {
    const known = this.downloads.get(minecraft);
    if (known && this.s.ops.get(known)?.status === 'running') return known;
    const installer = new ClientInstaller(this.s.http, path.join(this.s.paths.cache, 'minecraft'));
    const info = this.s.ops.start({ kind: 'registry.download', title: `Download Minecraft ${minecraft} data` }, async (ctx) => {
      ctx.progress(null, `Downloading the Minecraft ${minecraft} client`);
      const jar = await installer.clientJar(minecraft, ctx);
      return { minecraft, jar };
    });
    this.downloads.set(minecraft, info.id);
    return info.id;
  }
}
