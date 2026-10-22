import type { InstanceInfo, OperationInfo } from '../shared/types';
import type { Manifest, ProfileView } from './store';

export const LAUNCHABLE_LOADERS = ['fabric', 'neoforge', 'forge'];

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
  if (!p.includeSourceMod) return `Runs the configured mod set without the project's own code${extra}.`;
  return `Runs the project's current code${extra}.`;
}

export type PlayPhase = 'idle' | 'preparing' | 'building' | 'starting' | 'running' | 'stopping' | 'build-failed' | 'launch-failed' | 'crashed';

export interface PlayState {
  phase: PlayPhase;
  label: string;
  detail?: string;
  op?: OperationInfo;
  instance?: InstanceInfo;
  last?: InstanceInfo;
  busy: boolean;
  active: boolean;
  failed: boolean;
  tone: 'idle' | 'busy' | 'ok' | 'err';
}

const LIVE = ['starting', 'running', 'stopping'];
const ENDED = ['exited', 'crashed', 'failed'];
const RECENT = 30 * 60 * 1000;

export function derivePlayState(ops: OperationInfo[], instances: InstanceInfo[], workspace: string, profileId: string | null): PlayState {
  const launchOp = ops.find((o) => o.kind === 'instance.launch' && o.workspace === workspace);
  const live = instances.filter((i) => i.workspace === workspace && LIVE.includes(i.status)).sort((a, b) => Number((a.slot ?? 0) > 1) - Number((b.slot ?? 0) > 1));
  const inst = live.find((i) => !profileId || i.profileId === profileId) ?? live[0];
  const last = instances.filter((i) => i.workspace === workspace && ENDED.includes(i.status) && (!profileId || i.profileId === profileId)).sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))[0];
  const base = { last, busy: false, active: false, failed: false };
  if (launchOp?.status === 'running') {
    const msg = launchOp.message ?? '';
    const building = /Gradle|Compiling|Building|harness/i.test(msg);
    const starting = /Starting Java/i.test(msg);
    const phase: PlayPhase = starting ? 'starting' : building ? 'building' : 'preparing';
    return { ...base, phase, label: phase === 'building' ? 'Building' : phase === 'starting' ? 'Starting' : 'Preparing', detail: msg, op: launchOp, busy: true, active: true, tone: 'busy' };
  }
  if (inst) {
    if (inst.status === 'stopping') return { ...base, phase: 'stopping', label: 'Stopping', instance: inst, busy: true, active: true, tone: 'busy' };
    if (inst.status === 'starting') return { ...base, phase: 'starting', label: 'Starting', detail: inst.side === 'server' ? 'Loading the server' : inst.bridge.connected ? 'Loading the game' : 'Waiting for the game window', instance: inst, busy: true, active: true, tone: 'busy' };
    return { ...base, phase: 'running', label: 'Running', instance: inst, active: true, tone: 'ok' };
  }
  const opFailedAt = launchOp?.status === 'failed' ? launchOp.endedAt ?? 0 : 0;
  const lastAt = last ? last.endedAt ?? last.startedAt : 0;
  if (opFailedAt && Date.now() - opFailedAt < RECENT && opFailedAt >= lastAt) {
    const gradle = /Gradle failed|compile|Build failed|exit \d+\)/i.test(launchOp?.error ?? '');
    return { ...base, phase: gradle ? 'build-failed' : 'launch-failed', label: gradle ? 'Build failed' : 'Launch failed', detail: launchOp?.error, op: launchOp, failed: true, tone: 'err' };
  }
  if (last && last.status !== 'exited' && Date.now() - lastAt < RECENT) {
    const label = last.status === 'failed' ? 'Failed to start' : `Crashed${last.exitCode != null ? ` (exit ${last.exitCode})` : ''}`;
    return { ...base, phase: 'crashed', label, detail: last.crashReport ? `Crash report: ${last.crashReport}` : undefined, failed: true, tone: 'err' };
  }
  return { ...base, phase: 'idle', label: 'Stopped', detail: last?.status === 'exited' ? `Last run ended normally ${ago(lastAt)}` : undefined, tone: 'idle' };
}

export function primaryLabel(state: PlayState, side: 'client' | 'server' | undefined): string {
  if (state.phase === 'running') return 'Stop';
  if (state.phase === 'stopping') return 'Stopping';
  if (state.phase === 'starting') return 'Starting';
  if (state.phase === 'building' || state.phase === 'preparing') return 'Building';
  return side === 'server' ? 'Start server' : 'Launch client';
}

export function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

export function uptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
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

export const isSourceChange = (f: { path: string; kind: ChangeKind }) => f.kind === 'code' && /\.(java|kt|groovy|scala)$/.test(f.path);

export interface ChangeSummary {
  assets: number;
  data: number;
  code: number;
  restart: number;
  config: number;
  other: number;
  files: { path: string; kind: ChangeKind }[];
}

export function summarizeChanges(files: { path: string; kind: ChangeKind }[]): ChangeSummary {
  const s: ChangeSummary = { assets: 0, data: 0, code: 0, restart: 0, config: 0, other: 0, files };
  for (const f of files) {
    if (f.kind === 'assets') s.assets++;
    else if (f.kind === 'data') s.data++;
    else if (isSourceChange(f)) s.code++;
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
