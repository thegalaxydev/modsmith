import fs from 'node:fs';
import path from 'node:path';
import type { FileNode } from '../shared/types';
import { PRODUCT } from '../shared/product';
import type { Services } from './context';
import { readManifest, writeManifest, defaultProfiles, ManifestSchema, type Manifest, readLock } from './manifest';
import type { DetectedProject } from './adapters/types';
import { resolveWithin, writeFileAtomic } from './manifest-helpers';
import { migrateProject } from './legacy';

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_IMAGE = 2 * 1024 * 1024;

const IGNORED = new Set(['.git', '.gradle', 'build', 'node_modules', 'out', 'bin', '.idea', '.vscode', 'run', '.modsmith']);

export interface WorkspaceInspection {
  path: string;
  name: string;
  exists: boolean;
  trusted: boolean;
  manifest: Manifest | null;
  manifestErrors: string[];
  detected: DetectedProject | null;
  type: Manifest['type'] | 'unmanaged';
  catalogEntry?: string;
  catalogStatus?: string;
  lockProfiles: string[];
  stateDir: string;
  gitRepo: boolean;
  warnings: string[];
}

export function stateDir(root: string): string {
  return path.join(root, PRODUCT.stateDir);
}

export function instanceDirFor(root: string, profileId: string, mode: 'development' | 'production', side: string): string {
  return path.join(stateDir(root), 'instances', `${profileId}${mode === 'production' ? '-prod' : ''}-${side}`);
}

export class WorkspaceService {
  constructor(private s: Services) {}

