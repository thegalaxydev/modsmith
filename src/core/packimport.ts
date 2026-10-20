import fs from 'node:fs';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { z } from 'zod';
import type { OperationInfo } from '../shared/types';
import type { Services } from './context';
import type { WorkspaceService } from './workspace';
import { CfManifestSchema } from './mrpack';
import { ProfileSchema, writeManifest, type Manifest, type ModRef, type Profile } from './manifest';
import { describeRef } from './resolver';
import { downloadVerified } from './http';
import { primaryFile, pickVersion, type ModrinthVersion } from './modrinth';
import { cfDistributable, cfFilePage, cfSha1, pickCfFile, CLASS_MODPACKS, type CfFile } from './curseforge';
import { resolveWithin } from './paths';
import type { OpContext } from './operations';

export const MrIndexSchema = z.object({
  formatVersion: z.literal(1),
  game: z.literal('minecraft'),
  versionId: z.string(),
  name: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      hashes: z.object({ sha1: z.string(), sha512: z.string().optional() }).passthrough(),
      env: z.object({ client: z.enum(['required', 'optional', 'unsupported']), server: z.enum(['required', 'optional', 'unsupported']) }).optional(),
      downloads: z.array(z.string().url()).min(1),
      fileSize: z.number()
    })
  ),
  dependencies: z.record(z.string(), z.string())
});

export type PackLoader = 'fabric' | 'neoforge' | 'forge' | 'quilt';

export interface MrPackFile {
  path: string;
  sha1: string;
  sha512?: string;
  size: number;
  downloads: string[];
  environment: 'client' | 'server' | 'both';
  supported: boolean;
}

export interface ParsedPack {
  format: 'mrpack' | 'curseforge';
  name: string;
  version?: string;
  minecraft: string;
  loader: PackLoader;
  loaderVersion?: string;
  mrFiles: MrPackFile[];
  cfFiles: { projectID: number; fileID: number; required: boolean }[];
  overrides: Record<string, Uint8Array>;
}

export function parsePackArchive(bytes: Uint8Array, side: 'client' | 'server'): ParsedPack {
  const entries = unzipSync(bytes);
  const overrides: Record<string, Uint8Array> = {};
  const take = (prefix: string) => {
    for (const [p, data] of Object.entries(entries)) if (p.startsWith(prefix) && !p.endsWith('/') && p.length > prefix.length) overrides[p.slice(prefix.length)] = data;
  };
  if (entries['modrinth.index.json']) {
    const index = MrIndexSchema.parse(JSON.parse(strFromU8(entries['modrinth.index.json'])));
    const deps = index.dependencies;
    const loader: PackLoader | null = deps['fabric-loader'] ? 'fabric' : deps.neoforge ? 'neoforge' : deps.forge ? 'forge' : deps['quilt-loader'] ? 'quilt' : null;
    if (!deps.minecraft || !loader) throw new Error('The pack does not declare a Minecraft version and a mod loader');
    take('overrides/');
    take(side === 'client' ? 'client-overrides/' : 'server-overrides/');
    return {
      format: 'mrpack',
      name: index.name,
      version: index.versionId,
      minecraft: deps.minecraft,
      loader,
      loaderVersion: deps['fabric-loader'] ?? deps.neoforge ?? deps.forge ?? deps['quilt-loader'],
      mrFiles: index.files.map((f) => ({
        path: f.path.replace(/\\/g, '/'),
        sha1: f.hashes.sha1.toLowerCase(),
        sha512: f.hashes.sha512,
        size: f.fileSize,
        downloads: f.downloads,
        environment: f.env?.client === 'unsupported' ? 'server' : f.env?.server === 'unsupported' ? 'client' : 'both',
        supported: !f.env || f.env[side] !== 'unsupported'
      })),
      cfFiles: [],
      overrides
    };
  }
  if (entries['manifest.json']) {
    const m = CfManifestSchema.parse(JSON.parse(strFromU8(entries['manifest.json'])));
    const primary = m.minecraft.modLoaders.find((l) => l.primary) ?? m.minecraft.modLoaders[0];
    const lm = /^(fabric|neoforge|forge|quilt)-(.+)$/.exec(primary?.id ?? '');
    if (!lm) throw new Error(`Unsupported mod loader ${primary?.id ?? '(none)'}`);
    take(`${m.overrides ?? 'overrides'}/`);
    return { format: 'curseforge', name: m.name, version: m.version, minecraft: m.minecraft.version, loader: lm[1] as PackLoader, loaderVersion: lm[2], mrFiles: [], cfFiles: m.files.map((f) => ({ projectID: f.projectID, fileID: f.fileID, required: f.required !== false })), overrides };
  }
  throw new Error('Not a modpack: expected modrinth.index.json (Modrinth .mrpack) or manifest.json (CurseForge .zip)');
}

