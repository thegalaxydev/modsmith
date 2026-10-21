import { describe, expect, it } from 'vitest';
import { parse } from '../src/renderer/jsonSchemas';
import { contextAt, wantFor } from '../src/renderer/registryComplete';

function want(file: string, text: string) {
  const offset = text.indexOf('|');
  const { json } = parse(file, text.replace('|', ''));
  const found = contextAt(json, offset);
  return found ? wantFor(file, found.context) : null;
}

const RECIPE = 'src/main/resources/data/demo/recipe/crate.json';

describe('registry completion context', () => {
  it('offers items and item tags in recipes', () => {
    expect(want(RECIPE, '{"type":"minecraft:crafting_shaped","key":{"#":{"item":"minecraft:st|"}}}')).toEqual({ registry: 'item', ids: true, tags: false, hash: true });
    expect(want(RECIPE, '{"type":"minecraft:crafting_shaped","key":{"#":"|"}}')).toEqual({ registry: 'item', ids: true, tags: true, hash: true });
    expect(want(RECIPE, '{"ingredients":["|"]}')).toEqual({ registry: 'item', ids: true, tags: true, hash: true });
    expect(want(RECIPE, '{"key":{"X":{"tag":"minecraft:pl|"}}}')).toEqual({ registry: 'item', ids: false, tags: true, hash: false });
    expect(want(RECIPE, '{"result":{"id":"|","count":2}}')).toEqual({ registry: 'item', ids: true, tags: false, hash: false });
    expect(want('data/demo/recipes/old.json', '{"result":"|"}')).toEqual({ registry: 'item', ids: true, tags: false, hash: false });
  });

  it('reads the registry of tag files from their folder', () => {
    expect(want('src/main/resources/data/demo/tags/block/ores.json', '{"values":["|"]}')).toEqual({ registry: 'block', ids: true, tags: true, hash: true });
    expect(want('src/main/resources/data/demo/tags/entity_types/bosses.json', '{"values":[{"id":"|","required":false}]}')).toEqual({ registry: 'entity_type', ids: true, tags: true, hash: true });
    expect(want('src/main/resources/data/demo/tags/item/x.json', '{"replace":false,"values":[],"x":"|"}')).toBeNull();
  });

  it('understands loot entries, blocks and entity predicates', () => {
    const loot = 'data/demo/loot_table/blocks/crate.json';
    expect(want(loot, '{"pools":[{"entries":[{"type":"minecraft:item","name":"|"}]}]}')).toEqual({ registry: 'item', ids: true, tags: false, hash: false });
    expect(want(loot, '{"pools":[{"entries":[{"type":"minecraft:tag","name":"|"}]}]}')).toEqual({ registry: 'item', ids: false, tags: true, hash: false });
    expect(want(loot, '{"conditions":[{"condition":"minecraft:block_state_property","block":"|"}]}')).toEqual({ registry: 'block', ids: true, tags: false, hash: true });
    expect(want('data/demo/advancement/a.json', '{"criteria":{"k":{"conditions":{"entity":{"type":"|"}}}}}')).toEqual({ registry: 'entity_type', ids: true, tags: true, hash: true });
    expect(want('data/demo/structure/s.json', '{"palette":[{"Name":"|"}]}')).toEqual({ registry: 'block', ids: true, tags: false, hash: true });
    expect(want('data/demo/predicate/p.json', '{"predicate":{"location":{"block":{"tag":"|"}}}}')).toEqual({ registry: 'block', ids: false, tags: true, hash: false });
  });

  it('stays out of keys and unrelated values', () => {
    expect(want(RECIPE, '{"it|em":"minecraft:stick"}')).toBeNull();
    expect(want(RECIPE, '{"type":"minecraft:cr|"}')).toBeNull();
    expect(want('src/main/resources/fabric.mod.json', '{"name":"|"}')).toBeNull();
  });
});