  normalize(p: string): string {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) return abs;
    const root = fs.realpathSync.native(abs);
    if (fs.statSync(root).isDirectory()) migrateProject(root);
    return root;
  }

  inspect(p: string): WorkspaceInspection {
    const root = this.normalize(p);
    const exists = fs.existsSync(root) && fs.statSync(root).isDirectory();
    const warnings: string[] = [];
    if (!exists) {
      return { path: root, name: path.basename(root), exists, trusted: false, manifest: null, manifestErrors: [], detected: null, type: 'unmanaged', lockProfiles: [], stateDir: stateDir(root), gitRepo: false, warnings: ['Directory does not exist'] };
    }
    const { manifest, errors } = readManifest(root);
    const detected = this.s.adapters.fabric.detectProject(root);
    let lockProfiles: string[] = [];
    try {
      lockProfiles = Object.keys(readLock(root).profiles);
    } catch (err) {
      warnings.push((err as Error).message);
    }
    const entry = manifest?.platform.catalogEntry ? this.s.catalog.get(manifest.platform.catalogEntry) : undefined;
    if (manifest && manifest.platform.catalogEntry && !entry) warnings.push(`Catalog entry ${manifest.platform.catalogEntry} is not known to this version of ${PRODUCT.name}`);
    if (manifest && !this.s.adapters[manifest.platform.loader].implemented) warnings.push(`${manifest.platform.loader} adapter is not implemented; build and launch are disabled`);
    if (detected?.ambiguous) warnings.push('Project structure is ambiguous; see detection notes');
    return {
      path: root,
      name: manifest?.name ?? path.basename(root),
      exists,
      trusted: this.s.store.isTrusted(root),
      manifest,
      manifestErrors: errors,
      detected,
      type: manifest?.type ?? 'unmanaged',
      catalogEntry: entry?.id,
      catalogStatus: entry?.status,
      lockProfiles,
      stateDir: stateDir(root),
      gitRepo: fs.existsSync(path.join(root, '.git')),
      warnings
    };
  }

  open(p: string): WorkspaceInspection {
    const info = this.inspect(p);
    if (!info.exists) throw new Error(`Workspace not found: ${info.path}`);
    this.s.store.addRecent(info.path, info.name, info.type);
    return info;
  }

  trust(p: string, trusted: boolean): WorkspaceInspection {
    const root = this.normalize(p);
    this.s.store.setTrusted(root, trusted);
    return this.inspect(root);
  }

  requireTrusted(root: string): void {
    if (!this.s.store.isTrusted(this.normalize(root))) {
      throw new Error(`Workspace ${root} is not trusted. Building or launching runs the project's Gradle scripts as code; trust the workspace first (workspace_trust).`);
    }
  }

  requireManifest(root: string): Manifest {
    const { manifest, errors } = readManifest(this.normalize(root));
    if (!manifest) throw new Error(errors.length ? `Invalid ${PRODUCT.manifestFile}: ${errors.join('; ')}` : `No ${PRODUCT.manifestFile} in ${root}. Initialize the workspace first.`);
    return manifest;
  }

  initManifest(p: string, opts: { type: Manifest['type']; name?: string; minecraft?: string; loaderVersion?: string }): Manifest {
    const root = this.normalize(p);
    if (fs.existsSync(path.join(root, PRODUCT.manifestFile))) throw new Error(`${PRODUCT.manifestFile} already exists`);
    const detected = this.s.adapters.fabric.detectProject(root);
    const loader = detected && detected.loader !== 'unknown' ? detected.loader : 'fabric';
    const minecraft = opts.minecraft ?? detected?.minecraftHint?.replace(/^[~^>=<\s]+/, '');
    const loaderVersion = opts.loaderVersion ?? detected?.loaderVersionHint;
    if (!minecraft || !loaderVersion) throw new Error('Could not determine Minecraft and loader versions from the project. Provide them explicitly.');
    const entry = this.s.catalog.select(loader, minecraft, { allowUnverified: true });
    const manifest = ManifestSchema.parse({
      schemaVersion: 1,
      name: opts.name ?? path.basename(root),
      type: opts.type,
      modId: detected?.modMetadata.find((m) => m.id)?.id,
      platform: { loader, minecraft, loaderVersion, catalogEntry: entry?.id },
      source: { kind: opts.type === 'modpack' ? 'none' : 'gradle', root: '.' },
      dependencies: [],
      profiles: defaultProfiles(opts.type === 'modpack' ? 'client' : 'both').map((pr) => ({ ...pr, includeSourceMod: opts.type !== 'modpack' })),
      createdBy: `${PRODUCT.name} ${PRODUCT.version}`
    });
    writeManifest(root, manifest);
    this.ensureGitignore(root);
    return manifest;
  }

  ensureGitignore(root: string): void {
    const gi = path.join(root, '.gitignore');
    const line = `${PRODUCT.stateDir}/`;
    const text = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    if (!text.split(/\r?\n/).includes(line)) fs.writeFileSync(gi, text + (text && !text.endsWith('\n') ? '\n' : '') + line + '\n');
  }

  tree(p: string, rel = '', depth = 3): FileNode[] {
    const root = this.normalize(p);
    const dir = resolveWithin(root, rel || '.');
    const walk = (d: string, level: number): FileNode[] => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return [];
      }
      return entries
        .filter((e) => !(e.isDirectory() && IGNORED.has(e.name)))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .map((e) => {
          const full = path.join(d, e.name);
          const node: FileNode = { name: e.name, path: path.relative(root, full).replace(/\\/g, '/'), dir: e.isDirectory() };
          if (node.dir && level < depth) node.children = walk(full, level + 1);
          return node;
        });
    };
    return walk(dir, 0);
  }

  readFile(p: string, rel: string): { path: string; content: string; size: number; binary: boolean; mtime: number } {
    const root = this.normalize(p);
    const file = resolveWithin(root, rel);
    const st = fs.statSync(file);
    if (st.isDirectory()) throw new Error(`${rel} is a directory`);
    if (st.size > 4 * 1024 * 1024) throw new Error(`${rel} is larger than 4 MB; open it in an external editor`);
    const buf = fs.readFileSync(file);
    const binary = buf.subarray(0, 8000).includes(0);
    return { path: rel, content: binary ? buf.toString('base64') : buf.toString('utf8'), size: st.size, binary, mtime: st.mtimeMs };
  }

  writeFile(p: string, rel: string, content: string, opts: { expectedMtime?: number; create?: boolean; encoding?: 'utf8' | 'base64' } = {}): { path: string; mtime: number } {
    const root = this.normalize(p);
    const file = resolveWithin(root, rel);
    const exists = fs.existsSync(file);
    if (!exists && !opts.create) throw new Error(`${rel} does not exist; pass create to create it`);
    if (exists && opts.expectedMtime !== undefined && Math.abs(fs.statSync(file).mtimeMs - opts.expectedMtime) > 1) {
      throw new Error(`${rel} changed on disk since it was opened; reload before saving`);
    }
    if (opts.encoding === 'base64' && !/^[A-Za-z0-9+/]*={0,2}$/.test(content.replace(/\s+/g, ''))) throw new Error('content is not valid base64');
    writeFileAtomic(file, opts.encoding === 'base64' ? Buffer.from(content, 'base64') : content);
    return { path: rel, mtime: fs.statSync(file).mtimeMs };
  }

  image(p: string): string | null {
    const root = this.normalize(p);
    const rel = readManifest(root).manifest?.icon;
    if (!rel) return null;
    const mime = IMAGE_TYPES[path.extname(rel).toLowerCase()];
    if (!mime) return null;
    try {
      const file = resolveWithin(root, rel);
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > MAX_IMAGE) return null;
      return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
    } catch {
      return null;
    }
  }

  setImage(p: string, file: string | null): { icon: string | null } {
    const root = this.normalize(p);
    const manifest = this.requireManifest(root);
    if (file === null) {
      delete manifest.icon;
      writeManifest(root, manifest);
      return { icon: null };
    }
    const full = resolveWithin(root, file);
    if (!IMAGE_TYPES[path.extname(full).toLowerCase()]) throw new Error('Choose a PNG, JPEG, WebP or GIF image');
    const st = fs.statSync(full);
    if (!st.isFile()) throw new Error(`${file} is not a file`);
    if (st.size > MAX_IMAGE) throw new Error('Choose an image smaller than 2 MB');
    manifest.icon = path.relative(root, full).split(path.sep).join('/');
    writeManifest(root, manifest);
    return { icon: manifest.icon };
  }

  deleteFile(p: string, rel: string, confirm: boolean): void {
    if (!confirm) throw new Error('Deleting a file is destructive; pass confirm: true to proceed');
    const root = this.normalize(p);
    const file = resolveWithin(root, rel);
    if (path.resolve(file) === path.resolve(root)) throw new Error('Refusing to delete the workspace root');
    if (fs.statSync(file).isDirectory()) throw new Error('Deleting directories is not supported');
    fs.rmSync(file);
  }
}
