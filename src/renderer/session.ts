import type { InstanceInfo, OperationInfo } from '../shared/types';
import type { Manifest, ProfileView } from './store';

export const LAUNCHABLE_LOADERS = ['fabric', 'neoforge'];

export function canLaunchLoader(loader?: string) {
  return !!loader && LAUNCHABLE_LOADERS.includes(loader);
}

export function profileLabel(p: Pick<ProfileView, 'name' | 'side' | 'mode'>): string {
  if (/^development client$/i.test(p.name)) return 'Test Client';
  if (/^development server$/i.test(p.name)) return 'Dedicated Server';
  return p.name;
}

export function profileDescription(p: ProfileView, m?: Manifest | null): string {
  const extra = p.mods.length ? ` plus ${p.mods.length} extra mod${p.mods.length === 1 ? '' : 's'}` : '';
  if (p.mode === 'production' && p.side === 'client') return `Builds the release JAR and plays it in a normal Minecraft client, like players get${extra}.`;
  if (p.mode === 'production') return `Builds the release JAR and runs it on a real ${m?.platform.loader === 'fabric' ? 'Fabric ' : ''}server${extra}.`;
  if (p.side === 'server') return `Checks that the project works on a dedicated server${extra}.`;
  if (!p.includeSourceMod) return `Plays the configured mod set without the project's own code${extra}.`;
  return `Play with the project's current code${extra}.`;
}

export type PlayPhase = 'idle' | 'preparing' | 'building' | 'starting' | 'running' | 'stopping' | 'build-failed' | 'launch-failed';

export interface PlayState {
  phase: PlayPhase;
  label: string;
  detail?: string;
  op?: OperationInfo;
  instance?: InstanceInfo;
  busy: boolean;
  active: boolean;
}

const LIVE = ['starting', 'running', 'stopping'];

export function derivePlayState(ops: OperationInfo[], instances: InstanceInfo[], workspace: string, profileId: string | null): PlayState {
  const launchOp = ops.find((o) => o.kind === 'instance.launch' && o.workspace === workspace);
  const inst = instances.find((i) => i.workspace === workspace && LIVE.includes(i.status) && (!profileId || i.profileId === profileId)) ?? instances.find((i) => i.workspace === workspace && LIVE.includes(i.status));
  if (launchOp?.status === 'running') {
    const msg = launchOp.message ?? '';
    const building = /Gradle|Compiling|Building|harness/i.test(msg);
    const starting = /Starting Java/i.test(msg);
    const phase: PlayPhase = starting ? 'starting' : building ? 'building' : 'preparing';
    return { phase, label: phase === 'building' ? 'Building' : phase === 'starting' ? 'Starting Minecraft' : 'Preparing', detail: msg, op: launchOp, busy: true, active: true };
  }
  if (inst) {
    if (inst.status === 'stopping') return { phase: 'stopping', label: 'Stopping', instance: inst, busy: true, active: true };
    if (inst.status === 'starting') return { phase: 'starting', label: 'Starting Minecraft', detail: inst.bridge.connected ? 'Loading game' : 'Waiting for the game window', instance: inst, busy: true, active: true };
    return { phase: 'running', label: 'Running', instance: inst, busy: false, active: true };
  }
  if (launchOp?.status === 'failed' && Date.now() - (launchOp.endedAt ?? 0) < 30 * 60 * 1000) {
    const gradle = /Gradle failed|compile|Build failed|exit \d+\)/i.test(launchOp.error ?? '');
    return { phase: gradle ? 'build-failed' : 'launch-failed', label: gradle ? 'Build failed' : 'Launch failed', detail: launchOp.error, op: launchOp, busy: false, active: false };
  }
  return { phase: 'idle', label: 'Ready to play', busy: false, active: false };
}

export type ChangeKind = 'assets' | 'data' | 'code' | 'metadata' | 'build' | 'config' | 'other';

