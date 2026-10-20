import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (p) => path.join(root, p);

const files = [
  { file: 'package.json', re: /^(\s*"version":\s*")([^"]+)(")/m },
  { file: 'src-tauri/tauri.conf.json', re: /^(\s*"version":\s*")([^"]+)(")/m },
  { file: 'src/shared/product.ts', re: /^(\s*version:\s*')([^']+)(')/m },
  { file: 'src-tauri/Cargo.toml', re: /^(version\s*=\s*")([^"]+)(")/m },
  { file: 'crates/service/Cargo.toml', re: /^(version\s*=\s*")([^"]+)(")/m },
  { file: 'crates/x11win/Cargo.toml', re: /^(version\s*=\s*")([^"]+)(")/m },
  { file: 'crates/service/src/http.rs', re: /(USER_AGENT: &str = "modsmith\/)([^ ]+)( )/ }
];

function current() {
  const found = new Map();
  for (const { file, re } of files) {
    const m = readFileSync(at(file), 'utf8').match(re);
    if (!m) throw new Error(`No version found in ${file}`);
    found.set(`${file} ${re.source.slice(0, 24)}`, m[2]);
  }
  return found;
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'set') {
  const v = String(arg ?? '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error('Usage: node scripts/version.mjs set <major.minor.patch>');
  for (const { file, re } of files) {
    const text = readFileSync(at(file), 'utf8');
    writeFileSync(at(file), text.replace(re, (_m, a, _b, c) => `${a}${v}${c}`));
  }
  console.log(`Version set to ${v}. Rebuild once so Cargo.lock picks it up, commit, then tag v${v}.`);
} else if (cmd === 'check') {
  const want = String(arg ?? '').replace(/^v/, '');
  const bad = [...current()].filter(([, v]) => v !== want);
  if (bad.length) {
    for (const [where, v] of bad) console.error(`${where.split(' ')[0]} has ${v}, expected ${want}`);
    process.exit(1);
  }
  console.log(`All version fields are ${want}`);
} else {
  const versions = new Set(current().values());
  console.log([...versions].join(', '));
  if (versions.size > 1) process.exit(1);
}
