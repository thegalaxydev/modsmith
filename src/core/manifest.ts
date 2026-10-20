import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PRODUCT } from '../shared/product';

export const MANIFEST_SCHEMA_VERSION = 1;

export const ModRefSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('modrinth'),
    projectId: z.string().min(1),
    versionId: z.string().min(1).optional(),
    slug: z.string().optional(),
    title: z.string().optional(),
    required: z.boolean().default(true),
    enabled: z.boolean().optional(),
    usage: z.enum(['runtime', 'compile']).default('runtime'),
    environment: z.enum(['client', 'server', 'both']).default('both'),
    from: z.string().optional()
  }),
  z.object({
    source: z.literal('curseforge'),
    projectId: z.union([z.number().int(), z.string().regex(/^\d+$/)]).transform(String),
    fileId: z.union([z.number().int(), z.string().regex(/^\d+$/)]).transform(String).optional(),
    slug: z.string().optional(),
    title: z.string().optional(),
    required: z.boolean().default(true),
    enabled: z.boolean().optional(),
    usage: z.literal('runtime').default('runtime'),
    environment: z.enum(['client', 'server', 'both']).default('both'),
    from: z.string().optional()
  }),
  z.object({
    source: z.literal('local'),
    path: z.string().min(1),
    title: z.string().optional(),
    required: z.boolean().default(true),
    enabled: z.boolean().optional(),
    usage: z.literal('runtime').default('runtime'),
    environment: z.enum(['client', 'server', 'both']).default('both'),
    from: z.string().optional()
  }),
  z.object({
    source: z.literal('maven'),
    coordinates: z.string().regex(/^[^:\s]+:[^:\s]+:[^:\s]+(:[^:\s]+)?$/, 'Expected group:artifact:version[:classifier]'),
    repository: z.string().url().optional(),
    title: z.string().optional(),
    required: z.boolean().default(true),
    enabled: z.boolean().optional(),
    usage: z.enum(['runtime', 'compile']).default('compile'),
    environment: z.enum(['client', 'server', 'both']).default('both'),
    from: z.string().optional()
  })
]);
export type ModRef = z.infer<typeof ModRefSchema>;

export const ProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/, 'Profile id must be lowercase letters, digits, _ or -'),
  name: z.string().min(1),
  side: z.enum(['client', 'server']),
  mode: z.enum(['development', 'production']).default('development'),
  java: z.object({ home: z.string().optional(), minMajor: z.number().int().optional() }).default({}),
  jvm: z.object({ memoryMb: z.number().int().min(512).max(65536).default(4096), args: z.array(z.string()).default([]) }).default({ memoryMb: 4096, args: [] }),
  includeSourceMod: z.boolean().default(true),
  bridge: z.boolean().default(true),
  mods: z.array(ModRefSchema).default([]),
  configDir: z.string().optional(),
  resourcePacks: z.array(z.string()).default([]),
  datapacks: z.array(z.string()).default([]),
  scripts: z.array(z.string()).default([]),
  world: z.object({ snapshot: z.string().optional(), name: z.string().optional() }).optional(),
  debug: z.object({ enabled: z.boolean().default(false), port: z.number().int().min(1024).max(65535).default(5005), suspend: z.boolean().default(false) }).default({ enabled: false, port: 5005, suspend: false }),
  programArgs: z.array(z.string()).default([]),
  imports: z
    .array(
      z.object({
        name: z.string().min(1),
        provider: z.enum(['modrinth', 'curseforge', 'file']),
        project: z.string().optional(),
        version: z.string().optional(),
        versionName: z.string().optional(),
        overrides: z.string().optional(),
        importedAt: z.string()
      })
    )
    .default([])
});
export type Profile = z.infer<typeof ProfileSchema>;

