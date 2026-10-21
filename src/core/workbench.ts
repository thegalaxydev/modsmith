import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ActivitySource } from '../shared/types';
import { PRODUCT } from '../shared/product';
import { API, type MethodName } from '../shared/api';
import { appPaths } from './paths';
import { Store } from './db';
import { EventBus } from './events';
import { OperationManager } from './operations';
import { JavaService } from './java';
import { TemurinService, jdksDir } from './temurin';
import { CompatibilityCatalog } from './catalog';
import { HttpClient } from './http';
import { ModrinthClient } from './modrinth';
import { CurseForgeClient, pickCfFile, cfDistributable, curseforgeApi } from './curseforge';
import { SecretStore } from './secrets';
import { BridgeHost } from './bridge';
import { InstanceManager } from './instances';
import { FabricAdapter, PlannedAdapter } from './adapters/fabric';
import { NeoForgeAdapter } from './adapters/neoforge';
import type { Services } from './context';
import { WorkspaceService, stateDir } from './workspace';
import { ProjectService, type CreateProjectInput } from './projects';
import { ProfileService } from './profiles';
import { LaunchService } from './launch';
import { HotswapService } from './hotswap';
import { SessionService } from './sessions';
import { ModUpdateService } from './modupdates';
import { PerfService } from './perf';
import { DebugService } from './debug';
import { RegistryIndexService } from './regindex';
import { AssetService } from './assets';
import { LspService } from './lsp';
import { ThemeService } from './themes';
import { CrashService } from './crash';
import { SnapshotService } from './snapshots';
import { ScenarioService } from './scenarios';
import { BisectService } from './bisect';
import { MrpackService } from './mrpack';
import { PresetService } from './presets';
import { readJarMetadata } from './jarmeta';
import { readLock } from './manifest';
import { PackImportService } from './packimport';
import { checkForUpdate } from './updates';
import { redactValue } from './redact';

export type Handler = (params: any, meta: { source: ActivitySource }) => Promise<unknown> | unknown;

export interface McpLaunchInfo {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export class Workbench {
  readonly s: Services;
  readonly workspaces: WorkspaceService;
  readonly projects: ProjectService;
  readonly profiles: ProfileService;
  readonly packs: PackImportService;
  readonly launcher: LaunchService;
  readonly hotswap: HotswapService;
  readonly sessions: SessionService;
  readonly modUpdates: ModUpdateService;
  readonly perf: PerfService;
  readonly debug: DebugService;
  readonly registryIndex: RegistryIndexService;
  readonly assets: AssetService;
  readonly lsp: LspService;
  readonly themes: ThemeService;
  readonly crash: CrashService;
  readonly snapshots: SnapshotService;
  readonly scenarios: ScenarioService;
  readonly bisect: BisectService;
  readonly mrpack: MrpackService;
  readonly presets: PresetService;
  readonly temurin: TemurinService;
  readonly handlers: Record<MethodName, Handler>;
  mcpLaunch: McpLaunchInfo | null = null;
  cfKey: () => string | null = () => null;
  clientCounts: () => Record<string, number> = () => ({});
  resetCfKey: () => void = () => undefined;
  onShutdown: ((stopInstances: boolean) => void) | null = null;

