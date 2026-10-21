import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Recorded {
  method: string;
  url: string;
  apiKey?: string;
  contentType?: string;
  body: string;
}

const hit = (id: string, extra: Record<string, unknown> = {}) => ({ project_id: id, slug: `slug-${id}`, title: `Title ${id}`, description: 'desc', author: 'someone', downloads: 42, icon_url: id === 'B' ? null : `https://cdn.example/${id}.png`, categories: ['fabric'], versions: ['1.21.1'], license: 'MIT', client_side: 'required', server_side: 'optional', project_type: 'mod', ...extra });

const version = (id: string, type: string, date: string, loaders = ['fabric'], games = ['1.21.1']) => ({ id, project_id: 'P', name: `v ${id}`, version_number: id, version_type: type, loaders, game_versions: games, date_published: date, dependencies: [], files: [{ hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) }, url: `https://cdn.example/${id}.jar`, filename: `${id}.jar`, primary: true, size: 10 }] });

const cfMod = (id: number, extra: Record<string, unknown> = {}) => ({ id, slug: `cf-${id}`, name: `CF ${id}`, summary: 'summary', downloadCount: 7, allowModDistribution: id !== 2 ? true : false, links: { websiteUrl: `https://www.curseforge.com/minecraft/mc-mods/cf-${id}` }, logo: id === 3 ? null : { thumbnailUrl: id === 1 ? null : `https://media.example/${id}.png`, url: `https://media.example/${id}-full.png` }, authors: id === 3 ? undefined : [{ name: 'A' }, { name: 'B' }], ...extra });

const cfFile = (id: number, releaseType: number, date: string, versions: string[], extra: Record<string, unknown> = {}) => ({ id, modId: 1, displayName: `File ${id}`, fileName: `f${id}.jar`, releaseType, fileDate: date, fileLength: 5, downloadUrl: id === 13 ? null : `https://edge.example/${id}.jar`, hashes: [{ value: 'c'.repeat(40), algo: 1 }], gameVersions: versions, dependencies: [], ...extra });

function route(method: string, u: URL, key: string | undefined, counters: Map<string, number>): { status: number; body: unknown; raw?: string; headers?: Record<string, string> } {
  const p = u.pathname;
  const count = (k: string) => {
    const n = (counters.get(k) ?? 0) + 1;
    counters.set(k, n);
    return n;
  };
  if (p === '/modrinth/search') {
    const q = u.searchParams.get('query') ?? '';
    if (q === 'boom') return { status: 404, body: { error: 'not_found', description: 'x'.repeat(300) } };
    if (q === 'flaky' && count('flaky') % 2 === 1) return { status: 503, body: {}, headers: { 'retry-after': '0' } };
    if (q === 'garbage') return { status: 200, body: null, raw: '{not json' };
    if (q === 'nototal') return { status: 200, body: { hits: [hit('Z')] } };
    return { status: 200, body: { hits: [hit('A'), hit('B', { slug: 'b-slug' })], offset: 0, limit: 20, total_hits: 2, echo: u.search } };
  }
  const versionsMatch = p.match(/^\/modrinth\/project\/([^/]+)\/version$/);
  if (versionsMatch) {
    const id = decodeURIComponent(versionsMatch[1]);
    if (id === 'missing') return { status: 404, body: { error: 'not_found' } };
    if (id === 'none') return { status: 200, body: [] };
    return { status: 200, body: [version('1.0', 'beta', '2024-05-02T00:00:00.123456Z'), version('0.9', 'release', '2024-05-01T00:00:00Z'), version('0.8', 'release', '2024-06-01T00:00:00Z'), version('0.7', 'alpha', '2025-01-01T00:00:00Z'), version('x', 'release', '2026-01-01T00:00:00Z', ['forge'])] };
  }
  if (p.startsWith('/cf/')) {
    if (p === '/cf/games/432') return key === 'good-key-1234567890' ? { status: 200, body: { data: { id: 432 } } } : key === 'broken-key-1234567890' ? { status: 500, body: {} } : { status: 403, body: {} };
    if (key !== 'good-key-1234567890') return { status: 403, body: {} };
    if (p === '/cf/mods/search') return { status: 200, body: { data: [cfMod(1), cfMod(2), cfMod(3)], pagination: { index: 0, pageSize: 20, resultCount: 3, totalCount: 3 }, echo: u.search } };
    if (p === '/cf/mods/1/files') return { status: 200, body: { data: [cfFile(11, 2, '2024-05-03T00:00:00Z', ['1.21.1', 'Fabric']), cfFile(12, 1, '2024-05-01T00:00:00Z', ['1.21.1', 'Fabric', 'Client']), cfFile(13, 1, '2024-05-02T00:00:00Z', ['1.21.1', 'Fabric']), cfFile(14, 1, '2024-06-02T00:00:00Z', ['1.21.1', 'Forge']), cfFile(15, 1, '2024-07-02T00:00:00Z', ['1.21.1', 'Fabric'], { isServerPack: true })], echo: u.search } };
    if (p === '/cf/mods/1') return { status: 200, body: { data: cfMod(1) } };
    return { status: 404, body: { error: 'nope' } };
  }
  if (p === '/fabric/versions/game') return { status: 200, body: [{ version: '1.21.1', stable: true }, { version: '24w33a', stable: false }] };
  const loaderMatch = p.match(/^\/fabric\/versions\/loader\/(.+)$/);
  if (loaderMatch) return { status: 200, body: [{ loader: { version: '0.19.5', stable: true }, intermediary: {} }, { loader: { version: '0.19.6-beta', stable: false } }] };
  if (p === '/neo/versions') return { status: 200, body: { isSnapshot: false, versions: ['20.4.1', '20.6.2', '21.0.1-beta', '21.0.5', '21.1.1', '21.1.77', '22.0.1', 'weird'] } };
  if (p === '/github/repos/thegalaxydev/modsmith/releases/latest') return { status: 404, body: { message: 'Not Found' } };
  return { status: 404, body: { error: 'unknown route' } };
}

