import { hoverTooltip, type Tooltip } from '@codemirror/view';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { ASTNode, JSONDocument } from 'vscode-json-languageservice';
import { store, waitForOperation } from './store';
import { parse } from './jsonSchemas';
import type { InstanceInfo } from '../shared/types';

export type Registry = 'item' | 'block' | 'entity_type' | 'fluid';

interface Entry {
  id: string;
  name?: string;
  source: string;
}
interface Tag {
  id: string;
  values: string[];
  source: string;
}
export interface RegistryIndex {
  minecraft: string;
  items: Entry[];
  blocks: Entry[];
  entities: Entry[];
  tags: Record<string, Tag[]>;
  warnings: string[];
  pending: string | null;
}

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

function keyOf(node: ASTNode | undefined): string | null {
  return node?.type === 'property' ? node.keyNode.value : null;
}

export function contextAt(json: JSONDocument, offset: number): { node: ASTNode; context: JsonContext } | null {
  const node = json.getNodeFromOffset(offset, true);
  if (!node || node.type !== 'string') return null;
  const parent = node.parent;
  if (parent?.type === 'property' && parent.keyNode === node) return null;
  const ancestors: string[] = [];
  let p: ASTNode | undefined = parent;
  while (p) {
    const k = keyOf(p);
    if (k !== null) ancestors.push(k);
    p = p.parent;
  }
  const holder = parent?.type === 'property' ? parent.parent : parent?.type === 'array' ? parent.parent?.parent : undefined;
  const siblings: Record<string, string> = {};
  if (holder?.type === 'object') {
    for (const prop of holder.properties) if (prop.valueNode?.type === 'string') siblings[prop.keyNode.value] = prop.valueNode.value;
  }
  return { node, context: { key: ancestors[0] ?? null, parentKey: ancestors[1] ?? null, ancestors, firstKey: ancestors[ancestors.length - 1] ?? null, siblings } };
}

let cached: { workspace: string; version: number; at: number; promise: Promise<RegistryIndex> } | null = null;

export function invalidateRegistryIndex() {
  cached = null;
}

export function registryIndex(workspace: string): Promise<RegistryIndex> {
  const version = store.state.fileVersion;
  if (cached && cached.workspace === workspace && cached.version === version && Date.now() - cached.at < 120000) return cached.promise;
  const promise = store.call<RegistryIndex>('registry.index', { path: workspace }, { quiet: true });
  cached = { workspace, version, at: Date.now(), promise };
  promise.then(
    (r) => {
      if (r.pending) {
        void waitForOperation(r.pending).then(() => {
          if (cached?.promise === promise) cached = null;
        });
      }
    },
    () => {
      if (cached?.promise === promise) cached = null;
    }
  );
  return promise;
}

const live = new Map<string, Promise<{ id: string; name?: string }[]>>();