export const ManifestSchema = z.object({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  name: z.string().min(1),
  type: z.enum(['mod', 'modpack', 'combined']),
  modId: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/).optional(),
  icon: z.string().min(1).optional(),
  platform: z.object({
    loader: z.enum(['fabric', 'neoforge', 'forge']),
    minecraft: z.string().min(1),
    loaderVersion: z.string().min(1),
    catalogEntry: z.string().optional()
  }),
  source: z.object({ kind: z.enum(['gradle', 'none']), root: z.string().default('.') }).default({ kind: 'gradle', root: '.' }),
  dependencies: z.array(ModRefSchema).default([]),
  profiles: z.array(ProfileSchema).default([]),
  preset: z.string().optional(),
  createdBy: z.string().optional()
});
export type Manifest = z.infer<typeof ManifestSchema>;

export function manifestPath(root: string): string {
  return path.join(root, PRODUCT.manifestFile);
}

export function readManifest(root: string): { manifest: Manifest | null; errors: string[] } {
  const file = manifestPath(root);
  if (!fs.existsSync(file)) return { manifest: null, errors: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { manifest: null, errors: [`${PRODUCT.manifestFile} is not valid JSON: ${(err as Error).message}`] };
  }
  return validateManifest(raw);
}

export function validateManifest(raw: unknown): { manifest: Manifest | null; errors: string[] } {
  const res = ManifestSchema.safeParse(raw);
  if (!res.success) {
    return { manifest: null, errors: res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  const ids = new Set<string>();
  const errors: string[] = [];
  for (const p of res.data.profiles) {
    if (ids.has(p.id)) errors.push(`profiles: duplicate profile id ${p.id}`);
    ids.add(p.id);
  }
  return { manifest: errors.length ? null : res.data, errors };
}

export function writeManifest(root: string, manifest: Manifest): void {
  const res = ManifestSchema.safeParse(manifest);
  if (!res.success) throw new Error(`Refusing to write invalid manifest: ${res.error.issues.map((i) => i.message).join('; ')}`);
  writeFileAtomic(manifestPath(root), JSON.stringify(res.data, null, 2) + '\n');
}

export function writeFileAtomic(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function defaultProfiles(side: 'client' | 'server' | 'both' = 'both'): Profile[] {
  const out: Profile[] = [];
  if (side !== 'server') out.push(ProfileSchema.parse({ id: 'dev-client', name: 'Test Client', side: 'client' }));
  if (side !== 'client') out.push(ProfileSchema.parse({ id: 'dev-server', name: 'Dedicated Server', side: 'server', jvm: { memoryMb: 2048, args: [] } }));
  return out;
}

export const LockEntrySchema = z.object({
  key: z.string(),
  provider: z.enum(['modrinth', 'curseforge', 'local', 'bridge', 'maven']),
  distribution: z.enum(['direct', 'manual']).optional(),
  manualUrl: z.string().optional(),
  projectId: z.string().optional(),
  versionId: z.string().optional(),
  versionNumber: z.string().optional(),
  title: z.string(),
  fileName: z.string(),
  url: z.string().optional(),
  sha1: z.string().optional(),
  sha512: z.string().optional(),
  size: z.number().optional(),
  modIds: z.array(z.string()).default([]),
  license: z.string().optional(),
  environment: z.object({ client: z.string(), server: z.string() }).optional(),
  reason: z.string(),
  required: z.boolean()
});
export type LockEntry = z.infer<typeof LockEntrySchema>;

export const LockFileSchema = z.object({
  schemaVersion: z.literal(1),
  profiles: z.record(z.string(), z.object({
    resolvedAt: z.string(),
    minecraft: z.string(),
    loader: z.string(),
    loaderVersion: z.string(),
    entries: z.array(LockEntrySchema),
    issues: z.array(z.object({ severity: z.enum(['error', 'warning', 'info']), message: z.string() })).default([])
  }))
});
export type LockFile = z.infer<typeof LockFileSchema>;

export function lockPath(root: string): string {
  return path.join(root, `${PRODUCT.id}.lock.json`);
}

export function readLock(root: string): LockFile {
  const file = lockPath(root);
  if (!fs.existsSync(file)) return { schemaVersion: 1, profiles: {} };
  const res = LockFileSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!res.success) throw new Error(`Invalid lock file: ${res.error.issues.map((i) => i.message).join('; ')}`);
  return res.data;
}

export function writeLock(root: string, lock: LockFile): void {
  writeFileAtomic(lockPath(root), JSON.stringify(lock, null, 2) + '\n');
}
