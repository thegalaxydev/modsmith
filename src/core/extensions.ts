import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { unzipSync } from 'fflate';
import { PRODUCT } from '../shared/product';
import { EXTENSION_ID, PERMISSIONS, type CatalogExtension, type ExtensionManifest, type ExtensionPermission, type InstalledExtension } from '../shared/extensions';
import type { Services } from './context';
import { downloadVerified, fetchWithRetry, hashFile, USER_AGENT } from './http';
import { compareVersions } from './updates';
import { normalizeRel } from './themes';

const MAX_PACKAGE = 50 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_UNPACKED = 200 * 1024 * 1024;
const MAX_READ = 10 * 1024 * 1024;
export const DEFAULT_INDEX = 'https://thegalaxydev.github.io/modsmith/extensions/index.json';

const indexSource = () => process.env.MODSMITH_EXTENSION_INDEX || DEFAULT_INDEX;
const githubApi = () => process.env.MODSMITH_GITHUB_API || 'https://api.github.com';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const RELEASE = /^\d+\.\d+\.\d+$/;
const PART_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

function fail(message: string): never {
  throw new Error(`extension.json: ${message}`);
}

function optionalText(m: Obj, key: string, max: number) {
  if (m[key] === undefined) return undefined;
  if (!text(m[key], max)) fail(`${key} must be text of ${max} characters at most`);
  return m[key] as string;
}

function optionalLink(m: Obj, key: string) {
  if (m[key] === undefined) return undefined;
  if (typeof m[key] !== 'string' || !/^https:\/\/\S+$/.test(m[key] as string)) fail(`${key} must be an https:// link`);
  return m[key] as string;
}

function packageFile(m: Obj, key: string, ext: string, files: Set<string>) {
  if (m[key] === undefined) return undefined;
  const v = m[key];
  if (typeof v !== 'string' || !v.toLowerCase().endsWith(ext)) fail(`${key} must be a ${ext} file in the package`);
  const rel = normalizeRel('', v, '', 'package');
  if (!files.has(rel)) fail(`${key} points to ${v}, which is not in the package`);
  return rel;
}

function contributions(raw: unknown, key: 'viewers' | 'panels') {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(`contributes.${key} must be a list`);
  const seen = new Set<string>();
  return raw.map((c) => {
    if (!isObj(c)) fail(`contributes.${key} entries must be objects`);
    if (typeof c.id !== 'string' || !PART_ID.test(c.id)) fail(`contributes.${key} ids must be lowercase letters, digits and dashes`);
    if (seen.has(c.id)) fail(`contributes.${key} has ${c.id} twice`);
    seen.add(c.id);
    if (!text(c.title, 60)) fail(`contributes.${key}.${c.id} needs a title of 60 characters at most`);
    if (key === 'panels') return { id: c.id, title: (c.title as string).trim() };
    if (!Array.isArray(c.files) || !c.files.length || !c.files.every((f) => text(f, 200))) fail(`contributes.viewers.${c.id} needs a files list of glob patterns, like ["*.nbt"]`);
    return { id: c.id, title: (c.title as string).trim(), files: c.files as string[] };
  });
}

export function validateManifest(raw: unknown, files: Set<string>): ExtensionManifest {
  if (!isObj(raw)) fail('the file is not a JSON object');
  const m = raw;
  if (typeof m.id !== 'string' || !EXTENSION_ID.test(m.id)) fail('id must be publisher.name in lowercase letters, digits and dashes, like galaxy.nbt-viewer');
  if (!text(m.name, 60)) fail('name is required (60 characters at most)');
  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) fail('version must look like 1.2.3');
  if (!text(m.publisher, 60)) fail('publisher is required (60 characters at most)');
  if (typeof m.modsmith !== 'string' || !RELEASE.test(m.modsmith)) fail('modsmith must be the oldest Modsmith version the extension works with, like 0.1.12');
  const description = optionalText(m, 'description', 300);
  const repository = optionalLink(m, 'repository');
  const homepage = optionalLink(m, 'homepage');
  const license = optionalText(m, 'license', 60);
  const main = packageFile(m, 'main', '.js', files);
  const style = packageFile(m, 'style', '.css', files);
  const perms = m.permissions ?? [];
  if (!Array.isArray(perms)) fail('permissions must be a list');
  const permissions: ExtensionPermission[] = [];
  for (const p of perms) {
    if (typeof p !== 'string' || !(p in PERMISSIONS)) fail(`permissions has an unknown permission ${JSON.stringify(p)}`);
    if (!permissions.includes(p as ExtensionPermission)) permissions.push(p as ExtensionPermission);
  }
  const c = m.contributes ?? {};
  if (!isObj(c)) fail('contributes must be an object');
  const viewers = contributions(c.viewers, 'viewers') as ExtensionManifest['contributes']['viewers'];
  const panels = contributions(c.panels, 'panels');
  if ((viewers.length || panels.length) && !main) fail('main is required when the extension contributes viewers or panels');
  const out: ExtensionManifest = { id: m.id, name: (m.name as string).trim(), version: m.version, publisher: (m.publisher as string).trim(), modsmith: m.modsmith, permissions, contributes: { viewers, panels } };
  if (description !== undefined) out.description = description;
  if (repository !== undefined) out.repository = repository;
  if (homepage !== undefined) out.homepage = homepage;
  if (license !== undefined) out.license = license;
  if (main !== undefined) out.main = main;
  if (style !== undefined) out.style = style;
  return out;
}

