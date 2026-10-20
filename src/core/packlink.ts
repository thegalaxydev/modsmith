import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { PRODUCT } from '../shared/product';
import { readManifest } from './manifest';
import { readJarMetadata, type ModMetadata } from './jarmeta';

export const LinkedPackSchema = z.object({
  path: z.string().min(1),
  enabled: z.boolean().default(true),
  configs: z.boolean().default(true)
});
export type LinkedPack = z.infer<typeof LinkedPackSchema>;

export const LinksFileSchema = z.record(z.string(), z.array(LinkedPackSchema));

export type PackKind = 'curseforge' | 'modrinth' | 'prism' | 'modsmith' | 'folder';
export type PackLoader = 'fabric' | 'neoforge' | 'forge' | 'quilt';

export interface PackJar {
  file: string;
  name: string;
}

export interface PackFolder {
  path: string;
  kind: PackKind;
  name: string;
  gameDir: string;
  minecraft?: string;
  loader?: PackLoader;
  loaderVersion?: string;
  jars: PackJar[];
  disabledJars: number;
  configDirs: string[];
  problems: string[];
}

const CONFIG_DIRS = ['config', 'defaultconfigs', 'kubejs'];

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function parseLoader(text: string | undefined | null): { loader?: PackLoader; version?: string } {
  if (!text) return {};
  const t = text.toLowerCase();
  const m = /^(neoforge|fabric|forge|quilt)[-_ ]?(.*)$/.exec(t);
  if (m) return { loader: m[1] as PackLoader, version: m[2] || undefined };
  if (t.includes('neoforged')) return { loader: 'neoforge' };
  if (t.includes('fabric')) return { loader: 'fabric' };
  if (t.includes('quilt')) return { loader: 'quilt' };
  if (t.includes('forge')) return { loader: 'forge' };
  return {};
}

