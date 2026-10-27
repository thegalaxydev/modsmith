import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { CompatibilityCatalog } from '../src/core/catalog';
import { findResourcesDir } from '../src/core/paths';
import { generateFabricProject } from '../src/core/adapters/fabric';
import { generateNeoForgeProject } from '../src/core/adapters/neoforge';
import { generateForgeProject } from '../src/core/adapters/forge';
import { applyMeta, FABRIC_FILES, readMeta, setProperty, TOML_FILES, type Loader, type MetaFiles } from '../src/renderer/modmeta';

const catalog = new CompatibilityCatalog(findResourcesDir(__dirname));

const opts = (catalogEntryId: string) => ({
  projectName: 'Demo Mod',
  destination: 'C:/x',
  modId: 'demo',
  packageName: 'com.example.demo',
  author: 'Alex',
  description: 'A demo.',
  license: 'MIT',
  git: false,
  catalogEntryId,
  environment: 'both' as const,
  starters: ['empty'],
  dependencies: []
});

function files(loader: Loader, entryId: string): MetaFiles {
  const entry = catalog.get(entryId)!;
  const gen = loader === 'fabric' ? generateFabricProject : loader === 'neoforge' ? generateNeoForgeProject : generateForgeProject;
  const out = gen(opts(entryId), entry);
  const find = (paths: string[]) => {
    const f = out.find((g) => paths.includes(g.path));
    return f ? { path: f.path, content: String(f.content), mtime: 1 } : undefined;
  };
  return { props: find(['gradle.properties']), fabric: find(FABRIC_FILES), toml: find(TOML_FILES) };
}

function write(f: MetaFiles, changes: Record<string, string>): MetaFiles {
  const next = { ...f };
  for (const k of ['props', 'fabric', 'toml'] as const) if (next[k] && changes[next[k]!.path] !== undefined) next[k] = { ...next[k]!, content: changes[next[k]!.path] };
  return next;
}

describe('mod metadata', () => {
  it('reads and edits a Fabric project', () => {
    const f = files('fabric', 'fabric-1.21.1');
    const meta = readMeta('fabric', f);
    expect(meta.problems).toEqual([]);
    expect(meta.modId).toBe('demo');
    expect(meta.values).toMatchObject({ name: 'Demo Mod', version: '0.1.0', description: 'A demo.', authors: 'Alex', license: 'MIT', group: 'com.example.demo', homepage: '' });
    expect(meta.locations.version).toEqual({ file: 'gradle.properties', kind: 'property', key: 'version' });
    expect(meta.locations.name).toMatchObject({ kind: 'json', key: 'name' });
    expect(meta.dependencies.map((d) => d.modId)).toContain('fabricloader');
    const deps = [...meta.dependencies.filter((d) => d.modId !== 'fabric-api'), { modId: 'cloth-config', versionRange: '>=15', required: false }];
    const changes = applyMeta('fabric', f, meta, { ...meta.values, version: '1.2.0', name: 'Demo "Mod"', authors: 'Alex, Sam', homepage: 'https://example.com', description: 'Line one\nLine two' }, deps);
    expect(Object.keys(changes).sort()).toEqual(['gradle.properties', 'src/main/resources/fabric.mod.json']);
    expect(changes['gradle.properties']).toContain('\nversion=1.2.0\n');
    const j = JSON.parse(changes['src/main/resources/fabric.mod.json']);
    expect(j).toMatchObject({ name: 'Demo "Mod"', authors: ['Alex', 'Sam'], contact: { homepage: 'https://example.com' }, description: 'Line one\nLine two', version: '${version}', recommends: { 'cloth-config': '>=15' } });
    expect(j.depends['fabric-api']).toBeUndefined();
    expect(Object.keys(j).slice(0, 3)).toEqual(['schemaVersion', 'id', 'version']);
    const again = readMeta('fabric', write(f, changes));
    expect(again.values).toMatchObject({ version: '1.2.0', authors: 'Alex, Sam', homepage: 'https://example.com' });
    expect(again.dependencies.find((d) => d.modId === 'cloth-config')).toEqual({ modId: 'cloth-config', versionRange: '>=15', required: false });
    expect(applyMeta('fabric', f, meta, meta.values, meta.dependencies)).toEqual({});
  });

  for (const [loader, entryId] of [['neoforge', 'neoforge-1.21.1'], ['forge', 'forge-1.20.1']] as const) {
    it(`reads and edits a ${loader} project`, () => {
      const f = files(loader, entryId);
      const meta = readMeta(loader, f);
      expect(meta.problems).toEqual([]);
      expect(meta.modId).toBe('demo');
      expect(meta.values).toMatchObject({ name: 'Demo Mod', version: '0.1.0', description: 'A demo.', authors: 'Alex', license: 'MIT', group: 'com.example.demo' });
      expect(meta.locations.version).toEqual({ file: 'gradle.properties', kind: 'property', key: 'mod_version' });
      expect(meta.locations.description).toMatchObject({ kind: 'toml', key: 'mods.description' });
      expect(meta.dependencies.map((d) => [d.modId, d.required])).toEqual([[loader, true], ['minecraft', true]]);
      const deps = [...meta.dependencies.map((d) => (d.modId === 'minecraft' ? { ...d, versionRange: '[1.21.1,1.22)' } : d)), { modId: 'jei', versionRange: '[19,)', required: false, side: 'CLIENT' }];
      const changes = applyMeta(loader, f, meta, { ...meta.values, version: '2.0.0', description: 'Multi\nline "text"', homepage: 'https://example.com/mod', issues: 'https://example.com/issues' }, deps);
      const toml = changes[f.toml!.path];
      expect(changes['gradle.properties']).toContain('mod_version=2.0.0');
      const parsed = parseToml(toml.replace(/\$\{[a-z_]+\}/g, 'x')) as Record<string, unknown>;
      const mods = (parsed.mods as Record<string, unknown>[])[0];
      expect(mods).toMatchObject({ description: 'Multi\nline "text"', displayURL: 'https://example.com/mod' });
      expect(parsed.issueTrackerURL).toBe('https://example.com/issues');
      const again = readMeta(loader, write(f, changes));
      expect(again.values).toMatchObject({ version: '2.0.0', description: 'Multi\nline "text"', homepage: 'https://example.com/mod', issues: 'https://example.com/issues' });
      expect(again.dependencies).toEqual(deps.map((d) => ({ ...d, side: d.side ?? 'BOTH' })));
      const removed = applyMeta(loader, write(f, changes), again, again.values, again.dependencies.filter((d) => d.modId !== 'jei'));
      expect(readMeta(loader, write(write(f, changes), removed)).dependencies.map((d) => d.modId)).toEqual([loader, 'minecraft']);
      expect(applyMeta(loader, f, meta, meta.values, meta.dependencies)).toEqual({});
    });
  }

  it('keeps line endings and comments in properties', () => {
    expect(setProperty('# c\r\nmod_version = 1.0 \r\nx=y\r\n', 'mod_version', '1.1')).toBe('# c\r\nmod_version = 1.1\r\nx=y\r\n');
    expect(setProperty('a=b\n', 'c', 'd')).toBe('a=b\nc=d\n');
  });
});
