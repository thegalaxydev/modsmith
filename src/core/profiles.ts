import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { OperationInfo } from '../shared/types';
import type { Services } from './context';
import type { WorkspaceService } from './workspace';
import { stateDir } from './workspace';
import { ProfileSchema, readLock, writeLock, writeManifest, ModRefSchema, type LockEntry, type Manifest, type ModRef, type Profile } from './manifest';
import { resolveProfile, describeRef, type ResolveResult, type ResolverProvider, type ResolvedVersion } from './resolver';
import { downloadVerified, hashFile } from './http';
import { cfDistributable, cfFilePage, cfToProject, cfToVersion, type CfFile, type CfMod } from './curseforge';
import { readJarMetadata, allModIds, parseModsToml, type ModMetadata } from './jarmeta';
import { legacyManagedFile } from './legacy';
import { compatibilityProblems, configTarget, detectPackFolder, discoverPackFolders, jarMetadata, LinkedPackSchema, readLinks, samePath, selectPackJars, writeLinks, type PackFolder } from './packlink';
import type { OpContext } from './operations';

export const FABRIC_API_PROJECT = 'P7dR8mSH';
export const CF_FABRIC_API_PROJECT = '306612';

const metaCache = new Map<string, { mtime: number; ids: string[] }>();

export function classpathModIds(classpath: string[]): string[] {
  const ids = new Set<string>();
  for (const entry of classpath) {
    try {
      const st = fs.statSync(entry);
      if (st.isDirectory()) {
        const fmj = path.join(entry, 'fabric.mod.json');
        if (fs.existsSync(fmj)) {
          const j = JSON.parse(fs.readFileSync(fmj, 'utf8'));
          if (j.id) ids.add(j.id);
          (j.provides ?? []).forEach((p: string) => ids.add(p));
        }
        const toml = path.join(entry, 'META-INF', 'neoforge.mods.toml');
        if (fs.existsSync(toml)) parseModsToml(fs.readFileSync(toml, 'utf8'), 'neoforge').forEach((m) => ids.add(m.id));
        continue;
      }
      if (!entry.endsWith('.jar') || st.size > 20 * 1024 * 1024) continue;
      const cached = metaCache.get(entry);
      let list: string[];
      if (cached && cached.mtime === st.mtimeMs) list = cached.ids;
      else {
        list = allModIds(readJarMetadata(entry));
        metaCache.set(entry, { mtime: st.mtimeMs, ids: list });
      }
      list.forEach((i) => ids.add(i));
    } catch {
      void 0;
    }
  }
  return [...ids];
}

export function refsHash(manifest: Manifest, profile: Profile, mode: string): string {
  return crypto.createHash('sha256').update(JSON.stringify({ deps: manifest.dependencies, mods: profile.mods, side: profile.side, mode, mc: manifest.platform.minecraft, loader: manifest.platform.loaderVersion, bridge: profile.bridge })).digest('hex').slice(0, 16);
}

export class ProfileService {
  constructor(private s: Services, private ws: WorkspaceService) {}

  list(root: string) {
    const manifest = this.ws.requireManifest(root);
    const lock = readLock(this.ws.normalize(root));
    return manifest.profiles.map((p) => ({ ...p, resolved: lock.profiles[p.id] ? { resolvedAt: lock.profiles[p.id].resolvedAt, entries: lock.profiles[p.id].entries.length, issues: lock.profiles[p.id].issues.length } : null }));
  }

  private save(root: string, manifest: Manifest): void {
    writeManifest(this.ws.normalize(root), manifest);
    this.s.bus.emit('workspace.changed', { workspace: this.ws.normalize(root) });
  }

  create(root: string, input: unknown): Profile {
    const manifest = this.ws.requireManifest(root);
    const profile = ProfileSchema.parse(input);
    if (manifest.profiles.some((p) => p.id === profile.id)) throw new Error(`Profile ${profile.id} already exists`);
    manifest.profiles.push(profile);
    this.save(root, manifest);
    return profile;
  }

