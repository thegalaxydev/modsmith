import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { API } from '../src/shared/api';
import { serviceBinary } from './service';
import { generateApiJson } from '../scripts/export-api.mjs';

type Schema = Record<string, unknown>;
const apiJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'api.json'), 'utf8')) as { methods: Record<string, { params: Schema }> };

function sample(s: Schema): unknown {
  if (Array.isArray(s.anyOf)) return sample((s.anyOf as Schema[]).find((b) => b.type !== 'null')!);
  if (Array.isArray(s.enum)) return s.enum[s.enum.length - 1];
  const type = Array.isArray(s.type) ? (s.type as string[]).find((t) => t !== 'null') : s.type;
  switch (type) {
    case 'string':
      return s.pattern ? 'abc' : 'x'.repeat(Math.max(1, Number(s.minLength ?? 1)));
    case 'integer':
    case 'number':
      return Math.max(Number(s.minimum ?? 1), 1);
    case 'boolean':
      return true;
    case 'array':
      return [sample(s.items as Schema)];
    case 'object': {
      if (s.propertyNames) return { k: 1 };
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries((s.properties ?? {}) as Record<string, Schema>)) out[k] = sample(v);
      return out;
    }
    default:
      return { anything: true };
  }
}

function cases(method: string): unknown[] {
  const schema = apiJson.methods[method].params;
  const valid = sample(schema) as Record<string, unknown>;
  const out: unknown[] = [{}, null, valid, { ...valid, unexpected: 1 }, 5, [1]];
  const props = (schema.properties ?? {}) as Record<string, Schema>;
  for (const key of Object.keys(props)) {
    const without = { ...valid };
    delete without[key];
    out.push(without);
    for (const bad of [null, 7, 'str', true, [], {}, '', -1, 1.5, 1e12, 'NOT-matching!']) out.push({ ...valid, [key]: bad });
    const nested = props[key];
    if (nested.type === 'object' && nested.properties) {
      for (const inner of Object.keys(nested.properties as object)) out.push({ ...valid, [key]: { ...(valid[key] as object), [inner]: 42 } });
    }
    if (nested.type === 'array') out.push({ ...valid, [key]: [42, null] });
  }
  return out;
}

