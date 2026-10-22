export interface RegistryEntry {
  id: string;
  version: string;
  name: string;
  publisher: string;
  description?: string;
  repository: string;
  license?: string;
  url: string;
  sha256: string;
  size: number;
  modsmith: string;
  permissions: string[];
}

export interface RegistryIndex {
  schemaVersion: 1;
  generatedAt: string;
  extensions: { id: string; name: string; publisher: string; description?: string; repository: string; license?: string; versions: Pick<RegistryEntry, 'version' | 'url' | 'sha256' | 'size' | 'modsmith' | 'permissions'>[] }[];
}

export const ID: RegExp;
export const VERSION: RegExp;
export const RELEASE: RegExp;
export const PERMISSIONS: string[];
export const FIELDS: string[];
export function compareVersions(a: string, b: string): number;
export function githubRepo(link: string | undefined): string | null;
export function releaseRepo(url: string | undefined): string | null;
export function checkEntry(e: unknown, file?: string): string[];
export function readRegistry(root: string): { entries: (RegistryEntry & { file: string })[]; problems: string[] };
export function buildIndex(root: string, generatedAt?: string): RegistryIndex;