function liveInstance(workspace: string): InstanceInfo | undefined {
  return store.state.instances.find((i) => i.workspace === workspace && i.bridge.connected && ['running', 'starting'].includes(i.status));
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

function liveEntries(inst: InstanceInfo, registry: Registry, query: string, tags: boolean): Promise<{ id: string; name?: string }[]> {
  const key = `${inst.id}|${tags ? 'tag' : 'id'}|${registry}|${query}`;
  let p = live.get(key);
  if (!p) {
    p = tags
      ? store.call<{ tags: { tag: string }[] }>('world.tags', { id: inst.id, registry, query, limit: 200 }, { quiet: true }).then((r) => r.tags.map((t) => ({ id: t.tag.replace(/^#/, '') })))
      : store.call<{ entries: { id: string; name?: string }[] }>('registry.search', { id: inst.id, registry, query, limit: 200 }, { quiet: true }).then((r) => r.entries);
    p = p.catch(() => []);
    live.set(key, p);
    setTimeout(() => live.delete(key), 30000);
  }
  return withTimeout(p, 900, []);
}

const listFor = (index: RegistryIndex, registry: Registry): Entry[] => (registry === 'item' ? index.items : registry === 'block' ? index.blocks : registry === 'entity_type' ? index.entities : []);

const REG_LABEL: Record<Registry, string> = { item: 'Item', block: 'Block', entity_type: 'Entity', fluid: 'Fluid' };

export function registryCompletion(file: string) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const ws = store.state.workspace?.path;
    if (!ws) return null;
    const { json } = parse(file, ctx.state.doc.toString());
    const found = contextAt(json, ctx.pos);
    if (!found) return null;
    const want = wantFor(file, found.context);
    if (!want) return null;
    const from = found.node.offset + 1;
    const end = found.node.offset + found.node.length;
    const to = ctx.state.sliceDoc(end - 1, end) === '"' && end - 1 >= ctx.pos ? end - 1 : ctx.pos;
    if (ctx.pos < from) return null;
    const typed = ctx.state.sliceDoc(from, ctx.pos);
    const index = await registryIndex(ws).catch(() => null);
    const options: Completion[] = [];
    const seen = new Set<string>();
    if (want.ids) {
      for (const e of listFor(index ?? ({ items: [], blocks: [], entities: [] } as unknown as RegistryIndex), want.registry)) {
        seen.add(e.id);
        options.push({ label: e.id, detail: e.name, info: `${REG_LABEL[want.registry]} from ${e.source}`, type: 'constant' });
      }
    }
    if (want.tags) {
      for (const t of index?.tags[want.registry] ?? []) {
        const label = want.hash ? `#${t.id}` : t.id;
        seen.add(label);
        const sample = t.values.slice(0, 8).join(', ');
        options.push({ label, detail: `${t.values.length} entr${t.values.length === 1 ? 'y' : 'ies'}`, info: `${REG_LABEL[want.registry]} tag from ${t.source}${sample ? `\n${sample}${t.values.length > 8 ? ', …' : ''}` : ''}`, type: 'class' });
      }
    }
    const inst = liveInstance(ws);
    const query = typed.replace(/^#/, '');
    if (inst && query.length >= 2) {
      const [ids, tags] = await Promise.all([want.ids && want.registry !== 'fluid' ? liveEntries(inst, want.registry, query, false) : Promise.resolve([]), want.tags ? liveEntries(inst, want.registry, query, true) : Promise.resolve([])]);
      for (const e of ids) if (!seen.has(e.id)) (seen.add(e.id), options.push({ label: e.id, detail: e.name, info: `${REG_LABEL[want.registry]} from the running game`, type: 'constant' }));
      for (const t of tags) {
        const label = want.hash ? `#${t.id}` : t.id;
        if (!seen.has(label)) (seen.add(label), options.push({ label, info: `${REG_LABEL[want.registry]} tag from the running game`, type: 'class' }));
      }
    }
    if (!options.length) return null;
    if (typed) for (const o of options) o.boost = 5;
    return { from, to, options, validFor: /^#?[a-z0-9_.-]*:?[a-z0-9_./-]*$/ };
  };
}

export function registryHover(file: string) {
  return hoverTooltip(async (view, pos): Promise<Tooltip | null> => {
    const ws = store.state.workspace?.path;
    if (!ws) return null;
    const { json } = parse(file, view.state.doc.toString());
    const found = contextAt(json, pos);
    if (!found || found.node.type !== 'string') return null;
    const want = wantFor(file, found.context);
    if (!want) return null;
    const raw = found.node.value;
    const index = await registryIndex(ws).catch(() => null);
    if (!index) return null;
    const isTag = raw.startsWith('#') || (want.tags && !want.ids);
    const id = raw.replace(/^#/, '');
    const full = id.includes(':') ? id : `minecraft:${id}`;
    let text: string | null = null;
    if (isTag) {
      const t = (index.tags[want.registry] ?? []).find((x) => x.id === full);
      if (t) text = `${REG_LABEL[want.registry]} tag #${t.id} · ${t.source}\n${t.values.slice(0, 12).join('\n')}${t.values.length > 12 ? `\n… ${t.values.length - 12} more` : ''}`;
    } else {
      const e = listFor(index, want.registry).find((x) => x.id === full);
      if (e) text = `${e.name ? `${e.name} · ` : ''}${REG_LABEL[want.registry]} · ${e.source}`;
    }
    if (!text) return null;
    return {
      pos: found.node.offset + 1,
      end: found.node.offset + found.node.length - 1,
      above: true,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-json-hover';
        dom.textContent = text!;
        return { dom };
      }
    };
  });
}
