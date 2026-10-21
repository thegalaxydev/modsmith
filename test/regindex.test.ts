import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { Workbench } from '../src/core/workbench';
import { createService, serviceBinary, type ServiceUnderTest } from './service';
import { tmpDir } from './helpers';

type Index = {
  minecraft: string;
  sources: { label: string; kind: string; items: number; blocks: number; entities: number; tags: number }[];
  items: { id: string; name?: string; source: string }[];
  blocks: { id: string; name?: string; source: string }[];
  entities: { id: string; name?: string; source: string }[];
  tags: Record<string, { id: string; values: string[]; source: string }[]>;
  warnings: string[];
  pending: string | null;
};

const MC = '1.21.1';
const SHA = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12';

const jar = (file: string, entries: Record<string, string>) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)]))));
  return file;
};

const put = (root: string, rel: string, text: string) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

function seedVanilla() {
  const cache = process.env.MODSMITH_CACHE_DIR!;
  jar(path.join(cache, 'minecraft', 'versions', MC, `${MC}.jar`), {
    'assets/minecraft/lang/en_us.json': JSON.stringify({
      'item.minecraft.stick': 'Stick',
      'item.minecraft.potion.effect.water': 'Water Bottle',
      'block.minecraft.oak_log': 'Oak Log',
      'block.minecraft.water': 'Water',
      'entity.minecraft.zombie': 'Zombie',
      'entity.minecraft.villager.armorer': 'Armorer',
      'item.minecraft.scute': 'Scute',
      'entity.minecraft.item_frame': 'Item Frame',
      'entity.minecraft.falling_block_type': 'Falling %s',
      'item.modifiers.any': 'When in any slot'
    }),
    'assets/minecraft/blockstates/oak_log.json': '{}',
    'assets/minecraft/blockstates/water.json': '{}',
    'assets/minecraft/models/item/oak_log.json': '{}',
    'assets/minecraft/models/item/potion.json': '{}',
    'assets/minecraft/models/item/stick.json': '{}',
    'assets/minecraft/blockstates/item_frame.json': '{}',
    'assets/minecraft/models/item/bow_pulling_0.json': '{}',
    'data/minecraft/tags/item/logs.json': JSON.stringify({ values: ['minecraft:oak_log'] }),
    'data/minecraft/tags/block/logs.json': JSON.stringify({ values: ['minecraft:oak_log'] }),
    'data/minecraft/tags/entity_type/undead.json': JSON.stringify({ values: ['minecraft:zombie'] })
  });
}

async function project(svc: { call: (m: string, p: Record<string, unknown>, s: 'ui') => Promise<unknown> }) {
  const dir = tmpDir('mwb-reg-');
  await svc.call('workspace.init', { path: dir, type: 'modpack', name: 'Gadgets', minecraft: MC, loaderVersion: '0.19.5' }, 'ui');
  const res = path.join(dir, 'src', 'main', 'resources');
  put(res, 'assets/gadgets/lang/en_us.json', JSON.stringify({ 'item.gadgets.gizmo': 'Gizmo', 'block.gadgets.crate': 'Crate', 'entity.gadgets.critter': 'Critter', 'item.minecraft.stick': 'Not used' }));
  put(res, 'assets/gadgets/blockstates/crate.json', '{}');
  put(res, 'assets/gadgets/models/item/crate.json', '{}');
  put(res, 'assets/gadgets/models/item/gizmo.json', '{}');
  put(res, 'data/gadgets/tags/item/tools.json', JSON.stringify({ values: ['gadgets:gizmo', '#minecraft:logs'] }));
  put(path.join(dir, 'src', 'main', 'generated'), 'data/minecraft/tags/item/logs.json', JSON.stringify({ values: ['gadgets:crate', 'minecraft:oak_log'] }));
  const downloads = path.join(process.env.MODSMITH_CACHE_DIR!, 'downloads');
  jar(path.join(downloads, 'modrinth', SHA.slice(0, 2), SHA, 'wrench-1.0.jar'), {
    'assets/wrench/lang/en_us.json': JSON.stringify({ 'item.wrench.wrench': 'Wrench' }),
    'assets/wrench/items/wrench.json': '{}',
    'data/c/tags/item/tools/wrench.json': JSON.stringify({ values: [{ id: 'wrench:wrench', required: false }] })
  });
  const entry = { key: 'modrinth:wrench', provider: 'modrinth', title: 'Wrench', fileName: 'wrench-1.0.jar', sha1: SHA, modIds: ['wrench'], reason: 'test', required: true };
  fs.writeFileSync(path.join(dir, 'modsmith.lock.json'), JSON.stringify({ schemaVersion: 1, profiles: { 'dev-client': { resolvedAt: '2026-10-21T00:00:00Z', minecraft: MC, loader: 'fabric', loaderVersion: '0.19.5', entries: [entry], issues: [] } } }));
  const lib = jar(path.join(tmpDir('mwb-lib-'), 'fabric-api-base.jar'), {
    'data/c/tags/items/tools/wrench.json': JSON.stringify({ values: ['minecraft:stick'] }),
    'data/c/tags/blocks/storage_blocks.json': JSON.stringify({ values: [] }),
    'not-json.txt': 'x'
  });
  put(path.join(dir, '.modsmith', 'launch'), 'runClient.json', JSON.stringify({ runs: { runClient: { classpath: [lib, path.join(dir, 'build', 'classes', 'java', 'main'), path.join(dir, 'missing.jar')] } } }));
  return dir;
}

