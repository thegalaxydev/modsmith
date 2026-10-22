import { store } from './store';
import { methodsFor, viewerMatches, type ExtensionPanel, type ExtensionViewer, type InstalledExtension } from '../shared/extensions';

export const PANEL_PREFIX = 'ext:';

export function panelTabId(ext: string, panel: string) {
  return `${PANEL_PREFIX}${ext}/${panel}`;
}

export function findPanel(tabId: string, list: InstalledExtension[] = store.state.extensions): { ext: InstalledExtension; panel: ExtensionPanel } | null {
  if (!tabId.startsWith(PANEL_PREFIX)) return null;
  const [extId, panelId] = tabId.slice(PANEL_PREFIX.length).split('/');
  const ext = list.find((e) => e.id === extId && e.enabled);
  const panel = ext?.manifest.contributes.panels.find((p) => p.id === panelId);
  return ext && panel ? { ext, panel } : null;
}

export function viewerFor(list: InstalledExtension[], file: string): { ext: InstalledExtension; viewer: ExtensionViewer } | null {
  for (const ext of list) {
    if (!ext.enabled) continue;
    const viewer = ext.manifest.contributes.viewers.find((v) => viewerMatches(v, file));
    if (viewer) return { ext, viewer };
  }
  return null;
}

const INSTANCE_SCOPED = /^(game|world|viewport|bridge)\.|^instance\.(status|stop|hotswap)$|^registry\.search$/;
const UNSCOPED = new Set(['instance.list', 'catalog.list']);

export async function hostCall(ext: InstalledExtension, method: string, params: unknown): Promise<unknown> {
  if (!methodsFor(ext.manifest.permissions).has(method)) throw new Error(`${ext.name} does not have permission to use ${method}`);
  const ws = store.state.workspace;
  if (!ws) throw new Error('Open a project first');
  const p: Record<string, unknown> = typeof params === 'object' && params !== null && !Array.isArray(params) ? { ...(params as Record<string, unknown>) } : {};
  const own = store.state.instances.filter((i) => i.workspace === ws.path);
  if (INSTANCE_SCOPED.test(method)) {
    if (p.id === undefined) {
      const live = own.find((i) => i.status === 'running') ?? own.find((i) => ['starting', 'running'].includes(i.status));
      if (!live) throw new Error('Start the game first');
      p.id = live.id;
    } else if (!own.some((i) => i.id === p.id)) throw new Error(`${String(p.id)} is not a game instance of this project`);
  } else if (!UNSCOPED.has(method)) p.path = ws.path;
  const result = await store.call(method, p, { quiet: true });
  if (method === 'instance.list' && Array.isArray(result)) return result.filter((i: { workspace?: string }) => i.workspace === ws.path);
  return result;
}

let themeNames: string[] | null = null;

export function themeVars(): Record<string, string> {
  const root = document.documentElement;
  if (!themeNames) {
    const names = new Set<string>();
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSStyleRule) || !/(^|,)\s*(:root|html)\b/.test(rule.selectorText)) continue;
        for (const prop of Array.from(rule.style)) if (prop.startsWith('--')) names.add(prop);
      }
    }
    themeNames = [...names];
  }
  const names = new Set(themeNames);
  for (const prop of Array.from(root.style)) if (prop.startsWith('--')) names.add(prop);
  const computed = getComputedStyle(root);
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = computed.getPropertyValue(n).trim();
    if (v) out[n] = v;
  }
  return out;
}

export function frameUrl(ext: InstalledExtension) {
  const base = location.protocol === 'tauri:' ? 'modsmithext://localhost' : `${location.protocol}//modsmithext.localhost`;
  return `${base}/${ext.id}/__frame__.html?v=${encodeURIComponent(ext.installedAt)}`;
}

export function frameContext(ext: InstalledExtension, kind: 'viewer' | 'panel', contribution: string, file: string | null) {
  const ws = store.state.workspace;
  const manifest = ws?.manifest;
  return {
    kind,
    contribution,
    file,
    extension: { id: ext.id, name: ext.name, version: ext.version },
    workspace: ws ? { path: ws.path, name: ws.name, modId: manifest?.modId ?? null, loader: manifest?.platform.loader ?? ws.detected?.loader ?? null, minecraft: manifest?.platform.minecraft ?? ws.detected?.minecraftHint ?? null } : null
  };
}

const STATE_LIMIT = 1024 * 1024;

export async function hostMessage(ext: InstalledExtension, m: { type: string; method?: string; params?: unknown; file?: unknown; kind?: unknown; text?: unknown; value?: unknown; message?: unknown }): Promise<unknown> {
  const key = `mwb.ext.state.${ext.id}`;
  switch (m.type) {
    case 'call':
      return hostCall(ext, String(m.method ?? ''), m.params);
    case 'asset':
      return store.call('extension.read', { id: ext.id, file: String(m.file ?? '') }, { quiet: true });
    case 'openFile': {
      if (!ext.manifest.permissions.includes('project.read')) throw new Error(`${ext.name} does not have permission to open project files`);
      const file = String(m.file ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!file || file.split('/').includes('..')) throw new Error('openFile needs a path inside the project');
      store.openTab(`file:${file}`);
      return null;
    }
    case 'toast': {
      const kind = m.kind === 'error' || m.kind === 'success' ? m.kind : 'info';
      store.toast(kind, `${ext.name}: ${String(m.text ?? '').slice(0, 300)}`);
      return null;
    }
    case 'stateGet':
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    case 'stateSet': {
      const raw = JSON.stringify(m.value ?? null);
      if (raw.length > STATE_LIMIT) throw new Error('Extension state is limited to 1 MB');
      localStorage.setItem(key, raw);
      return null;
    }
    case 'error':
      console.warn(`[${ext.id}]`, m.message);
      return null;
    default:
      throw new Error(`Unknown request ${m.type}`);
  }
}
