import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateApiJson } from './export-api.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const skipRenderer = process.argv.includes('--no-renderer');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: 'linked',
  logLevel: 'info',
  external: ['koffi', 'node:sqlite'],
  absWorkingDir: root
};

const entries = [
  { in: 'src/service/main.ts', out: 'dist/service/main.cjs' },
  { in: 'src/mcp/main.ts', out: 'dist/mcp/main.cjs' },
  { in: 'src/cli/main.ts', out: 'dist/cli/main.cjs' },
  { in: 'src/worker/main.ts', out: 'dist/worker/main.cjs' }
];

mkdirSync(path.join(root, 'dist'), { recursive: true });
const [apiJson, schemasJson] = await generateApiJson();
for (const [name, text] of [['api.json', apiJson], ['schemas.json', schemasJson]]) {
  const file = path.join(root, 'resources', name);
  if (!existsSync(file) || readFileSync(file, 'utf8') !== text) writeFileSync(file, text);
}
await Promise.all(entries.map((e) => build({ ...common, entryPoints: [e.in], outfile: e.out })));

if (!skipRenderer) {
  execSync('npx vite build', { cwd: root, stdio: 'inherit' });
}
if (watch) {
  console.log('watch mode is not supported by this script; rerun after changes');
}
