import type { Capability, CatalogEntry, LoaderId } from '../../shared/types';
import type { ModRef } from '../manifest';
import type { OpContext } from '../operations';

export interface ScaffoldOptions {
  projectName: string;
  destination: string;
  modId: string;
  packageName: string;
  author: string;
  description: string;
  license: string;
  git: boolean;
  catalogEntryId: string;
  environment: 'both' | 'client' | 'server';
  starters: string[];
  dependencies: ModRef[];
  resolvedDependencyModIds?: Record<string, string[]>;
  mavenCoordinates?: Record<string, string>;
}

export interface StarterOption {
  id: string;
  label: string;
  description: string;
  state: 'supported' | 'planned';
  requires?: string[];
}

export interface DetectedProject {
  loader: LoaderId | 'unknown';
  buildSystem: 'gradle' | 'none';
  gradleWrapper: boolean;
  buildFiles: string[];
  modMetadata: { file: string; id?: string; version?: string; minecraft?: string; loaderVersion?: string }[];
  loaderPlugins: string[];
  minecraftHint?: string;
  loaderVersionHint?: string;
  notes: string[];
  ambiguous: boolean;
}

export interface GeneratedFile {
  path: string;
  content: string | Buffer;
  executable?: boolean;
}

export interface LoaderAdapter {
  id: LoaderId;
  displayName: string;
  implemented: boolean;
  capabilities(): Capability[];
  catalogEntries(): CatalogEntry[];
  starterOptions(entry: CatalogEntry): StarterOption[];
  listGameVersions(signal?: AbortSignal): Promise<{ versions: { version: string; stable: boolean }[]; fetchedAt: number; stale: boolean; error?: string }>;
  listLoaderVersions(minecraft: string, signal?: AbortSignal): Promise<{ versions: { version: string; stable: boolean }[]; fetchedAt: number; stale: boolean; error?: string }>;
  generateProject(opts: ScaffoldOptions, entry: CatalogEntry): GeneratedFile[];
  detectProject(dir: string): DetectedProject | null;
  runTaskNames(): { client: string; server: string; datagen?: string };
  installServer?(instanceDir: string, entry: { minecraft: string; loaderVersion: string }, ctx: OpContext): Promise<{ jar: string; args: string[] }>;
}