export interface Extra {
  status?: number;
  body?: unknown;
  bytes?: Uint8Array;
}

export interface FakeTemurin {
  release: string;
  name: string;
  bytes: Uint8Array;
  checksum?: string;
}

function adoptium(u: URL, temurin: Map<string, FakeTemurin>): { status: number; body?: unknown; bytes?: Uint8Array; headers?: Record<string, string> } | null {
  const assets = u.pathname.match(/^\/adoptium\/v3\/assets\/latest\/(\d+)\/hotspot$/);
  if (assets) {
    const q = u.searchParams;
    const t = temurin.get(`${assets[1]}-${q.get('image_type')}-${q.get('os')}-${q.get('architecture')}`);
    if (!t || q.get('vendor') !== 'eclipse') return { status: 404, body: { errorMessage: 'No releases match the request' } };
    const checksum = t.checksum ?? crypto.createHash('sha256').update(t.bytes).digest('hex');
    return { status: 200, body: [{ release_name: t.release, vendor: 'eclipse', binary: { image_type: q.get('image_type'), os: q.get('os'), architecture: q.get('architecture'), package: { name: t.name, checksum, size: t.bytes.length, link: `https://github.example/${t.name}` } } }] };
  }
  const binary = u.pathname.match(/^\/adoptium\/v3\/binary\/latest\/(\d+)\/ga\/([^/]+)\/([^/]+)\/([^/]+)\/hotspot\/normal\/eclipse$/);
  if (binary) {
    const t = temurin.get(`${binary[1]}-${binary[4]}-${binary[2]}-${binary[3]}`);
    return t ? { status: 307, headers: { location: `/adoptium/files/${encodeURIComponent(t.name)}` } } : { status: 404, body: { errorMessage: 'No releases match the request' } };
  }
  const file = u.pathname.match(/^\/adoptium\/files\/(.+)$/);
  if (file) {
    const t = [...temurin.values()].find((x) => x.name === decodeURIComponent(file[1]));
    return t ? { status: 200, bytes: t.bytes } : { status: 404, body: {} };
  }
  return null;
}

export async function startFakeApi() {
  const requests: Recorded[] = [];
  const counters = new Map<string, number>();
  const extra = new Map<string, Extra | ((body: string) => Extra)>();
  const temurin = new Map<string, FakeTemurin>();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://localhost');
      requests.push({ method: req.method ?? 'GET', url: req.url ?? '', apiKey: req.headers['x-api-key'] as string | undefined, contentType: req.headers['content-type'] as string | undefined, body });
      const jdk = adoptium(u, temurin);
      if (jdk) {
        res.writeHead(jdk.status, { 'Content-Type': jdk.bytes ? 'application/octet-stream' : 'application/json', ...(jdk.headers ?? {}) });
        res.end(jdk.bytes ? Buffer.from(jdk.bytes) : JSON.stringify(jdk.body ?? null));
        return;
      }
      const custom = extra.get(`${req.method} ${u.pathname}${u.search}`) ?? extra.get(`${req.method} ${u.pathname}`);
      if (custom) {
        const c = typeof custom === 'function' ? custom(body) : custom;
        res.writeHead(c.status ?? 200, { 'Content-Type': c.bytes ? 'application/java-archive' : 'application/json' });
        res.end(c.bytes ? Buffer.from(c.bytes) : JSON.stringify(c.body));
        return;
      }
      const r = route(req.method ?? 'GET', u, req.headers['x-api-key'] as string | undefined, counters);
      res.writeHead(r.status, { 'Content-Type': 'application/json', ...(r.headers ?? {}) });
      res.end(r.raw ?? JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    requests,
    extra,
    temurin,
    env: { MODSMITH_MODRINTH_API: `${base}/modrinth`, MODSMITH_CURSEFORGE_API: `${base}/cf`, MODSMITH_FABRIC_META: `${base}/fabric`, MODSMITH_NEOFORGE_VERSIONS: `${base}/neo/versions`, MODSMITH_GITHUB_API: `${base}/github`, MODSMITH_ADOPTIUM_API: `${base}/adoptium/v3` },
    close: () => new Promise<void>((r) => server.close(() => r()))
  };
}
