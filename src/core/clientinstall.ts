import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { downloadVerified } from './http';
import { runProcess } from './proc';
import type { HttpClient } from './http';
import type { OpContext } from './operations';

export interface Rule {
  action: 'allow' | 'disallow';
  os?: { name?: string; arch?: string; version?: string };
  features?: Record<string, boolean>;
}

export interface Artifact {
  path?: string;
  sha1?: string;
  size?: number;
  url?: string;
}

export interface Library {
  name: string;
  url?: string;
  sha1?: string;
  size?: number;
  downloads?: { artifact?: Artifact; classifiers?: Record<string, Artifact> };
  natives?: Record<string, string>;
  rules?: Rule[];
}

export type Argument = string | { rules?: Rule[]; value: string | string[] };

export interface VersionJson {
  id: string;
  inheritsFrom?: string;
  type?: string;
  mainClass: string;
  arguments?: { game?: Argument[]; jvm?: Argument[] };
  minecraftArguments?: string;
  libraries: Library[];
  assetIndex?: { id: string; sha1: string; size: number; url: string; totalSize?: number };
  assets?: string;
  downloads?: { client?: Artifact };
  javaVersion?: { majorVersion: number };
}

export interface Platform {
  os: 'windows' | 'osx' | 'linux';
  arch: string;
}

