import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Workbench } from '../src/core/workbench';
import { compareVersions } from '../src/core/updates';
import { PRODUCT } from '../src/shared/product';
import { createService, serviceBinary, type ServiceUnderTest } from './service';
import { startFakeApi } from './fakeapi';

const LATEST = 'GET /github/repos/thegalaxydev/modsmith/releases/latest';

function release(tag: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    name: `Modsmith ${tag}`,
    html_url: `https://github.com/thegalaxydev/modsmith/releases/tag/${tag}`,
    published_at: '2026-10-21T12:00:00Z',
    body: 'Fixes and improvements',
    assets: [
      { name: `Modsmith_${tag.slice(1)}_x64-setup.exe`, browser_download_url: `https://github.com/thegalaxydev/modsmith/releases/download/${tag}/Modsmith_${tag.slice(1)}_x64-setup.exe`, size: 4194304 },
      { name: `Modsmith_${tag.slice(1)}_amd64.AppImage`, browser_download_url: `https://github.com/thegalaxydev/modsmith/releases/download/${tag}/Modsmith_${tag.slice(1)}_amd64.AppImage`, size: 89128960 }
    ],
    ...extra
  };
}

describe('version comparison', () => {
  it('orders release versions numerically', () => {
    expect(compareVersions('0.2.0', '0.1.0')).toBe(1);
    expect(compareVersions('v0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.1.1')).toBe(-1);
    expect(compareVersions('1.2.0-beta.1', '1.2.0')).toBe(0);
  });
});

describe('update check', () => {
  let node: Workbench;
  let rust: ServiceUnderTest | null = null;
  let api: Awaited<ReturnType<typeof startFakeApi>>;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    api = await startFakeApi();
    for (const [k, v] of Object.entries(api.env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    node = new Workbench();
    if (serviceBinary) {
      rust = createService();
      await rust.call('system.info', {}, 'ui');
    }
  });
  afterAll(async () => {
    await node.stop(false);
    await rust?.stop();
    await api.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const clearCache = () => {
    const db = new DatabaseSync(path.join(process.env.MODSMITH_DATA_DIR!, 'workbench.sqlite'));
    db.exec('PRAGMA busy_timeout = 5000; DELETE FROM http_cache');
    db.close();
  };
  const strip = (v: unknown) => {
    const o = JSON.parse(JSON.stringify(v)) as Record<string, unknown>;
    expect(typeof o.checkedAt).toBe('number');
    delete o.checkedAt;
    return o;
  };
  const both = async (params: Record<string, unknown>) => {
    clearCache();
    const n = strip(await node.call('system.check_update', params, 'ui'));
    if (rust) {
      clearCache();
      const r = strip(await rust.call('system.check_update', params, 'ui'));
      expect(r).toEqual(n);
    }
    return n;
  };

  it('reports no update when the repository has no releases', async () => {
    api.extra.delete(LATEST);
    expect(await both({})).toEqual({ current: PRODUCT.version, latest: null, available: false, name: null, url: 'https://github.com/thegalaxydev/modsmith/releases', publishedAt: null, notes: '', assets: [], stale: false, error: null });
  });

  it('reports a newer release with its download files', async () => {
    api.extra.set(LATEST, { body: release('v99.0.0') });
    const r = await both({});
    expect(r).toMatchObject({ current: PRODUCT.version, latest: '99.0.0', available: true, name: 'Modsmith v99.0.0', url: 'https://github.com/thegalaxydev/modsmith/releases/tag/v99.0.0', publishedAt: '2026-10-21T12:00:00Z', notes: 'Fixes and improvements', stale: false, error: null });
    expect(r.assets).toEqual([
      { name: 'Modsmith_99.0.0_x64-setup.exe', url: 'https://github.com/thegalaxydev/modsmith/releases/download/v99.0.0/Modsmith_99.0.0_x64-setup.exe', size: 4194304 },
      { name: 'Modsmith_99.0.0_amd64.AppImage', url: 'https://github.com/thegalaxydev/modsmith/releases/download/v99.0.0/Modsmith_99.0.0_amd64.AppImage', size: 89128960 }
    ]);
  });

  it('reports no update when the latest release is the running version', async () => {
    api.extra.set(LATEST, { body: release(`v${PRODUCT.version}`, { name: '' }) });
    expect(await both({})).toMatchObject({ latest: PRODUCT.version, available: false, name: `v${PRODUCT.version}` });
  });

  it('reports errors without failing', async () => {
    api.extra.set(LATEST, { status: 403, body: { message: 'API rate limit exceeded' } });
    const r = await both({});
    expect(r).toMatchObject({ latest: null, available: false });
    expect(String(r.error)).toMatch(/^HTTP 403 for .*rate limit/);
  });

  it('caches the answer for six hours unless forced', async () => {
    clearCache();
    api.extra.set(LATEST, { body: release('v99.0.0') });
    const count = () => api.requests.filter((q) => q.url.endsWith('/releases/latest')).length;
    const before = count();
    await node.call('system.check_update', {}, 'ui');
    await node.call('system.check_update', {}, 'ui');
    expect(count()).toBe(before + 1);
    await node.call('system.check_update', { force: true }, 'ui');
    expect(count()).toBe(before + 2);
  });
});
