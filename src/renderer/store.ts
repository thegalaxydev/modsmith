import { useSyncExternalStore, useEffect, useRef, useState, useCallback } from 'react';
import { RpcClient } from '../shared/rpc-client';
import type { ActivityEntry, Diagnostic, InstanceInfo, LogLine, OperationInfo } from '../shared/types';
import type { InstalledExtension } from '../shared/extensions';
import type { UpdateInfo } from './updates';
import { classifyChange, clearLayout, DEFAULT_LAYOUT, loadLayout, saveLayout, type ChangeKind, type LayoutPrefs } from './session';
export interface AskOptions {
  yes?: string;
  no?: string;
  danger?: boolean;
}

export interface MessageBox extends AskOptions {
  text: string;
  kind: 'confirm' | 'alert';
  resolve: (v: boolean) => void;
}
import type { DockController, ToolId } from './dock';

export interface WorkspaceInfo {
  path: string;
  name: string;
  exists: boolean;
  trusted: boolean;
  manifest: Manifest | null;
  manifestErrors: string[];
  detected: {
    loader: string;
    buildSystem: string;
    gradleWrapper: boolean;
    buildFiles: string[];
    modMetadata: { file: string; id?: string; minecraft?: string }[];
    loaderPlugins: string[];
    minecraftHint?: string;
    loaderVersionHint?: string;
    notes: string[];
    ambiguous: boolean;
  } | null;
  type: string;
  catalogEntry?: string;
  catalogStatus?: string;
  lockProfiles: string[];
  stateDir: string;
  gitRepo: boolean;
  warnings: string[];
}

export interface ModRefView {
  source: 'modrinth' | 'curseforge' | 'local' | 'maven';
  projectId?: string;
  fileId?: string;
  versionId?: string;
  slug?: string;
  title?: string;
  path?: string;
  coordinates?: string;
  required: boolean;
  enabled?: boolean;
  usage: string;
  environment: string;
  from?: string;
}

export interface ProfileView {
  id: string;
  name: string;
  side: 'client' | 'server';
  mode: 'development' | 'production';
  java: { home?: string; minMajor?: number };
  jvm: { memoryMb: number; args: string[] };
  includeSourceMod: boolean;
  bridge: boolean;
  mods: ModRefView[];
  configDir?: string;
  resourcePacks: string[];
  datapacks: string[];
  scripts: string[];
  imports: { name: string; provider: 'modrinth' | 'curseforge' | 'file'; project?: string; version?: string; versionName?: string; overrides?: string; importedAt: string }[];
  world?: { snapshot?: string; name?: string };
  debug: { enabled: boolean; port: number; suspend: boolean };
  programArgs: string[];
}

export interface Manifest {
  schemaVersion: number;
  name: string;
  type: string;
  modId?: string;
  icon?: string;
  platform: { loader: string; minecraft: string; loaderVersion: string; catalogEntry?: string };
  source: { kind: string; root: string };
  dependencies: ModRefView[];
  profiles: ProfileView[];
}

export interface DebugFrame {
  id: number;
  name: string;
  line: number;
  file: string | null;
  uri: string | null;
  source: string;
}

export interface DebugState {
  status: 'idle' | 'starting' | 'running' | 'paused' | 'stopping';
  message: string;
  instance: string | null;
  session: string | null;
  threads: { id: number; name: string }[];
  threadId: number | null;
  reason: string | null;
  frames: DebugFrame[];
  frameId: number | null;
  scopes: { name: string; ref: number }[];
  location: { file: string; line: number } | null;
  output: string[];
}

export const IDLE_DEBUG: DebugState = { status: 'idle', message: '', instance: null, session: null, threads: [], threadId: null, reason: null, frames: [], frameId: null, scopes: [], location: null, output: [] };