function zodResult(method: string, params: unknown) {
  const def = (API as Record<string, { params: { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { issues: { path: PropertyKey[]; message: string }[] } } } }>)[method];
  const r = def.params.safeParse(params ?? {});
  if (r.success) return { ok: true, params: r.data };
  return { ok: false, error: `Invalid parameters for ${method}: ${r.error!.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
}

describe('resources/api.json', () => {
  it('matches the method table in src/shared/api.ts and the manifest schemas', async () => {
    const [api, schemas] = await generateApiJson();
    expect(fs.readFileSync(path.join(__dirname, '..', 'resources', 'api.json'), 'utf8')).toBe(api);
    expect(fs.readFileSync(path.join(__dirname, '..', 'resources', 'schemas.json'), 'utf8')).toBe(schemas);
  });
});

describe.runIf(!!serviceBinary)('Rust parameter validation matches zod', () => {
  it('agrees on every method for generated valid and invalid parameters', async () => {
    const child = spawn(serviceBinary!, ['validate'], { stdio: ['pipe', 'pipe', 'inherit'] });
    const lines = readline.createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
    const mismatches: string[] = [];
    let total = 0;
    for (const method of Object.keys(API)) {
      for (const params of cases(method)) {
        child.stdin!.write(JSON.stringify({ method, params }) + '\n');
        const rust = JSON.parse((await lines.next()).value as string);
        const zod = JSON.parse(JSON.stringify(zodResult(method, params)));
        total++;
        try {
          expect(rust).toEqual(zod);
        } catch {
          mismatches.push(`${method} ${JSON.stringify(params)}\n  rust: ${JSON.stringify(rust)}\n  zod:  ${JSON.stringify(zod)}`);
        }
      }
    }
    child.stdin!.end();
    expect(total).toBeGreaterThan(1000);
    expect(mismatches.slice(0, 15).join('\n')).toBe('');
  }, 120000);
});

describe.runIf(!!serviceBinary)('Rust manifest, lock and catalog validation matches zod', () => {
  it('agrees on generated manifests, lock files and catalogs', async () => {
    const { ManifestSchema, LockFileSchema, validateManifest } = await import('../src/core/manifest');
    const { CatalogSchema } = await import('../src/core/catalog');
    const base = ManifestSchema.parse({
      schemaVersion: 1,
      name: 'Demo',
      type: 'mod',
      modId: 'demo',
      icon: 'icon.png',
      platform: { loader: 'fabric', minecraft: '1.21.1', loaderVersion: '0.19.5', catalogEntry: 'fabric-1.21.1' },
      dependencies: [
        { source: 'modrinth', projectId: 'P', versionId: 'V', enabled: false },
        { source: 'curseforge', projectId: 1, fileId: '2' },
        { source: 'local', path: 'libs/a.jar' },
        { source: 'maven', coordinates: 'a:b:1', repository: 'https://repo.example/maven' }
      ],
      profiles: [{ id: 'dev-client', name: 'Client', side: 'client', java: { home: 'C:/jdk', minMajor: 21 }, world: { name: 'w' }, imports: [{ name: 'Pack', provider: 'modrinth', importedAt: 'now' }] }]
    });
    const lock = { schemaVersion: 1, profiles: { p: { resolvedAt: 'x', minecraft: '1.21.1', loader: 'fabric', loaderVersion: '0.19.5', entries: [{ key: 'k', provider: 'modrinth', title: 't', fileName: 'f.jar', reason: 'r', required: true, environment: { client: 'required', server: 'optional' } }], issues: [{ severity: 'info', message: 'm' }] } } };
    const fullCatalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'catalog', 'compatibility.json'), 'utf8'));
    const catalog = { ...fullCatalog, entries: fullCatalog.entries.filter((e: { id: string }) => ['fabric-1.21.1', 'fabric-1.16.5', 'neoforge-1.21.1'].includes(e.id)) };
    const bad: unknown[] = [null, 7, 'str', true, [], {}, '', -1, 1.5, 'NOT valid!', 'https://x.y'];
    function* variants(value: unknown, depth = 0): Generator<unknown> {
      yield value;
      if (depth > 5 || !value || typeof value !== 'object') return;
      const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
      for (const [k, v] of entries) {
        const clone = (x: unknown) => (Array.isArray(value) ? Object.assign([...value], { [Number(k)]: x }) : { ...(value as object), [k]: x });
        if (!Array.isArray(value)) {
          const without = { ...(value as Record<string, unknown>) };
          delete without[k];
          yield without;
        }
        for (const b of bad) yield clone(b);
        for (const inner of variants(v, depth + 1)) if (inner !== v) yield clone(inner);
      }
    }
    const child = spawn(serviceBinary!, ['validate'], { stdio: ['pipe', 'pipe', 'inherit'] });
    const lines = readline.createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
    const issues = (r: { success: boolean; data?: unknown; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
      r.success ? { ok: true, value: r.data } : { ok: false, errors: r.error!.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
    const mismatches: string[] = [];
    let total = 0;
    const check = async (schema: string, value: unknown, expected: unknown) => {
      child.stdin!.write(JSON.stringify({ schema, value }) + '\n');
      const rust = JSON.parse((await lines.next()).value as string);
      total++;
      try {
        expect(rust).toEqual(JSON.parse(JSON.stringify(expected)));
      } catch {
        mismatches.push(`${schema} ${JSON.stringify(value)}\n  rust: ${JSON.stringify(rust)}\n  zod:  ${JSON.stringify(expected)}`);
      }
    };
    for (const v of variants(base)) {
      const r = validateManifest(v);
      await check('manifest', v, r.manifest ? { ok: true, value: r.manifest } : { ok: false, errors: r.errors });
    }
    for (const v of variants(lock)) await check('lock', v, issues(LockFileSchema.safeParse(v)));
    for (const v of variants(catalog, 3)) await check('catalog', v, issues(CatalogSchema.safeParse(v)));
    child.stdin!.end();
    if (process.env.MISMATCH_FILE) fs.writeFileSync(process.env.MISMATCH_FILE, mismatches.join('\n'));
    expect(total).toBeGreaterThan(1500);
    expect(mismatches.slice(0, 12).join('\n')).toBe('');
  }, 300000);
});
