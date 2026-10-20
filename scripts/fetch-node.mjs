import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = process.env.MODSMITH_NODE_VERSION ?? '24.22.0';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = {
  'win32-x64': { dist: 'win-x64/node.exe', triple: 'x86_64-pc-windows-msvc', ext: '.exe' },
  'win32-arm64': { dist: 'win-arm64/node.exe', triple: 'aarch64-pc-windows-msvc', ext: '.exe' }
};
const t = targets[`${process.platform}-${process.arch}`];
if (!t) throw new Error(`No bundled Node runtime is configured for ${process.platform}-${process.arch}`);

const outDir = path.join(root, 'src-tauri', 'binaries');
const out = path.join(outDir, `node-${t.triple}${t.ext}`);
const stamp = `${out}.version`;
const license = path.join(outDir, 'node.LICENSE.txt');
if (existsSync(out) && existsSync(license) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === NODE_VERSION) {
  console.log(`Node ${NODE_VERSION} sidecar already present`);
  process.exit(0);
}

const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
const expected = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, name]) => name === t.dist)?.[0];
if (!expected) throw new Error(`SHASUMS256.txt for Node ${NODE_VERSION} has no entry for ${t.dist}`);
const res = await fetch(`${base}/${t.dist}`);
if (!res.ok) throw new Error(`Download of ${base}/${t.dist} failed: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
const actual = createHash('sha256').update(buf).digest('hex');
if (actual !== expected) throw new Error(`Checksum mismatch for ${t.dist}: expected ${expected}, got ${actual}`);
const licenseRes = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${NODE_VERSION}/LICENSE`);
if (!licenseRes.ok) throw new Error(`Download of the Node ${NODE_VERSION} LICENSE failed: HTTP ${licenseRes.status}`);
mkdirSync(outDir, { recursive: true });
writeFileSync(license, await licenseRes.text());
writeFileSync(`${out}.tmp`, buf);
renameSync(`${out}.tmp`, out);
writeFileSync(stamp, NODE_VERSION);
console.log(`Node ${NODE_VERSION} sidecar written to ${path.relative(root, out)} (${(buf.length / 1048576).toFixed(1)} MB, sha256 ok)`);