export interface AppState {
  connection: 'connecting' | 'connected' | 'disconnected';
  connectionError?: string;
  workspace: WorkspaceInfo | null;
  instances: InstanceInfo[];
  operations: OperationInfo[];
  activity: ActivityEntry[];
  diagnostics: Diagnostic[];
  activeProfile: string | null;
  selectedInstance: string | null;
  toasts: { id: number; kind: 'error' | 'info' | 'success'; text: string }[];
  update: UpdateInfo | null;
  updateDismissed: string | null;
  fileVersion: number;
  modalOpen: boolean;
  layout: LayoutPrefs;
  layoutVersion: number;
  changes: Record<string, { path: string; kind: ChangeKind; at: number }[]>;
  clients: Record<string, number>;
  recentFiles: Record<string, string[]>;
  breakpoints: Record<string, Record<string, number[]>>;
  debug: DebugState;
  tabs: string[];
  activeTab: string;
  openPanels: string[];
  dirtyFiles: string[];
  inspectRequest: number;
  overlays: number;
  prompt: { title: string; label: string; value: string; resolve: (v: string | null) => void } | null;
  messages: MessageBox[];
  extensions: InstalledExtension[];
  settingsTab: string | null;
}

type Listener = () => void;

class Store {
  state: AppState = {
    connection: 'connecting',
    workspace: null,
    instances: [],
    operations: [],
    activity: [],
    diagnostics: [],
    activeProfile: null,
    selectedInstance: null,
    toasts: [],
    update: null,
    updateDismissed: null,
    fileVersion: 0,
    modalOpen: false,
    layout: loadLayout(),
    layoutVersion: 0,
    changes: {},
    tabs: ['home', 'minecraft'],
    activeTab: 'home',
    openPanels: [],
    dirtyFiles: [],
    inspectRequest: 0,
    overlays: 0,
    prompt: null,
    messages: [],
    extensions: [],
    settingsTab: null,
    clients: {},
    recentFiles: (() => {
      try {
        return JSON.parse(localStorage.getItem('mwb.recentFiles') ?? '{}');
      } catch {
        return {};
      }
    })(),
    breakpoints: (() => {
      try {
        return JSON.parse(localStorage.getItem('mwb.breakpoints') ?? '{}');
      } catch {
        return {};
      }
    })(),
    debug: IDLE_DEBUG
  };
  private listeners = new Set<Listener>();
  private dock: DockController | null = null;
  rpc: RpcClient | null = null;
  logListeners = new Set<(instanceId: string, lines: LogLine[]) => void>();
  opLogListeners = new Set<(id: string, line: string) => void>();
  lspListeners = new Set<(session: string, message: string | null) => void>();
  debugListeners = new Set<(session: string, message: string | null) => void>();
  bridgeListeners = new Set<(instanceId: string, event: string, data: unknown) => void>();
  private toastId = 1;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = () => this.state;

