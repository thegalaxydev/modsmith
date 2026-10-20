import { PRODUCT } from '../shared/product';
import type { HttpClient } from './http';

const githubApi = () => process.env.MODSMITH_GITHUB_API || 'https://api.github.com';
const releasesPage = () => `https://github.com/${PRODUCT.repository}/releases`;

function parts(v: string): number[] {
  return v
    .trim()
    .replace(/^[vV]+/, '')
    .split(/[-+]/)[0]
    .split('.')
    .map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
}

export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const c = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (c) return Math.sign(c);
  }
  return 0;
}

interface Release {
  tag_name?: string;
  name?: string | null;
  html_url?: string;
  published_at?: string | null;
  body?: string | null;
  assets?: { name?: string; browser_download_url?: string; size?: number }[];
}

export async function checkForUpdate(http: HttpClient, force = false) {
  const current = PRODUCT.version;
  const empty = (error: string | null) => ({ current, latest: null, available: false, name: null, url: releasesPage(), publishedAt: null, notes: '', assets: [], checkedAt: Date.now(), stale: false, error });
  let r;
  try {
    r = await http.getJson<Release>(`${githubApi()}/repos/${PRODUCT.repository}/releases/latest`, { maxAgeMs: force ? 0 : 6 * 3600 * 1000 });
  } catch (err) {
    const message = (err as Error).message;
    return empty(message.startsWith('HTTP 404 ') ? null : message);
  }
  const d = r.data;
  const tag = d.tag_name ?? '';
  if (!tag) return empty('The latest release has no version tag');
  const latest = tag.replace(/^[vV]+/, '');
  return {
    current,
    latest,
    available: compareVersions(latest, current) > 0,
    name: d.name || tag,
    url: d.html_url ?? releasesPage(),
    publishedAt: d.published_at ?? null,
    notes: Array.from(d.body ?? '').slice(0, 4000).join(''),
    assets: (d.assets ?? []).map((a) => ({ name: a.name ?? '', url: a.browser_download_url ?? '', size: a.size ?? 0 })),
    checkedAt: r.fetchedAt,
    stale: r.stale,
    error: r.error ?? null
  };
}
