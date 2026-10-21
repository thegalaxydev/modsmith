import { describe, expect, it } from 'vitest';
import { diffLock } from '../src/core/modupdates';
import { heldVersions } from '../src/core/profiles';
import type { LockEntry, Manifest } from '../src/core/manifest';

const entry = (key: string, versionId?: string, versionNumber?: string) => ({ key, provider: 'modrinth', title: key.split(':')[1], fileName: 'x.jar', modIds: [], reason: 'r', required: true, versionId, versionNumber }) as LockEntry;

describe('mod updates', () => {
  it('diffs lock entries and issues', () => {
    const d = diffLock([entry('modrinth:a', 'a1', '1.0'), entry('modrinth:b', 'b1', '2.0')], [entry('modrinth:a', 'a2', '1.1'), entry('modrinth:c', 'c1')], [{ severity: 'error', message: 'old' }], [{ severity: 'warning', message: 'new' }, { severity: 'info', message: 'x' }]);
    expect(d).toEqual({ changed: [{ key: 'modrinth:a', title: 'a', from: '1.0', to: '1.1' }], added: [{ key: 'modrinth:c', title: 'c', version: undefined }], removed: [{ key: 'modrinth:b', title: 'b', version: '2.0' }], newIssues: [{ severity: 'warning', message: 'new' }], fixedIssues: [{ severity: 'error', message: 'old' }] });
  });

  it('holds locked versions unless they are updated or the platform changed', () => {
    const manifest = { platform: { minecraft: '1.21.1', loader: 'fabric' } } as Manifest;
    const previous = { resolvedAt: 'x', minecraft: '1.21.1', loader: 'fabric', loaderVersion: '0.19.5', entries: [entry('modrinth:a', 'a1'), entry('modrinth:b', 'b1'), { ...entry('local:x.jar'), provider: 'local' as const }], issues: [] };
    expect(heldVersions(previous, manifest, {})).toEqual({ 'modrinth:a': 'a1', 'modrinth:b': 'b1' });
    expect(heldVersions(previous, manifest, { update: ['modrinth:a'], held: { 'modrinth:c': 'c0' } })).toEqual({ 'modrinth:b': 'b1', 'modrinth:c': 'c0' });
    expect(heldVersions(previous, manifest, { update: 'all' })).toEqual({});
    expect(heldVersions({ ...previous, minecraft: '1.21.4' }, manifest, {})).toEqual({});
  });
});
