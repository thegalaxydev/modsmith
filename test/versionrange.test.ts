import { describe, expect, it } from 'vitest';
import { compareVersions, satisfies } from '../src/core/versionrange';
import { checkModGraph } from '../src/core/resolver';
import type { ModMetadata } from '../src/core/jarmeta';
import type { LockEntry } from '../src/core/manifest';

const meta = (id: string, version: string, breaks: Record<string, string> = {}): ModMetadata => ({ loader: 'fabric', id, version, provides: [], depends: {}, recommends: {}, breaks, conflicts: {}, nested: [] });
const entry = (key: string, title: string, modIds: string[]): LockEntry => ({ key, provider: 'local', title, fileName: `${key}.jar`, sha1: key, size: 1, modIds, reason: 'test', required: true }) as LockEntry;

describe('version ranges', () => {
  it('compares versions', () => {
    expect(compareVersions('1.39.12', '1.38.1')).toBeGreaterThan(0);
    expect(compareVersions('25.2.10', '24.0.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('0.16.10+1.21.1', '0.16.10')).toBe(0);
    expect(compareVersions('1.21', '1.21.0')).toBe(0);
  });

  it('evaluates Fabric predicates', () => {
    expect(satisfies('1.39.12', '<1.38.1')).toBe(false);
    expect(satisfies('1.37.0', '<1.38.1')).toBe(true);
    expect(satisfies('1.21.1', '>=1.21 <1.22')).toBe(true);
    expect(satisfies('1.20.4', '1.21.x')).toBe(false);
    expect(satisfies('1.21.4', '1.21.x')).toBe(true);
    expect(satisfies('1.2.9', '~1.2')).toBe(true);
    expect(satisfies('1.3.0', '~1.2')).toBe(false);
    expect(satisfies('1.9.0', '^1.2.3')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.3')).toBe(false);
    expect(satisfies('3.0', '<1.0 || >=3.0')).toBe(true);
    expect(satisfies('2.0', '*')).toBe(true);
    expect(satisfies('abc', '<1.0')).toBeNull();
  });

  it('evaluates Maven ranges from NeoForge', () => {
    expect(satisfies('21.1.77', '[21.1,)')).toBe(true);
    expect(satisfies('2.0', '[1.0,2.0)')).toBe(false);
    expect(satisfies('1.5', '[1.0,2.0)')).toBe(true);
    expect(satisfies('1.0', '(,1.0]')).toBe(true);
  });

  it('only reports breaks when the installed version is in the range', () => {
    const entries = [entry('mini', "Xaero's Minimap", ['xaerominimap']), entry('world', "Xaero's World Map", ['xaeroworldmap'])];
    const ok = checkModGraph(entries, { mini: [meta('xaerominimap', '25.2.10', { xaeroworldmap: '<1.38.1' })], world: [meta('xaeroworldmap', '1.39.12', { xaerominimap: '<24.0.1' })] }, []);
    expect(ok.filter((i) => i.message.includes('breaking'))).toEqual([]);
    const bad = checkModGraph(entries, { mini: [meta('xaerominimap', '25.2.10', { xaeroworldmap: '<1.38.1' })], world: [meta('xaeroworldmap', '1.37.0')] }, []);
    expect(bad.find((i) => i.message.includes('breaking'))).toMatchObject({ severity: 'error' });
  });
});