export interface ImportInput {
  profile: string;
  name?: string;
  side?: 'client' | 'server';
  file?: string;
  modrinth?: { project: string; version?: string };
  curseforge?: { project: string; file?: string };
}

export interface ImportResult {
  profile: string;
  pack: string;
  version: string | null;
  added: number;
  replaced: number;
  skipped: string[];
  localFiles: number;
  overrides: number;
  manual: string[];
  warnings: string[];
}

function slugId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'pack'
  );
}

export class PackImportService {
  constructor(private s: Services, private ws: WorkspaceService) {}

  async searchModpacks(opts: { provider: 'modrinth' | 'curseforge'; query: string; loader?: string; minecraft?: string; limit?: number; offset?: number }) {
    if (opts.provider === 'curseforge') {
      const r = await this.s.curseforge.search({ query: opts.query, loader: opts.loader, minecraft: opts.minecraft, classId: CLASS_MODPACKS, limit: opts.limit, offset: opts.offset });
      return { provider: 'curseforge', total: r.total, hits: r.hits.map((m) => ({ id: String(m.id), slug: m.slug, title: m.name, description: m.summary, author: m.authors?.map((a) => a.name).join(', ') ?? '', downloads: m.downloadCount, iconUrl: m.logo?.thumbnailUrl ?? m.logo?.url ?? null, url: m.links?.websiteUrl ?? null })) };
    }
    const r = await this.s.modrinth.search({ query: opts.query, loader: opts.loader, minecraft: opts.minecraft, projectType: 'modpack', limit: opts.limit, offset: opts.offset });
    return { provider: 'modrinth', total: r.total_hits, hits: r.hits.map((h) => ({ id: h.project_id, slug: h.slug, title: h.title, description: h.description, author: h.author, downloads: h.downloads, iconUrl: h.icon_url ?? null, url: `https://modrinth.com/modpack/${h.slug}` })) };
  }

  importIntoProfile(root: string, input: ImportInput): OperationInfo {
    const dir = this.ws.normalize(root);
    const manifest = this.ws.requireManifest(dir);
    const sources = [input.file, input.modrinth, input.curseforge].filter(Boolean).length;
    if (sources !== 1) throw new Error('Give exactly one of file, modrinth or curseforge');
    if (input.file && !fs.existsSync(input.file)) throw new Error(`File not found: ${input.file}`);
    if (input.curseforge && !this.s.curseforge.configured()) throw new Error('Importing from CurseForge needs a CurseForge API key (Settings > Providers)');
    const label = input.file ? path.basename(input.file) : input.modrinth ? `Modrinth ${input.modrinth.project}` : `CurseForge ${input.curseforge!.project}`;
    return this.s.ops.start({ kind: 'profile.import_pack', title: `Import ${label} into a test profile`, workspace: dir }, (ctx) => this.run(dir, manifest, input, ctx));
  }