  constructor() {
    const paths = appPaths();
    const store = new Store(paths.db);
    const bus = new EventBus();
    const http = new HttpClient(store);
    const catalog = new CompatibilityCatalog(paths.resources);
    const bridge = new BridgeHost(bus);
    const secrets = new SecretStore(path.join(paths.data, 'secrets.json'));
    let cfKeyCache: string | null | undefined;
    this.cfKey = () => {
      if (process.env.MODSMITH_CURSEFORGE_API_KEY) return process.env.MODSMITH_CURSEFORGE_API_KEY;
      if (cfKeyCache === undefined) {
        try {
          cfKeyCache = SecretStore.supported() ? secrets.get('curseforge.apiKey') : null;
        } catch {
          cfKeyCache = null;
        }
      }
      return cfKeyCache;
    };
    this.resetCfKey = () => {
      cfKeyCache = undefined;
    };
    const s: Services = {
      paths,
      store,
      bus,
      ops: new OperationManager(bus, store),
      java: new JavaService(store, jdksDir(paths.data)),
      catalog,
      http,
      modrinth: new ModrinthClient(http),
      curseforge: new CurseForgeClient(http, () => this.cfKey()),
      secrets,
      bridge,
      instances: new InstanceManager(bus, store, bridge),
      adapters: { fabric: new FabricAdapter(catalog, http), neoforge: new NeoForgeAdapter(catalog, http), forge: new PlannedAdapter('forge', 'Forge', catalog) }
    };
    this.s = s;
    this.workspaces = new WorkspaceService(s);
    this.projects = new ProjectService(s, this.workspaces);
    this.profiles = new ProfileService(s, this.workspaces);
    this.launcher = new LaunchService(s, this.workspaces, this.profiles, this.projects);
    this.hotswap = new HotswapService(s, this.projects);
    this.sessions = new SessionService(s, this.workspaces, this.launcher);
    this.modUpdates = new ModUpdateService(s, this.workspaces, this.profiles);
    this.debug = new DebugService(s, this.workspaces);
    this.registryIndex = new RegistryIndexService(s, this.workspaces);
    this.assets = new AssetService(this.registryIndex);
    this.lsp = new LspService(s, this.workspaces, this.projects);
    this.themes = new ThemeService(s);
    this.crash = new CrashService(s);
    this.snapshots = new SnapshotService(s, this.workspaces);
    this.scenarios = new ScenarioService(s, this.workspaces);
    this.perf = new PerfService(s, this.workspaces, this.launcher, this.scenarios);
    this.bisect = new BisectService(s, this.workspaces);
    this.mrpack = new MrpackService(s, this.workspaces);
    this.packs = new PackImportService(s, this.workspaces);
    this.presets = new PresetService(s);
    this.temurin = new TemurinService(s, this.workspaces);
    this.handlers = this.buildHandlers();
  }

  async start(): Promise<void> {
    await this.s.bridge.start();
  }

  async stop(stopInstances: boolean): Promise<void> {
    this.lsp.stopAll();
    this.debug.stopAll();
    if (stopInstances) await this.s.instances.stopAll();
    await this.s.bridge.stop();
    this.s.store.close();
  }

  async call(method: string, rawParams: unknown, source: ActivitySource): Promise<unknown> {
    const def = (API as Record<string, (typeof API)[MethodName]>)[method];
    if (!def) throw new Error(`Unknown method ${method}`);
    const parsed = def.params.safeParse(rawParams ?? {});
    if (!parsed.success) {
      const msg = invalidParams(method, parsed.error.issues);
      this.record(source, method, rawParams, 'error', msg, def.mutating);
      throw new Error(msg);
    }
    try {
      const result = await this.handlers[method as MethodName](parsed.data, { source });
      this.record(source, method, parsed.data, 'ok', summarize(result), def.mutating);
      return result;
    } catch (err) {
      this.record(source, method, parsed.data, 'error', (err as Error).message, def.mutating);
      throw err;
    }
  }

  private record(source: ActivitySource, method: string, params: unknown, status: 'ok' | 'error', summary: string, mutating: boolean): void {
    if (!mutating && source !== 'mcp' && status === 'ok') return;
    if (['operation.status', 'operation.wait', 'logs.read', 'instance.status', 'instance.list', 'operation.list', 'activity.list'].includes(method) && status === 'ok' && source !== 'mcp') return;
    const p = JSON.stringify(redactValue(params ?? {}));
    const entry = this.s.store.addActivity(source, method, p.length > 2000 ? p.slice(0, 2000) + '...' : p, status, summary.slice(0, 500));
    this.s.bus.emit('activity.added', entry);
  }

  private instanceOrThrow(id: string) {
    const i = this.s.instances.get(id);
    if (!i) throw new Error(`Unknown instance ${id}`);
    return i;
  }