function listJars(modsDir: string): { jars: PackJar[]; disabled: number } {
  if (!fs.existsSync(modsDir)) return { jars: [], disabled: 0 };
  const jars: PackJar[] = [];
  let disabled = 0;
  for (const e of fs.readdirSync(modsDir, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const lower = e.name.toLowerCase();
    if (lower.endsWith('.jar')) jars.push({ file: path.join(modsDir, e.name), name: e.name });
    else if (lower.endsWith('.jar.disabled')) disabled++;
  }
  jars.sort((a, b) => a.name.localeCompare(b.name));
  return { jars, disabled };
}

function modrinthAppMeta(profileDir: string): { name?: string; minecraft?: string; loader?: string; loaderVersion?: string } {
  const legacy = readJson(path.join(profileDir, 'profile.json')) as { metadata?: { name?: string; game_version?: string; loader?: string; loader_version?: { id?: string } } } | null;
  if (legacy?.metadata) return { name: legacy.metadata.name, minecraft: legacy.metadata.game_version, loader: legacy.metadata.loader, loaderVersion: legacy.metadata.loader_version?.id };
  const appDir = path.dirname(path.dirname(profileDir));
  const db = path.join(appDir, 'app.db');
  if (!fs.existsSync(db)) return {};
  try {
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const conn = new DatabaseSync(db, { readOnly: true });
    try {
      const row = conn.prepare('SELECT name, game_version, mod_loader, mod_loader_version FROM profiles WHERE path = ?').get(path.basename(profileDir)) as { name?: string; game_version?: string; mod_loader?: string; mod_loader_version?: string } | undefined;
      return row ? { name: row.name, minecraft: row.game_version, loader: row.mod_loader, loaderVersion: row.mod_loader_version } : {};
    } finally {
      conn.close();
    }
  } catch {
    return {};
  }
}

function isModrinthAppProfile(dir: string): boolean {
  const parent = path.basename(path.dirname(dir)).toLowerCase();
  const app = path.basename(path.dirname(path.dirname(dir))).toLowerCase();
  return parent === 'profiles' && (app === 'modrinthapp' || app === 'com.modrinth.theseus' || fs.existsSync(path.join(dir, 'profile.json')));
}

function modsmithPack(root: string, side: 'client' | 'server'): PackFolder | null {
  const { manifest } = readManifest(root);
  if (!manifest) return null;
  const state = path.join(root, PRODUCT.stateDir);
  const profile = manifest.profiles.find((p) => p.side === side) ?? manifest.profiles[0];
  const problems: string[] = [];
  const jars: PackJar[] = [];
  if (manifest.type === 'mod') problems.push(`${manifest.name} is a mod project, not a modpack`);
  if (!profile) problems.push(`${manifest.name} has no test profiles`);
  else {
    const filesJson = readJson(path.join(state, `resolved-${profile.id}.files.json`)) as { files?: Record<string, string> } | null;
    if (!filesJson?.files) problems.push(`Open ${manifest.name} in ${PRODUCT.name} and press Play once so its mods are downloaded`);
    else for (const f of Object.values(filesJson.files)) if (fs.existsSync(f) && !path.basename(f).startsWith(`${PRODUCT.id}-bridge`)) jars.push({ file: f, name: path.basename(f) });
  }
  const configDirs = profile?.configDir ? [path.join(root, profile.configDir)].filter((d) => fs.existsSync(d)) : [];
  return { path: root, kind: 'modsmith', name: manifest.name, gameDir: root, minecraft: manifest.platform.minecraft, loader: manifest.platform.loader, loaderVersion: manifest.platform.loaderVersion, jars, disabledJars: 0, configDirs, problems };
}

export function detectPackFolder(input: string, side: 'client' | 'server' = 'client'): PackFolder {
  let dir = path.resolve(input);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Folder not found: ${input}`);
  if (path.basename(dir).toLowerCase() === 'mods') dir = path.dirname(dir);
  if (fs.existsSync(path.join(dir, PRODUCT.manifestFile))) {
    const pack = modsmithPack(dir, side);
    if (pack) return pack;
  }
  let kind: PackKind = 'folder';
  let name = path.basename(dir);
  let gameDir = dir;
  let minecraft: string | undefined;
  let loaderText: string | undefined;
  let loaderVersion: string | undefined;
  const cf = readJson(path.join(dir, 'minecraftinstance.json')) as { name?: string; gameVersion?: string; baseModLoader?: { name?: string; minecraftVersion?: string } } | null;
  const mmc = readJson(path.join(dir, 'mmc-pack.json')) as { components?: { uid?: string; version?: string; cachedName?: string }[] } | null;
  if (cf) {
    kind = 'curseforge';
    name = cf.name ?? name;
    minecraft = cf.gameVersion ?? cf.baseModLoader?.minecraftVersion;
    loaderText = cf.baseModLoader?.name;
  } else if (mmc) {
    kind = 'prism';
    const cfg = fs.existsSync(path.join(dir, 'instance.cfg')) ? fs.readFileSync(path.join(dir, 'instance.cfg'), 'utf8') : '';
    name = /^name=(.*)$/m.exec(cfg)?.[1]?.trim() || name;
    gameDir = ['.minecraft', 'minecraft'].map((d) => path.join(dir, d)).find((d) => fs.existsSync(d)) ?? path.join(dir, '.minecraft');
    for (const c of mmc.components ?? []) {
      if (c.uid === 'net.minecraft') minecraft = c.version;
      else if (c.uid === 'net.fabricmc.fabric-loader') (loaderText = 'fabric'), (loaderVersion = c.version);
      else if (c.uid === 'net.neoforged') (loaderText = 'neoforge'), (loaderVersion = c.version);
      else if (c.uid === 'net.minecraftforge') (loaderText = 'forge'), (loaderVersion = c.version);
      else if (c.uid === 'org.quiltmc.quilt-loader') (loaderText = 'quilt'), (loaderVersion = c.version);
    }
  } else if (isModrinthAppProfile(dir)) {
    kind = 'modrinth';
    const meta = modrinthAppMeta(dir);
    name = meta.name ?? name;
    minecraft = meta.minecraft;
    loaderText = meta.loader;
    loaderVersion = meta.loaderVersion;
  }
  const parsed = parseLoader(loaderText);
  const modsDir = fs.existsSync(path.join(gameDir, 'mods')) ? path.join(gameDir, 'mods') : gameDir;
  const { jars, disabled } = listJars(modsDir);
  const problems: string[] = [];
  if (!jars.length) problems.push(modsDir === gameDir ? 'No mods folder or mod JARs found in this folder' : 'The mods folder has no enabled mod JARs');
  const configDirs = CONFIG_DIRS.map((d) => path.join(gameDir, d)).filter((d) => fs.existsSync(d));
  return { path: dir, kind, name, gameDir, minecraft, loader: parsed.loader, loaderVersion: loaderVersion ?? parsed.version, jars, disabledJars: disabled, configDirs, problems };
}

export function configTarget(dir: string): string {
  const base = path.basename(dir);
  return CONFIG_DIRS.includes(base) ? base : 'config';
}

export function compatibilityProblems(pack: PackFolder, minecraft: string, loader: string): string[] {
  const out: string[] = [];
  if (pack.minecraft && pack.minecraft !== minecraft) out.push(`${pack.name} is for Minecraft ${pack.minecraft}; this project uses ${minecraft}`);
  if (pack.loader && pack.loader !== loader) out.push(`${pack.name} uses ${pack.loader}; this project uses ${loader}`);
  return out;
}

export function discoverPackFolders(extra: string[] = []): string[] {
  const home = os.homedir();
  const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const roots = [
    path.join(home, 'curseforge', 'minecraft', 'Instances'),
    path.join(home, 'Documents', 'Curse', 'Minecraft', 'Instances'),
    path.join(appData, 'ModrinthApp', 'profiles'),
    path.join(appData, 'com.modrinth.theseus', 'profiles'),
    path.join(appData, 'PrismLauncher', 'instances'),
    path.join(home, '.local', 'share', 'PrismLauncher', 'instances'),
    path.join(home, 'Library', 'Application Support', 'PrismLauncher', 'instances'),
    path.join(home, 'Library', 'Application Support', 'ModrinthApp', 'profiles'),
    path.join(home, '.local', 'share', 'ModrinthApp', 'profiles'),
    path.join(home, '.var', 'app', 'org.prismlauncher.PrismLauncher', 'data', 'PrismLauncher', 'instances')
  ];
  const out = new Set<string>();
  for (const r of roots) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(r, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_')) out.add(path.join(r, e.name));
  }
  for (const p of extra) if (fs.existsSync(p)) out.add(p);
  return [...out];
}

function linksFile(root: string): string {
  return path.join(root, PRODUCT.stateDir, 'linked-packs.json');
}

export function readLinks(root: string): Record<string, LinkedPack[]> {
  const raw = readJson(linksFile(root));
  const parsed = LinksFileSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

export function writeLinks(root: string, links: Record<string, LinkedPack[]>): void {
  const file = linksFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const clean = Object.fromEntries(Object.entries(links).filter(([, v]) => v.length));
  fs.writeFileSync(file, JSON.stringify(clean, null, 2) + '\n');
}

export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

const metaCache = new Map<string, { mtime: number; meta: ModMetadata[] }>();

export function jarMetadata(file: string): ModMetadata[] {
  const st = fs.statSync(file);
  const hit = metaCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.meta;
  let meta: ModMetadata[] = [];
  try {
    meta = readJarMetadata(file);
  } catch {
    meta = [];
  }
  metaCache.set(file, { mtime: st.mtimeMs, meta });
  return meta;
}

export interface PackSelection {
  use: PackJar[];
  skipped: { name: string; reason: string }[];
}

export function selectPackJars(pack: PackFolder, opts: { side: 'client' | 'server'; replacedIds: string[] }): PackSelection {
  const replaced = new Set(opts.replacedIds.filter(Boolean));
  const use: PackJar[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const j of pack.jars) {
    const meta = jarMetadata(j.file);
    const ids = meta.flatMap((m) => [m.id, ...m.provides]);
    const clash = ids.find((id) => replaced.has(id));
    if (clash) {
      skipped.push({ name: j.name, reason: `"${clash}" comes from this project's development build instead` });
      continue;
    }
    if (opts.side === 'server' && meta[0]?.environment === 'client') {
      skipped.push({ name: j.name, reason: 'client-only mod' });
      continue;
    }
    use.push(j);
  }
  return { use, skipped };
}