  private async fetchArchive(manifest: Manifest, input: ImportInput, ctx: OpContext): Promise<{ bytes: Uint8Array; provider: 'modrinth' | 'curseforge' | 'file'; project?: string; version?: string; versionName?: string }> {
    const { loader, minecraft } = manifest.platform;
    if (input.file) return { bytes: new Uint8Array(fs.readFileSync(input.file)), provider: 'file' };
    if (input.modrinth) {
      const project = await this.s.modrinth.project(input.modrinth.project, ctx.signal);
      if (project.project_type !== 'modpack') throw new Error(`${project.title} is a ${project.project_type} on Modrinth, not a modpack`);
      let version: ModrinthVersion | null;
      if (input.modrinth.version) version = await this.s.modrinth.version(input.modrinth.version, ctx.signal);
      else version = pickVersion(await this.s.modrinth.versions(project.id, { loader, minecraft, signal: ctx.signal }), loader, minecraft);
      if (!version) throw new Error(`${project.title} has no version for Minecraft ${minecraft} with ${loader}`);
      const file = version.files.find((f) => f.filename.endsWith('.mrpack')) ?? primaryFile(version);
      if (!file) throw new Error(`${project.title} ${version.version_number} has no .mrpack file`);
      ctx.log(`Downloading ${project.title} ${version.version_number}`);
      const got = await downloadVerified({ url: file.url, dest: path.join(this.s.paths.downloads, 'modpacks', 'modrinth', file.hashes.sha1, file.filename), sha1: file.hashes.sha1, sha512: file.hashes.sha512, size: file.size, signal: ctx.signal });
      return { bytes: new Uint8Array(fs.readFileSync(got.path)), provider: 'modrinth', project: project.id, version: version.id, versionName: version.version_number };
    }
    const cf = this.s.curseforge;
    const mod = await cf.mod(input.curseforge!.project, ctx.signal);
    if (mod.classId !== undefined && mod.classId !== CLASS_MODPACKS) throw new Error(`${mod.name} is not a CurseForge modpack`);
    let file: CfFile | null;
    if (input.curseforge!.file) file = await cf.file(mod.id, input.curseforge!.file, ctx.signal);
    else file = pickCfFile(await cf.files(mod.id, { loader, minecraft, signal: ctx.signal }), loader, minecraft);
    if (!file) throw new Error(`${mod.name} has no file for Minecraft ${minecraft} with ${loader}`);
    const sha1 = cfSha1(file);
    if (!cfDistributable(mod, file) || !file.downloadUrl) throw new Error(`The author of ${mod.name} does not allow downloads through the API. Download ${file.fileName} from ${cfFilePage(mod, file)} and import the file instead.`);
    if (!sha1) throw new Error(`${file.fileName} has no published SHA-1; refusing to download it unverified`);
    ctx.log(`Downloading ${mod.name} ${file.displayName}`);
    const got = await downloadVerified({ url: file.downloadUrl, dest: path.join(this.s.paths.downloads, 'modpacks', 'curseforge', sha1, file.fileName), sha1, size: file.fileLength, signal: ctx.signal });
    return { bytes: new Uint8Array(fs.readFileSync(got.path)), provider: 'curseforge', project: String(mod.id), version: String(file.id), versionName: file.displayName };
  }

