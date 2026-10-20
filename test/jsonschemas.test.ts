import { describe, expect, it } from 'vitest';
import { CompatibilityCatalog } from '../src/core/catalog';
import { findResourcesDir } from '../src/core/paths';
import { generateFabricProject } from '../src/core/adapters/fabric';
import { generateNeoForgeProject } from '../src/core/adapters/neoforge';
import { SCHEMAS, jsonService, parse, schemaFor, validateJson } from '../src/renderer/jsonSchemas';
import { EditorState } from '@codemirror/state';
import { jsonIntelligence, toCmSnippet } from '../src/renderer/jsonIntel';

const catalog = new CompatibilityCatalog(findResourcesDir(__dirname));

const opts = {
  projectName: 'My Mod',
  destination: 'C:/x',
  modId: 'mymod',
  packageName: 'com.example.mymod',
  author: 'A',
  description: 'D',
  license: 'MIT',
  git: false,
  environment: 'both' as const,
  dependencies: []
};

describe('JSON schema matching', () => {
  it('maps project files to schemas', () => {
    const label = (f: string) => schemaFor(f)?.label ?? null;
    expect(label('modsmith.json')).toBe('Modsmith project');
    expect(label('profiles/dev-client/profile.json')).toBe('Modsmith profile');
    expect(label('src/main/resources/fabric.mod.json')).toBe('Fabric mod metadata');
    expect(label('src/main/resources/mymod.client.mixins.json')).toBe('Mixin configuration');
    expect(label('src/main/resources/pack.mcmeta')).toBe('Pack metadata');
    expect(label('src/main/resources/assets/mymod/lang/en_us.json')).toBe('Language file');
    expect(label('src\\main\\resources\\assets\\mymod\\lang\\de_de.json')).toBe('Language file');
    expect(label('src/main/resources/data/mymod/recipe/thing.json')).toBe('Recipe');
    expect(label('src/main/generated/data/mymod/recipes/thing.json')).toBe('Recipe');
    expect(label('src/main/resources/data/mymod/loot_table/blocks/x.json')).toBe('Loot table');
    expect(label('src/main/resources/data/minecraft/tags/item/planks.json')).toBe('Tag');
    expect(label('src/main/resources/data/mymod/worldgen/biome/x.json')).toBe('Biome');
    expect(label('src/main/resources/assets/mymod/textures/item/x.png.mcmeta')).toBe('Texture metadata');
    expect(label('src/main/resources/assets/mymod/models/item/x.json')).toBeNull();
    expect(label('package.json')).toBeNull();
  });

  it('marks only schemas that match vanilla data as checked', () => {
    expect(schemaFor('data/x/advancement/a.json')?.checked).toBe(true);
    expect(schemaFor('data/x/recipe/a.json')?.checked).toBe(false);
    expect(schemaFor('data/x/loot_table/a.json')?.checked).toBe(false);
  });

  it('bundles every schema and all of its references', async () => {
    for (const s of SCHEMAS) {
      const diags = await validateJson(sampleFileFor(s.label), '{}');
      const loading = diags.filter((d) => /load|resolve|reference/i.test(String(d.message)));
      expect(loading, `${s.label}: ${loading.map((d) => d.message).join('; ')}`).toEqual([]);
    }
  });
});

function sampleFileFor(label: string): string {
  const samples = [
    'modsmith.json',
    'profiles/p/profile.json',
    'scenarios/s.json',
    'modrinth.index.json',
    'fabric.mod.json',
    'a.mixins.json',
    'pack.mcmeta',
    'assets/x/lang/en_us.json',
    'assets/x/textures/a.png.mcmeta',
    'assets/x/particles/a.json',
    'data/x/advancement/a.json',
    'data/x/recipe/a.json',
    'data/x/loot_table/a.json',
    'data/x/item_modifier/a.json',
    'data/x/predicate/a.json',
    'data/x/tags/item/a.json',
    'data/x/damage_type/a.json',
    'data/x/dimension_type/a.json',
    'data/x/dimension/a.json',
    'data/x/worldgen/biome/a.json',
    'data/x/worldgen/configured_carver/a.json',
    'data/x/worldgen/template_pool/a.json',
    'data/x/trim_material/a.json',
    'data/x/trim_pattern/a.json'
  ];
  const hit = samples.find((f) => schemaFor(f)?.label === label);
  if (!hit) throw new Error(`No sample path for ${label}`);
  return hit;
}

describe('generated projects', () => {
  const cases = [
    ['fabric-1.21.1', () => generateFabricProject({ ...opts, catalogEntryId: 'fabric-1.21.1', starters: ['empty', 'item', 'block', 'command', 'config', 'datagen', 'bridge', 'profiles'] }, catalog.get('fabric-1.21.1')!)],
    ['neoforge-1.21.1', () => generateNeoForgeProject({ ...opts, catalogEntryId: 'neoforge-1.21.1', starters: catalog.get('neoforge-1.21.1')!.starters }, catalog.get('neoforge-1.21.1')!)]
  ] as const;

  for (const [id, generate] of cases) {
    it(`${id} JSON files pass their schemas`, async () => {
      const files = generate();
      let checked = 0;
      for (const f of files) {
        if (!/\.(json|mcmeta)$/.test(f.path) || !schemaFor(f.path)) continue;
        const diags = await validateJson(f.path, f.content.toString());
        expect(diags.map((d) => `${f.path}: ${d.message}`)).toEqual([]);
        checked++;
      }
      expect(checked).toBeGreaterThan(0);
    });
  }
});

describe('editing help', () => {
  it('completes fabric.mod.json properties', async () => {
    const text = '{\n  \n}';
    const { doc, json } = parse('src/main/resources/fabric.mod.json', text);
    const list = await jsonService().doComplete(doc, doc.positionAt(4), json);
    const labels = list?.items.map((i) => i.label) ?? [];
    expect(labels).toEqual(expect.arrayContaining(['schemaVersion', 'id', 'version', 'entrypoints']));
  });

  it('warns about invalid values in checked schemas', async () => {
    const diags = await validateJson('src/main/resources/fabric.mod.json', '{"schemaVersion": 1, "id": "mymod", "version": "1", "environment": "sometimes"}');
    expect(diags.some((d) => /environment|Value is not accepted/i.test(String(d.message)))).toBe(true);
    expect(diags.every((d) => d.severity === 2)).toBe(true);
  });

  it('reports syntax errors as errors', async () => {
    const diags = await validateJson('src/main/resources/fabric.mod.json', '{"id": "x",}');
    expect(diags.some((d) => d.severity === 1)).toBe(true);
  });

  it('gives the editor one stable completion source per file', () => {
    const state = EditorState.create({ doc: '{}', extensions: jsonIntelligence('src/main/resources/fabric.mod.json') });
    const first = state.languageDataAt<unknown>('autocomplete', 1);
    expect(first).toHaveLength(1);
    expect(state.languageDataAt<unknown>('autocomplete', 1)[0]).toBe(first[0]);
  });

  it('converts editor snippets', () => {
    expect(toCmSnippet('"${1:name}": $2')).toBe('"${1:name}": ${2}');
    expect(toCmSnippet('{\n\t"a": ${1}\n}')).toBe('\\{\n\t"a": ${1}\n\\}');
    expect(toCmSnippet('"${1|a,b|}"')).toBe('"${1:a}"');
    expect(toCmSnippet('\\$x')).toBe('$x');
  });
});