export function classifyChange(file: string): ChangeKind {
  const f = file.replace(/\\/g, '/');
  if (/(^|\/)(build\.gradle|settings\.gradle|gradle\.properties|modsmith\.dependencies\.gradle)(\.kts)?$/.test(f) || /^gradle\//.test(f)) return 'build';
  if (/\.(java|kt|groovy|scala)$/.test(f) || /mixins?\.json$/.test(f) || /\.accesswidener$/.test(f)) return 'code';
  if (/(fabric\.mod\.json|neoforge\.mods\.toml|mods\.toml)$/.test(f)) return 'metadata';
  if (/\/resources\/assets\//.test(f) || /\/generated\/(resources\/)?assets\//.test(f)) return 'assets';
  if (/\/resources\/data\//.test(f) || /\/generated\/(resources\/)?data\//.test(f)) return 'data';
  if (/(^|\/)config\//.test(f) || /\.(toml|json5|properties|cfg)$/.test(f)) return 'config';
  return 'other';
}

export interface ChangeSummary {
  assets: number;
  data: number;
  restart: number;
  config: number;
  other: number;
  files: { path: string; kind: ChangeKind }[];
}

export function summarizeChanges(files: { path: string; kind: ChangeKind }[]): ChangeSummary {
  const s: ChangeSummary = { assets: 0, data: 0, restart: 0, config: 0, other: 0, files };
  for (const f of files) {
    if (f.kind === 'assets') s.assets++;
    else if (f.kind === 'data') s.data++;
    else if (f.kind === 'code' || f.kind === 'metadata' || f.kind === 'build') s.restart++;
    else if (f.kind === 'config') s.config++;
    else s.other++;
  }
  return s;
}

const LAYOUT_KEY = 'mwb.layout.v2';

export interface LayoutPrefs {
  sidePanel: 'project' | null;
  inspector: boolean;
  drawer: boolean;
  drawerTab: 'console' | 'problems' | 'tasks' | 'tests' | 'activity';
  explorerView: 'project' | 'files';
  groups: Record<string, Record<string, number>>;
}

export const DEFAULT_LAYOUT: LayoutPrefs = { sidePanel: 'project', inspector: false, drawer: false, drawerTab: 'console', explorerView: 'project', groups: {} };

export function loadLayout(): LayoutPrefs {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) return { ...DEFAULT_LAYOUT, ...JSON.parse(raw) };
  } catch {
    void 0;
  }
  return { ...DEFAULT_LAYOUT };
}

export function saveLayout(l: LayoutPrefs) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));
  } catch {
    void 0;
  }
}

export function clearLayout() {
  try {
    localStorage.removeItem(LAYOUT_KEY);
  } catch {
    void 0;
  }
}

export function plainIssue(message: string): string {
  let m = message.match(/declares a dependency on "([^"]+)" which is not present/);
  if (m) return `Requires ${friendlyModId(m[1])}.`;
  m = message.match(/has no (\w+) version for Minecraft ([\w.-]+)/);
  if (m) return `No ${cap(m[1])} build for Minecraft ${m[2]}.`;
  if (/does not declare .* support/.test(message)) return 'Made for a different Minecraft version or loader.';
  m = message.match(/is a (\w+) mod, not (\w+)/);
  if (m) return `Made for ${cap(m[1])}, not ${cap(m[2])}.`;
  m = message.match(/Duplicate mod ID "([^"]+)"/);
  if (m) return `Two installed files use the same mod ID (${m[1]}).`;
  if (/duplicates a mod on the development classpath/.test(message)) return 'Already provided by the project; remove this copy.';
  if (/included more than once/.test(message)) return 'The same file is installed twice.';
  m = message.match(/declares "([^"]+)" as breaking/);
  if (m) return `Known to break with ${friendlyModId(m[1])}.`;
  if (/incompatible/.test(message)) return 'Marked as incompatible with another installed mod.';
  if (/does not allow third-party downloads|Manual file missing|Not redistributable/.test(message)) return 'Needs a manual download from CurseForge.';
  if (/unsupported on the (client|server) side/.test(message)) return 'Not used on this side (client or server).';
  if (/already provided by the development classpath/.test(message)) return 'Already provided by the project.';
  if (/is disabled in this profile/.test(message)) return 'Disabled.';
  if (/Download failed/.test(message)) return 'Download failed.';
  if (/not configured/.test(message)) return 'CurseForge needs an API key (Settings > Providers).';
  return message;
}

function cap(s: string) {
  return s === 'neoforge' ? 'NeoForge' : s.charAt(0).toUpperCase() + s.slice(1);
}

function friendlyModId(id: string) {
  const known: Record<string, string> = { 'fabric-api': 'Fabric API', fabric: 'Fabric API', fabricloader: 'Fabric Loader', cloth_config: 'Cloth Config', 'cloth-config': 'Cloth Config', modmenu: 'Mod Menu', architectury: 'Architectury API', geckolib: 'GeckoLib', neoforge: 'NeoForge' };
  return known[id] ?? id;
}
