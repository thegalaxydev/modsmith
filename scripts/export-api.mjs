import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'resources', 'api.json');
const schemasOut = path.join(root, 'resources', 'schemas.json');

export async function generateApiJson() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'modsmith-api-'));
  try {
    const file = path.join(tmp, 'api.cjs');
    await build({ entryPoints: [path.join(root, 'scripts', 'api-entry.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: file, logLevel: 'silent', absWorkingDir: root });
    const { API, PRODUCT, ManifestSchema, LockFileSchema, CatalogSchema, PresetSchema, ProfileSchema, ModRefSchema, LinkedPackSchema, LinksFileSchema, MrIndexSchema, IndexSchema, CfManifestSchema, z } = createRequire(import.meta.url)(file);
    const annotate = (ctx) => {
      const def = ctx.zodSchema._zod.def;
      for (const check of def.checks ?? []) {
        const message = typeof check._zod.def.error === 'function' ? check._zod.def.error() : undefined;
        if (typeof message === 'string') ctx.jsonSchema['x-message'] = message;
      }
      if (def.type === 'pipe' && def.out?._zod.def.type === 'transform') ctx.jsonSchema['x-transform'] = def.out._zod.def.transform.name;
      if (def.type === 'default' && !('default' in ctx.jsonSchema)) ctx.jsonSchema.default = JSON.parse(JSON.stringify(def.defaultValue));
    };
    const schema = (s) => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any', override: annotate });
    const methods = {};
    for (const [name, def] of Object.entries(API)) {
      methods[name] = {
        description: def.description,
        mcp: def.mcp,
        mutating: def.mutating,
        longRunning: !!def.longRunning,
        destructive: !!def.destructive,
        untrustedOutput: !!def.untrustedOutput,
        params: schema(def.params)
      };
    }
    const schemas = JSON.stringify({ manifest: schema(ManifestSchema), lock: schema(LockFileSchema), catalog: schema(CatalogSchema), preset: schema(PresetSchema), profile: schema(ProfileSchema), modRef: schema(ModRefSchema), linkedPack: schema(LinkedPackSchema), links: schema(LinksFileSchema), mrIndex: schema(MrIndexSchema), mrpackIndex: schema(IndexSchema), cfManifest: schema(CfManifestSchema) }, null, 2) + '\n';
    return [JSON.stringify({ version: 1, product: { name: PRODUCT.name, version: PRODUCT.version, protocol: PRODUCT.serviceProtocolVersion }, methods }, null, 2) + '\n', schemas];
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [api, schemas] = await generateApiJson();
  for (const [file, text] of [[out, api], [schemasOut, schemas]]) {
    if ((existsSync(file) ? readFileSync(file, 'utf8') : '') !== text) {
      writeFileSync(file, text);
      console.log(`wrote ${path.relative(root, file)}`);
    }
  }
}