export interface ExtensionPackage {
  manifest: ExtensionManifest;
  files: Map<string, Uint8Array>;
}

export function readPackage(file: string): ExtensionPackage {
  const size = fs.statSync(file).size;
  if (size > MAX_PACKAGE) throw new Error('The package is larger than 50 MB');
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(fs.readFileSync(file));
  } catch {
    throw new Error('The package is not a valid .zip file');
  }
  const names = Object.keys(entries);
  if (names.length > MAX_ENTRIES) throw new Error('The package has more than 5000 files');
  let total = 0;
  for (const name of names) {
    if (name.startsWith('/') || name.includes('\\') || name.includes(':') || name.split('/').includes('..')) throw new Error(`The package has an unsafe file path: ${name}`);
    total += entries[name].length;
    if (total > MAX_UNPACKED) throw new Error('The package unpacks to more than 200 MB');
  }
  const fileNames = names.filter((n) => !n.endsWith('/'));
  let prefix = '';
  if (!fileNames.includes('extension.json')) {
    const tops = new Set(fileNames.map((n) => (n.includes('/') ? n.slice(0, n.indexOf('/') + 1) : '')));
    const only = tops.size === 1 ? [...tops][0] : '';
    if (!only || !fileNames.includes(`${only}extension.json`)) throw new Error('The package has no extension.json at its top level');
    prefix = only;
  }
  const files = new Map<string, Uint8Array>();
  for (const n of fileNames) if (n.startsWith(prefix)) files.set(n.slice(prefix.length), entries[n]);
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(files.get('extension.json')!).toString('utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`extension.json: ${(e as Error).message}`);
  }
  return { manifest: validateManifest(raw, new Set(files.keys())), files };
}

function allowedUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`${url} is not a valid link`);
  }
  const local = u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local) throw new Error('Only https:// links can be installed');
  return u;
}

interface Release {
  tag_name?: string;
  assets?: { name?: string; browser_download_url?: string }[];
}