  private bridgeCall(id: string, method: string, params: Record<string, unknown> = {}, timeout = 20000) {
    this.instanceOrThrow(id);
    return this.s.bridge.call(id, method, params, timeout);
  }

  private buildHandlers(): Record<MethodName, Handler> {
    const s = this.s;
    return {
      'system.check_update': (p) => checkForUpdate(s.http, p.force === true),
      'system.info': () => ({
        product: PRODUCT.name,
        version: PRODUCT.version,
        platform: `${process.platform} ${process.arch} (${os.release()})`,
        node: process.versions.node,
        dataDir: s.paths.data,
        cacheDir: s.paths.cache,
        resources: s.paths.resources,
        bridgePort: s.bridge.port,
        bridgeJars: fs.existsSync(path.join(s.paths.resources, 'bridge')) ? fs.readdirSync(path.join(s.paths.resources, 'bridge')).filter((f) => f.endsWith('.jar')) : [],
        nativeViewport: process.platform === 'win32' ? 'win32-reparent' : 'unsupported',
        clients: this.clientCounts(),
        demoMode: process.env.MODSMITH_DEMO === '1'
      }),
      'system.capabilities': () => [s.adapters.fabric, s.adapters.neoforge].map((a) => ({ id: a.id, name: a.displayName, implemented: a.implemented, capabilities: a.capabilities(), catalog: a.catalogEntries().map((e) => ({ id: e.id, minecraft: e.minecraft, status: e.status })) })),
      'java.list': (p) => s.java.list(!!p.refresh),
      'java.add': (p) => s.java.addHome(p.home),
      'java.install': (p) => this.temurin.install(p.major, p.imageType),
      'java.requirements': (p) => this.temurin.requirements(p),
      'catalog.list': () => ({ updated: s.catalog.updated, entries: s.catalog.entries }),
      'catalog.starters': (p) => {
        const e = s.catalog.get(p.entryId);
        if (!e) throw new Error(`Unknown catalog entry ${p.entryId}`);
        return s.adapters[e.loader].starterOptions(e);
      },
      'meta.game_versions': (p) => s.adapters[p.loader as 'fabric'].listGameVersions(),
      'meta.loader_versions': (p) => s.adapters[p.loader as 'fabric'].listLoaderVersions(p.minecraft),

      'workspace.list': () => s.store.listRecent().map((r) => ({ ...r, exists: fs.existsSync(r.path) })),
      'workspace.inspect': (p) => this.workspaces.inspect(p.path),
      'workspace.open': (p) => this.workspaces.open(p.path),
      'workspace.trust': (p) => this.workspaces.trust(p.path, p.trusted),
      'workspace.init': (p) => this.workspaces.initManifest(p.path, p),
      'workspace.tree': (p) => this.workspaces.tree(p.path, p.dir ?? '', p.depth ?? 3),
      'workspace.read_file': (p) => this.workspaces.readFile(p.path, p.file),
      'workspace.write_file': (p) => {
        const r = this.workspaces.writeFile(p.path, p.file, p.content, { expectedMtime: p.expectedMtime, create: p.create });
        s.bus.emit('workspace.file_changed', { workspace: this.workspaces.normalize(p.path), file: p.file });
        return r;
      },
      'workspace.image': (p) => this.workspaces.image(p.path),
      'workspace.set_image': (p) => {
        const r = this.workspaces.setImage(p.path, p.file);
        s.bus.emit('workspace.file_changed', { workspace: this.workspaces.normalize(p.path), file: PRODUCT.manifestFile });
        return r;
      },
      'workspace.delete_file': (p) => this.workspaces.deleteFile(p.path, p.file, p.confirm),

      'project.validate_create': (p) => this.projects.validateCreate(p.input as unknown as CreateProjectInput),
      'project.plan_dependencies': (p) => this.projects.planDependencies(p.minecraft, p.loader, p.refs),
      'project.create': (p) => this.projects.create(p as CreateProjectInput),
      'project.validate': (p) => this.projects.validate(p.path),
      'project.build': (p) => this.projects.build(p.path, { clean: p.clean, tasks: p.tasks }),
      'project.diagnostics': (p) => this.projects.diagnostics(p.path),
      'project.datagen': (p) => this.launcher.datagen(p.path),

      'preset.list': () => this.presets.list(),
      'preset.save': (p) => this.presets.save(p.preset),
      'preset.check': (p) => this.presets.check(p.id),

      'profile.list': (p) => this.profiles.list(p.path),
      'profile.create': (p) => this.profiles.create(p.path, p.profile),
      'profile.update': (p) => this.profiles.update(p.path, p.id, p.patch),
      'profile.clone': (p) => this.profiles.clone(p.path, p.source, p.id, p.name),
      'profile.remove': (p) => this.profiles.remove(p.path, p.id, p.confirm),
      'profile.resolve': (p) => this.profiles.resolveOp(p.path, p.id, p.mode),
      'profile.compare': (p) => this.profiles.compare(p.path, p.a, p.b),
      'profile.linked_packs': (p) => this.profiles.linkedPacks(p.path, p.profile),
      'profile.link_pack': (p) => this.profiles.linkPack(p.path, p.profile, { folder: p.folder, enabled: p.enabled, configs: p.configs }),
      'profile.unlink_pack': (p) => this.profiles.unlinkPack(p.path, p.profile, p.folder),
      'profile.discover_packs': (p) => this.profiles.discoverPacks(p.path, p.profile),
      'profile.lock': (p) => readLock(this.workspaces.normalize(p.path)),
      'profile.check_updates': (p) => this.modUpdates.check(p),
      'profile.preview_update': (p) => this.modUpdates.preview(p),
      'profile.apply_update': (p) => this.modUpdates.apply(p),
      'profile.update_history': (p) => this.modUpdates.history(p),
      'profile.rollback_update': (p) => this.modUpdates.rollback(p),

      'provider.status': () => ({
        providers: [
          { id: 'modrinth', name: 'Modrinth', usable: true, detail: 'Public API, no key required' },
          {
            id: 'curseforge',
            name: 'CurseForge',
            usable: s.curseforge.configured(),
            keySource: process.env.MODSMITH_CURSEFORGE_API_KEY ? 'environment' : s.secrets.has('curseforge.apiKey') ? 'os-secret-store' : null,
            detail: s.curseforge.configured() ? 'API key configured. Files whose authors disallow third-party distribution must be downloaded manually.' : 'Requires your own API key from the CurseForge for Studios console (console.curseforge.com). Modsmith does not ship one.',
            secretStorage: SecretStore.supported() ? 'Windows DPAPI (current user)' : 'unavailable; use MODSMITH_CURSEFORGE_API_KEY'
          }
        ]
      }),
      'provider.set_curseforge_key': async (p) => {
        if (!SecretStore.supported()) throw new Error('OS secret storage is not available on this platform; set MODSMITH_CURSEFORGE_API_KEY instead');
        const probe = await fetch(`${curseforgeApi()}/games/432`, { headers: { 'x-api-key': p.key, Accept: 'application/json' } });
        if (probe.status === 403 || probe.status === 401) throw new Error('CurseForge rejected this API key');
        if (!probe.ok) throw new Error(`Could not verify the key (HTTP ${probe.status})`);
        s.secrets.set('curseforge.apiKey', p.key);
        this.resetCfKey();
        return { stored: true, storage: 'Windows DPAPI' };
      },
      'provider.clear_curseforge_key': () => {
        s.secrets.delete('curseforge.apiKey');
        this.resetCfKey();
        return { cleared: true };
      },
      'dependency.search': async (p) => {
        if (p.provider === 'curseforge') {
          const r = await s.curseforge.search({ query: p.query, loader: p.loader, minecraft: p.minecraft, limit: p.limit, offset: p.offset });
          return {
            provider: 'curseforge',
            total: r.total,
            stale: r.stale,
            fetchedAt: r.fetchedAt,
            hits: r.hits.map((m) => ({ id: String(m.id), slug: m.slug, title: m.name, description: m.summary, author: m.authors?.map((a) => a.name).join(', ') ?? '', downloads: m.downloadCount, iconUrl: m.logo?.thumbnailUrl ?? m.logo?.url, clientSide: 'unknown', serverSide: 'unknown', license: '', distribution: m.allowModDistribution === false ? 'manual' : 'direct', url: m.links?.websiteUrl }))
          };
        }
        const r = await s.modrinth.search({ query: p.query, loader: p.loader, minecraft: p.minecraft, limit: p.limit, offset: p.offset });
        return {
          provider: 'modrinth',
          total: r.total_hits,
          stale: r.stale,
          fetchedAt: r.fetchedAt,
          hits: r.hits.map((h) => ({ id: h.project_id, slug: h.slug, title: h.title, description: h.description, author: h.author, downloads: h.downloads, iconUrl: h.icon_url, clientSide: h.client_side, serverSide: h.server_side, license: h.license, distribution: 'direct', url: `https://modrinth.com/mod/${h.slug}` }))
        };
      },
      'dependency.versions': async (p) => {
        if (p.provider === 'curseforge') {
          const files = await s.curseforge.files(p.projectId, { loader: p.loader, minecraft: p.minecraft });
          const mod = await s.curseforge.mod(p.projectId);
          const best = p.loader && p.minecraft ? pickCfFile(files, p.loader, p.minecraft) : null;
          return files.map((f) => ({ id: String(f.id), name: f.displayName, fileName: f.fileName, releaseType: f.releaseType, gameVersions: f.gameVersions, date: f.fileDate, distribution: cfDistributable(mod, f) ? 'direct' : 'manual', recommended: best?.id === f.id }));
        }
        return s.modrinth.versions(p.projectId, { loader: p.loader, minecraft: p.minecraft });
      },
      'dependency.provide_file': (p) => this.profiles.provideManualFile(p.file),
      'dependency.add': async (p) => {
        const ref = { ...p.ref } as Record<string, unknown>;
        if (ref.source === 'modrinth') {
          if (!ref.projectId) throw new Error('projectId is required for Modrinth mods');
          const proj = await s.modrinth.project(String(ref.projectId));
          ref.projectId = proj.id;
          ref.slug = proj.slug;
          ref.title = ref.title ?? proj.title;
        }
        if (ref.source === 'curseforge') {
          if (!ref.projectId || !/^\d+$/.test(String(ref.projectId))) throw new Error('A numeric CurseForge projectId is required');
          const mod = await s.curseforge.mod(String(ref.projectId));
          ref.slug = mod.slug;
          ref.title = ref.title ?? mod.name;
          ref.usage = 'runtime';
          if (ref.versionId && !ref.fileId) ref.fileId = ref.versionId;
          delete ref.versionId;
        }
        if (ref.source === 'local') {
          if (!ref.path) throw new Error('path is required for local mods');
          const abs = path.resolve(this.workspaces.normalize(p.path), String(ref.path));
          if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
          ref.path = abs;
        }
        return this.profiles.addMod(p.path, p.profile ?? null, ref);
      },
      'dependency.remove': (p) => this.profiles.removeMod(p.path, p.profile ?? null, p.key),
      'dependency.set_enabled': (p) => this.profiles.setModEnabled(p.path, p.profile ?? null, p.key, p.enabled),
      'dependency.inspect_jar': (p) => readJarMetadata(p.file),

      'instance.launch': (p) => this.launcher.launch(p.path, p.profile, { mode: p.mode }),
      'instance.stop': (p) => this.launcher.stop(p.id, !!p.force),
      'instance.hotswap': (p) => this.hotswap.start(p.id),
      'session.start': (p) => this.sessions.start(p),
      'perf.run': (p) => this.perf.run(p),
      'debug.connect': (p) => this.debug.connect(p),
      'debug.send': (p) => this.debug.send(p),
      'debug.disconnect': (p) => this.debug.disconnect(p),
      'debug.list': (p) => this.debug.list(p),
      'perf.results': (p) => this.perf.results(p),
      'perf.compare': (p) => this.perf.compare(p),
      'perf.delete': (p) => this.perf.remove(p),
      'session.list': (p) => this.sessions.list(p.path),
      'session.stop': (p) => this.sessions.stop(p.id),
      'registry.index': (p) => this.registryIndex.index(p.path),
      'assets.validate': (p) => this.assets.validate(p.path, { file: p.file, content: p.content }),
      'assets.model': (p) => this.assets.model(p.path, p.model),
      'instance.debug_port_check': (p) => this.hotswap.portCheck(p.port ?? 5005),
      'instance.list': () => s.instances.list(),
      'instance.status': (p) => ({ ...this.instanceOrThrow(p.id), bridge: { ...this.instanceOrThrow(p.id).bridge, ...s.bridge.status(p.id) } }),
      'instance.history': (p) => s.store.listLaunches(p.path ? this.workspaces.normalize(p.path) : undefined),
      'instance.eula_status': (p) => this.launcher.eulaStatus(p.path, p.profile, p.mode),
      'instance.accept_eula': (p) => this.launcher.acceptEula(p.path, p.profile, p.mode, p.accept),
      'lsp.status': (p) => this.lsp.status(p.path, p.language),
      'lsp.install': (p) => this.lsp.install(p.language),
      'lsp.start': (p) => this.lsp.start(p.path, p.language),
      'lsp.send': (p) => this.lsp.send(p.session, p.message),
      'lsp.stop': (p) => this.lsp.stop(p.session),
      'theme.inspect': (p) => this.themes.inspect(p.file),
      'theme.install': (p) => this.themes.install(p.file, p.variants),
      'theme.list': () => this.themes.list(),
      'theme.remove': (p) => this.themes.remove(p.id),
      'server.export_pack': (p) => this.launcher.exportServerPack(p.path, p.profile, p.output, p.zip),
      'instance.send_input': (p) => s.instances.sendInput(p.id, p.line),

      'logs.read': (p) => s.instances.logs(p.id, p),
      'crash.inspect': (p) => this.crash.inspect(p.id),
      'crash.bundle': (p) => this.crash.bundle(p.id, p.notes),

      'bridge.status': (p) => ({ instance: p.id, ...s.bridge.status(p.id) }),
      'bridge.call': (p) => this.bridgeCall(p.id, p.method, p.params ?? {}),
      'game.status': async (p) => {
        const i = this.instanceOrThrow(p.id);
        const base = (await this.bridgeCall(p.id, 'game.status')) as Record<string, unknown>;
        if (i.side !== 'client') return { ...base, inWorld: base.worldLoaded };
        return { ...base, ...((await this.bridgeCall(p.id, 'client.status')) as Record<string, unknown>) };
      },
      'game.mods': (p) => this.bridgeCall(p.id, 'game.mods'),
      'game.telemetry': (p) => this.bridgeCall(p.id, 'game.telemetry'),
      'game.reload': (p) => this.bridgeCall(p.id, p.kind === 'resources' ? 'client.reload_resources' : 'world.reload_datapacks', {}, 120000),
      'game.reload_capabilities': (p) => {
        const i = this.instanceOrThrow(p.id);
        const connected = s.bridge.status(p.id).connected;
        return {
          instance: p.id,
          actions: [
            { id: 'resources', label: 'Asset/resource reload', supported: connected && i.side === 'client', detail: i.side === 'client' ? 'Reloads textures, models, sounds, language files from resource packs and mod JARs. Changed source files must be rebuilt into the classpath first (Build updates build/resources).' : 'Dedicated servers have no client resources' },
            { id: 'datapacks', label: 'Datapack reload', supported: connected, detail: 'Runs /reload on the logical server: recipes, tags, loot tables, advancements, functions.' },
            { id: 'config', label: 'Config reload', supported: false, detail: 'Config reload depends on each mod; no generic mechanism is available. Restart to apply config changes unless the mod provides its own reload command.' },
            {
              id: 'hotswap',
              label: 'Java hot reload',
              supported: !!i.debugPort && i.mode === 'development',
              detail:
                i.mode !== 'development'
                  ? 'Release runs use the built JAR. Rebuild and restart to apply code changes.'
                  : i.debugPort
                    ? `Apply changes compiles the project and replaces changed method bodies in the running game through the debug port 127.0.0.1:${i.debugPort}. New or removed methods and fields, signature or hierarchy changes, static initializers, mixins and registration changes need a restart.`
                    : 'Turn on hot reload for this profile, which enables the debug port, and restart the game.'
            },
            { id: 'restart', label: 'Full rebuild and restart', supported: true, detail: 'Required for new registry entries, mixins, added or changed mods, entrypoints, and structural Java changes.' }
          ]
        };
      },
      'registry.search': (p) => this.bridgeCall(p.id, 'registry.search', { registry: p.registry, query: p.query, limit: p.limit ?? 100 }),
      'world.open': (p) => {
        if (this.instanceOrThrow(p.id).side !== 'client') throw new Error('Opening worlds is only possible in a client instance');
        return this.bridgeCall(p.id, 'world.open', { name: p.name, create: p.create, flat: p.flat, seed: p.seed });
      },
      'world.inspect_target': (p) => this.bridgeCall(p.id, 'world.inspect_target'),
      'world.give_item': (p) => this.bridgeCall(p.id, 'world.give_item', { item: p.item, count: p.count, player: p.player }),
      'world.run_command': (p) => this.bridgeCall(p.id, 'world.run_command', { command: p.command }, 60000),
      'world.entities': (p) => this.bridgeCall(p.id, 'world.entities', { radius: p.radius, limit: p.limit ?? 100 }),
      'world.recipes': (p) => this.bridgeCall(p.id, 'world.recipes', { query: p.query, limit: p.limit ?? 100 }),
      'world.tags': (p) => this.bridgeCall(p.id, 'world.tags', { registry: p.registry, query: p.query, limit: p.limit ?? 100 }),
      'world.snapshot': (p) => s.ops.start({ kind: 'world.snapshot', title: `Snapshot ${p.profile}`, workspace: this.workspaces.normalize(p.path) }, async () => {
        const running = s.instances.list().find((i) => i.workspace === this.workspaces.normalize(p.path) && i.profileId === p.profile && ['running', 'starting'].includes(i.status));
        const save = running && s.bridge.status(running.id).connected ? async () => void (await s.bridge.call(running.id, 'world.save', {}, 60000)) : null;
        return this.snapshots.create(p.path, p.profile, p.world, p.name, save);
      }),
      'world.snapshots': (p) => this.snapshots.list(p.path),
      'world.restore': (p) => this.snapshots.restore(p.path, p.profile, p.snapshot, p.confirm),
      'viewport.capture': async (p) => {
        const i = this.instanceOrThrow(p.id);
        if (i.side !== 'client') throw new Error('Screenshots require a client instance');
        const r = (await s.bridge.call(p.id, 'client.screenshot', {}, 30000)) as { png: string; width: number; height: number };
        const dir = path.join(i.instanceDir, 'screenshots', 'modsmith');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
        fs.writeFileSync(file, Buffer.from(r.png, 'base64'));
        return { file, width: r.width, height: r.height, pngBase64: r.png };
      },

      'scenario.list': (p) => this.scenarios.list(p.path),
      'scenario.run': (p) => this.scenarios.run(p.path, p.scenario, p.instance),
      'scenario.results': (p) => this.scenarios.results(p.path),
      'scenario.save': (p) => this.scenarios.save(p.path, p.file, p.scenario),
      'scenario.delete': (p) => this.scenarios.remove(p.path, p.file, p.confirm),

      'bisect.start': (p) => this.bisect.start(p.path, p.profile, p.predicate),
      'bisect.status': (p) => this.bisect.status(p.path),
      'bisect.record': (p) => this.bisect.record(p.path, p.outcome),
      'bisect.reset': (p) => this.bisect.reset(p.path),

      'modpack.import_mrpack': (p) => this.mrpack.importPack(p.file, p.destination, p.name),
      'modpack.search': (p) => this.packs.searchModpacks({ provider: p.provider, query: p.query, loader: p.loader, minecraft: p.minecraft, limit: p.limit, offset: p.offset }),
      'profile.import_pack': (p) => this.packs.importIntoProfile(p.path, { profile: p.profile, name: p.name, side: p.side, file: p.file, modrinth: p.modrinth, curseforge: p.curseforge }),
      'profile.remove_pack': (p) => this.packs.removeImported(p.path, p.profile, p.pack),
      'modpack.import_curseforge': (p) => this.mrpack.importCurseForge(p.file, p.destination, p.name),
      'modpack.export_curseforge': (p) => this.mrpack.exportCurseForge(p.path, p.profile, p.output, p.version),
      'modpack.export_mrpack': (p) => this.mrpack.exportPack(p.path, p.profile, p.output, p.version),

      'operation.list': () => s.ops.list(),
      'operation.status': (p) => {
        const op = s.ops.get(p.id);
        if (!op) throw new Error(`Unknown operation ${p.id}`);
        return op;
      },
      'operation.wait': async (p) => {
        const op = await s.ops.wait(p.id, p.timeoutMs);
        if (!op) throw new Error(`Unknown operation ${p.id}`);
        return op;
      },
      'operation.cancel': (p) => ({ cancelled: s.ops.cancel(p.id) }),
      'operation.log': (p) => {
        const lines = s.ops.fullLog(p.id);
        return { lines: p.tail ? lines.slice(-p.tail) : lines };
      },

      'activity.list': (p) => s.store.listActivity(p.limit ?? 200, p.source),
      'mcp.config': () => this.mcpConfig(),
      'viewport.window': async (p) => {
        const i = this.instanceOrThrow(p.id);
        if (process.platform !== 'win32' || !i.pid) return { supported: false, hwnd: null, reason: 'Native docking is only implemented on Windows' };
        const w = await import('../native/win32');
        const win = w.findGameWindow([i.pid]);
        return { supported: true, hwnd: win?.hwnd ?? null, title: win?.title ?? null, pid: i.pid };
      },
      'service.shutdown': (p) => {
        setTimeout(() => this.onShutdown?.(!!p.stopInstances), 50);
        return { stopping: true };
      }
    };
  }