  update(root: string, id: string, patch: Record<string, unknown>): Profile {
    const manifest = this.ws.requireManifest(root);
    const idx = manifest.profiles.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error(`Unknown profile ${id}`);
    const next = ProfileSchema.parse({ ...manifest.profiles[idx], ...patch, id });
    manifest.profiles[idx] = next;
    this.save(root, manifest);
    return next;
  }

  remove(root: string, id: string, confirm: boolean): void {
    if (!confirm) throw new Error('Removing a profile is destructive; pass confirm: true');
    const manifest = this.ws.requireManifest(root);
    manifest.profiles = manifest.profiles.filter((p) => p.id !== id);
    this.save(root, manifest);
  }

  clone(root: string, sourceId: string, newId: string, name?: string): Profile {
    const manifest = this.ws.requireManifest(root);
    const src = manifest.profiles.find((p) => p.id === sourceId);
    if (!src) throw new Error(`Unknown profile ${sourceId}`);
    const copy = ProfileSchema.parse({ ...structuredClone(src), id: newId, name: name ?? `${src.name} (copy)` });
    if (manifest.profiles.some((p) => p.id === newId)) throw new Error(`Profile ${newId} already exists`);
    manifest.profiles.push(copy);
    this.save(root, manifest);
    return copy;
  }

  addMod(root: string, profileId: string | null, refInput: unknown): ModRef {
    const manifest = this.ws.requireManifest(root);
    const ref = ModRefSchema.parse(refInput);
    const key = describeRef(ref);
    if (profileId) {
      const p = manifest.profiles.find((x) => x.id === profileId);
      if (!p) throw new Error(`Unknown profile ${profileId}`);
      if (p.mods.some((m) => describeRef(m) === key || (m.source === 'modrinth' && ref.source === 'modrinth' && m.projectId === ref.projectId))) throw new Error(`${key} is already in profile ${profileId}`);
      p.mods.push(ref);
    } else {
      if (manifest.dependencies.some((m) => describeRef(m) === key || (m.source === 'modrinth' && ref.source === 'modrinth' && m.projectId === ref.projectId))) throw new Error(`${key} is already a project dependency`);
      if (ref.usage === 'compile' && manifest.source.kind !== 'gradle') throw new Error('Compile dependencies require a Gradle source project');
      manifest.dependencies.push(ref);
    }
    this.save(root, manifest);
    return ref;
  }

  setModEnabled(root: string, profileId: string | null, key: string, enabled: boolean): ModRef {
    const manifest = this.ws.requireManifest(root);
    const list = profileId ? manifest.profiles.find((x) => x.id === profileId)?.mods : manifest.dependencies;
    if (!list) throw new Error(`Unknown profile ${profileId}`);
    const ref = list.find((m) => describeRef(m) === key || (m.source === 'modrinth' && (m.projectId === key || m.slug === key)));
    if (!ref) throw new Error(`${key} is not in ${profileId ? `profile ${profileId}` : 'the project dependencies'}`);
    ref.enabled = enabled;
    this.save(root, manifest);
    return ref;
  }

  removeMod(root: string, profileId: string | null, key: string): void {
    const manifest = this.ws.requireManifest(root);
    const match = (m: ModRef) => describeRef(m) === key || (m.source === 'modrinth' && (m.projectId === key || m.slug === key));
    if (profileId) {
      const p = manifest.profiles.find((x) => x.id === profileId);
      if (!p) throw new Error(`Unknown profile ${profileId}`);
      p.mods = p.mods.filter((m) => !match(m));
    } else {
      manifest.dependencies = manifest.dependencies.filter((m) => !match(m));
    }
    this.save(root, manifest);
  }

  private packSummary(pack: PackFolder, manifest: Manifest) {
    return {
      path: pack.path,
      kind: pack.kind,
      name: pack.name,
      minecraft: pack.minecraft ?? null,
      loader: pack.loader ?? null,
      loaderVersion: pack.loaderVersion ?? null,
      mods: pack.jars.length,
      disabledMods: pack.disabledJars,
      configFolders: pack.configDirs.map((d) => path.basename(d)),
      problems: [...compatibilityProblems(pack, manifest.platform.minecraft, manifest.platform.loader), ...pack.problems],
      compatible: !compatibilityProblems(pack, manifest.platform.minecraft, manifest.platform.loader).length && pack.jars.length > 0
    };
  }

