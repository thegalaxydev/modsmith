import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src', 'renderer', 'jsonschemas', 'schemastore');

const roots = [
  'fabric.mod.json',
  'sponge-mixins.json',
  'minecraft-pack-mcmeta.json',
  'minecraft-lang.json',
  'minecraft-texture-mcmeta.json',
  'minecraft-particle.json',
  'minecraft-advancement.json',
  'minecraft-recipe.json',
  'minecraft-loot-table.json',
  'minecraft-item-modifier.json',
  'minecraft-predicate.json',
  'minecraft-tag.json',
  'minecraft-damage-type.json',
  'minecraft-dimension.json',
  'minecraft-dimension-type.json',
  'minecraft-biome.json',
  'minecraft-configured-carver.json',
  'minecraft-template-pool.json',
  'minecraft-trim-material.json',
  'minecraft-trim-pattern.json'
];

const base = 'https://www.schemastore.org/';
const hosts = ['https://www.schemastore.org/', 'https://json.schemastore.org/', 'http://json.schemastore.org/'];

function localName(ref) {
  for (const h of hosts) if (ref.startsWith(h)) return ref.slice(h.length).split('#')[0];
  if (!/^[a-z]+:/i.test(ref) && !ref.startsWith('#')) return ref.split('#')[0];
  return null;
}

function refsIn(value, out) {
  if (Array.isArray(value)) value.forEach((v) => refsIn(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === '$ref' && typeof v === 'string') {
        const name = localName(v);
        if (name) out.add(name);
        else if (!v.startsWith('#')) throw new Error(`Unsupported external $ref ${v}`);
      } else refsIn(v, out);
    }
  }
}

mkdirSync(outDir, { recursive: true });
const done = new Set();
const queue = [...roots];
while (queue.length) {
  const name = queue.shift();
  if (done.has(name)) continue;
  done.add(name);
  const res = await fetch(base + name);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${base + name}`);
  const json = await res.json();
  const refs = new Set();
  refsIn(json, refs);
  for (const r of refs) if (!done.has(r)) queue.push(r);
  writeFileSync(path.join(outDir, name), JSON.stringify(json, null, 2) + '\n');
  console.log(`${name}${refs.size ? ` -> ${[...refs].join(', ')}` : ''}`);
}
console.log(`${done.size} schemas written to ${path.relative(root, outDir)}`);