export function currentPlatform(): Platform {
  return { os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux', arch: os.arch() === 'ia32' ? 'x86' : os.arch() };
}

export function rulesAllow(rules: Rule[] | undefined, platform: Platform, features: Record<string, boolean> = {}): boolean {
  if (!rules?.length) return true;
  let allowed = false;
  for (const r of rules) {
    let match = true;
    if (r.os?.name && r.os.name !== platform.os) match = false;
    if (r.os?.arch && r.os.arch !== platform.arch) match = false;
    if (r.features) for (const [k, v] of Object.entries(r.features)) if ((features[k] ?? false) !== v) match = false;
    if (match) allowed = r.action === 'allow';
  }
  return allowed;
}

export function mavenPath(name: string): string {
  const [coords, ext = 'jar'] = name.split('@');
  const parts = coords.split(':');
  const [group, artifact, version, classifier] = parts;
  if (!group || !artifact || !version) throw new Error(`Invalid library name ${name}`);
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`;
}

function libraryKey(name: string): string {
  const parts = name.split('@')[0].split(':');
  return [parts[0], parts[1], parts[3] ?? ''].join(':');
}

export function mergeVersions(child: VersionJson, parent: VersionJson): VersionJson {
  const childKeys = new Set(child.libraries.map((l) => libraryKey(l.name)));
  return {
    ...parent,
    ...child,
    inheritsFrom: undefined,
    libraries: [...child.libraries, ...parent.libraries.filter((l) => !childKeys.has(libraryKey(l.name)))],
    arguments: { game: [...(parent.arguments?.game ?? []), ...(child.arguments?.game ?? [])], jvm: [...(parent.arguments?.jvm ?? []), ...(child.arguments?.jvm ?? [])] },
    assetIndex: child.assetIndex ?? parent.assetIndex,
    assets: child.assets ?? parent.assets,
    downloads: child.downloads ?? parent.downloads,
    javaVersion: child.javaVersion ?? parent.javaVersion
  };
}

export interface ResolvedLibrary {
  name: string;
  file: string;
  url?: string;
  sha1?: string;
  size?: number;
}

export function libraryFiles(version: VersionJson, librariesDir: string, platform: Platform): ResolvedLibrary[] {
  const out: ResolvedLibrary[] = [];
  const seen = new Set<string>();
  for (const lib of version.libraries) {
    if (!rulesAllow(lib.rules, platform)) continue;
    const add = (rel: string, a: Artifact | undefined, fallbackUrl?: string) => {
      const file = path.join(librariesDir, ...rel.split('/'));
      if (seen.has(file)) return;
      seen.add(file);
      out.push({ name: lib.name, file, url: a?.url || fallbackUrl, sha1: a?.sha1 ?? lib.sha1, size: a?.size ?? lib.size });
    };
    const art = lib.downloads?.artifact;
    if (art?.path) add(art.path, art);
    else if (!lib.downloads) add(mavenPath(lib.name), undefined, `${(lib.url ?? 'https://libraries.minecraft.net/').replace(/\/?$/, '/')}${mavenPath(lib.name)}`);
    const nativeKey = lib.natives?.[platform.os]?.replace('${arch}', platform.arch.endsWith('64') ? '64' : '32');
    const nat = nativeKey ? lib.downloads?.classifiers?.[nativeKey] : undefined;
    if (nat?.path) add(nat.path, nat);
  }
  return out;
}

export function offlineUuid(name: string): string {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const h = md5.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function expandArguments(args: Argument[] | undefined, vars: Record<string, string>, platform: Platform, features: Record<string, boolean> = {}): string[] {
  const out: string[] = [];
  for (const a of args ?? []) {
    if (typeof a === 'string') out.push(a);
    else if (rulesAllow(a.rules, platform, features)) out.push(...(Array.isArray(a.value) ? a.value : [a.value]));
  }
  return out.map((s) => s.replace(/\$\{([a-zA-Z_]+)\}/g, (m, k: string) => (k in vars ? vars[k] : m)));
}

export interface ClientLaunch {
  mainClass: string;
  jvmArgs: string[];
  gameArgs: string[];
  javaMajor: number | null;
}

export function buildClientLaunch(version: VersionJson, opts: { librariesDir: string; clientJar: string; gameDir: string; assetsDir: string; nativesDir: string; username: string; platform: Platform; launcherName: string; launcherVersion: string }): ClientLaunch {
  const libs = libraryFiles(version, opts.librariesDir, opts.platform).map((l) => l.file);
  const classpath = [...libs, opts.clientJar].join(path.delimiter);
  const vars: Record<string, string> = {
    auth_player_name: opts.username,
    version_name: version.id,
    game_directory: opts.gameDir,
    assets_root: opts.assetsDir,
    game_assets: opts.assetsDir,
    assets_index_name: version.assetIndex?.id ?? version.assets ?? '',
    auth_uuid: offlineUuid(opts.username).replace(/-/g, ''),
    auth_access_token: '0',
    auth_session: '0',
    clientid: '0',
    auth_xuid: '0',
    user_type: 'legacy',
    user_properties: '{}',
    version_type: version.type ?? 'release',
    natives_directory: opts.nativesDir,
    launcher_name: opts.launcherName,
    launcher_version: opts.launcherVersion,
    classpath,
    classpath_separator: path.delimiter,
    library_directory: opts.librariesDir
  };
  const jvmArgs = version.arguments?.jvm ? expandArguments(version.arguments.jvm, vars, opts.platform) : [`-Djava.library.path=${opts.nativesDir}`, '-cp', classpath];
  if (!jvmArgs.includes('-cp') && !jvmArgs.includes('-classpath')) jvmArgs.push('-cp', classpath);
  const gameArgs = version.arguments?.game ? expandArguments(version.arguments.game, vars, opts.platform) : (version.minecraftArguments ?? '').split(' ').filter(Boolean).map((s) => s.replace(/\$\{([a-zA-Z_]+)\}/g, (m, k: string) => vars[k] ?? m));
  return { mainClass: version.mainClass, jvmArgs, gameArgs, javaMajor: version.javaVersion?.majorVersion ?? null };
}

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

export interface InstalledClient {
  version: VersionJson;
  root: string;
  librariesDir: string;
  assetsDir: string;
  clientJar: string;
}

export class ClientInstaller {
  constructor(private http: HttpClient, private root: string) {}

  get librariesDir(): string {
    return path.join(this.root, 'libraries');
  }

  get assetsDir(): string {
    return path.join(this.root, 'assets');
  }

  private versionDir(id: string): string {
    return path.join(this.root, 'versions', id);
  }

  async vanilla(minecraft: string, ctx: OpContext): Promise<VersionJson> {
    const file = path.join(this.versionDir(minecraft), `${minecraft}.json`);
    const manifest = await this.http.getJson<{ versions: { id: string; url: string; sha1: string }[] }>(MANIFEST_URL, { signal: ctx.signal, maxAgeMs: 6 * 3600 * 1000 });
    const entry = manifest.data.versions.find((v) => v.id === minecraft);
    if (!entry) throw new Error(`Minecraft ${minecraft} is not in the Mojang version manifest`);
    await downloadVerified({ url: entry.url, dest: file, sha1: entry.sha1, signal: ctx.signal });
    return JSON.parse(fs.readFileSync(file, 'utf8')) as VersionJson;
  }

  async fabric(minecraft: string, loaderVersion: string, ctx: OpContext): Promise<VersionJson> {
    const res = await this.http.getJson<VersionJson>(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(minecraft)}/${encodeURIComponent(loaderVersion)}/profile/json`, { signal: ctx.signal, maxAgeMs: 24 * 3600 * 1000 });
    const v = res.data;
    fs.mkdirSync(this.versionDir(v.id), { recursive: true });
    fs.writeFileSync(path.join(this.versionDir(v.id), `${v.id}.json`), JSON.stringify(v, null, 2));
    return v;
  }

  async neoforge(minecraft: string, loaderVersion: string, java: string, ctx: OpContext): Promise<VersionJson> {
    const id = `neoforge-${loaderVersion}`;
    const file = path.join(this.versionDir(id), `${id}.json`);
    if (!fs.existsSync(file)) {
      const url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
      const shaRes = await fetch(`${url}.sha1`, { signal: ctx.signal });
      if (!shaRes.ok) throw new Error(`Could not fetch the NeoForge installer checksum (${shaRes.status})`);
      const sha1 = (await shaRes.text()).trim().slice(0, 40);
      const jar = await downloadVerified({ url, dest: path.join(this.root, 'installers', `neoforge-${loaderVersion}-installer.jar`), sha1, signal: ctx.signal });
      const profiles = path.join(this.root, 'launcher_profiles.json');
      if (!fs.existsSync(profiles)) fs.writeFileSync(profiles, JSON.stringify({ profiles: {} }));
      ctx.log(`Installing NeoForge ${loaderVersion} client`);
      const r = await runProcess(java, ['-jar', jar.path, '--install-client', this.root], { cwd: this.root, signal: ctx.signal, onLine: (l) => ctx.log(l) });
      if (r.code !== 0 || !fs.existsSync(file)) throw new Error(`The NeoForge client installer failed (exit ${r.code})`);
    }
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as VersionJson;
    if (v.inheritsFrom && v.inheritsFrom !== minecraft) throw new Error(`NeoForge ${loaderVersion} is for Minecraft ${v.inheritsFrom}, not ${minecraft}`);
    return v;
  }

  private async mavenSha1(url: string, signal?: AbortSignal): Promise<string> {
    const res = await fetch(`${url}.sha1`, { signal });
    if (!res.ok) throw new Error(`No published checksum for ${url} (${res.status})`);
    return (await res.text()).trim().slice(0, 40);
  }

  async install(loader: 'fabric' | 'neoforge', minecraft: string, loaderVersion: string, java: string, ctx: OpContext): Promise<InstalledClient> {
    ctx.progress(0.1, `Preparing Minecraft ${minecraft}`);
    const vanilla = await this.vanilla(minecraft, ctx);
    const child = loader === 'fabric' ? await this.fabric(minecraft, loaderVersion, ctx) : await this.neoforge(minecraft, loaderVersion, java, ctx);
    const version = mergeVersions(child, vanilla);
    const platform = currentPlatform();
    const clientJar = path.join(this.versionDir(minecraft), `${minecraft}.jar`);
    const client = vanilla.downloads?.client;
    if (!client?.url || !client.sha1) throw new Error(`Minecraft ${minecraft} has no client download`);
    ctx.progress(0.15, `Downloading Minecraft ${minecraft}`);
    await downloadVerified({ url: client.url, dest: clientJar, sha1: client.sha1, size: client.size, signal: ctx.signal });
    const libs = libraryFiles(version, this.librariesDir, platform);
    let done = 0;
    await this.pool(libs, 8, async (l) => {
      ctx.throwIfCancelled();
      if (!fs.existsSync(l.file) || l.sha1) {
        if (!l.url) {
          if (!fs.existsSync(l.file)) throw new Error(`Library ${l.name} has no download URL`);
        } else {
          const sha1 = l.sha1 ?? (await this.mavenSha1(l.url, ctx.signal));
          await downloadVerified({ url: l.url, dest: l.file, sha1, size: l.size, signal: ctx.signal });
        }
      }
      done++;
      if (done % 10 === 0) ctx.progress(0.2 + (0.3 * done) / libs.length, `Libraries ${done}/${libs.length}`);
    });
    const idx = version.assetIndex;
    if (!idx) throw new Error(`Minecraft ${minecraft} has no asset index`);
    const indexFile = path.join(this.assetsDir, 'indexes', `${idx.id}.json`);
    await downloadVerified({ url: idx.url, dest: indexFile, sha1: idx.sha1, size: idx.size, signal: ctx.signal });
    const objects = Object.values((JSON.parse(fs.readFileSync(indexFile, 'utf8')) as { objects: Record<string, { hash: string; size: number }> }).objects);
    const missing = objects.filter((o) => !fs.existsSync(path.join(this.assetsDir, 'objects', o.hash.slice(0, 2), o.hash)));
    if (missing.length) ctx.log(`Downloading ${missing.length} of ${objects.length} game assets`);
    let got = 0;
    await this.pool(missing, 16, async (o) => {
      ctx.throwIfCancelled();
      await downloadVerified({ url: `https://resources.download.minecraft.net/${o.hash.slice(0, 2)}/${o.hash}`, dest: path.join(this.assetsDir, 'objects', o.hash.slice(0, 2), o.hash), sha1: o.hash, size: o.size, signal: ctx.signal });
      got++;
      if (got % 100 === 0) ctx.progress(0.5 + (0.35 * got) / missing.length, `Assets ${got}/${missing.length}`);
    });
    return { version, root: this.root, librariesDir: this.librariesDir, assetsDir: this.assetsDir, clientJar };
  }

  private async pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
    let i = 0;
    const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    });
    await Promise.all(workers);
  }
}
