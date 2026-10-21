import { useSyncExternalStore } from 'react';
import { store } from '../store';
import { createThemeManager, type ThemeTarget } from './manager';
import type { ThemeEntry, ThemeOutput } from './model';

const domTarget: ThemeTarget = {
  apply(output: ThemeOutput) {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(output.vars)) root.style.setProperty(k, v);
    root.style.colorScheme = output.colorScheme;
    root.dataset.scheme = output.colorScheme;
    let el = document.getElementById('mwb-theme-css') as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = 'mwb-theme-css';
      document.head.appendChild(el);
    }
    el.textContent = `${output.syntaxCss}\n${output.semanticCss}`;
  }
};

export const themes = createThemeManager({
  storage: {
    getItem: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    setItem: (k, v) => localStorage.setItem(k, v)
  },
  target: domTarget,
  catalog: {
    list: () => store.call<ThemeEntry[]>('theme.list', {}, { quiet: true }),
    remove: (id) => store.call('theme.remove', { id })
  }
});

export function startThemes() {
  themes.init();
  let last = store.getSnapshot().connection;
  if (last === 'connected') void themes.refresh();
  store.subscribe(() => {
    const now = store.getSnapshot().connection;
    if (now === 'connected' && last !== 'connected') void themes.refresh();
    last = now;
  });
}

export function useThemes() {
  return useSyncExternalStore(themes.subscribe, () => themes.state);
}
