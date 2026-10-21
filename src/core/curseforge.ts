import type { HttpClient } from './http';
import { fetchWithRetry, USER_AGENT } from './http';
import type { ModrinthProject, ModrinthVersion } from './modrinth';

export const curseforgeApi = () => process.env.MODSMITH_CURSEFORGE_API || 'https://api.curseforge.com/v1';
export const MINECRAFT_GAME_ID = 432;
export const CLASS_MODS = 6;
export const CLASS_MODPACKS = 4471;

export const LOADER_TYPES: Record<string, number> = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
const LOADER_NAMES: Record<string, string> = { Forge: 'forge', Fabric: 'fabric', Quilt: 'quilt', NeoForge: 'neoforge' };
const RELEASE: Record<number, 'release' | 'beta' | 'alpha'> = { 1: 'release', 2: 'beta', 3: 'alpha' };
const RELATION: Record<number, 'embedded' | 'optional' | 'required' | 'incompatible' | null> = { 1: 'embedded', 2: 'optional', 3: 'required', 4: null, 5: 'incompatible', 6: 'embedded' };

export interface CfMod {
  id: number;
  slug: string;
  name: string;
  summary: string;
  classId?: number;
  downloadCount: number;
  allowModDistribution: boolean | null;
  links?: { websiteUrl?: string; sourceUrl?: string | null };
  logo?: { url?: string; thumbnailUrl?: string } | null;
  authors?: { name: string }[];
  latestFilesIndexes?: { gameVersion: string; fileId: number; modLoader?: number | null }[];
}

export interface CfFile {
  id: number;
  modId: number;
  displayName: string;
  fileName: string;
  releaseType: number;
  fileDate: string;
  fileLength: number;
  downloadUrl: string | null;
  hashes: { value: string; algo: number }[];
  gameVersions: string[];
  dependencies: { modId: number; relationType: number }[];
  isAvailable?: boolean;
  isServerPack?: boolean;
}

export class CurseForgeError extends Error {}

export function cfSha1(file: CfFile): string | undefined {
  return file.hashes.find((h) => h.algo === 1)?.value;
}

export function cfFilePage(mod: CfMod | undefined, file: CfFile): string {
  const base = mod?.links?.websiteUrl ?? `https://www.curseforge.com/minecraft/mc-mods/${mod?.slug ?? file.modId}`;
  return `${base.replace(/\/$/, '')}/files/${file.id}`;
}

export function cfDistributable(mod: CfMod | undefined, file: CfFile): boolean {
  return !!file.downloadUrl && mod?.allowModDistribution !== false;
}

export function cfToProject(mod: CfMod, file?: CfFile): ModrinthProject {
  const gv = file?.gameVersions ?? [];
  const hasClient = gv.includes('Client');
  const hasServer = gv.includes('Server');
  return {
    id: String(mod.id),
    slug: mod.slug,
    title: mod.name,
    description: mod.summary,
    client_side: hasServer && !hasClient ? 'unsupported' : hasClient ? 'required' : 'unknown',
    server_side: hasClient && !hasServer ? 'unsupported' : hasServer ? 'required' : 'unknown',
    project_type: mod.classId === CLASS_MODPACKS ? 'modpack' : 'mod'
  };
}

export function cfToVersion(file: CfFile): ModrinthVersion {
  return {
    id: String(file.id),
    project_id: String(file.modId),
    name: file.displayName,
    version_number: file.displayName,
    version_type: RELEASE[file.releaseType] ?? 'release',
    loaders: file.gameVersions.map((g) => LOADER_NAMES[g]).filter(Boolean),
    game_versions: file.gameVersions.filter((g) => /^\d+\.\d+/.test(g)),
    date_published: file.fileDate,
    dependencies: file.dependencies.flatMap((d) => {
      const t = RELATION[d.relationType];
      return t ? [{ version_id: null, project_id: String(d.modId), file_name: null, dependency_type: t }] : [];
    }),
    files: [{ hashes: { sha1: cfSha1(file) ?? '', sha512: '' }, url: file.downloadUrl ?? '', filename: file.fileName, primary: true, size: file.fileLength }]
  };
}

export class CurseForgeClient {
  constructor(private http: HttpClient, private apiKey: () => string | null) {}

  configured(): boolean {
    return !!this.apiKey();
  }

