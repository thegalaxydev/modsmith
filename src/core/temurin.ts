import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { unzipSync } from 'fflate';
import type { JavaInstallation, OperationInfo } from '../shared/types';
import type { Services } from './context';
import type { OpContext } from './operations';
import { downloadVerified, fetchWithRetry, USER_AGENT } from './http';
import type { WorkspaceService } from './workspace';

export const adoptiumApi = () => process.env.MODSMITH_ADOPTIUM_API || 'https://api.adoptium.net/v3';

export function platform(): { os: string; arch: string } {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const arches: Record<string, string> = { x64: 'x64', arm64: 'aarch64', ia32: 'x32', arm: 'arm', ppc64: 'ppc64le' };
  return { os, arch: arches[process.arch] ?? process.arch };
}

export const jdksDir = (data: string) => path.join(data, 'jdks');

const mb = (n: number) => Math.floor(n / 1048576);

export function safeRel(name: string): string | null {
  const parts: string[] = [];
  for (const part of name.split(/[/\\]/)) {
    if (!part || part === '.') continue;
    if (part === '..' || part.includes(':')) throw new Error(`Refusing to unpack unsafe archive entry ${name}`);
    parts.push(part);
  }
  return parts.length ? path.join(...parts) : null;
}

function unzip(archive: string, out: string): void {
  const entries = unzipSync(new Uint8Array(fs.readFileSync(archive)));
  for (const [name, data] of Object.entries(entries)) {
    const rel = safeRel(name);
    if (!rel) continue;
    const target = path.join(out, rel);
    if (name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
}

const cstr = (b: Buffer) => {
  const end = b.indexOf(0);
  return b.subarray(0, end < 0 ? b.length : end).toString('utf8');
};
const octal = (b: Buffer) => parseInt(cstr(b).trim(), 8) || 0;

export function pax(data: Buffer): [string, string][] {
  const out: [string, string][] = [];
  let rest = data;
  while (rest.length) {
    const sp = rest.indexOf(0x20);
    if (sp < 0) break;
    const len = Number(rest.subarray(0, sp).toString('utf8'));
    if (!Number.isInteger(len) || len === 0 || len > rest.length || len <= sp + 1) break;
    const record = rest.subarray(sp + 1, len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq >= 0) out.push([record.slice(0, eq), record.slice(eq + 1)]);
    rest = rest.subarray(len);
  }
  return out;
}

function untar(archive: string, out: string): void {
  const buf = zlib.gunzipSync(fs.readFileSync(archive));
  let longName: string | null = null;
  let longLink: string | null = null;
  const links: [string, string][] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = octal(h.subarray(124, 136));
    const padded = Math.ceil(size / 512) * 512;
    const kind = h[156];
    const dataStart = off + 512;
    if (dataStart + padded > buf.length) throw new Error('Truncated archive');
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + padded;
    const ch = String.fromCharCode(kind);
    if (ch === 'L') {
      longName = cstr(data);
      continue;
    }
    if (ch === 'K') {
      longLink = cstr(data);
      continue;
    }
    if (ch === 'x') {
      for (const [k, v] of pax(data)) {
        if (k === 'path') longName = v;
        else if (k === 'linkpath') longLink = v;
      }
      continue;
    }
    if (ch === 'g') continue;
    let name = cstr(h.subarray(0, 100));
    if (h.subarray(257, 262).toString('latin1') === 'ustar') {
      const prefix = cstr(h.subarray(345, 500));
      if (prefix) name = `${prefix}/${name}`;
    }
    name = longName ?? name;
    const link = longLink ?? cstr(h.subarray(157, 257));
    longName = null;
    longLink = null;
    const mode = octal(h.subarray(100, 108));
    const rel = safeRel(name);
    if (!rel) continue;
    const target = path.join(out, rel);
    if (ch === '5') {
      fs.mkdirSync(target, { recursive: true });
    } else if (ch === '0' || kind === 0 || ch === '7') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      if (process.platform !== 'win32') fs.chmodSync(target, mode & 0o777);
    } else if (ch === '2') {
      if (link.startsWith('/')) throw new Error(`Refusing to unpack unsafe archive entry ${name}`);
      let depth = path.dirname(rel) === '.' ? 0 : path.dirname(rel).split(path.sep).length;
      for (const part of link.split('/')) {
        if (!part || part === '.') continue;
        depth += part === '..' ? -1 : 1;
        if (depth < 0) throw new Error(`Refusing to unpack unsafe archive entry ${name}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (process.platform !== 'win32') fs.symlinkSync(link, target);
    } else if (ch === '1') {
      const src = safeRel(link);
      if (src) links.push([path.join(out, src), target]);
    }
  }
  for (const [src, target] of links) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(src, target);
  }
}

export function unpack(archive: string, out: string): void {
  const name = path.basename(archive).toLowerCase();
  if (name.endsWith('.zip')) unzip(archive, out);
  else if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) untar(archive, out);
  else throw new Error(`Unsupported archive ${name}`);
}

interface Asset {
  release_name?: string;
  binary?: { package?: { name?: string; checksum?: string; size?: number } };
}

export interface JavaRequirement {
  purpose: 'gradle' | 'runtime';
  major: number;
  jdk: boolean;
  java: JavaInstallation | null;
}

export class TemurinService {
  constructor(private s: Services, private ws: WorkspaceService) {}

  install(major: number, imageType: 'jdk' | 'jre' = 'jdk'): OperationInfo {
    const image = imageType === 'jre' ? 'jre' : 'jdk';
    return this.s.ops.start({ kind: 'java.install', title: `Download Java ${major} (${image.toUpperCase()})` }, (ctx) => this.installSteps(major, image, ctx));
  }

  private async installSteps(major: number, image: string, ctx: OpContext): Promise<JavaInstallation> {
    const api = adoptiumApi();
    const { os, arch } = platform();
    const unavailable = () => new Error(`Eclipse Temurin ${major} (${image}) is not available for ${os} ${arch}`);
    ctx.progress(0, `Looking up Eclipse Temurin ${major}`);
    const url = `${api}/assets/latest/${major}/hotspot?${new URLSearchParams({ architecture: arch, image_type: image, os, vendor: 'eclipse' })}`;
    const res = await fetchWithRetry(url, { signal: ctx.signal, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    const body = await res.text();
    if (res.status === 404) throw unavailable();
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}: ${body.slice(0, 200)}`);
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error(`Unexpected response from ${url}`);
    }
    const asset = Array.isArray(data) ? (data as Asset[]).find((x) => typeof x?.binary?.package?.checksum === 'string' && typeof x?.binary?.package?.name === 'string') : undefined;
    if (!asset) throw unavailable();
    const pkg = asset.binary!.package!;
    const name = pkg.name!;
    if (/[/\\]/.test(name) || name.startsWith('.')) throw new Error(`Unexpected package name ${name}`);
    const size = typeof pkg.size === 'number' && Number.isInteger(pkg.size) && pkg.size >= 0 ? pkg.size : undefined;
    const release = typeof asset.release_name === 'string' ? asset.release_name : name;
    ctx.log(`Eclipse Temurin ${release} (${image}, ${os} ${arch}): ${name}`);
    const bin = `${api}/binary/latest/${major}/ga/${os}/${arch}/${image}/hotspot/normal/eclipse`;
    const dl = await downloadVerified({
      url: bin,
      dest: path.join(this.s.paths.downloads, 'temurin', name),
      sha256: pkg.checksum,
      size,
      signal: ctx.signal,
      onProgress: (received, totalHeader) => {
        const total = totalHeader ?? size ?? 0;
        ctx.progress(total > 0 ? 0.02 + 0.83 * Math.min(1, received / total) : 0.02, `Downloading ${name} (${mb(received)} of ${mb(total)} MB)`);
      }
    });
    ctx.log(dl.cached ? 'Using the verified download from the cache' : 'Downloaded and verified the SHA-256 checksum');
    ctx.throwIfCancelled();
    ctx.progress(0.88, `Unpacking ${name}`);
    const root = jdksDir(this.s.paths.data);
    fs.mkdirSync(root, { recursive: true });
    const tmp = path.join(root, `.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    let target: string;
    try {
      unpack(dl.path, tmp);
      const tops = fs.readdirSync(tmp).map((n) => path.join(tmp, n));
      if (tops.length !== 1 || !fs.statSync(tops[0]).isDirectory()) throw new Error(`Unexpected archive layout in ${name}`);
      target = path.join(root, path.basename(tops[0]));
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(tops[0], target);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    fs.rmSync(dl.path, { force: true });
    ctx.progress(0.96, 'Detecting Java');
    const macHome = path.join(target, 'Contents', 'Home');
    const home = fs.existsSync(macHome) && fs.statSync(macHome).isDirectory() ? macHome : target;
    const found = (await this.s.java.list(true)).find((j) => path.resolve(j.home).toLowerCase() === path.resolve(home).toLowerCase());
    if (!found) throw new Error(`Eclipse Temurin ${release} was unpacked to ${home} but its Java runtime did not start`);
    ctx.log(`Installed Eclipse Temurin ${found.version} at ${home}`);
    return found;
  }

  async requirements(p: { catalogEntryId?: string; path?: string; profile?: string; mode?: string }): Promise<{ requirements: JavaRequirement[]; install: { major: number; imageType: 'jdk' | 'jre' }[] }> {
    const reqs: { purpose: 'gradle' | 'runtime'; major: number; jdk: boolean; prefer?: string }[] = [];
    if (p.catalogEntryId) {
      const e = this.s.catalog.get(p.catalogEntryId);
      if (!e) throw new Error(`Unknown catalog entry ${p.catalogEntryId}`);
      reqs.push({ purpose: 'gradle', major: e.gradleJavaMin ?? 21, jdk: true });
    } else if (p.path) {
      const dir = this.ws.normalize(p.path);
      const m = this.ws.requireManifest(dir);
      const cat = m.platform.catalogEntry ? this.s.catalog.get(m.platform.catalogEntry) : undefined;
      const gradle = cat?.gradleJavaMin ?? 21;
      if (!p.profile) {
        reqs.push({ purpose: 'gradle', major: gradle, jdk: true });
      } else {
        const profile = m.profiles.find((x) => x.id === p.profile);
        if (!profile) throw new Error(`Unknown profile ${p.profile}`);
        const mode = p.mode ?? profile.mode;
        if (m.source.kind === 'gradle' || mode === 'development') reqs.push({ purpose: 'gradle', major: gradle, jdk: true });
        reqs.push({ purpose: 'runtime', major: profile.java.minMajor ?? cat?.runtimeJavaMin ?? 21, jdk: false, prefer: profile.java.home || undefined });
      }
    } else {
      throw new Error('Give a catalogEntryId or a workspace path');
    }
    const requirements: JavaRequirement[] = [];
    const install: { major: number; jdk: boolean }[] = [];
    for (const r of reqs) {
      const java = await this.s.java.select({ minMajor: r.major, requireJdk: r.jdk, preferHome: r.prefer });
      if (!java) {
        const existing = install.find((i) => i.major === r.major);
        if (existing) existing.jdk ||= r.jdk;
        else install.push({ major: r.major, jdk: r.jdk });
      }
      requirements.push({ purpose: r.purpose, major: r.major, jdk: r.jdk, java });
    }
    return { requirements, install: install.map((i) => ({ major: i.major, imageType: i.jdk ? 'jdk' : 'jre' })) };
  }
}