  linkedPacks(root: string, profileId: string) {
    const dir = this.ws.normalize(root);
    const manifest = this.ws.requireManifest(dir);
    const profile = manifest.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`Unknown profile ${profileId}`);
    return (readLinks(dir)[profileId] ?? []).map((link) => {
      try {
        return { ...link, found: true, ...this.packSummary(detectPackFolder(link.path, profile.side), manifest), path: link.path };
      } catch (err) {
        return { ...link, found: false, kind: 'folder', name: path.basename(link.path), minecraft: null, loader: null, loaderVersion: null, mods: 0, disabledMods: 0, configFolders: [], problems: [(err as Error).message], compatible: false };
      }
    });
  }

  linkPack(root: string, profileId: string, input: { folder: string; enabled?: boolean; configs?: boolean }) {
    const dir = this.ws.normalize(root);
    const manifest = this.ws.requireManifest(dir);
    const profile = manifest.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`Unknown profile ${profileId}`);
    const pack = detectPackFolder(input.folder, profile.side);
    if (samePath(pack.path, dir)) throw new Error('A project cannot link to itself');
    const blockers = compatibilityProblems(pack, manifest.platform.minecraft, manifest.platform.loader);
    if (blockers.length) throw new Error(blockers.join('; '));
    if (!pack.jars.length) throw new Error(pack.problems[0] ?? 'No mods found in this folder');
    const links = readLinks(dir);
    const list = links[profileId] ?? [];
    const idx = list.findIndex((l) => samePath(l.path, pack.path));
    const prev = idx >= 0 ? list[idx] : undefined;
    const next = LinkedPackSchema.parse({ path: pack.path, enabled: input.enabled ?? prev?.enabled ?? true, configs: input.configs ?? prev?.configs ?? true });
    if (idx >= 0) list[idx] = next;
    else list.push(next);
    links[profileId] = list;
    writeLinks(dir, links);
    this.s.bus.emit('workspace.changed', { workspace: dir });
    return { ...next, ...this.packSummary(pack, manifest), path: pack.path };
  }

  unlinkPack(root: string, profileId: string, folder: string): void {
    const dir = this.ws.normalize(root);
    const links = readLinks(dir);
    const list = links[profileId] ?? [];
    const next = list.filter((l) => !samePath(l.path, folder));
    if (next.length === list.length) throw new Error(`${folder} is not linked to profile ${profileId}`);
    links[profileId] = next;
    writeLinks(dir, links);
    this.s.bus.emit('workspace.changed', { workspace: dir });
  }

  discoverPacks(root: string, profileId: string) {
    const dir = this.ws.normalize(root);
    const manifest = this.ws.requireManifest(dir);
    const profile = manifest.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`Unknown profile ${profileId}`);
    const recentPacks = this.s.store
      .listRecent()
      .map((r) => r.path)
      .filter((p) => !samePath(p, dir));
    const out = [];
    for (const folder of discoverPackFolders(recentPacks)) {
      try {
        const pack = detectPackFolder(folder, profile.side);
        if (pack.kind === 'folder' && !pack.jars.length) continue;
        if (pack.kind === 'modsmith' && pack.problems.some((p) => p.includes('mod project'))) continue;
        out.push(this.packSummary(pack, manifest));
      } catch {
        void 0;
      }
    }
    return out.sort((a, b) => Number(b.compatible) - Number(a.compatible) || a.name.localeCompare(b.name));
  }

  devClasspathIds(root: string, side: 'client' | 'server'): string[] | null {
    const spec = path.join(stateDir(root), 'launch', `${side === 'client' ? 'runClient' : 'runServer'}.json`);
    if (!fs.existsSync(spec)) return null;
    try {
      const j = JSON.parse(fs.readFileSync(spec, 'utf8'));
      const run = j.runs?.[side === 'client' ? 'runClient' : 'runServer'];
      return run ? classpathModIds(run.classpath) : null;
    } catch {
      return null;
    }
  }

  async resolve(root: string, profileId: string, ctx: OpContext | null, opts: { mode?: 'development' | 'production'; providedModIds?: string[]; extraEntries?: LockEntry[] } = {}): Promise<ResolveResult & { profile: Profile }> {
    const dir = this.ws.normalize(root);
    const manifest = this.ws.requireManifest(dir);
    const profile = manifest.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`Unknown profile ${profileId}`);
    const mode = opts.mode ?? profile.mode;
    const loader = manifest.platform.loader;
    const refs: { ref: ModRef; reason: string }[] = [];
    for (const d of manifest.dependencies) {
      if (mode === 'development' && d.usage === 'compile') continue;
      refs.push({ ref: d.usage === 'compile' && d.source === 'modrinth' ? { ...d, usage: 'runtime' } : d, reason: 'project dependency' });
    }
    for (const m of profile.mods) refs.push({ ref: m, reason: m.from ? `pack ${m.from}` : `profile ${profile.id}` });
    const provided: Record<string, string> = {};
    let providedIds = opts.providedModIds ?? [];
    if (mode === 'development' && manifest.source.kind === 'gradle') {
      const cp = opts.providedModIds ?? this.devClasspathIds(dir, profile.side);
      providedIds = cp ?? [manifest.modId ?? '', manifest.platform.loader === 'fabric' ? 'fabric-api' : 'neoforge'].filter(Boolean);
      if (providedIds.includes('fabric-api')) provided[FABRIC_API_PROJECT] = 'Fabric API';
      for (const d of manifest.dependencies) if (d.source === 'modrinth' && d.usage === 'compile') provided[d.projectId] = d.title ?? d.projectId;
    }
    const linkIssues: ResolveResult['issues'] = [];
    const packIds = new Set<string>();
    const replacedIds = [...providedIds, ...(opts.extraEntries ?? []).flatMap((e) => e.modIds ?? [])];
    for (const link of readLinks(dir)[profile.id] ?? []) {
      if (!link.enabled) continue;
      let pack;
      try {
        pack = detectPackFolder(link.path, profile.side);
      } catch (err) {
        linkIssues.push({ severity: 'error', message: `Linked modpack folder is missing: ${link.path} (${(err as Error).message})` });
        continue;
      }
      const blockers = compatibilityProblems(pack, manifest.platform.minecraft, loader);
      if (!pack.jars.length) blockers.push(...pack.problems);
      if (blockers.length) {
        for (const b of blockers) linkIssues.push({ severity: 'error', message: `Linked modpack: ${b}` });
        continue;
      }
      const sel = selectPackJars(pack, { side: profile.side, replacedIds });
      for (const j of sel.use) for (const meta of jarMetadata(j.file)) packIds.add(meta.id);
      for (const j of sel.use) refs.push({ ref: { source: 'local', path: j.file, required: true, usage: 'runtime', environment: 'both' }, reason: `linked pack ${pack.name}` });
      for (const s of sel.skipped) linkIssues.push({ severity: 'info', message: `${s.name} from ${pack.name} not loaded: ${s.reason}` });
      ctx?.log(`Linked modpack ${pack.name}: ${sel.use.length} mods${pack.disabledJars ? `, ${pack.disabledJars} disabled in the pack` : ''}${sel.skipped.length ? `, ${sel.skipped.length} skipped` : ''}`);
    }
    if (mode === 'production' && manifest.source.kind === 'gradle' && profile.includeSourceMod) {
      if (manifest.platform.loader === 'fabric' && !packIds.has('fabric-api') && !refs.some((r) => (r.ref.source === 'modrinth' && r.ref.projectId === FABRIC_API_PROJECT) || (r.ref.source === 'curseforge' && r.ref.projectId === CF_FABRIC_API_PROJECT))) {
        refs.push({ ref: { source: 'modrinth', projectId: FABRIC_API_PROJECT, title: 'Fabric API', required: true, usage: 'runtime', environment: 'both' }, reason: 'required by the source mod (fabric-api)' });
      }
      for (const d of manifest.dependencies) if (d.source === 'modrinth' && d.usage === 'compile') refs.push({ ref: { ...d, usage: 'runtime' }, reason: 'compile dependency packaged for production' });
    }
    const ctxLog = (m: string) => ctx?.log(m);
    const res = await resolveProfile(
      {
        loader,
        minecraft: manifest.platform.minecraft,
        side: profile.side,
        refs,
        providedModIds: providedIds,
        providedModrinthProjects: provided,
        baseDir: dir,
        extraEntries: opts.extraEntries
      },
      {
        providers: this.providerApis(ctx?.signal),
        fetchFile: (e) => this.fetchLocked(e, ctx),
        readMetadata: (f) => readJarMetadata(f),
        hashLocal: async (f) => ({ sha1: await hashFile(f, 'sha1'), sha512: await hashFile(f, 'sha512'), size: fs.statSync(f).size })
      }
    );
    res.issues.unshift(...linkIssues);
    const lock = readLock(dir);
    const key = mode === 'production' ? `${profile.id}@production` : profile.id;
    lock.profiles[key] = {
      resolvedAt: new Date().toISOString(),
      minecraft: manifest.platform.minecraft,
      loader,
      loaderVersion: manifest.platform.loaderVersion,
      entries: res.entries.map((e) => ({ ...e, url: e.provider === 'local' || e.provider === 'bridge' ? undefined : e.url })),
      issues: res.issues
    };
    writeLock(dir, lock);
    fs.mkdirSync(stateDir(dir), { recursive: true });
    fs.writeFileSync(path.join(stateDir(dir), `resolved-${key.replace('@', '-')}.files.json`), JSON.stringify({ hash: refsHash(manifest, profile, mode), files: res.files }, null, 2));
    for (const i of res.issues) ctxLog(`[${i.severity}] ${i.message}`);
    this.s.bus.emit('workspace.changed', { workspace: dir });
    return { ...res, profile };
  }

  providerApis(signal?: AbortSignal): ResolverProvider['providers'] {
    const out: ResolverProvider['providers'] = {
      modrinth: {
        project: (id) => this.s.modrinth.project(id, signal),
        versions: (id, l, mc) => this.s.modrinth.versions(id, { loader: l, minecraft: mc, signal }),
        version: (id) => this.s.modrinth.version(id, signal)
      }
    };
    if (this.s.curseforge.configured()) {
      const cf = this.s.curseforge;
      const mods = new Map<string, Promise<CfMod>>();
      const mod = (id: string) => {
        if (!mods.has(id)) mods.set(id, cf.mod(id, signal));
        return mods.get(id)!;
      };
      const toVersion = async (f: CfFile): Promise<ResolvedVersion> => {
        const m = await mod(String(f.modId));
        const v = cfToVersion(f);
        return { ...v, distribution: cfDistributable(m, f) ? 'direct' : 'manual', manualUrl: cfFilePage(m, f) };
      };
      out.curseforge = {
        project: async (id) => cfToProject(await mod(id)),
        versions: async (id, l, mc) => Promise.all((await cf.files(id, { loader: l, minecraft: mc, signal })).filter((f) => f.isAvailable !== false && !f.isServerPack).map(toVersion)),
        version: async (fileId, projectId) => {
          if (!projectId) throw new Error(`CurseForge file ${fileId} needs its project id`);
          return toVersion(await cf.file(projectId, fileId, signal));
        }
      };
    }
    return out;
  }

  manualDir(): string {
    return path.join(this.s.paths.downloads, 'manual');
  }

  async fetchLocked(e: LockEntry, ctx: OpContext | null): Promise<string> {
    if (!e.sha1) throw new Error(`${e.title} has no published SHA-1; refusing to use an unverified file`);
    if (e.distribution === 'manual' || !e.url) {
      const dir = path.join(this.manualDir(), e.sha1);
      const candidate = fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => path.join(dir, f)).find((f) => f.endsWith('.jar')) : undefined;
      if (candidate && (await hashFile(candidate, 'sha1')) === e.sha1.toLowerCase()) return candidate;
      throw new Error(`Not redistributable through the API. Download ${e.fileName} from ${e.manualUrl ?? 'the project page'} and provide it (dependency_provide_file).`);
    }
    ctx?.log(`Downloading ${e.fileName}`);
    const dest = path.join(this.s.paths.downloads, e.provider, e.sha1.slice(0, 2), e.sha1, e.fileName);
    const r = await downloadVerified({ url: e.url, dest, sha1: e.sha1, sha512: e.sha512, size: e.size, signal: ctx?.signal });
    ctx?.log(`${r.cached ? 'Cached' : 'Downloaded and verified'} ${e.fileName}`);
    return r.path;
  }

  async provideManualFile(file: string): Promise<{ sha1: string; stored: string; matches: { workspace: string; profile: string; title: string }[] }> {
    if (!fs.existsSync(file) || !file.toLowerCase().endsWith('.jar')) throw new Error('Choose an existing .jar file');
    const sha1 = await hashFile(file, 'sha1');
    const dir = path.join(this.manualDir(), sha1);
    fs.mkdirSync(dir, { recursive: true });
    const stored = path.join(dir, path.basename(file));
    fs.copyFileSync(file, `${stored}.tmp`);
    fs.renameSync(`${stored}.tmp`, stored);
    const matches: { workspace: string; profile: string; title: string }[] = [];
    for (const r of this.s.store.listRecent()) {
      try {
        const lock = readLock(r.path);
        for (const [profile, p] of Object.entries(lock.profiles)) for (const e of p.entries) if (e.sha1?.toLowerCase() === sha1) matches.push({ workspace: r.path, profile, title: e.title });
      } catch {
        void 0;
      }
    }
    return { sha1, stored, matches };
  }

  resolveOp(root: string, profileId: string, mode?: 'development' | 'production'): OperationInfo {
    const dir = this.ws.normalize(root);
    return this.s.ops.start({ kind: 'profile.resolve', title: `Resolve profile ${profileId}`, workspace: dir }, async (ctx) => {
      const r = await this.resolve(dir, profileId, ctx, { mode });
      return { entries: r.entries, issues: r.issues, optionalSuggestions: r.optionalSuggestions };
    });
  }

  syncInstance(instanceDir: string, files: { name: string; source: string }[], ctx: OpContext | null): { added: string[]; removed: string[]; unmanaged: string[] } {
    const modsDir = path.join(instanceDir, 'mods');
    fs.mkdirSync(modsDir, { recursive: true });
    const managedFile = path.join(modsDir, '.modsmith-managed.json');
    const legacyFile = legacyManagedFile(modsDir);
    const previous: string[] = [...(fs.existsSync(managedFile) ? JSON.parse(fs.readFileSync(managedFile, 'utf8')) : []), ...(fs.existsSync(legacyFile) ? JSON.parse(fs.readFileSync(legacyFile, 'utf8')) : [])];
    if (fs.existsSync(legacyFile)) fs.rmSync(legacyFile);
    const wanted = new Map(files.map((f) => [f.name, f.source]));
    const removed: string[] = [];
    const added: string[] = [];
    for (const name of previous) {
      if (!wanted.has(name) && fs.existsSync(path.join(modsDir, name))) {
        fs.rmSync(path.join(modsDir, name));
        removed.push(name);
      }
    }
    for (const [name, source] of wanted) {
      const dest = path.join(modsDir, name);
      const srcStat = fs.statSync(source);
      if (fs.existsSync(dest) && fs.statSync(dest).size === srcStat.size && fs.statSync(dest).mtimeMs >= srcStat.mtimeMs) continue;
      const tmp = `${dest}.tmp`;
      fs.copyFileSync(source, tmp);
      fs.renameSync(tmp, dest);
      added.push(name);
    }
    fs.writeFileSync(managedFile, JSON.stringify([...wanted.keys()], null, 2));
    const unmanaged = fs.readdirSync(modsDir).filter((f) => f.endsWith('.jar') && !wanted.has(f));
    if (ctx) {
      ctx.log(`Instance mods: ${wanted.size} managed, ${added.length} updated, ${removed.length} removed${unmanaged.length ? `, ${unmanaged.length} unmanaged files left in place: ${unmanaged.join(', ')}` : ''}`);
    }
    return { added, removed, unmanaged };
  }

  overlay(root: string, profile: Profile, instanceDir: string, ctx: OpContext | null): void {
    const copyDir = (src: string, dest: string) => {
      if (!fs.existsSync(src)) {
        ctx?.log(`[warning] ${src} does not exist; skipped`);
        return;
      }
      fs.cpSync(src, dest, { recursive: true, force: true });
    };
    for (const link of readLinks(root)[profile.id] ?? []) {
      if (!link.enabled || !link.configs) continue;
      try {
        const pack = detectPackFolder(link.path, profile.side);
        for (const d of pack.configDirs) copyDir(d, path.join(instanceDir, configTarget(d)));
        if (pack.configDirs.length) ctx?.log(`Copied ${pack.configDirs.map((d) => path.basename(d)).join(', ')} from linked modpack ${pack.name}`);
      } catch (err) {
        ctx?.log(`[warning] Could not copy configs from ${link.path}: ${(err as Error).message}`);
      }
    }
    if (profile.configDir) copyDir(path.join(root, profile.configDir), path.join(instanceDir, 'config'));
    for (const rp of profile.resourcePacks) copyDir(path.join(root, rp), path.join(instanceDir, 'resourcepacks', path.basename(rp)));
    for (const sc of profile.scripts) copyDir(path.join(root, sc), path.join(instanceDir, path.basename(sc)));
    if (profile.world?.name) {
      for (const dp of profile.datapacks) copyDir(path.join(root, dp), path.join(instanceDir, 'saves', profile.world.name, 'datapacks', path.basename(dp)));
    } else if (profile.datapacks.length) {
      ctx?.log('[warning] Datapacks are configured but the profile has no world name; datapacks were not installed');
    }
  }

  compare(root: string, a: string, b: string) {
    const dir = this.ws.normalize(root);
    const manifest = this.ws.requireManifest(dir);
    const lock = readLock(dir);
    const pa = manifest.profiles.find((p) => p.id === a);
    const pb = manifest.profiles.find((p) => p.id === b);
    if (!pa || !pb) throw new Error('Unknown profile');
    const la = lock.profiles[a]?.entries ?? [];
    const lb = lock.profiles[b]?.entries ?? [];
    const keyOf = (e: LockEntry) => e.projectId ?? e.key;
    const mapA = new Map(la.map((e) => [keyOf(e), e]));
    const mapB = new Map(lb.map((e) => [keyOf(e), e]));
    const onlyA = la.filter((e) => !mapB.has(keyOf(e))).map((e) => `${e.title} ${e.versionNumber ?? ''}`.trim());
    const onlyB = lb.filter((e) => !mapA.has(keyOf(e))).map((e) => `${e.title} ${e.versionNumber ?? ''}`.trim());
    const changed = la.filter((e) => mapB.has(keyOf(e)) && (mapB.get(keyOf(e))!.sha1 ?? '') !== (e.sha1 ?? '')).map((e) => ({ title: e.title, a: e.versionNumber ?? e.sha1, b: mapB.get(keyOf(e))!.versionNumber ?? mapB.get(keyOf(e))!.sha1 }));
    const settings: { field: string; a: unknown; b: unknown }[] = [];
    for (const k of ['side', 'mode', 'includeSourceMod', 'bridge', 'configDir', 'resourcePacks', 'datapacks', 'scripts', 'world', 'jvm', 'java', 'debug', 'programArgs'] as const) {
      if (JSON.stringify(pa[k]) !== JSON.stringify(pb[k])) settings.push({ field: k, a: pa[k], b: pb[k] });
    }
    return { a, b, resolved: { a: !!lock.profiles[a], b: !!lock.profiles[b] }, onlyA, onlyB, changed, settings };
  }

  metadataFor(file: string): ModMetadata[] {
    return readJarMetadata(file);
  }
}