  set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    this.listeners.forEach((l) => l());
  }

  setLayout(patch: Partial<LayoutPrefs>) {
    const layout = { ...this.state.layout, ...patch };
    saveLayout(layout);
    this.set({ layout });
  }

  resetLayout() {
    clearLayout();
    if (this.dock) this.dock.reset();
    else {
      try {
        localStorage.removeItem('mwb.dock.v1');
      } catch {
        return;
      }
    }
    this.set((s) => ({ layout: { ...DEFAULT_LAYOUT, groups: {} }, layoutVersion: s.layoutVersion + 1 }));
  }

  attachDock(dock: DockController | null) {
    this.dock = dock;
  }

  showTool(id: ToolId) {
    this.dock?.open(id);
  }

  closeTool(id: ToolId) {
    this.dock?.close(id);
  }

  toggleTool(id: ToolId) {
    this.dock?.toggle(id);
  }

  toggleOutput() {
    this.dock?.toggleOutput();
  }

  pushOverlay() {
    this.set((s) => ({ overlays: s.overlays + 1 }));
    return () => this.set((s) => ({ overlays: Math.max(0, s.overlays - 1) }));
  }

  openTab(id: string) {
    if (this.dock) this.dock.open(id);
    else this.set((s) => ({ tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id], activeTab: id }));
    if (id.startsWith('file:') && this.state.workspace) this.noteRecentFile(this.state.workspace.path, id.slice(5));
  }

  async closeTab(id: string) {
    if (id === 'home' || id === 'minecraft') return;
    if (this.state.dirtyFiles.includes(id.slice(5)) && !(await this.ask('Close this file and discard unsaved changes?', { yes: 'Discard', no: 'Keep editing', danger: true }))) return;
    if (this.dock) {
      this.dock.close(id);
      this.set((s) => ({ dirtyFiles: s.dirtyFiles.filter((f) => `file:${f}` !== id) }));
      return;
    }
    this.set((s) => {
      const idx = s.tabs.indexOf(id);
      const tabs = s.tabs.filter((t) => t !== id);
      const activeTab = s.activeTab === id ? tabs[Math.max(0, idx - 1)] ?? 'home' : s.activeTab;
      return { tabs, activeTab, dirtyFiles: s.dirtyFiles.filter((f) => `file:${f}` !== id) };
    });
  }

  setDirty(file: string, dirty: boolean) {
    this.set((s) => ({ dirtyFiles: dirty ? (s.dirtyFiles.includes(file) ? s.dirtyFiles : [...s.dirtyFiles, file]) : s.dirtyFiles.filter((f) => f !== file) }));
  }

  ask(text: string, opts: AskOptions = {}): Promise<boolean> {
    return new Promise((resolve) => this.set((s) => ({ messages: [...s.messages, { ...opts, text, kind: 'confirm', resolve }] })));
  }

  tell(text: string): Promise<void> {
    return new Promise((resolve) => this.set((s) => ({ messages: [...s.messages, { text, kind: 'alert', resolve: () => resolve() }] })));
  }

  closeMessage(value: boolean) {
    const [first] = this.state.messages;
    if (!first) return;
    this.set((s) => ({ messages: s.messages.slice(1) }));
    first.resolve(value);
  }

  askText(title: string, label: string, value = ''): Promise<string | null> {
    return new Promise((resolve) => this.set({ prompt: { title, label, value, resolve } }));
  }

  recordChange(workspace: string, file: string) {
    const kind = classifyChange(file);
    this.set((s) => {
      const list = (s.changes[workspace] ?? []).filter((c) => c.path !== file);
      return { changes: { ...s.changes, [workspace]: [...list, { path: file, kind, at: Date.now() }] } };
    });
  }

  clearChanges(workspace: string, which?: (c: { path: string; kind: ChangeKind }) => boolean) {
    this.set((s) => ({ changes: { ...s.changes, [workspace]: which ? (s.changes[workspace] ?? []).filter((c) => !which(c)) : [] } }));
  }

  noteRecentFile(workspace: string, file: string) {
    this.set((s) => {
      const list = [file, ...(s.recentFiles[workspace] ?? []).filter((f) => f !== file)].slice(0, 8);
      const recentFiles = { ...s.recentFiles, [workspace]: list };
      try {
        localStorage.setItem('mwb.recentFiles', JSON.stringify(recentFiles));
      } catch {
        void 0;
      }
      return { recentFiles };
    });
  }

  openSettings(tab: string) {
    this.set({ settingsTab: tab });
  }

  async loadExtensions() {
    const extensions = await this.call<InstalledExtension[]>('extension.list', {}, { quiet: true }).catch(() => this.state.extensions);
    this.set({ extensions });
  }

  toast(kind: 'error' | 'info' | 'success', text: string) {
    const id = this.toastId++;
    this.set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => this.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 9000 : 4000);
  }

  async connect() {
    this.set({ connection: 'connecting', connectionError: undefined });
    try {
      if (!window.workbench) throw new Error('Desktop shell bridge is unavailable; run Modsmith through Electron');
      const ep = await window.workbench.endpoint();
      const rpc = new RpcClient(ep, 'ui', true);
      await rpc.connect(8000);
      this.rpc = rpc;
      rpc.onEvent((event, data) => this.onEvent(event, data));
      rpc.onClose(() => {
        this.set({ connection: 'disconnected' });
        setTimeout(() => void this.connect(), 2000);
      });
      this.set({ connection: 'connected' });
      const [instances, operations, activity, info, extensions] = await Promise.all([
        rpc.call<InstanceInfo[]>('instance.list'),
        rpc.call<OperationInfo[]>('operation.list'),
        rpc.call<ActivityEntry[]>('activity.list', { limit: 200 }),
        rpc.call<{ clients?: Record<string, number> }>('system.info'),
        rpc.call<InstalledExtension[]>('extension.list').catch(() => [])
      ]);
      this.set({ instances, operations, activity, clients: info.clients ?? {}, extensions });
      if (this.state.workspace) await this.refreshWorkspace();
    } catch (err) {
      this.set({ connection: 'disconnected', connectionError: (err as Error).message });
      setTimeout(() => void this.connect(), 3000);
    }
  }

  private onEvent(event: string, data: unknown) {
    switch (event) {
      case 'bridge.event': {
        const d = data as { instanceId: string; event: string; data: unknown };
        this.bridgeListeners.forEach((l) => l(d.instanceId, d.event, d.data));
        break;
      }
      case 'instance.updated': {
        const inst = data as InstanceInfo;
        this.set((s) => {
          const others = s.instances.filter((i) => i.id !== inst.id);
          return { instances: [inst, ...others].sort((a, b) => b.startedAt - a.startedAt) };
        });
        break;
      }
      case 'instance.log': {
        const d = data as { id: string; lines: LogLine[] };
        this.logListeners.forEach((l) => l(d.id, d.lines));
        break;
      }
      case 'operation.updated': {
        const op = data as OperationInfo;
        const known = this.state.operations.some((o) => o.id === op.id);
        this.set((s) => ({ operations: [op, ...s.operations.filter((o) => o.id !== op.id)].sort((a, b) => b.startedAt - a.startedAt).slice(0, 100) }));
        if (!known && op.kind === 'instance.launch' && op.workspace) this.clearChanges(op.workspace);
        const mine = !op.workspace || op.workspace === this.state.workspace?.path;
        if (op.status === 'failed' && op.error && mine) {
          this.toast('error', op.kind === 'instance.launch' ? `Could not start the game. ${op.error}` : op.kind === 'project.build' ? `Build failed. ${op.error}` : `${op.title}: ${op.error}`);
          if (this.state.workspace && op.workspace === this.state.workspace.path && ['project.build', 'instance.launch', 'instance.hotswap', 'project.datagen', 'profile.resolve', 'scenario.run'].includes(op.kind)) {
            const hasDiagnostics = this.state.diagnostics.some((d) => d.severity === 'error');
            this.showTool(hasDiagnostics ? 'problems' : 'tasks');
          }
        }
        if (op.status === 'succeeded' && (mine || op.kind === 'project.create') && ['project.build', 'profile.resolve', 'project.create'].includes(op.kind)) this.toast('success', `${op.title} completed`);
        if (op.status !== 'running' && this.state.workspace && op.workspace === this.state.workspace.path) void this.refreshWorkspace();
        break;
      }
      case 'operation.log': {
        const d = data as { id: string; line: string };
        this.opLogListeners.forEach((l) => l(d.id, d.line));
        break;
      }
      case 'lsp.message': {
        const d = data as { session: string; message: string };
        this.lspListeners.forEach((l) => l(d.session, d.message));
        break;
      }
      case 'debug.message': {
        const d = data as { session: string; message: string };
        this.debugListeners.forEach((l) => l(d.session, d.message));
        break;
      }
      case 'debug.closed': {
        const d = data as { session: string };
        this.debugListeners.forEach((l) => l(d.session, null));
        break;
      }
      case 'lsp.exited': {
        const d = data as { session: string };
        this.lspListeners.forEach((l) => l(d.session, null));
        break;
      }
      case 'clients.changed':
        this.set({ clients: data as Record<string, number> });
        break;
      case 'activity.added':
        this.set((s) => ({ activity: [data as ActivityEntry, ...s.activity].slice(0, 500) }));
        break;
      case 'diagnostics.updated': {
        const d = data as { workspace: string; diagnostics: Diagnostic[] };
        if (this.state.workspace?.path === d.workspace) this.set({ diagnostics: d.diagnostics });
        break;
      }
      case 'workspace.changed':
      case 'workspace.file_changed': {
        const d = data as { workspace: string; file?: string };
        if (event === 'workspace.file_changed' && d.file) this.recordChange(d.workspace, d.file);
        if (this.state.workspace?.path === d.workspace) {
          void this.refreshWorkspace();
          this.set((s) => ({ fileVersion: s.fileVersion + 1 }));
        }
        break;
      }
    }
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, opts: { quiet?: boolean } = {}): Promise<T> {
    if (!this.rpc) throw new Error('Not connected');
    try {
      return await this.rpc.call<T>(method, params);
    } catch (err) {
      if (!opts.quiet) this.toast('error', (err as Error).message);
      throw err;
    }
  }

  async openWorkspace(path: string) {
    const ws = await this.call<WorkspaceInfo>('workspace.open', { path });
    const diagnostics = await this.call<Diagnostic[]>('project.diagnostics', { path: ws.path }, { quiet: true }).catch(() => []);
    const remembered = localStorage.getItem(`mwb.profile.${ws.path}`);
    const activeProfile = ws.manifest?.profiles.find((p) => p.id === remembered)?.id ?? ws.manifest?.profiles[0]?.id ?? null;
    this.dock?.closeFiles();
    this.set({ workspace: ws, diagnostics, activeProfile, selectedInstance: null, tabs: ['home', 'minecraft'], activeTab: 'home', dirtyFiles: [] });
    this.dock?.open('home');
    localStorage.setItem('mwb.lastWorkspace', ws.path);
  }

  async refreshWorkspace() {
    const ws = this.state.workspace;
    if (!ws) return;
    try {
      const next = await this.call<WorkspaceInfo>('workspace.inspect', { path: ws.path }, { quiet: true });
      const active = next.manifest?.profiles.some((p) => p.id === this.state.activeProfile) ? this.state.activeProfile : next.manifest?.profiles[0]?.id ?? null;
      this.set({ workspace: next, activeProfile: active });
    } catch {
      void 0;
    }
  }

  selectProfile(id: string) {
    this.set({ activeProfile: id });
    if (this.state.workspace) localStorage.setItem(`mwb.profile.${this.state.workspace.path}`, id);
  }

  async closeWorkspace() {
    if (this.state.dirtyFiles.length && !(await this.ask('Close the project and discard unsaved changes?', { yes: 'Discard', no: 'Keep editing', danger: true }))) return;
    this.set({ workspace: null, activeProfile: null, diagnostics: [], tabs: ['home', 'minecraft'], activeTab: 'home', dirtyFiles: [] });
    localStorage.removeItem('mwb.lastWorkspace');
  }
}

export const store = new Store();

export function useStore<T>(selector: (s: AppState) => T): T {
  return selector(useSyncExternalStore(store.subscribe, store.getSnapshot));
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | undefined; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fnRef.current().then(
      (d) => {
        if (!alive) return;
        setData(d);
        setError(undefined);
        setLoading(false);
      },
      (e) => {
        if (!alive) return;
        setError((e as Error).message);
        setLoading(false);
      }
    );
    return () => {
      alive = false;
    };
  }, [...deps, n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { data, error, loading, reload };
}

export function waitForOperation(id: string): Promise<OperationInfo> {
  return new Promise((resolve) => {
    const check = () => {
      const op = store.state.operations.find((o) => o.id === id);
      if (op && op.status !== 'running' && op.status !== 'queued') {
        unsub();
        resolve(op);
      }
    };
    const unsub = store.subscribe(check);
    check();
  });
}
