import { BUILTIN_THEMES, DEFAULT_THEME_ID, MODSMITH_DARK, MODSMITH_HIGH_CONTRAST, MODSMITH_LIGHT } from './builtins';
import { isHighContrast, isDark, kindOf, resolveTheme, themeOutput, type ResolvedTheme, type ThemeEntry, type ThemeOutput } from './model';

export interface ThemeSelection {
  app: string;
  code: string;
  match: boolean;
}

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ThemeTarget {
  apply(output: ThemeOutput): void;
}

export interface ThemeCatalog {
  list(): Promise<ThemeEntry[]>;
  remove(id: string): Promise<unknown>;
}

export interface ThemeState {
  installed: ThemeEntry[];
  saved: ThemeSelection;
  preview: ThemeSelection | null;
  loaded: boolean;
  error: string | null;
}

const KEY = 'mwb.theme';
const CACHE_KEY = 'mwb.theme.cache';
const DEFAULT_SELECTION: ThemeSelection = { app: DEFAULT_THEME_ID, code: DEFAULT_THEME_ID, match: false };

export function fallbackFor(entry: Pick<ThemeEntry, 'type' | 'theme'> | null): ThemeEntry {
  if (!entry) return MODSMITH_DARK;
  const kind = kindOf(entry);
  if (isHighContrast(kind)) return MODSMITH_HIGH_CONTRAST;
  return isDark(kind) ? MODSMITH_DARK : MODSMITH_LIGHT;
}

export function createThemeManager(deps: { storage: ThemeStorage; target: ThemeTarget; catalog: ThemeCatalog }) {
  const listeners = new Set<() => void>();
  const resolved = new Map<string, ResolvedTheme>();
  let cache: Record<string, ThemeEntry> = {};
  let state: ThemeState = { installed: [], saved: DEFAULT_SELECTION, preview: null, loaded: false, error: null };

  const read = () => {
    try {
      const raw = deps.storage.getItem(KEY);
      const sel = raw ? (JSON.parse(raw) as Partial<ThemeSelection>) : {};
      const app = typeof sel.app === 'string' ? sel.app : DEFAULT_THEME_ID;
      const code = typeof sel.code === 'string' ? sel.code : DEFAULT_THEME_ID;
      return { app, code, match: sel.match === true };
    } catch {
      return DEFAULT_SELECTION;
    }
  };

  const readCache = () => {
    try {
      const raw = deps.storage.getItem(CACHE_KEY);
      const parsed = raw ? (JSON.parse(raw) as Record<string, ThemeEntry>) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };

  const persist = () => {
    try {
      deps.storage.setItem(KEY, JSON.stringify(state.saved));
      const keep: Record<string, ThemeEntry> = {};
      for (const id of [state.saved.app, state.saved.code]) {
        const e = find(id);
        if (e && e.source.kind !== 'builtin') keep[id] = e;
      }
      cache = keep;
      deps.storage.setItem(CACHE_KEY, JSON.stringify(keep));
    } catch {
      return;
    }
  };

  const set = (patch: Partial<ThemeState>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };

  function all(): ThemeEntry[] {
    return [...BUILTIN_THEMES, ...state.installed];
  }

  function find(id: string): ThemeEntry | null {
    return BUILTIN_THEMES.find((t) => t.id === id) ?? state.installed.find((t) => t.id === id) ?? (state.loaded ? null : (cache[id] ?? null));
  }

  function resolve(id: string): ResolvedTheme {
    const entry = find(id) ?? MODSMITH_DARK;
    const key = `${entry.id}|${entry.installedAt ?? ''}`;
    let r = resolved.get(key);
    if (!r) {
      try {
        r = resolveTheme(entry);
      } catch {
        r = resolveTheme(fallbackFor(entry));
      }
      resolved.set(key, r);
    }
    return r;
  }

  function current(): ThemeSelection {
    return state.preview ?? state.saved;
  }

  function apply() {
    const sel = current();
    const output = themeOutput(resolve(sel.app), resolve(sel.code), sel.match);
    try {
      deps.target.apply(output);
    } catch (e) {
      set({ error: (e as Error).message });
    }
  }

  function repair(sel: ThemeSelection): ThemeSelection {
    const fix = (id: string) => (find(id) ? id : fallbackFor(cache[id] ?? null).id);
    return { ...sel, app: fix(sel.app), code: fix(sel.code) };
  }

  async function refresh() {
    try {
      const installed = await deps.catalog.list();
      resolved.clear();
      set({ installed, loaded: true, error: null });
    } catch (e) {
      set({ error: (e as Error).message });
      return;
    }
    const repaired = repair(state.saved);
    if (repaired.app !== state.saved.app || repaired.code !== state.saved.code) set({ saved: repaired });
    if (state.preview) set({ preview: repair(state.preview) });
    persist();
    apply();
  }

  return {
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    get state() {
      return state;
    },
    all,
    find,
    resolve,
    current,
    init() {
      cache = readCache();
      set({ saved: read() });
      apply();
    },
    refresh,
    preview(sel: Partial<ThemeSelection>) {
      set({ preview: { ...current(), ...sel } });
      apply();
    },
    cancelPreview() {
      if (!state.preview) return;
      set({ preview: null });
      apply();
    },
    commit(sel?: Partial<ThemeSelection>) {
      const next = repair({ ...current(), ...sel });
      set({ saved: next, preview: null });
      persist();
      apply();
    },
    async remove(id: string) {
      if (BUILTIN_THEMES.some((t) => t.id === id)) throw new Error('Built-in themes cannot be removed');
      const entry = find(id);
      await deps.catalog.remove(id);
      const fb = fallbackFor(entry).id;
      const swap = (sel: ThemeSelection) => ({ ...sel, app: sel.app === id ? fb : sel.app, code: sel.code === id ? fb : sel.code });
      set({ installed: state.installed.filter((t) => t.id !== id), saved: swap(state.saved), preview: state.preview ? swap(state.preview) : null });
      persist();
      apply();
      await refresh();
    }
  };
}

export type ThemeManager = ReturnType<typeof createThemeManager>;