  private key(): string {
    const k = this.apiKey();
    if (!k) throw new CurseForgeError('CurseForge requires an API key from the CurseForge for Studios console (console.curseforge.com). Add it in Settings > Providers or set MODSMITH_CURSEFORGE_API_KEY.');
    return k;
  }

  private async get<T>(pathAndQuery: string, maxAgeMs = 15 * 60 * 1000, signal?: AbortSignal): Promise<T> {
    const res = await this.http.getJson<{ data: T }>(`${curseforgeApi()}${pathAndQuery}`, { maxAgeMs, signal, headers: { 'x-api-key': this.key() } });
    return res.data.data;
  }

  private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetchWithRetry(`${curseforgeApi()}${path}`, { method: 'POST', signal, headers: { 'x-api-key': this.key(), 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT }, body: JSON.stringify(body) });
    if (res.status === 403) throw new CurseForgeError('CurseForge rejected the API key (403)');
    if (!res.ok) throw new CurseForgeError(`CurseForge HTTP ${res.status}`);
    return ((await res.json()) as { data: T }).data;
  }

  async search(opts: { query: string; loader?: string; minecraft?: string; classId?: number; limit?: number; offset?: number; signal?: AbortSignal }) {
    const params = new URLSearchParams({ gameId: String(MINECRAFT_GAME_ID), classId: String(opts.classId ?? CLASS_MODS), searchFilter: opts.query, sortField: '2', sortOrder: 'desc', pageSize: String(Math.min(50, opts.limit ?? 20)), index: String(opts.offset ?? 0) });
    if (opts.minecraft) params.set('gameVersion', opts.minecraft);
    if (opts.loader && LOADER_TYPES[opts.loader] && opts.minecraft) params.set('modLoaderType', String(LOADER_TYPES[opts.loader]));
    const res = await this.http.getJson<{ data: CfMod[]; pagination: { totalCount: number } }>(`${curseforgeApi()}/mods/search?${params}`, { maxAgeMs: 10 * 60 * 1000, signal: opts.signal, headers: { 'x-api-key': this.key() } });
    return { hits: res.data.data, total: res.data.pagination.totalCount, stale: res.stale, fetchedAt: res.fetchedAt };
  }

  mod(id: number | string, signal?: AbortSignal): Promise<CfMod> {
    return this.get<CfMod>(`/mods/${encodeURIComponent(String(id))}`, 60 * 60 * 1000, signal);
  }

  mods(ids: number[], signal?: AbortSignal): Promise<CfMod[]> {
    return ids.length ? this.post<CfMod[]>('/mods', { modIds: ids }, signal) : Promise.resolve([]);
  }

  async files(modId: number | string, opts: { loader?: string; minecraft?: string; signal?: AbortSignal; maxAgeMs?: number } = {}): Promise<CfFile[]> {
    const params = new URLSearchParams({ pageSize: '50' });
    if (opts.minecraft) params.set('gameVersion', opts.minecraft);
    if (opts.loader && LOADER_TYPES[opts.loader]) params.set('modLoaderType', String(LOADER_TYPES[opts.loader]));
    return this.get<CfFile[]>(`/mods/${encodeURIComponent(String(modId))}/files?${params}`, opts.maxAgeMs ?? 15 * 60 * 1000, opts.signal);
  }

  file(modId: number | string, fileId: number | string, signal?: AbortSignal): Promise<CfFile> {
    return this.get<CfFile>(`/mods/${encodeURIComponent(String(modId))}/files/${encodeURIComponent(String(fileId))}`, 24 * 3600 * 1000, signal);
  }

  filesByIds(ids: number[], signal?: AbortSignal): Promise<CfFile[]> {
    return ids.length ? this.post<CfFile[]>('/mods/files', { fileIds: ids }, signal) : Promise.resolve([]);
  }
}

export function pickCfFile(files: CfFile[], loader: string, minecraft: string): CfFile | null {
  const loaderName = Object.entries(LOADER_NAMES).find(([, v]) => v === loader)?.[0];
  const ok = files.filter((f) => f.isAvailable !== false && !f.isServerPack && f.gameVersions.includes(minecraft) && (!loaderName || f.gameVersions.includes(loaderName)));
  ok.sort((a, b) => a.releaseType - b.releaseType || Date.parse(b.fileDate) - Date.parse(a.fileDate));
  return ok[0] ?? null;
}
