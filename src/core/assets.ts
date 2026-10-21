import fs from 'node:fs';
import path from 'node:path';
import { modernItems, readResource, type Collected, type RegistryIndexService } from './regindex';
import { wantFor, type JsonContext, type Registry } from '../shared/registryRules';

export interface AssetProblem {
  file: string;
  line: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  code: string;
}

const ID = /^([a-z0-9_.-]+:)?[a-z0-9_./-]+$/;
const R = {
  model: /^assets\/([a-z0-9_.-]+)\/models\/([a-z0-9_./-]+)\.json$/,
  blockstate: /^assets\/([a-z0-9_.-]+)\/blockstates\/([a-z0-9_./-]+)\.json$/,
  itemDef: /^assets\/([a-z0-9_.-]+)\/items\/([a-z0-9_./-]+)\.json$/,
  lang: /^assets\/([a-z0-9_.-]+)\/lang\/en_us\.json$/,
  data: /^data\/([a-z0-9_.-]+)\/.+\.json$/
};
const REG_LABEL: Record<Registry, string> = { item: 'item', block: 'block', entity_type: 'entity type', fluid: 'fluid' };

export const normId = (raw: string) => (raw.includes(':') ? raw : `minecraft:${raw}`);
const split = (id: string) => {
  const i = id.indexOf(':');
  return [id.slice(0, i), id.slice(i + 1)] as const;
};
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function lineOf(text: string, needle: string, nth = 0) {
  let i = text.indexOf(needle);
  for (let k = 0; k < nth && i >= 0; k++) i = text.indexOf(needle, i + needle.length);
  if (i < 0) return 1;
  let line = 1;
  for (let k = 0; k < i; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
}

function walkFiles(root: string, dir: string, out: string[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(root, p, out);
    else out.push(path.relative(root, p).replace(/\\/g, '/'));
  }
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);

function blockstateModels(json: Json): string[] {
  const out: string[] = [];
  const take = (v: Json) => {
    for (const x of Array.isArray(v) ? v : [v]) if (isObj(x) && typeof x.model === 'string') out.push(x.model);
  };
  if (isObj(json) && isObj(json.variants)) for (const v of Object.values(json.variants)) take(v);
  if (isObj(json) && Array.isArray(json.multipart)) for (const part of json.multipart) if (isObj(part) && part.apply !== undefined) take(part.apply);
  return out;
}

function nestedModels(json: Json, out: string[] = []): string[] {
  if (Array.isArray(json)) for (const v of json) nestedModels(v, out);
  else if (isObj(json)) {
    for (const [k, v] of Object.entries(json)) {
      if (k === 'model' && typeof v === 'string') out.push(v);
      else nestedModels(v, out);
    }
  }
  return out;
}

function visitStrings(json: Json, ancestors: string[], holder: Record<string, Json> | null, out: (value: string, ctx: JsonContext, holder: Record<string, Json> | null) => void) {
  if (typeof json === 'string') {
    const siblings: Record<string, string> = {};
    if (holder) for (const [k, v] of Object.entries(holder)) if (typeof v === 'string') siblings[k] = v;
    out(json, { key: ancestors[0] ?? null, parentKey: ancestors[1] ?? null, ancestors, firstKey: ancestors[ancestors.length - 1] ?? null, siblings }, holder);
  } else if (Array.isArray(json)) {
    for (const v of json) visitStrings(v, ancestors, holder, out);
  } else if (isObj(json)) {
    for (const [k, v] of Object.entries(json)) visitStrings(v, [k, ...ancestors], json, out);
  }
}

export class AssetService {
  constructor(private registry: RegistryIndexService) {}

  validate(root: string, opts: { file?: string; content?: string } = {}) {
    const c = this.registry.collect(root);
    const dir = c.dir;
    const vanilla = c.vanilla;
    const target = opts.file?.replace(/\\/g, '/');
    const problems: AssetProblem[] = [];
    let checked = 0;
    const files: { rel: string; res: string; abs: string }[] = [];
    for (const r of c.roots) {
      const names: string[] = [];
      for (const top of ['assets', 'data']) walkFiles(r, path.join(r, top), names);
      for (const res of names) files.push({ res, abs: path.join(r, res), rel: path.relative(dir, path.join(r, res)).replace(/\\/g, '/') });
    }
    files.sort((a, b) => byKey(a.rel, b.rel));
    for (const f of files) {
      if (target !== undefined && f.rel !== target) continue;
      if (!f.res.endsWith('.json')) continue;
      let text: string;
      try {
        text = target !== undefined && opts.content !== undefined ? opts.content : fs.readFileSync(f.abs, 'utf8');
      } catch {
        continue;
      }
      text = text.replace(/^﻿/, '');
      checked++;
      const add = (severity: AssetProblem['severity'], code: string, message: string, line = 1) => problems.push({ file: f.rel, line, severity, message, code });
      let json: Json;
      try {
        json = JSON.parse(text) as Json;
      } catch {
        add('error', 'json', 'This file is not valid JSON');
        continue;
      }
      if (!vanilla) continue;
      this.check(c, f.res, text, json, add);
    }
    const seen = new Set<string>();
    const unique = problems.filter((p) => {
      const k = `${p.file}|${p.line}|${p.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    unique.sort((a, b) => byKey(a.file, b.file) || a.line - b.line || byKey(a.message, b.message));
    return { problems: unique, checked, complete: vanilla, pending: c.pending };
  }

  private check(c: Collected, res: string, text: string, json: Json, add: (s: AssetProblem['severity'], code: string, message: string, line?: number) => void) {
    const m = c.merged;
    const modern = modernItems(c);
    const seen = new Map<string, number>();
    const at = (v: string) => {
      const needle = JSON.stringify(v);
      const n = seen.get(needle) ?? 0;
      seen.set(needle, n + 1);
      return lineOf(text, needle, n);
    };
    const named = (kind: string, id: string) => {
      const [ns, p] = split(id);
      return m.lang.has(`${kind}.${ns}.${p}`);
    };
    const nameHint = (kind: string, id: string) => {
      const [ns, p] = split(id);
      return `add ${kind}.${ns}.${p} to assets/${ns}/lang/en_us.json`;
    };
    const checkModel = (raw: string) => {
      if (!ID.test(raw)) return add('error', 'model', `${raw} is not a valid model ID`, at(raw));
      const id = normId(raw);
      if (!m.models.has(id)) add('error', 'model', `Model ${id} does not exist`, at(raw));
    };
    let r: RegExpExecArray | null;
    if ((r = R.model.exec(res))) {
      const [, ns, p] = r;
      if (isObj(json) && typeof json.parent === 'string' && !json.parent.startsWith('builtin/')) {
        const parent = json.parent;
        if (!ID.test(parent)) add('error', 'parent', `${parent} is not a valid model ID`, at(parent));
        else if (!m.models.has(normId(parent))) add('error', 'parent', `Parent model ${normId(parent)} does not exist`, at(parent));
      }
      if (isObj(json) && isObj(json.textures)) {
        for (const v of Object.values(json.textures)) {
          if (typeof v !== 'string' || v.startsWith('#')) continue;
          if (!ID.test(v)) add('error', 'texture', `${v} is not a valid texture ID`, at(v));
          else if (!m.textures.has(normId(v))) add('error', 'texture', `Texture ${normId(v)} does not exist`, at(v));
        }
      }
      if (!modern && p.startsWith('item/')) {
        const id = `${ns}:${p.slice(5)}`;
        if (!named('item', id) && !named('block', id)) add('warning', 'name', `Item ${id} has no English name (${nameHint('item', id)})`);
      }
    } else if ((r = R.blockstate.exec(res))) {
      const id = `${r[1]}:${r[2]}`;
      for (const model of blockstateModels(json)) checkModel(model);
      if (!named('block', id)) add('warning', 'name', `Block ${id} has no English name (${nameHint('block', id)})`);
    } else if ((r = R.itemDef.exec(res))) {
      const id = `${r[1]}:${r[2]}`;
      for (const model of nestedModels(json)) checkModel(model);
      if (!named('item', id) && !named('block', id)) add('warning', 'name', `Item ${id} has no English name (${nameHint('item', id)})`);
    } else if ((r = R.lang.exec(res))) {
      const ns = r[1];
      if (!isObj(json)) return;
      const key = new RegExp(`^item\\.${ns.replace(/[.-]/g, '\\$&')}\\.([a-z0-9_/]+)$`);
      for (const k of Object.keys(json)) {
        const km = key.exec(k);
        if (!km) continue;
        const id = `${ns}:${km[1]}`;
        if (modern ? !m.itemDefs.has(id) : !m.models.has(`${ns}:item/${km[1]}`)) {
          add('warning', 'item-model', modern ? `Item ${id} has a name but no item definition (assets/${ns}/items/${km[1]}.json)` : `Item ${id} has a name but no item model (assets/${ns}/models/item/${km[1]}.json)`, lineOf(text, JSON.stringify(k)));
        }
      }
    } else if (R.data.test(res)) {
      visitStrings(json, [], null, (v, ctx, holder) => {
        if (!v) return;
        const line = at(v);
        const want = wantFor(res, ctx);
        if (!want) return;
        if (holder && holder.required === false) return;
        if (v.startsWith('#') && !want.tags) return add('error', 'tag-not-allowed', `Tags are not allowed here: ${v}`, line);
        const isTag = v.startsWith('#') || (want.tags && !want.ids);
        const raw = v.replace(/^#/, '');
        if (!ID.test(raw)) return add('error', 'id-format', `${v} is not a valid ID`, line);
        const full = normId(raw);
        const [ns] = split(full);
        if (!m.namespaces.has(ns)) return add('info', 'namespace', `No mod provides the namespace ${ns}`, line);
        if (isTag) {
          if (!m.tags.has(`${want.registry}|${full}`)) add('warning', 'tag', `Unknown ${REG_LABEL[want.registry]} tag #${full}`, line);
          return;
        }
        const list = want.registry === 'item' ? m.items : want.registry === 'block' ? m.blocks : want.registry === 'entity_type' ? m.entities : null;
        if (list && !list.has(full)) add('warning', 'id', `Unknown ${REG_LABEL[want.registry]} ${full}`, line);
      });
    }
  }

  model(root: string, model: string) {
    const c = this.registry.collect(root);
    const id = normId(model);
    const chain: string[] = [];
    const missing: string[] = [];
    const textures: Record<string, string> = {};
    let elements: Json = null;
    let display: Json = null;
    let guiLight: string | null = null;
    let generated = false;
    let builtin: string | null = null;
    let cur = id;
    for (let depth = 0; depth < 16; depth++) {
      const plain = cur.replace(/^minecraft:/, '');
      if (plain.startsWith('builtin/')) {
        if (plain === 'builtin/generated') generated = true;
        else builtin = plain;
        break;
      }
      const [ns, p] = split(cur);
      const bytes = readResource(c.sources, `assets/${ns}/models/${p}.json`);
      let json: Json = null;
      try {
        json = bytes ? (JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')) as Json) : null;
      } catch {
        json = null;
      }
      if (!isObj(json)) {
        missing.push(cur);
        break;
      }
      chain.push(cur);
      if (isObj(json.textures)) for (const [k, v] of Object.entries(json.textures)) if (typeof v === 'string' && !(k in textures)) textures[k] = v;
      if (elements === null && Array.isArray(json.elements)) elements = json.elements;
      if (display === null && isObj(json.display) && isObj(json.display.gui)) display = json.display.gui;
      if (guiLight === null && typeof json.gui_light === 'string') guiLight = json.gui_light;
      if (typeof json.parent !== 'string') break;
      const next = json.parent.startsWith('builtin/') ? json.parent : normId(json.parent);
      if (chain.includes(next)) break;
      cur = next;
    }
    const resolved: Record<string, string> = {};
    for (const k of Object.keys(textures).sort(byKey)) {
      let v = textures[k];
      for (let i = 0; i < 8 && v.startsWith('#'); i++) v = textures[v.slice(1)] ?? v;
      if (!v.startsWith('#') && ID.test(v)) resolved[k] = normId(v);
    }
    const images: Record<string, string> = {};
    for (const t of [...new Set(Object.values(resolved))].sort(byKey)) {
      const [ns, p] = split(t);
      const bytes = readResource(c.sources, `assets/${ns}/textures/${p}.png`);
      if (bytes) images[t] = bytes.toString('base64');
      else missing.push(t);
    }
    return { id, chain, generated, builtin, elements, textures: resolved, display, guiLight, images, missing };
  }
}
