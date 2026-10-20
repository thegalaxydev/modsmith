import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PRODUCT } from '../shared/product';
import type { Store } from './db';
import { CancelledError } from './operations';

export const USER_AGENT = `${PRODUCT.id}/${PRODUCT.version} (local development workbench)`;

export interface CachedJson<T> {
  data: T;
  fetchedAt: number;
  fromCache: boolean;
  stale: boolean;
  error?: string;
}

export class HttpClient {
  constructor(private store: Store) {}

  async getJson<T>(url: string, opts: { maxAgeMs?: number; signal?: AbortSignal; headers?: Record<string, string> } = {}): Promise<CachedJson<T>> {
    const maxAge = opts.maxAgeMs ?? 30 * 60 * 1000;
    const cached = this.store.getHttpCache(url);
    if (cached && Date.now() - cached.fetchedAt < maxAge) {
      return { data: JSON.parse(cached.body) as T, fetchedAt: cached.fetchedAt, fromCache: true, stale: false };
    }
    try {
      const res = await fetchWithRetry(url, { signal: opts.signal, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(opts.headers ?? {}) } });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}: ${body.slice(0, 200)}`);
      JSON.parse(body);
      this.store.setHttpCache(url, body);
      return { data: JSON.parse(body) as T, fetchedAt: Date.now(), fromCache: false, stale: false };
    } catch (err) {
      if (err instanceof CancelledError || opts.signal?.aborted) throw err;
      if (cached) {
        return { data: JSON.parse(cached.body) as T, fetchedAt: cached.fetchedAt, fromCache: true, stale: true, error: (err as Error).message };
      }
      throw err;
    }
  }
}

export async function fetchWithRetry(url: string, init: RequestInit & { signal?: AbortSignal }, retries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (init.signal?.aborted) throw new CancelledError();
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        await sleep(Math.max(retryAfter * 1000, 500 * 2 ** attempt), init.signal);
        continue;
      }
      return res;
    } catch (err) {
      if (init.signal?.aborted) throw new CancelledError();
      lastErr = err;
      await sleep(500 * 2 ** attempt, init.signal);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new CancelledError());
    }, { once: true });
  });
}

export interface DownloadSpec {
  url: string;
  dest: string;
  sha1?: string;
  sha512?: string;
  size?: number;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number | null) => void;
}

export function hashFile(file: string, algo: 'sha1' | 'sha512' | 'sha256'): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

export async function verifyFile(file: string, expected: { sha1?: string; sha512?: string; size?: number }): Promise<{ ok: boolean; reason?: string }> {
  if (!fs.existsSync(file)) return { ok: false, reason: 'missing' };
  if (expected.size !== undefined && fs.statSync(file).size !== expected.size) return { ok: false, reason: `size mismatch (expected ${expected.size}, got ${fs.statSync(file).size})` };
  if (expected.sha512) {
    const h = await hashFile(file, 'sha512');
    if (h.toLowerCase() !== expected.sha512.toLowerCase()) return { ok: false, reason: 'sha512 mismatch' };
  } else if (expected.sha1) {
    const h = await hashFile(file, 'sha1');
    if (h.toLowerCase() !== expected.sha1.toLowerCase()) return { ok: false, reason: 'sha1 mismatch' };
  }
  return { ok: true };
}

export async function downloadVerified(spec: DownloadSpec): Promise<{ path: string; cached: boolean }> {
  if (!spec.sha1 && !spec.sha512) throw new Error(`Refusing to download without a published hash: ${spec.url}`);
  if (fs.existsSync(spec.dest)) {
    const v = await verifyFile(spec.dest, spec);
    if (v.ok) return { path: spec.dest, cached: true };
    fs.rmSync(spec.dest, { force: true });
  }
  fs.mkdirSync(path.dirname(spec.dest), { recursive: true });
  const tmp = `${spec.dest}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchWithRetry(spec.url, { signal: spec.signal, headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} downloading ${spec.url}`);
      const total = Number(res.headers.get('content-length')) || null;
      const out = fs.createWriteStream(tmp);
      let received = 0;
      const reader = res.body.getReader();
      try {
        for (;;) {
          if (spec.signal?.aborted) throw new CancelledError();
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (!out.write(Buffer.from(value))) await new Promise<void>((r) => out.once('drain', () => r()));
          spec.onProgress?.(received, total);
        }
      } finally {
        await new Promise<void>((r) => out.end(() => r()));
      }
      const v = await verifyFile(tmp, spec);
      if (!v.ok) throw new Error(`Hash verification failed for ${spec.url}: ${v.reason}`);
      fs.renameSync(tmp, spec.dest);
      return { path: spec.dest, cached: false };
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      if (err instanceof CancelledError || spec.signal?.aborted) throw new CancelledError();
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
