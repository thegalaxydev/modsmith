import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ENV, PRODUCT } from '../shared/product';
import { LEGACY, migrateCacheDir, migrateDataDir } from './legacy';

export interface AppPaths {
  data: string;
  cache: string;
  db: string;
  serviceFile: string;
  serviceLog: string;
  downloads: string;
  resources: string;
  tmp: string;
}

function defaultDataDir(): string {
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), PRODUCT.name);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', PRODUCT.name);
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), PRODUCT.id);
}

function defaultCacheDir(): string {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), PRODUCT.name, 'cache');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', PRODUCT.name);
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), PRODUCT.id);
}

export function findResourcesDir(start: string = __dirname): string {
  const candidates: string[] = [];
  if ((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath) {
    candidates.push(path.join((process as NodeJS.Process & { resourcesPath: string }).resourcesPath, 'resources'));
  }
  let dir = start;
  for (let i = 0; i < 6; i++) {
    candidates.push(path.join(dir, 'resources'));
    dir = path.dirname(dir);
  }
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'templates'))) return c;
  }
  throw new Error(`Could not locate ${PRODUCT.name} resources directory from ${start}`);
}

let cached: AppPaths | null = null;

export function appPaths(): AppPaths {
  if (cached) return cached;
  const data = process.env[ENV.dataDir] ?? defaultDataDir();
  const cache = process.env[ENV.cacheDir] ?? defaultCacheDir();
  if (process.platform === 'win32' && !process.env[ENV.dataDir]) migrateDataDir(path.join(path.dirname(data), LEGACY.name), data);
  if (process.platform === 'win32' && !process.env[ENV.cacheDir]) migrateCacheDir(path.join(path.dirname(path.dirname(cache)), LEGACY.name, 'cache'), cache);
  cached = {
    data,
    cache,
    db: path.join(data, 'workbench.sqlite'),
    serviceFile: path.join(data, 'service.json'),
    serviceLog: path.join(data, 'service.log'),
    downloads: path.join(cache, 'downloads'),
    resources: findResourcesDir(),
    tmp: path.join(cache, 'tmp')
  };
  for (const d of [cached.data, cached.cache, cached.downloads, cached.tmp]) fs.mkdirSync(d, { recursive: true });
  return cached;
}

export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function resolveWithin(root: string, relOrAbs: string): string {
  const resolved = path.resolve(root, relOrAbs);
  if (!isWithin(root, resolved)) throw new Error(`Path is outside the workspace: ${relOrAbs}`);
  if (fs.existsSync(resolved)) {
    const real = fs.realpathSync(resolved);
    if (!isWithin(fs.realpathSync(root), real)) throw new Error(`Path resolves outside the workspace: ${relOrAbs}`);
  }
  return resolved;
}
