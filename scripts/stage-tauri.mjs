import { cpSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'sidecar');
const entries = ['mcp', 'cli', 'worker'];

for (const e of entries) {
  if (!existsSync(path.join(root, 'dist', e, 'main.cjs'))) throw new Error(`dist/${e}/main.cjs is missing; run node scripts/build.mjs first`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const e of entries) {
  mkdirSync(path.join(out, 'dist', e), { recursive: true });
  cpSync(path.join(root, 'dist', e, 'main.cjs'), path.join(out, 'dist', e, 'main.cjs'));
}
cpSync(path.join(root, 'resources'), path.join(out, 'resources'), { recursive: true });

const keep = (src) => statSync(src).isDirectory() || /\.(cjs|js|json|node|txt)$/.test(src) || path.basename(src) === 'LICENSE.txt';
const koffi = path.join(root, 'node_modules', 'koffi');
for (const f of ['package.json', 'index.cjs', 'indirect.cjs', 'LICENSE.txt']) cpSync(path.join(koffi, f), path.join(out, 'node_modules', 'koffi', f));
cpSync(path.join(koffi, 'src', 'koffi'), path.join(out, 'node_modules', 'koffi', 'src', 'koffi'), { recursive: true, filter: keep });

const scope = path.join(root, 'node_modules', '@koromix');
for (const pkg of existsSync(scope) ? readdirSync(scope) : []) {
  if (pkg !== `koffi-${process.platform}-${process.arch}`) continue;
  cpSync(path.join(scope, pkg), path.join(out, 'node_modules', '@koromix', pkg), { recursive: true, filter: (s) => !s.endsWith('.lib') });
}
const nodeLicense = path.join(root, 'src-tauri', 'binaries', 'node.LICENSE.txt');
if (existsSync(nodeLicense)) cpSync(nodeLicense, path.join(out, 'licenses', 'node.LICENSE.txt'));
console.log(`staged service runtime files in ${path.relative(root, out)}`);
