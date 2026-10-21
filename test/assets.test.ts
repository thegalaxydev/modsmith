import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { Workbench } from '../src/core/workbench';
import { createService, serviceBinary, type ServiceUnderTest } from './service';
import { tmpDir } from './helpers';

const MC = '1.21.1';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const png = () => Buffer.from(PNG, 'base64');

type Problem = { file: string; line: number; severity: string; message: string; code: string };

function seedVanilla() {
  const file = path.join(process.env.MODSMITH_CACHE_DIR!, 'minecraft', 'versions', MC, `${MC}.jar`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entries: Record<string, Uint8Array> = {
    'assets/minecraft/lang/en_us.json': strToU8(JSON.stringify({ 'item.minecraft.stick': 'Stick', 'block.minecraft.stone': 'Stone', 'block.minecraft.oak_log': 'Oak Log' })),
    'assets/minecraft/blockstates/stone.json': strToU8('{"variants":{"":{"model":"minecraft:block/stone"}}}'),
    'assets/minecraft/blockstates/oak_log.json': strToU8('{"variants":{"":{"model":"minecraft:block/oak_log"}}}'),
    'assets/minecraft/models/block/block.json': strToU8(JSON.stringify({ gui_light: 'side', display: { gui: { rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625] } } })),
    'assets/minecraft/models/block/cube_all.json': strToU8(JSON.stringify({ parent: 'block/block', textures: { particle: '#all' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#all' }, north: { texture: '#all' } } }] })),
    'assets/minecraft/models/block/stone.json': strToU8(JSON.stringify({ parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/stone' } })),
    'assets/minecraft/models/block/oak_log.json': strToU8(JSON.stringify({ parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/oak_log' } })),
    'assets/minecraft/models/item/generated.json': strToU8(JSON.stringify({ parent: 'builtin/generated', gui_light: 'front' })),
    'assets/minecraft/models/item/stick.json': strToU8(JSON.stringify({ parent: 'minecraft:item/generated', textures: { layer0: 'minecraft:item/stick' } })),
    'assets/minecraft/models/item/oak_log.json': strToU8(JSON.stringify({ parent: 'minecraft:block/oak_log' })),
    'assets/minecraft/textures/block/stone.png': png(),
    'assets/minecraft/textures/block/oak_log.png': png(),
    'assets/minecraft/textures/item/stick.png': png(),
    'data/minecraft/tags/item/logs.json': strToU8('{"values":["minecraft:oak_log"]}')
  };
  fs.writeFileSync(file, zipSync(entries));
}

const put = (root: string, rel: string, text: string | Buffer) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

async function project(call: (m: string, p: Record<string, unknown>) => Promise<unknown>) {
  const dir = tmpDir('mwb-assets-');
  await call('workspace.init', { path: dir, type: 'modpack', name: 'Demo', minecraft: MC, loaderVersion: '0.19.5' });
  const r = path.join(dir, 'src', 'main', 'resources');
  put(r, 'assets/demo/lang/en_us.json', JSON.stringify({ 'block.demo.crate': 'Crate', 'item.demo.gizmo': 'Gizmo', 'item.demo.ghost': 'Ghost' }, null, 2));
  put(r, 'assets/demo/blockstates/crate.json', JSON.stringify({ variants: { '': { model: 'demo:block/crate' }, 'facing=north': [{ model: 'demo:block/missing' }] } }, null, 2));
  put(r, 'assets/demo/blockstates/unnamed.json', JSON.stringify({ multipart: [{ apply: { model: 'minecraft:block/stone' } }] }, null, 2));
  put(r, 'assets/demo/models/block/crate.json', JSON.stringify({ parent: 'minecraft:block/cube_all', textures: { all: 'demo:block/crate' } }, null, 2));
  put(r, 'assets/demo/models/block/broken.json', JSON.stringify({ parent: 'block/nope', textures: { all: 'demo:block/none', side: '#all', bad: 'Not Valid' } }, null, 2));
  put(r, 'assets/demo/models/item/gizmo.json', JSON.stringify({ parent: 'item/generated', textures: { layer0: 'demo:item/gizmo' } }, null, 2));
  put(r, 'assets/demo/models/item/nameless.json', JSON.stringify({ parent: 'item/generated', textures: { layer0: 'minecraft:item/stick' } }, null, 2));
  put(r, 'assets/demo/textures/block/crate.png', png());
  put(r, 'assets/demo/textures/item/gizmo.png', png());
  put(
    r,
    'data/demo/recipe/crate.json',
    JSON.stringify(
      {
        type: 'minecraft:crafting_shaped',
        key: { '#': 'minecraft:stick', X: '#minecraft:logs', Y: 'minecraft:stik', Z: '#minecraft:nope', Q: 'Bad Id', W: 'other:thing' },
        result: { id: 'demo:gizmo', count: 1 },
        extra: { item: '#minecraft:logs' }
      },
      null,
      2
    )
  );
  put(r, 'data/demo/tags/item/things.json', JSON.stringify({ values: ['demo:gizmo', { id: 'maybe:x', required: false }, 'demo:ghost2'] }, null, 2));
  put(r, 'data/demo/loot_table/blocks/bad.json', '{ "pools": [');
  return dir;
}

const R = 'src/main/resources/';

describe('asset validation', () => {
  let svc: ServiceUnderTest;
  beforeAll(() => {
    svc = createService();
    seedVanilla();
  });
  afterAll(async () => {
    await svc.stop();
  });
  const call = (m: string, p: Record<string, unknown>) => svc.call(m, p, 'ui');

  it('reports broken references, missing names and unknown IDs with their lines', async () => {
    const dir = await project(call);
    const r = (await call('assets.validate', { path: dir })) as { problems: Problem[]; checked: number; complete: boolean; pending: string | null };
    expect(r.complete).toBe(true);
    expect(r.checked).toBe(10);
    expect(r.problems.map((p) => [p.file.replace(R, ''), p.line, p.severity, p.code, p.message])).toEqual([
      ['assets/demo/blockstates/crate.json', 8, 'error', 'model', 'Model demo:block/missing does not exist'],
      ['assets/demo/blockstates/unnamed.json', 1, 'warning', 'name', 'Block demo:unnamed has no English name (add block.demo.unnamed to assets/demo/lang/en_us.json)'],
      ['assets/demo/lang/en_us.json', 4, 'warning', 'item-model', 'Item demo:ghost has a name but no item model (assets/demo/models/item/ghost.json)'],
      ['assets/demo/models/block/broken.json', 2, 'error', 'parent', 'Parent model minecraft:block/nope does not exist'],
      ['assets/demo/models/block/broken.json', 4, 'error', 'texture', 'Texture demo:block/none does not exist'],
      ['assets/demo/models/block/broken.json', 6, 'error', 'texture', 'Not Valid is not a valid texture ID'],
      ['assets/demo/models/item/nameless.json', 1, 'warning', 'name', 'Item demo:nameless has no English name (add item.demo.nameless to assets/demo/lang/en_us.json)'],
      ['data/demo/loot_table/blocks/bad.json', 1, 'error', 'json', 'This file is not valid JSON'],
      ['data/demo/recipe/crate.json', 6, 'warning', 'id', 'Unknown item minecraft:stik'],
      ['data/demo/recipe/crate.json', 7, 'warning', 'tag', 'Unknown item tag #minecraft:nope'],
      ['data/demo/recipe/crate.json', 8, 'error', 'id-format', 'Bad Id is not a valid ID'],
      ['data/demo/recipe/crate.json', 9, 'info', 'namespace', 'No mod provides the namespace other'],
      ['data/demo/recipe/crate.json', 16, 'error', 'tag-not-allowed', 'Tags are not allowed here: #minecraft:logs'],
      ['data/demo/tags/item/things.json', 8, 'warning', 'id', 'Unknown item demo:ghost2']
    ]);
  });

  it('checks a single file with unsaved content', async () => {
    const dir = await project(call);
    const file = `${R}assets/demo/models/block/crate.json`;
    const ok = (await call('assets.validate', { path: dir, file })) as { problems: Problem[]; checked: number };
    expect(ok).toMatchObject({ problems: [], checked: 1 });
    const edited = (await call('assets.validate', { path: dir, file, content: '{\n  "parent": "minecraft:block/cube_all",\n  "textures": { "all": "demo:block/crates" }\n}' })) as { problems: Problem[] };
    expect(edited.problems).toEqual([{ file, line: 3, severity: 'error', code: 'texture', message: 'Texture demo:block/crates does not exist' }]);
  });

  it('resolves models through their parents with texture data', async () => {
    const dir = await project(call);
    const block = (await call('assets.model', { path: dir, model: 'demo:block/crate' })) as Record<string, unknown>;
    expect(block).toMatchObject({
      id: 'demo:block/crate',
      chain: ['demo:block/crate', 'minecraft:block/cube_all', 'minecraft:block/block'],
      generated: false,
      builtin: null,
      textures: { all: 'demo:block/crate', particle: 'demo:block/crate' },
      display: { rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625] },
      guiLight: 'side',
      missing: []
    });
    expect((block.elements as unknown[]).length).toBe(1);
    expect(Object.keys(block.images as object)).toEqual(['demo:block/crate']);
    expect((block.images as Record<string, string>)['demo:block/crate']).toBe(PNG);
    const item = (await call('assets.model', { path: dir, model: 'demo:item/gizmo' })) as Record<string, unknown>;
    expect(item).toMatchObject({ chain: ['demo:item/gizmo', 'minecraft:item/generated'], generated: true, elements: null, textures: { layer0: 'demo:item/gizmo' }, guiLight: 'front', missing: [] });
    const broken = (await call('assets.model', { path: dir, model: 'demo:block/broken' })) as Record<string, unknown>;
    expect(broken).toMatchObject({ chain: ['demo:block/broken'], missing: ['minecraft:block/nope', 'demo:block/none'] });
  });
});

describe.runIf(!!serviceBinary)('Rust service matches the Node service for assets', () => {
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
  const outcome = (p: Promise<unknown>) =>
    p.then(
      (ok) => ({ ok: JSON.parse(JSON.stringify(ok ?? null)) }),
      (e: Error) => ({ err: e.message })
    );

  it('validates and resolves models the same way', async () => {
    const dir = await project((m, p) => node.call(m, p, 'ui'));
    const cases: [string, Record<string, unknown>][] = [
      ['assets.validate', { path: dir }],
      ['assets.validate', { path: dir, file: `${R}data/demo/recipe/crate.json`, content: '{"key":{"a":"minecraft:stik"}}' }],
      ['assets.model', { path: dir, model: 'demo:block/crate' }],
      ['assets.model', { path: dir, model: 'demo:item/gizmo' }],
      ['assets.model', { path: dir, model: 'demo:block/broken' }],
      ['assets.model', { path: dir, model: 'stone' }],
      ['assets.validate', { path: path.join(dir, 'nowhere') }]
    ];
    for (const [method, params] of cases) {
      const r = await outcome(rust.call(method, params, 'ui'));
      const n = await outcome(node.call(method, params, 'ui'));
      expect(r, `${method} ${JSON.stringify(params)}`).toEqual(n);
    }
  });
});
