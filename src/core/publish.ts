import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Services } from './context';
import type { WorkspaceService } from './workspace';
import { writeManifest, type Manifest } from './manifest';
import { SecretStore } from './secrets';
import { USER_AGENT } from './http';

export type PublishProvider = 'modrinth' | 'curseforge';

const PROVIDERS: PublishProvider[] = ['modrinth', 'curseforge'];
const TOKEN: Record<PublishProvider, { secret: string; env: string; label: string }> = {
  modrinth: { secret: 'modrinth.token', env: 'MODSMITH_MODRINTH_TOKEN', label: 'Modrinth' },
  curseforge: { secret: 'curseforge.uploadToken', env: 'MODSMITH_CURSEFORGE_UPLOAD_TOKEN', label: 'CurseForge' }
};
const LOADER_NAMES: Record<string, string> = { fabric: 'Fabric', neoforge: 'NeoForge', forge: 'Forge', quilt: 'Quilt' };

const modrinthApi = () => process.env.MODSMITH_MODRINTH_API || 'https://api.modrinth.com/v2';
const cfUploadApi = () => process.env.MODSMITH_CURSEFORGE_UPLOAD_API || 'https://minecraft.curseforge.com';

interface Link {
  id: string;
  slug?: string;
  title?: string;
}

interface PublishInput {
  path: string;
  file: string;
  targets: PublishProvider[];
  version: string;
  name?: string;
  changelog?: string;
  releaseType?: 'release' | 'beta' | 'alpha';
  gameVersions?: string[];
  loaders?: string[];
}

function slice(text: string, max = 200) {
  return text.length > max ? text.slice(0, max) : text;
}

function errorText(body: string): string {
  try {
    const j = JSON.parse(body) as { description?: unknown; errorMessage?: unknown; error?: unknown };
    const msg = j.description ?? j.errorMessage ?? j.error;
    if (typeof msg === 'string' && msg) return slice(msg);
  } catch {
    return slice(body);
  }
  return slice(body);
}

