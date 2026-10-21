import { fetchWithRetry, USER_AGENT, type HttpClient } from './http';

const api = () => process.env.MODSMITH_MODRINTH_API || 'https://api.modrinth.com/v2';

export interface ModrinthSearchHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  icon_url?: string;
  categories: string[];
  versions: string[];
  license: string;
  client_side: string;
  server_side: string;
  project_type: string;
  latest_version?: string;
}

export interface ModrinthProject {
  id: string;
  slug: string;
  title: string;
  description: string;
  client_side: string;
  server_side: string;
  license?: { id: string; name: string; url?: string | null };
  source_url?: string | null;
  project_type: string;
  team?: string;
  loaders?: string[];
  game_versions?: string[];
}

export interface ModrinthFile {
  hashes: { sha1: string; sha512: string };
  url: string;
  filename: string;
  primary: boolean;
  size: number;
  file_type?: string | null;
}

export interface ModrinthVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  version_type: 'release' | 'beta' | 'alpha';
  loaders: string[];
  game_versions: string[];
  date_published: string;
  dependencies: { version_id: string | null; project_id: string | null; file_name: string | null; dependency_type: 'required' | 'optional' | 'incompatible' | 'embedded' }[];
  files: ModrinthFile[];
}

export class ModrinthClient {
  constructor(private http: HttpClient) {}

  async search(opts: { query: string; loader?: string; minecraft?: string; projectType?: string; limit?: number; offset?: number; signal?: AbortSignal }) {
    const facets: string[][] = [[`project_type:${opts.projectType ?? 'mod'}`]];
    if (opts.loader) facets.push([`categories:${opts.loader}`]);
    if (opts.minecraft) facets.push([`versions:${opts.minecraft}`]);
    const params = new URLSearchParams({ query: opts.query, limit: String(opts.limit ?? 20), offset: String(opts.offset ?? 0), facets: JSON.stringify(facets), index: 'relevance' });
    const res = await this.http.getJson<{ hits: ModrinthSearchHit[]; total_hits: number }>(`${api()}/search?${params}`, { signal: opts.signal, maxAgeMs: 10 * 60 * 1000 });
    return { ...res.data, stale: res.stale, error: res.error, fetchedAt: res.fetchedAt };
  }

  async project(idOrSlug: string, signal?: AbortSignal): Promise<ModrinthProject> {
    return (await this.http.getJson<ModrinthProject>(`${api()}/project/${encodeURIComponent(idOrSlug)}`, { signal, maxAgeMs: 60 * 60 * 1000 })).data;
  }

  async projects(ids: string[], signal?: AbortSignal): Promise<ModrinthProject[]> {
    if (!ids.length) return [];
    return (await this.http.getJson<ModrinthProject[]>(`${api()}/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`, { signal, maxAgeMs: 60 * 60 * 1000 })).data;
  }

  async versions(projectId: string, opts: { loader?: string; minecraft?: string; signal?: AbortSignal; maxAgeMs?: number } = {}): Promise<ModrinthVersion[]> {
    const params = new URLSearchParams();
    if (opts.loader) params.set('loaders', JSON.stringify([opts.loader]));
    if (opts.minecraft) params.set('game_versions', JSON.stringify([opts.minecraft]));
    return (await this.http.getJson<ModrinthVersion[]>(`${api()}/project/${encodeURIComponent(projectId)}/version?${params}`, { signal: opts.signal, maxAgeMs: opts.maxAgeMs ?? 15 * 60 * 1000 })).data;
  }

  async version(versionId: string, signal?: AbortSignal): Promise<ModrinthVersion> {
    return (await this.http.getJson<ModrinthVersion>(`${api()}/version/${encodeURIComponent(versionId)}`, { signal, maxAgeMs: 24 * 3600 * 1000 })).data;
  }

  async versionsFromHashes(sha1s: string[], signal?: AbortSignal): Promise<Record<string, ModrinthVersion>> {
    const out: Record<string, ModrinthVersion> = {};
    for (let i = 0; i < sha1s.length; i += 500) {
      const chunk = sha1s.slice(i, i + 500);
      const res = await fetchWithRetry(`${api()}/version_files`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT }, body: JSON.stringify({ hashes: chunk, algorithm: 'sha1' }) });
      if (!res.ok) throw new Error(`Modrinth HTTP ${res.status} looking up file hashes`);
      Object.assign(out, (await res.json()) as Record<string, ModrinthVersion>);
    }
    return out;
  }

  async versionFromHash(sha1: string, signal?: AbortSignal): Promise<ModrinthVersion | null> {
    try {
      return (await this.http.getJson<ModrinthVersion>(`${api()}/version_file/${sha1}?algorithm=sha1`, { signal, maxAgeMs: 24 * 3600 * 1000 })).data;
    } catch {
      return null;
    }
  }
}

export function pickVersion(versions: ModrinthVersion[], loader: string, minecraft: string): ModrinthVersion | null {
  const rank = { release: 0, beta: 1, alpha: 2 } as const;
  const ok = versions.filter((v) => v.loaders.includes(loader) && v.game_versions.includes(minecraft));
  ok.sort((a, b) => rank[a.version_type] - rank[b.version_type] || Date.parse(b.date_published) - Date.parse(a.date_published));
  return ok[0] ?? null;
}

export function primaryFile(v: ModrinthVersion): ModrinthFile | null {
  return v.files.find((f) => f.primary) ?? v.files.find((f) => f.filename.endsWith('.jar')) ?? v.files[0] ?? null;
}