describe('registry index', () => {
  let svc: ServiceUnderTest;
  beforeAll(() => {
    svc = createService();
    seedVanilla();
  });
  afterAll(async () => {
    await svc.stop();
  });

  it('combines vanilla, project, locked mod and classpath registries with names', async () => {
    const dir = await project(svc);
    const r = await svc.call<Index>('registry.index', { path: dir }, 'ui');
    expect(r.minecraft).toBe(MC);
    expect(r.pending).toBeNull();
    expect(r.warnings).toEqual([]);
    expect(r.items).toEqual([
      { id: 'gadgets:crate', name: 'Crate', source: 'Gadgets' },
      { id: 'gadgets:gizmo', name: 'Gizmo', source: 'Gadgets' },
      { id: 'minecraft:oak_log', name: 'Oak Log', source: `Minecraft ${MC}` },
      { id: 'minecraft:potion', source: `Minecraft ${MC}` },
      { id: 'minecraft:stick', name: 'Stick', source: `Minecraft ${MC}` },
      { id: 'wrench:wrench', name: 'Wrench', source: 'wrench-1.0' }
    ]);
    expect(r.blocks.map((b) => [b.id, b.name])).toEqual([
      ['gadgets:crate', 'Crate'],
      ['minecraft:oak_log', 'Oak Log'],
      ['minecraft:water', 'Water']
    ]);
    expect(r.entities).toEqual([
      { id: 'gadgets:critter', name: 'Critter', source: 'Gadgets' },
      { id: 'minecraft:item_frame', name: 'Item Frame', source: `Minecraft ${MC}` },
      { id: 'minecraft:zombie', name: 'Zombie', source: `Minecraft ${MC}` }
    ]);
    expect(r.tags.item).toEqual([
      { id: 'c:tools/wrench', values: ['wrench:wrench', 'minecraft:stick'], source: 'wrench-1.0' },
      { id: 'gadgets:tools', values: ['gadgets:gizmo', '#minecraft:logs'], source: 'Gadgets' },
      { id: 'minecraft:logs', values: ['minecraft:oak_log', 'gadgets:crate'], source: `Minecraft ${MC}` }
    ]);
    expect(r.tags.block.map((t) => t.id)).toEqual(['c:storage_blocks', 'minecraft:logs']);
    expect(r.tags.entity_type.map((t) => t.id)).toEqual(['minecraft:undead']);
    expect(r.sources.map((s) => [s.label, s.kind])).toEqual([
      [`Minecraft ${MC}`, 'vanilla'],
      ['Gadgets', 'project'],
      ['wrench-1.0', 'mod'],
      ['fabric-api-base', 'library']
    ]);
  });

  it('explains a missing or invalid manifest', async () => {
    const empty = tmpDir('mwb-reg-');
    await expect(svc.call('registry.index', { path: empty }, 'ui')).rejects.toThrow(`No modsmith.json in ${empty}`);
  });
});

describe.runIf(!!serviceBinary)('Rust service matches the Node service for the registry index', () => {
  let node: Workbench;
  let rust: ServiceUnderTest;
  beforeAll(() => {
    node = new Workbench();
    rust = createService();
    seedVanilla();
  });
  afterAll(async () => {
    await node.stop(false);
    await rust.stop();
  });

  it('builds the same index', async () => {
    const dir = await project({ call: (m, p, s) => node.call(m, p, s) });
    const r = await rust.call('registry.index', { path: dir }, 'ui');
    const n = JSON.parse(JSON.stringify(await node.call('registry.index', { path: dir }, 'ui')));
    expect(r).toEqual(n);
    const bad = path.join(tmpDir('mwb-reg-'), 'nothing');
    const err = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e.message);
    expect(await err(rust.call('registry.index', { path: bad }, 'ui'))).toBe(await err(node.call('registry.index', { path: bad }, 'ui')));
  });
});
