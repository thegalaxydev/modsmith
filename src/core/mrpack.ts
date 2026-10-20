import fs from 'node:fs';
import path from 'node:path';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { z } from 'zod';
import type { OperationInfo } from '../shared/types';
import { PRODUCT } from '../shared/product';
import type { Services } from './context';
import type { WorkspaceService } from './workspace';
import { ManifestSchema, ProfileSchema, readLock, writeManifest, type ModRef } from './manifest';
import { validateDestination } from './validation';
import { resolveWithin } from './paths';

export const IndexSchema = z.object({
  formatVersion: z.literal(1),
  game: z.literal('minecraft'),
  versionId: z.string(),
  name: z.string(),
  summary: z.string().optional(),
  files: z.array(z.object({
    path: z.string(),
    hashes: z.object({ sha1: z.string(), sha512: z.string() }).passthrough(),
    env: z.object({ client: z.enum(['required', 'optional', 'unsupported']), server: z.enum(['required', 'optional', 'unsupported']) }).optional(),
    downloads: z.array(z.string().url()).min(1),
    fileSize: z.number()
  })),
  dependencies: z.record(z.string(), z.string())
});

export const CfManifestSchema = z.object({
  minecraft: z.object({ version: z.string(), modLoaders: z.array(z.object({ id: z.string(), primary: z.boolean().optional() })).min(1) }),
  manifestType: z.literal('minecraftModpack'),
  manifestVersion: z.number().int(),
  name: z.string(),
  version: z.string().optional(),
  author: z.string().optional(),
  files: z.array(z.object({ projectID: z.number().int(), fileID: z.number().int(), required: z.boolean().optional() })),
  overrides: z.string().optional()
});

export class MrpackService {
  constructor(private s: Services, private ws: WorkspaceService) {}

