import fs from 'node:fs';
import path from 'node:path';
import { PRODUCT } from '../shared/product';

export const LEGACY = { name: 'ModWorkbench', id: 'modworkbench' } as const;

const DATA_FILES = ['workbench.sqlite', 'workbench.sqlite-wal', 'workbench.sqlite-shm'];

function move(from: string, to: string): boolean {
  if (!fs.existsSync(from) || fs.existsSync(to)) return false;
  try {
    fs.renameSync(from, to);
    return true;
  } catch {
    return false;
  }
}

function replaceInFile(file: string, from: string, to: string): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes(from)) fs.writeFileSync(file, text.split(from).join(to));
}

export function migrateDataDir(legacyDir: string, dataDir: string): void {
  if (!fs.existsSync(path.join(legacyDir, DATA_FILES[0])) || fs.existsSync(path.join(dataDir, DATA_FILES[0]))) return;
  fs.mkdirSync(dataDir, { recursive: true });
  for (const f of DATA_FILES) {
    const src = path.join(legacyDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dataDir, f));
  }
}

export function migrateCacheDir(legacyDir: string, cacheDir: string): void {
  if (fs.existsSync(cacheDir) || !fs.existsSync(legacyDir)) return;
  fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
  move(legacyDir, cacheDir);
}

export function migrateProject(root: string): void {
  const legacyManifest = path.join(root, `${LEGACY.id}.json`);
  const manifest = path.join(root, PRODUCT.manifestFile);
  if (!fs.existsSync(legacyManifest) || fs.existsSync(manifest)) return;
  move(path.join(root, `${LEGACY.id}.lock.json`), path.join(root, `${PRODUCT.id}.lock.json`));
  const depsOld = `${LEGACY.id}.dependencies.gradle`;
  const depsNew = `${PRODUCT.id}.dependencies.gradle`;
  if (move(path.join(root, depsOld), path.join(root, depsNew))) {
    for (const f of ['build.gradle', 'build.gradle.kts']) replaceInFile(path.join(root, f), depsOld, depsNew);
  }
  move(path.join(root, `.${LEGACY.id}`), path.join(root, PRODUCT.stateDir));
  replaceInFile(path.join(root, '.gitignore'), `.${LEGACY.id}/`, `${PRODUCT.stateDir}/`);
  fs.renameSync(legacyManifest, manifest);
}

export function legacyManagedFile(modsDir: string): string {
  return path.join(modsDir, `.${LEGACY.id}-managed.json`);
}
