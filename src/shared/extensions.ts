export type ExtensionPermission = 'project.read' | 'project.write' | 'game' | 'build' | 'network' | 'companion';

export const PERMISSIONS: Record<ExtensionPermission, { label: string; methods: string[] }> = {
  'project.read': {
    label: 'Read files and settings of the open project',
    methods: ['workspace.inspect', 'workspace.tree', 'workspace.read_file', 'workspace.image', 'project.diagnostics', 'assets.validate', 'assets.model', 'registry.index', 'registry.search', 'profile.list', 'instance.list', 'instance.status', 'catalog.list']
  },
  'project.write': {
    label: 'Create and change files in the open project',
    methods: ['workspace.write_file']
  },
  game: {
    label: 'Control the running game: run commands, give items, inspect the world and take screenshots',
    methods: ['game.status', 'game.mods', 'game.telemetry', 'game.reload', 'world.open', 'world.inspect_target', 'world.give_item', 'world.run_command', 'world.entities', 'world.recipes', 'world.tags', 'viewport.capture', 'bridge.status', 'bridge.call']
  },
  build: {
    label: 'Build the project and start or stop the game',
    methods: ['project.build', 'project.datagen', 'instance.launch', 'instance.stop', 'instance.hotswap']
  },
  network: {
    label: 'Connect to the internet',
    methods: []
  },
  companion: {
    label: 'Add its companion mod to development runs of the game',
    methods: []
  }
};

export interface ExtensionViewer {
  id: string;
  title: string;
  files: string[];
}

export interface ExtensionPanel {
  id: string;
  title: string;
}

export interface ExtensionMod {
  file: string;
  loader: 'fabric' | 'neoforge' | 'forge';
  minecraft: string;
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  publisher: string;
  description?: string;
  modsmith: string;
  repository?: string;
  homepage?: string;
  license?: string;
  main?: string;
  style?: string;
  permissions: ExtensionPermission[];
  contributes: { viewers: ExtensionViewer[]; panels: ExtensionPanel[]; mods?: ExtensionMod[] };
}

export interface InstalledExtension {
  id: string;
  name: string;
  version: string;
  publisher: string;
  description: string | null;
  manifest: ExtensionManifest;
  enabled: boolean;
  verified: boolean;
  source: { kind: 'registry' | 'url' | 'file'; location: string };
  sha256: string;
  installedAt: string;
}

export interface CatalogExtension {
  id: string;
  name: string;
  publisher: string;
  description: string | null;
  repository: string | null;
  license: string | null;
  latest: { version: string; modsmith: string; permissions: ExtensionPermission[]; size: number | null };
  compatible: boolean;
  installed: string | null;
  update: boolean;
}

export const EXTENSION_ID = /^[a-z0-9][a-z0-9-]{0,38}\.[a-z0-9][a-z0-9-]{0,63}$/;

export function bridgePrefix(extensionId: string) {
  return `ext.${extensionId}.`;
}

export function methodsFor(permissions: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const p of permissions) for (const m of PERMISSIONS[p as ExtensionPermission]?.methods ?? []) out.add(m);
  return out;
}

export function globToRegExp(glob: string): RegExp {
  let re = '';
  const g = glob.replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(g.includes('/') ? `^${re}$` : `(?:^|/)${re}$`, 'i');
}

export function viewerMatches(viewer: ExtensionViewer, file: string): boolean {
  const rel = file.replace(/\\/g, '/');
  return viewer.files.some((g) => globToRegExp(g).test(rel));
}