  private async run(dir: string, manifest: Manifest, input: ImportInput, ctx: OpContext): Promise<ImportResult> {
    const archive = await this.fetchArchive(manifest, input, ctx);
    const existing = manifest.profiles.find((p) => p.id === input.profile);
    const side = existing?.side ?? input.side ?? 'client';
    const pack = parsePackArchive(archive.bytes, side);
    if (pack.minecraft !== manifest.platform.minecraft) throw new Error(`${pack.name} is for Minecraft ${pack.minecraft}; this project uses ${manifest.platform.minecraft}`);
    if (pack.loader !== manifest.platform.loader) throw new Error(`${pack.name} uses ${pack.loader}; this project uses ${manifest.platform.loader}`);
    ctx.log(`${pack.name}${pack.version ? ` ${pack.version}` : ''}: Minecraft ${pack.minecraft}, ${pack.loader} ${pack.loaderVersion ?? ''}`.trim());
    const profile: Profile = existing ?? ProfileSchema.parse({ id: input.profile, name: input.name ?? `${pack.name} test`, side, includeSourceMod: manifest.source.kind === 'gradle' });
    const warnings: string[] = [];
    const manual: string[] = [];
    const refs: ModRef[] = [];
    const overridesRel = `profiles/${profile.id}/packs/${slugId(pack.name)}`;
    const overridesAbs = resolveWithin(dir, overridesRel);
    let localFiles = 0;

    if (pack.format === 'mrpack') {
      const files = pack.mrFiles.filter((f) => f.supported);
      const mods = files.filter((f) => /^mods\/[^/]+\.jar$/i.test(f.path));
      ctx.progress(0.2, `Identifying ${mods.length} mods on Modrinth`);
      const found = mods.length ? await this.s.modrinth.versionsFromHashes(mods.map((f) => f.sha1), ctx.signal) : {};
      const projectIds = [...new Set(Object.values(found).map((v) => v.project_id))];
      const titles = new Map<string, string>();
      try {
        for (const p of await this.s.modrinth.projects(projectIds, ctx.signal)) titles.set(p.id, p.title);
      } catch (err) {
        warnings.push(`Could not fetch Modrinth project names: ${(err as Error).message}`);
      }
      const other = files.filter((f) => !found[f.sha1] || !mods.includes(f));
      for (const f of mods) {
        const v = found[f.sha1];
        if (v) refs.push({ source: 'modrinth', projectId: v.project_id, versionId: v.id, title: titles.get(v.project_id) ?? path.basename(f.path), required: true, usage: 'runtime', environment: f.environment, from: pack.name });
      }
      for (const [i, f] of other.entries()) {
        ctx.throwIfCancelled();
        ctx.progress(0.4 + (0.3 * i) / Math.max(1, other.length), `Downloading ${path.basename(f.path)}`);
        const dest = resolveWithin(overridesAbs, f.path);
        try {
          const got = await downloadVerified({ url: f.downloads[0], dest: path.join(this.s.paths.downloads, 'modpacks', 'files', f.sha1, path.basename(f.path)), sha1: f.sha1, sha512: f.sha512, size: f.size, signal: ctx.signal });
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(got.path, dest);
          localFiles++;
        } catch (err) {
          warnings.push(`${f.path}: ${(err as Error).message}`);
        }
      }
    } else {
      const titles = new Map<number, { name: string; distributable: boolean; page?: string }>();
      if (this.s.curseforge.configured()) {
        try {
          for (const m of await this.s.curseforge.mods(pack.cfFiles.map((f) => f.projectID), ctx.signal)) titles.set(m.id, { name: m.name, distributable: m.allowModDistribution !== false, page: m.links?.websiteUrl });
        } catch (err) {
          warnings.push(`Could not fetch CurseForge project names: ${(err as Error).message}`);
        }
      } else {
        warnings.push('No CurseForge API key is configured. The mods were added by id; checking and launching this profile needs a key (Settings > Providers).');
      }
      for (const f of pack.cfFiles) {
        const t = titles.get(f.projectID);
        if (t && !t.distributable) manual.push(`${t.name}: the author only allows downloads from CurseForge${t.page ? ` (${t.page})` : ''}`);
        refs.push({ source: 'curseforge', projectId: String(f.projectID), fileId: String(f.fileID), title: t?.name ?? `CurseForge ${f.projectID}`, required: f.required, usage: 'runtime', environment: 'both', from: pack.name });
      }
    }

    ctx.progress(0.75, 'Writing pack overrides');
    let overrides = 0;
    for (const [rel, data] of Object.entries(pack.overrides)) {
      const out = resolveWithin(overridesAbs, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data);
      overrides++;
    }
    const modsDir = path.join(overridesAbs, 'mods');
    if (fs.existsSync(modsDir)) {
      for (const f of fs.readdirSync(modsDir).filter((n) => n.toLowerCase().endsWith('.jar'))) {
        refs.push({ source: 'local', path: `${overridesRel}/mods/${f}`, title: f, required: true, usage: 'runtime', environment: 'both', from: pack.name });
      }
    }

    const previous = profile.mods.filter((m) => m.from === pack.name);
    const kept = profile.mods.filter((m) => m.from !== pack.name);
    const keys = new Set(kept.map((m) => describeRef(m)));
    const keptProjects = new Map<string, string | undefined>(kept.flatMap((m) => (m.source === 'modrinth' || m.source === 'curseforge' ? [[`${m.source}:${m.projectId}`, m.title] as [string, string | undefined]] : [])));
    const skipped: string[] = [];
    const added: ModRef[] = [];
    for (const r of refs) {
      const project = r.source === 'modrinth' || r.source === 'curseforge' ? `${r.source}:${r.projectId}` : null;
      if (keys.has(describeRef(r)) || (project && keptProjects.has(project))) {
        skipped.push(`${(project && keptProjects.get(project)) ?? r.title ?? describeRef(r)} is already in the profile`);
        continue;
      }
      keys.add(describeRef(r));
      added.push(r);
    }
    profile.mods = [...kept, ...added];

    const others = fs.existsSync(overridesAbs) ? fs.readdirSync(overridesAbs, { withFileTypes: true }) : [];
    const prefix = `${overridesRel}/`;
    profile.scripts = profile.scripts.filter((s) => !s.startsWith(prefix));
    profile.resourcePacks = profile.resourcePacks.filter((s) => !s.startsWith(prefix));
    for (const e of others) {
      if (e.name === 'mods') continue;
      if (e.name === 'config' && e.isDirectory()) {
        if (!profile.configDir || profile.configDir.startsWith(`profiles/${profile.id}/packs/`)) profile.configDir = `${overridesRel}/config`;
        else warnings.push(`The profile already uses ${profile.configDir} for config files; the pack config is in ${overridesRel}/config`);
        continue;
      }
      if (e.name === 'resourcepacks' && e.isDirectory()) {
        for (const rp of fs.readdirSync(path.join(overridesAbs, 'resourcepacks'))) profile.resourcePacks.push(`${overridesRel}/resourcepacks/${rp}`);
        continue;
      }
      profile.scripts.push(`${overridesRel}/${e.name}`);
    }
    profile.imports = [
      ...profile.imports.filter((i) => i.name !== pack.name),
      { name: pack.name, provider: archive.provider, project: archive.project, version: archive.version, versionName: archive.versionName ?? pack.version, overrides: overridesRel, importedAt: new Date().toISOString() }
    ];

    const next = ProfileSchema.parse(profile);
    if (existing) manifest.profiles = manifest.profiles.map((p) => (p.id === next.id ? next : p));
    else manifest.profiles.push(next);
    writeManifest(dir, manifest);
    this.s.bus.emit('workspace.changed', { workspace: dir });
    ctx.log(`Added ${added.length} mods from ${pack.name}${previous.length ? ` (replacing ${previous.length} from an earlier import)` : ''}; ${skipped.length} already present; ${overrides} override files`);
    for (const w of warnings) ctx.log(`[warning] ${w}`);
    for (const m of manual) ctx.log(`[info] ${m}`);
    return { profile: next.id, pack: pack.name, version: archive.versionName ?? pack.version ?? null, added: added.length, replaced: previous.length, skipped, localFiles, overrides, manual, warnings };
  }

  removeImported(root: string, profileId: string, packName: string) {
    const dir = this.ws.normalize(root);
    const manifest = this.ws.requireManifest(dir);
    const profile = manifest.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`Unknown profile ${profileId}`);
    const record = profile.imports.find((i) => i.name === packName);
    const removed = profile.mods.filter((m) => m.from === packName).length;
    if (!record && !removed) throw new Error(`${packName} was not imported into profile ${profileId}`);
    profile.mods = profile.mods.filter((m) => m.from !== packName);
    profile.imports = profile.imports.filter((i) => i.name !== packName);
    if (record?.overrides) {
      const prefix = `${record.overrides}/`;
      profile.scripts = profile.scripts.filter((s) => !s.startsWith(prefix));
      profile.resourcePacks = profile.resourcePacks.filter((s) => !s.startsWith(prefix));
      if (profile.configDir?.startsWith(prefix)) profile.configDir = undefined;
    }
    writeManifest(dir, manifest);
    this.s.bus.emit('workspace.changed', { workspace: dir });
    return { removed, overridesKept: record?.overrides ?? null };
  }
}