  mcpConfig() {
    const launch = this.mcpLaunch;
    if (!launch) return { available: false, reason: 'MCP launch command unknown' };
    const config = { mcpServers: { [PRODUCT.id]: { command: launch.command, args: launch.args, env: launch.env } } };
    return {
      available: true,
      config,
      claudeCodeCommand: `claude mcp add ${PRODUCT.id} ${Object.entries(launch.env).map(([k, v]) => `-e ${k}=${v}`).join(' ')} -- "${launch.command}" ${launch.args.map((a) => `"${a}"`).join(' ')}`.replace(/\s+/g, ' ').trim(),
      note: 'The MCP server is a stdio process that connects to the running Modsmith service (starting it if needed), so the UI, CLI and assistants share the same instances and history.'
    };
  }

  stateDirFor(ws: string): string {
    return stateDir(this.workspaces.normalize(ws));
  }
}

function invalidParams(method: string, issues: { path: PropertyKey[]; message: string }[]): string {
  return `Invalid parameters for ${method}: ${issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`;
}

function summarize(result: unknown): string {
  if (result === undefined || result === null) return 'ok';
  if (typeof result !== 'object') return String(result).slice(0, 200);
  const r = result as Record<string, unknown>;
  if (typeof r.kind === 'string' && typeof r.id === 'string' && typeof r.status === 'string') return `operation ${r.id} ${r.status}`;
  if (Array.isArray(result)) return `${result.length} items`;
  const keys = Object.keys(r).slice(0, 6).join(', ');
  return `{${keys}}`;
}