async function resolveLink(url: string): Promise<string> {
  allowedUrl(url);
  const latest = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/releases(?:\/latest)?)?\/?$/.exec(url);
  const tagged = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/releases\/tag\/([^/?#]+)\/?$/.exec(url);
  if (!latest && !tagged) return url;
  const [owner, repo] = latest ? [latest[1], latest[2]] : [tagged![1], tagged![2]];
  const api = latest ? `${githubApi()}/repos/${owner}/${repo}/releases/latest` : `${githubApi()}/repos/${owner}/${repo}/releases/tags/${tagged![3]}`;
  const res = await fetchWithRetry(api, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' } });
  if (res.status === 404) throw new Error(latest ? `${owner}/${repo} has no published release` : `${owner}/${repo} has no release ${tagged![3]}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${api}`);
  const rel = (await res.json()) as Release;
  const zips = (rel.assets ?? []).filter((a) => (a.name ?? '').toLowerCase().endsWith('.zip') && a.browser_download_url);
  const pick = zips.find((a) => (a.name ?? '').toLowerCase().includes('modsmith')) ?? zips[0];
  if (!pick) throw new Error(`The release ${rel.tag_name ?? ''} has no .zip asset; attach the extension package to the release`);
  return pick.browser_download_url!;
}

async function downloadLimited(url: string, dest: string): Promise<void> {
  allowedUrl(url);
  const res = await fetchWithRetry(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} downloading ${url}`);
  const chunks: Buffer[] = [];
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_PACKAGE) {
      await reader.cancel();
      throw new Error('The package is larger than 50 MB');
    }
    chunks.push(Buffer.from(value));
  }
  fs.writeFileSync(dest, Buffer.concat(chunks));
}

interface IndexVersion {
  version: string;
  url: string;
  sha256: string;
  size?: number;
  modsmith: string;
  permissions: ExtensionPermission[];
}

interface IndexEntry {
  id: string;
  name: string;
  publisher: string;
  description?: string;
  repository?: string;
  license?: string;
  versions: IndexVersion[];
}

function readIndex(data: unknown): IndexEntry[] {
  if (!isObj(data) || !Array.isArray(data.extensions)) throw new Error('The extension index is not valid');
  const out: IndexEntry[] = [];
  for (const e of data.extensions) {
    if (!isObj(e) || typeof e.id !== 'string' || !EXTENSION_ID.test(e.id) || typeof e.name !== 'string' || !Array.isArray(e.versions)) continue;
    const versions = e.versions
      .filter((v): v is Obj => isObj(v) && typeof v.version === 'string' && SEMVER.test(v.version) && typeof v.url === 'string' && typeof v.sha256 === 'string' && /^[0-9a-fA-F]{64}$/.test(v.sha256) && typeof v.modsmith === 'string')
      .map((v) => ({ version: v.version as string, url: v.url as string, sha256: (v.sha256 as string).toLowerCase(), size: typeof v.size === 'number' ? v.size : undefined, modsmith: v.modsmith as string, permissions: (Array.isArray(v.permissions) ? v.permissions.filter((p) => typeof p === 'string' && p in PERMISSIONS) : []) as ExtensionPermission[] }))
      .sort((a, b) => compareVersions(b.version, a.version));
    if (!versions.length) continue;
    out.push({ id: e.id, name: e.name, publisher: typeof e.publisher === 'string' ? e.publisher : '', description: typeof e.description === 'string' ? e.description : undefined, repository: typeof e.repository === 'string' ? e.repository : undefined, license: typeof e.license === 'string' ? e.license : undefined, versions });
  }
  return out;
}

const compatible = (v: IndexVersion) => compareVersions(v.modsmith, PRODUCT.version) <= 0;
const newest = (e: IndexEntry) => e.versions.find(compatible) ?? e.versions[0];

export class ExtensionService {
  constructor(private s: Services) {}

  private dir() {
    return path.join(this.s.paths.data, 'extensions');
  }

  private downloads() {
    return path.join(this.dir(), '.downloads');
  }

  private record(id: string): InstalledExtension | null {
    if (!EXTENSION_ID.test(id)) return null;
    try {
      const v = JSON.parse(fs.readFileSync(path.join(this.dir(), id, 'install.json'), 'utf8'));
      return v && v.id === id ? (v as InstalledExtension) : null;
    } catch {
      return null;
    }
  }

  private async index(maxAgeMs: number) {
    const src = indexSource();
    if (!/^https?:\/\//.test(src)) {
      const data = JSON.parse(fs.readFileSync(src, 'utf8'));
      return { source: src, fetchedAt: Date.now(), stale: false, error: null as string | null, entries: readIndex(data) };
    }
    const r = await this.s.http.getJson<unknown>(src, { maxAgeMs });
    return { source: src, fetchedAt: r.fetchedAt, stale: r.stale, error: r.error ?? null, entries: readIndex(r.data) };
  }

  list(): InstalledExtension[] {
    const dir = this.dir();
    if (!fs.existsSync(dir)) return [];
    const out: InstalledExtension[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.') || name.endsWith('.part')) continue;
      const rec = this.record(name);
      if (rec) out.push(rec);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async catalog(force = false) {
    const installed = new Map(this.list().map((r) => [r.id, r.version]));
    let idx;
    try {
      idx = await this.index(force ? 0 : 6 * 3600 * 1000);
    } catch (e) {
      return { source: indexSource(), fetchedAt: Date.now(), stale: false, error: (e as Error).message, extensions: [] as CatalogExtension[] };
    }
    const extensions: CatalogExtension[] = idx.entries
      .map((e) => {
        const v = newest(e);
        const have = installed.get(e.id) ?? null;
        return {
          id: e.id,
          name: e.name,
          publisher: e.publisher,
          description: e.description ?? null,
          repository: e.repository ?? null,
          license: e.license ?? null,
          latest: { version: v.version, modsmith: v.modsmith, permissions: v.permissions, size: v.size ?? null },
          compatible: compatible(v),
          installed: have,
          update: !!have && compatible(v) && compareVersions(v.version, have) > 0
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { source: idx.source, fetchedAt: idx.fetchedAt, stale: idx.stale, error: idx.error, extensions };
  }

  async inspect(p: { file?: string; url?: string }) {
    if (!!p.file === !!p.url) throw new Error('Pass either file or url');
    let file: string;
    let source: InstalledExtension['source'];
    if (p.url) {
      const link = await resolveLink(p.url);
      const dl = this.downloads();
      fs.mkdirSync(dl, { recursive: true });
      const tmp = path.join(dl, `${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`);
      try {
        await downloadLimited(link, tmp);
        const sha = await hashFile(tmp, 'sha256');
        file = path.join(dl, `${sha}.zip`);
        fs.renameSync(tmp, file);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
      source = { kind: 'url', location: p.url };
    } else {
      file = path.resolve(p.file!);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${file} does not exist`);
      source = { kind: 'file', location: file };
    }
    const pkg = readPackage(file);
    const sha256 = await hashFile(file, 'sha256');
    return { manifest: pkg.manifest, file, sha256, size: fs.statSync(file).size, compatible: compareVersions(pkg.manifest.modsmith, PRODUCT.version) <= 0, source, installed: this.record(pkg.manifest.id)?.version ?? null };
  }

  async install(p: { registry?: string; version?: string; file?: string; sha256?: string; url?: string }) {
    if (p.registry) return this.installVerified(p.registry, p.version);
    if (!p.file) throw new Error('Pass registry or file');
    const file = path.resolve(p.file);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${file} does not exist`);
    const sha256 = await hashFile(file, 'sha256');
    if (p.sha256 && p.sha256.toLowerCase() !== sha256) throw new Error('The package changed since it was inspected (SHA-256 mismatch)');
    const pkg = readPackage(file);
    return this.place(pkg, sha256, false, p.url ? { kind: 'url', location: p.url } : { kind: 'file', location: file });
  }

  private async installVerified(id: string, version?: string) {
    const idx = await this.index(0);
    const entry = idx.entries.find((e) => e.id === id);
    if (!entry) throw new Error(`No Verified extension ${id}`);
    let v: IndexVersion | undefined;
    if (version) {
      v = entry.versions.find((x) => x.version === version);
      if (!v) throw new Error(`${id} has no Verified version ${version}`);
    } else v = entry.versions.find(compatible);
    if (!v || !compatible(v)) {
      const need = v ?? entry.versions[0];
      throw new Error(`${entry.name} ${need.version} needs Modsmith ${need.modsmith} or newer; this is ${PRODUCT.version}`);
    }
    allowedUrl(v.url);
    const dest = path.join(this.downloads(), `${v.sha256}.zip`);
    await downloadVerified({ url: v.url, dest, sha256: v.sha256 });
    const pkg = readPackage(dest);
    if (pkg.manifest.id !== id || pkg.manifest.version !== v.version) throw new Error(`The downloaded package is ${pkg.manifest.id} ${pkg.manifest.version}, not ${id} ${v.version}`);
    for (const perm of pkg.manifest.permissions) if (!v.permissions.includes(perm)) throw new Error(`The package asks for ${perm}, which was not approved for this version`);
    return this.place(pkg, v.sha256, true, { kind: 'registry', location: v.url });
  }

  private place(pkg: ExtensionPackage, sha256: string, verified: boolean, source: InstalledExtension['source']) {
    const m = pkg.manifest;
    if (compareVersions(m.modsmith, PRODUCT.version) > 0) throw new Error(`${m.name} ${m.version} needs Modsmith ${m.modsmith} or newer; this is ${PRODUCT.version}`);
    const dir = this.dir();
    const previous = this.record(m.id);
    const target = path.join(dir, m.id);
    const part = path.join(dir, `${m.id}.part`);
    fs.rmSync(part, { recursive: true, force: true });
    fs.mkdirSync(path.join(part, 'files'), { recursive: true });
    for (const [rel, bytes] of pkg.files) {
      const dest = path.join(part, 'files', rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes);
    }
    const rec: InstalledExtension = { id: m.id, name: m.name, version: m.version, publisher: m.publisher, description: m.description ?? null, manifest: m, enabled: previous?.enabled ?? true, verified, source, sha256, installedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(part, 'install.json'), JSON.stringify(rec, null, 2));
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(part, target);
    return { installed: rec, previous: previous?.version ?? null };
  }

  remove(id: string) {
    if (!this.record(id)) throw new Error(`No installed extension ${id}`);
    fs.rmSync(path.join(this.dir(), id), { recursive: true, force: true });
    return { removed: id };
  }

  setEnabled(id: string, enabled: boolean) {
    const rec = this.record(id);
    if (!rec) throw new Error(`No installed extension ${id}`);
    rec.enabled = enabled;
    fs.writeFileSync(path.join(this.dir(), id, 'install.json'), JSON.stringify(rec, null, 2));
    return rec;
  }

  read(id: string, file: string) {
    if (!this.record(id)) throw new Error(`No installed extension ${id}`);
    const rel = normalizeRel('', file, '', 'extension');
    const full = path.join(this.dir(), id, 'files', rel);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      throw new Error(`${rel} is not in ${id}`);
    }
    if (!st.isFile()) throw new Error(`${rel} is not in ${id}`);
    if (st.size > MAX_READ) throw new Error(`${rel} is larger than 10 MB`);
    const buf = fs.readFileSync(full);
    const binary = buf.subarray(0, 8000).includes(0);
    return { file: rel, content: binary ? buf.toString('base64') : buf.toString('utf8'), binary, size: st.size };
  }
}