  importPack(file: string, destination: string, name?: string): OperationInfo {
    const dest = path.resolve(destination);
    const err = validateDestination(dest);
    if (err) throw new Error(err);
    return this.s.ops.start({ kind: 'modpack.import', title: `Import ${path.basename(file)}`, workspace: dest }, async (ctx) => {
      const entries = unzipSync(new Uint8Array(fs.readFileSync(file)));
      const indexRaw = entries['modrinth.index.json'];
      if (!indexRaw) throw new Error('Not a Modrinth pack: modrinth.index.json is missing');
      const index = IndexSchema.parse(JSON.parse(strFromU8(indexRaw)));
      const mc = index.dependencies.minecraft;
      const loader = index.dependencies['fabric-loader'] ? 'fabric' : index.dependencies.neoforge ? 'neoforge' : index.dependencies.forge ? 'forge' : null;
      if (!mc || !loader) throw new Error('Pack does not declare a Minecraft version and a supported loader');
      const loaderVersion = index.dependencies['fabric-loader'] ?? index.dependencies.neoforge ?? index.dependencies.forge;
      const entry = this.s.catalog.select(loader, mc, { allowUnverified: true });
      const mods: ModRef[] = [];
      const unresolved: string[] = [];
      for (const [i, f] of index.files.entries()) {
        ctx.throwIfCancelled();
        ctx.progress(i / Math.max(1, index.files.length), `Identifying ${path.basename(f.path)}`);
        if (!f.path.startsWith('mods/')) {
          unresolved.push(`${f.path}: non-mod file downloads are not imported`);
          continue;
        }
        const v = await this.s.modrinth.versionFromHash(f.hashes.sha1, ctx.signal);
        if (!v) {
          unresolved.push(`${f.path}: not found on Modrinth by hash`);
          continue;
        }
        const env = f.env?.client === 'unsupported' ? 'server' : f.env?.server === 'unsupported' ? 'client' : 'both';
        mods.push({ source: 'modrinth', projectId: v.project_id, versionId: v.id, title: path.basename(f.path), required: true, usage: 'runtime', environment: env });
      }
      fs.mkdirSync(dest, { recursive: true });
      const overridesDir = path.join(dest, 'profiles', 'pack', 'overrides');
      let overrides = 0;
      for (const [p, data] of Object.entries(entries)) {
        for (const prefix of ['overrides/', 'client-overrides/']) {
          if (p.startsWith(prefix) && !p.endsWith('/')) {
            const out = resolveWithin(overridesDir, p.slice(prefix.length));
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, data);
            overrides++;
          }
        }
      }
      const hasConfig = fs.existsSync(path.join(overridesDir, 'config'));
      const profile = ProfileSchema.parse({ id: 'pack-client', name: `${index.name} client`, side: 'client', includeSourceMod: false, mods, configDir: hasConfig ? 'profiles/pack/overrides/config' : undefined });
      const manifest = ManifestSchema.parse({
        schemaVersion: 1,
        name: name ?? index.name,
        type: 'modpack',
        platform: { loader, minecraft: mc, loaderVersion, catalogEntry: entry?.id },
        source: { kind: 'none', root: '.' },
        dependencies: [],
        profiles: [profile],
        createdBy: `${PRODUCT.name} ${PRODUCT.version} (mrpack import)`
      });
      writeManifest(dest, manifest);
      fs.writeFileSync(path.join(dest, '.gitignore'), `${PRODUCT.stateDir}/\n`);
      this.s.store.addRecent(this.ws.normalize(dest), manifest.name, 'modpack');
      ctx.log(`Imported ${mods.length} mods, ${overrides} override files; ${unresolved.length} unresolved`);
      unresolved.forEach((u) => ctx.log(`[warning] ${u}`));
      return { path: this.ws.normalize(dest), mods: mods.length, overrides, unresolved, catalogEntry: entry?.id ?? null };
    });
  }

  importCurseForge(file: string, destination: string, name?: string): OperationInfo {
    const dest = path.resolve(destination);
    const err = validateDestination(dest);
    if (err) throw new Error(err);
    return this.s.ops.start({ kind: 'modpack.import', title: `Import ${path.basename(file)}`, workspace: dest }, async (ctx) => {
      const entries = unzipSync(new Uint8Array(fs.readFileSync(file)));
      const raw = entries['manifest.json'];
      if (!raw) throw new Error('Not a CurseForge modpack: manifest.json is missing');
      const manifestCf = CfManifestSchema.parse(JSON.parse(strFromU8(raw)));
      const primary = manifestCf.minecraft.modLoaders.find((l) => l.primary) ?? manifestCf.minecraft.modLoaders[0];
      const m = primary?.id.match(/^(fabric|neoforge|forge|quilt)-(.+)$/);
      if (!m) throw new Error(`Unsupported mod loader ${primary?.id ?? '(none)'}`);
      const loader = m[1] as 'fabric' | 'neoforge' | 'forge';
      if (!['fabric', 'neoforge', 'forge'].includes(loader)) throw new Error(`${m[1]} is not a supported loader`);
      const mc = manifestCf.minecraft.version;
      const entry = this.s.catalog.select(loader, mc, { allowUnverified: true });
      const titles = new Map<number, string>();
      if (this.s.curseforge.configured()) {
        try {
          for (const mod of await this.s.curseforge.mods(manifestCf.files.map((f) => f.projectID), ctx.signal)) titles.set(mod.id, mod.name);
        } catch (e) {
          ctx.log(`[warning] Could not fetch CurseForge project names: ${(e as Error).message}`);
        }
      } else {
        ctx.log('[info] No CurseForge API key configured; mods were imported by id. Resolution needs an API key.');
      }
      const mods: ModRef[] = manifestCf.files.map((f) => ({ source: 'curseforge', projectId: String(f.projectID), fileId: String(f.fileID), title: titles.get(f.projectID) ?? `CurseForge ${f.projectID}`, required: f.required !== false, usage: 'runtime', environment: 'both' }));
      fs.mkdirSync(dest, { recursive: true });
      const overridesDir = path.join(dest, 'profiles', 'pack', 'overrides');
      const prefix = `${manifestCf.overrides ?? 'overrides'}/`;
      let overrides = 0;
      for (const [p, data] of Object.entries(entries)) {
        if (p.startsWith(prefix) && !p.endsWith('/')) {
          const out = resolveWithin(overridesDir, p.slice(prefix.length));
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, data);
          overrides++;
        }
      }
      const hasConfig = fs.existsSync(path.join(overridesDir, 'config'));
      const profile = ProfileSchema.parse({ id: 'pack-client', name: `${manifestCf.name} client`, side: 'client', includeSourceMod: false, mods, configDir: hasConfig ? 'profiles/pack/overrides/config' : undefined });
      const manifest = ManifestSchema.parse({
        schemaVersion: 1,
        name: name ?? manifestCf.name,
        type: 'modpack',
        platform: { loader, minecraft: mc, loaderVersion: m[2], catalogEntry: entry?.id },
        source: { kind: 'none', root: '.' },
        dependencies: [],
        profiles: [profile],
        createdBy: `${PRODUCT.name} ${PRODUCT.version} (CurseForge import)`
      });
      writeManifest(dest, manifest);
      fs.writeFileSync(path.join(dest, '.gitignore'), `${PRODUCT.stateDir}/\n`);
      this.s.store.addRecent(this.ws.normalize(dest), manifest.name, 'modpack');
      ctx.log(`Imported ${mods.length} CurseForge mods and ${overrides} override files`);
      return { path: this.ws.normalize(dest), mods: mods.length, overrides, catalogEntry: entry?.id ?? null };
    });
  }

  exportCurseForge(workspace: string, profileId: string, output: string, version: string) {
    const dir = this.ws.normalize(workspace);
    const manifest = this.ws.requireManifest(dir);
    const profile = manifest.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`Unknown profile ${profileId}`);
    const lock = readLock(dir).profiles[profileId];
    if (!lock) throw new Error(`Resolve profile ${profileId} before exporting`);
    const files: { projectID: number; fileID: number; required: boolean }[] = [];
    const manual: string[] = [];
    for (const e of lock.entries) {
      if (e.provider === 'bridge') continue;
      if (e.provider === 'curseforge' && e.projectId && e.versionId) files.push({ projectID: Number(e.projectId), fileID: Number(e.versionId), required: e.required });
      else manual.push(`${e.title} (${e.fileName}, ${e.provider}): CurseForge manifests can only reference CurseForge files. It was not embedded because redistribution rights are unknown; players must add it manually.`);
    }
    const cf = {
      minecraft: { version: manifest.platform.minecraft, modLoaders: [{ id: `${manifest.platform.loader}-${manifest.platform.loaderVersion}`, primary: true }] },
      manifestType: 'minecraftModpack',
      manifestVersion: 1,
      name: manifest.name,
      version,
      author: '',
      files,
      overrides: 'overrides'
    };
    CfManifestSchema.parse(cf);
    const zip: Record<string, Uint8Array> = { 'manifest.json': strToU8(JSON.stringify(cf, null, 2)) };
    if (profile.configDir) {
      const cfg = path.join(dir, profile.configDir);
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) walk(full);
          else zip[`overrides/config/${path.relative(cfg, full).replace(/\\/g, '/')}`] = new Uint8Array(fs.readFileSync(full));
        }
      };
      if (fs.existsSync(cfg)) walk(cfg);
    }
    const out = path.resolve(output.endsWith('.zip') ? output : `${output}.zip`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, zipSync(zip));
    return { file: out, files: files.length, manualSteps: manual };
  }

  exportPack(workspace: string, profileId: string, output: string, version: string) {
    const dir = this.ws.normalize(workspace);
    const manifest = this.ws.requireManifest(dir);
    const profile = manifest.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`Unknown profile ${profileId}`);
    const lock = readLock(dir).profiles[profileId];
    if (!lock) throw new Error(`Resolve profile ${profileId} before exporting`);
    const loaderKey = manifest.platform.loader === 'fabric' ? 'fabric-loader' : manifest.platform.loader;
    const files: z.infer<typeof IndexSchema>['files'] = [];
    const manual: string[] = [];
    for (const e of lock.entries) {
      if (e.provider === 'bridge') continue;
      if (e.provider === 'modrinth' && e.url && e.sha1 && e.sha512 && e.size) {
        const env = e.environment ? { client: e.environment.client === 'unsupported' ? 'unsupported' as const : 'required' as const, server: e.environment.server === 'unsupported' ? 'unsupported' as const : 'required' as const } : undefined;
        files.push({ path: `mods/${e.fileName}`, hashes: { sha1: e.sha1, sha512: e.sha512 }, env, downloads: [e.url], fileSize: e.size });
      } else {
        manual.push(`${e.title} (${e.fileName}): not hosted on Modrinth; it was not embedded because redistribution rights are unknown. Obtain it from its original source and place it in mods/.`);
      }
    }
    const index = { formatVersion: 1, game: 'minecraft', versionId: version, name: manifest.name, summary: `Exported by ${PRODUCT.name} from profile ${profileId}`, files, dependencies: { minecraft: manifest.platform.minecraft, [loaderKey]: manifest.platform.loaderVersion } };
    IndexSchema.parse(index);
    const zip: Record<string, Uint8Array> = { 'modrinth.index.json': strToU8(JSON.stringify(index, null, 2)) };
    if (profile.configDir) {
      const cfg = path.join(dir, profile.configDir);
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) walk(full);
          else zip[`overrides/config/${path.relative(cfg, full).replace(/\\/g, '/')}`] = new Uint8Array(fs.readFileSync(full));
        }
      };
      if (fs.existsSync(cfg)) walk(cfg);
    }
    const out = path.resolve(output.endsWith('.mrpack') ? output : `${output}.mrpack`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, zipSync(zip));
    return { file: out, files: files.length, manualSteps: manual };
  }
}
