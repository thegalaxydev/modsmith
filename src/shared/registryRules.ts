export type Registry = 'item' | 'block' | 'entity_type' | 'fluid';

export interface Want {
  registry: Registry;
  ids: boolean;
  tags: boolean;
  hash: boolean;
}

export interface JsonContext {
  key: string | null;
  parentKey: string | null;
  ancestors: string[];
  firstKey: string | null;
  siblings: Record<string, string>;
}

const ITEM_KEYS = new Set(['item', 'items', 'ingredient', 'ingredients', 'base', 'addition', 'template', 'input', 'icon']);
const ENTITY_PARENTS = new Set(['entity', 'this', 'killer', 'killer_entity', 'direct_killer_entity', 'direct_entity', 'source_entity', 'vehicle', 'passenger', 'targeted_entity', 'projectile']);
const TAG_DIRS: Record<string, Registry> = { item: 'item', items: 'item', block: 'block', blocks: 'block', entity_type: 'entity_type', entity_types: 'entity_type', fluid: 'fluid', fluids: 'fluid' };

const isType = (v: string | undefined, name: string) => v === name || v === `minecraft:${name}`;

export function wantFor(file: string, c: JsonContext): Want | null {
  const f = file.replace(/\\/g, '/');
  const tagFile = /(?:^|\/)data\/[^/]+\/tags\/(item|items|block|blocks|entity_type|entity_types|fluid|fluids)\//.exec(f);
  if (tagFile && c.firstKey === 'values') return { registry: TAG_DIRS[tagFile[1]], ids: true, tags: true, hash: true };
  const recipe = /(?:^|\/)data\/[^/]+\/recipes?\//.test(f);
  const k = c.key;
  if (!k) return null;
  const has = (...names: string[]) => c.ancestors.some((a) => names.includes(a));
  if (k === 'tag') {
    const registry: Registry = has('block', 'blocks', 'location', 'block_state') ? 'block' : has(...ENTITY_PARENTS, 'entity_type') ? 'entity_type' : has('fluid', 'fluids') ? 'fluid' : 'item';
    return { registry, ids: false, tags: true, hash: false };
  }
  if (k === 'name' && isType(c.siblings.type, 'item')) return { registry: 'item', ids: true, tags: false, hash: false };
  if (k === 'name' && isType(c.siblings.type, 'tag')) return { registry: 'item', ids: false, tags: true, hash: false };
  if (k === 'type' && c.parentKey && ENTITY_PARENTS.has(c.parentKey)) return { registry: 'entity_type', ids: true, tags: true, hash: true };
  if (k === 'block' || k === 'blocks' || k === 'Name') return { registry: 'block', ids: true, tags: k === 'blocks', hash: true };
  if (k === 'entity_type' || k === 'entity_types') return { registry: 'entity_type', ids: true, tags: true, hash: true };
  if (k === 'fluid' || k === 'fluids') return { registry: 'fluid', ids: false, tags: true, hash: true };
  if (k === 'result' || (k === 'id' && (c.parentKey === 'result' || c.parentKey === 'icon'))) return { registry: 'item', ids: true, tags: false, hash: false };
  if (ITEM_KEYS.has(k) || (recipe && c.parentKey === 'key')) return { registry: 'item', ids: true, tags: k !== 'icon' && k !== 'item', hash: true };
  return null;
}