export function multipart(field: string, json: string, fileName: string, bytes: Buffer): { body: Buffer; contentType: string } {
  const boundary = `ModsmithBoundary${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`;
  const safe = fileName.replace(/["\r\n]/g, '_');
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="${field}"\r\nContent-Type: application/json\r\n\r\n${json}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safe}"\r\nContent-Type: application/java-archive\r\n\r\n`;
  return { body: Buffer.concat([Buffer.from(head, 'utf8'), bytes, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]), contentType: `multipart/form-data; boundary=${boundary}` };
}

export function modrinthRef(input: string): string {
  const m = /modrinth\.com\/(?:mod|plugin|datapack|resourcepack|shader|modpack|project)\/([^/?#]+)/.exec(input);
  return (m?.[1] ?? input).trim();
}

export function linkUrl(provider: PublishProvider, link: Link): string {
  if (provider === 'modrinth') return `https://modrinth.com/mod/${link.slug ?? link.id}`;
  return link.slug ? `https://www.curseforge.com/minecraft/mc-mods/${link.slug}` : `https://www.curseforge.com/projects/${link.id}`;
}

export class PublishService {
  constructor(private s: Services, private ws: WorkspaceService) {}

  private token(provider: PublishProvider): string | null {
    const t = TOKEN[provider];
    if (process.env[t.env]) return process.env[t.env]!;
    try {
      return SecretStore.supported() ? this.s.secrets.get(t.secret) : null;
    } catch {
      return null;
    }
  }

  private tokenSource(provider: PublishProvider): string | null {
    const t = TOKEN[provider];
    if (process.env[t.env]) return 'environment';
    return this.s.secrets.has(t.secret) ? 'os-secret-store' : null;
  }

  status(root: string) {
    const manifest = this.ws.requireManifest(this.ws.normalize(root));
    const out: Record<string, unknown> = { storage: SecretStore.supported() ? 'Windows DPAPI' : null };
    for (const p of PROVIDERS) {
      const link = manifest.publish?.[p];
      out[p] = { project: link ? { ...link, url: linkUrl(p, link) } : null, token: this.tokenSource(p) };
    }
    return out;
  }

  async link(root: string, provider: PublishProvider, project: string | null) {
    const dir = this.ws.normalize(root);
    const manifest = this.ws.requireManifest(dir);
    let link: Link | null = null;
    if (project !== null && project.trim()) {
      if (provider === 'modrinth') {
        const ref = modrinthRef(project);
        const res = await fetch(`${modrinthApi()}/project/${encodeURIComponent(ref)}`, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
        if (res.status === 404) throw new Error(`Modrinth has no project ${ref}`);
        if (!res.ok) throw new Error(`Modrinth answered HTTP ${res.status}: ${errorText(await res.text())}`);
        const p = (await res.json()) as { id: string; slug?: string; title?: string; project_type?: string };
        if (p.project_type && p.project_type !== 'mod') throw new Error(`${p.title ?? ref} is a ${p.project_type} on Modrinth, not a mod`);
        link = { id: p.id, slug: p.slug, title: p.title };
      } else {
        const id = project.trim();
        if (!/^\d+$/.test(id)) throw new Error('Enter the numeric Project ID from the About Project box on your CurseForge project page');
        link = { id };
        if (this.s.curseforge.configured()) {
          let mod;
          try {
            mod = await this.s.curseforge.mod(id);
          } catch {
            throw new Error(`CurseForge has no project ${id}`);
          }
          link = { id, slug: mod.slug, title: mod.name };
        }
      }
    }
    const publish = { ...(manifest.publish ?? {}) };
    if (link) publish[provider] = link;
    else delete publish[provider];
    const next: Manifest = { ...manifest, publish };
    if (!publish.modrinth && !publish.curseforge) delete next.publish;
    writeManifest(dir, next);
    return link ? { ...link, url: linkUrl(provider, link) } : null;
  }

  async setToken(provider: PublishProvider, token: string) {
    if (!SecretStore.supported()) throw new Error(`OS secret storage is not available on this platform; set ${TOKEN[provider].env} instead`);
    const res =
      provider === 'modrinth'
        ? await fetch(`${modrinthApi()}/user`, { headers: { Authorization: token, 'User-Agent': USER_AGENT, Accept: 'application/json' } })
        : await fetch(`${cfUploadApi()}/api/game/version-types`, { headers: { 'X-Api-Token': token, 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (res.status === 401 || res.status === 403) throw new Error(`${TOKEN[provider].label} rejected this token`);
    if (!res.ok) throw new Error(`Could not verify the token (HTTP ${res.status})`);
    this.s.secrets.set(TOKEN[provider].secret, token);
    return { stored: true, storage: 'Windows DPAPI' };
  }

  clearToken(provider: PublishProvider) {
    this.s.secrets.delete(TOKEN[provider].secret);
    return { cleared: true };
  }

  publish(input: PublishInput) {
    const dir = this.ws.normalize(input.path);
    const manifest = this.ws.requireManifest(dir);
    if (!input.file.endsWith('.jar') || /[\\/]/.test(input.file) || input.file.startsWith('.')) throw new Error(`${input.file} is not a JAR in build/libs`);
    const file = path.join(dir, 'build', 'libs', input.file);
    if (!fs.existsSync(file)) throw new Error(`${input.file} is not in build/libs; build the project first`);
    const targets = PROVIDERS.filter((p) => input.targets.includes(p));
    if (!targets.length) throw new Error('Choose where to publish');
    for (const p of targets) {
      if (!manifest.publish?.[p]) throw new Error(`Link a ${TOKEN[p].label} project in Project settings first`);
      if (!this.token(p)) throw new Error(`Add a ${TOKEN[p].label} upload token in Project settings first`);
    }
    const version = input.version.trim();
    if (!version) throw new Error('Enter a version number');
    const tokens = Object.fromEntries(targets.map((p) => [p, this.token(p)!])) as Record<PublishProvider, string>;
    const job = {
      bytes: fs.readFileSync(file),
      fileName: input.file,
      name: input.name?.trim() || `${manifest.name} ${version}`,
      version,
      changelog: input.changelog ?? '',
      releaseType: input.releaseType ?? 'release',
      gameVersions: input.gameVersions?.length ? input.gameVersions : [manifest.platform.minecraft],
      loaders: input.loaders?.length ? input.loaders : [manifest.platform.loader]
    };
    return this.s.ops.start({ kind: 'project.publish', title: `Publish ${job.name}`, workspace: dir }, async (ctx) => {
      const results: { provider: PublishProvider; ok: boolean; id?: string; url?: string; error?: string }[] = [];
      for (const [i, p] of targets.entries()) {
        ctx.progress(i / targets.length, `Uploading to ${TOKEN[p].label}`);
        try {
          const r = p === 'modrinth' ? await this.uploadModrinth(manifest.publish!.modrinth!, tokens.modrinth, job) : await this.uploadCurseForge(manifest.publish!.curseforge!, tokens.curseforge, job);
          ctx.log(`${TOKEN[p].label}: published ${job.fileName} (${r.url})`);
          results.push({ provider: p, ok: true, ...r });
        } catch (err) {
          const error = (err as Error).message;
          ctx.log(`${TOKEN[p].label}: ${error}`);
          results.push({ provider: p, ok: false, error });
        }
      }
      if (results.every((r) => !r.ok)) throw new Error(results.map((r) => `${TOKEN[r.provider].label}: ${r.error}`).join('; '));
      return { results };
    });
  }

  private async uploadModrinth(link: Link, token: string, job: { bytes: Buffer; fileName: string; name: string; version: string; changelog: string; releaseType: string; gameVersions: string[]; loaders: string[] }) {
    const data = JSON.stringify({
      changelog: job.changelog,
      dependencies: [],
      featured: true,
      file_parts: ['file'],
      game_versions: job.gameVersions,
      loaders: job.loaders,
      name: job.name,
      primary_file: 'file',
      project_id: link.id,
      version_number: job.version,
      version_type: job.releaseType
    });
    const form = multipart('data', data, job.fileName, job.bytes);
    const res = await fetch(`${modrinthApi()}/version`, { method: 'POST', headers: { Authorization: token, 'User-Agent': USER_AGENT, Accept: 'application/json', 'Content-Type': form.contentType }, body: new Uint8Array(form.body) });
    const text = await res.text();
    if (res.status === 401) throw new Error('Modrinth rejected the upload token; add a new one in Project settings');
    if (!res.ok) throw new Error(`Modrinth answered HTTP ${res.status}: ${errorText(text)}`);
    const v = JSON.parse(text) as { id: string };
    return { id: v.id, url: `https://modrinth.com/mod/${link.slug ?? link.id}/version/${v.id}` };
  }

  private async uploadCurseForge(link: Link, token: string, job: { bytes: Buffer; fileName: string; name: string; changelog: string; releaseType: string; gameVersions: string[]; loaders: string[] }) {
    const headers = { 'X-Api-Token': token, 'User-Agent': USER_AGENT, Accept: 'application/json' };
    const get = async <T>(p: string): Promise<T> => {
      const res = await fetch(`${cfUploadApi()}${p}`, { headers });
      const text = await res.text();
      if (res.status === 401 || res.status === 403) throw new Error('CurseForge rejected the upload token; add a new one in Project settings');
      if (!res.ok) throw new Error(`CurseForge answered HTTP ${res.status}: ${errorText(text)}`);
      return JSON.parse(text) as T;
    };
    const types = await get<{ id: number; slug: string }[]>('/api/game/version-types');
    const versions = await get<{ id: number; gameVersionTypeID: number; name: string }[]>('/api/game/versions');
    const mcTypes = types.filter((t) => t.slug.startsWith('minecraft-')).map((t) => t.id);
    const loaderTypes = types.filter((t) => t.slug === 'modloader').map((t) => t.id);
    const ids: number[] = [];
    for (const gv of job.gameVersions) {
      const v = versions.find((x) => mcTypes.includes(x.gameVersionTypeID) && x.name === gv);
      if (!v) throw new Error(`CurseForge does not list Minecraft ${gv}`);
      ids.push(v.id);
    }
    for (const loader of job.loaders) {
      const name = LOADER_NAMES[loader] ?? loader;
      const v = versions.find((x) => loaderTypes.includes(x.gameVersionTypeID) && x.name.toLowerCase() === name.toLowerCase());
      if (!v) throw new Error(`CurseForge does not list the ${name} loader`);
      ids.push(v.id);
    }
    const metadata = JSON.stringify({ changelog: job.changelog, changelogType: 'markdown', displayName: job.name, gameVersions: ids, releaseType: job.releaseType });
    const form = multipart('metadata', metadata, job.fileName, job.bytes);
    const res = await fetch(`${cfUploadApi()}/api/projects/${link.id}/upload-file`, { method: 'POST', headers: { ...headers, 'Content-Type': form.contentType }, body: new Uint8Array(form.body) });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new Error('CurseForge rejected the upload token; add a new one in Project settings');
    if (!res.ok) throw new Error(`CurseForge answered HTTP ${res.status}: ${errorText(text)}`);
    const f = JSON.parse(text) as { id: number };
    const page = link.slug ? `https://www.curseforge.com/minecraft/mc-mods/${link.slug}/files/${f.id}` : `https://www.curseforge.com/projects/${link.id}`;
    return { id: String(f.id), url: page };
  }
}
