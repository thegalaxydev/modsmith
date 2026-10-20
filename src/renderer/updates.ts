import { store } from './store';

export interface UpdateAsset {
  name: string;
  url: string;
  size: number;
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  name: string | null;
  url: string;
  publishedAt: string | null;
  notes: string;
  assets: UpdateAsset[];
  checkedAt: number;
  stale: boolean;
  error: string | null;
}

const ENABLED_KEY = 'mwb.updateCheck';
const DISMISSED_KEY = 'mwb.updateDismissed';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    return;
  }
}

export function updateCheckEnabled(): boolean {
  return read(ENABLED_KEY) !== '0';
}

export function setUpdateCheckEnabled(on: boolean) {
  write(ENABLED_KEY, on ? '1' : '0');
}

export function isDismissed(version: string | null): boolean {
  return !!version && read(DISMISSED_KEY) === version;
}

export function dismissUpdate(version: string | null) {
  if (version) write(DISMISSED_KEY, version);
  store.set({ updateDismissed: version });
}

export async function checkForUpdates(force = false): Promise<UpdateInfo | null> {
  try {
    const info = await store.call<UpdateInfo>('system.check_update', { force }, { quiet: true });
    store.set({ update: info });
    return info;
  } catch {
    return null;
  }
}

export function assetFor(info: UpdateInfo, platform: string): UpdateAsset | undefined {
  const order = platform === 'win32' ? [/[-_]setup\.exe$/i, /\.msi$/i, /\.exe$/i] : platform === 'linux' ? [/\.AppImage$/, /\.deb$/i] : platform === 'darwin' ? [/\.dmg$/i] : [];
  for (const re of order) {
    const hit = info.assets.find((a) => re.test(a.name));
    if (hit) return hit;
  }
  return undefined;
}
