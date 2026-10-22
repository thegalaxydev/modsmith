import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

if (process.platform !== 'win32') {
  console.error('Modsmith Setup is built on Windows only');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const conf = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const host = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (\S+)$/m)?.[1];
const release = path.join(root, 'target', 'release');
const sources = [
  ['modsmith.exe', path.join(release, 'modsmith.exe')],
  ['modsmith-service.exe', path.join(root, 'src-tauri', 'binaries', `modsmith-service-${host}.exe`)]
];

function addTree(src, dest) {
  for (const name of readdirSync(src)) {
    const full = path.join(src, name);
    const rel = `${dest}${name}`;
    if (statSync(full).isDirectory()) addTree(full, `${rel}/`);
    else sources.push([rel, full]);
  }
}

for (const [from, to] of Object.entries(conf.bundle.resources ?? {})) addTree(path.resolve(root, 'src-tauri', from), to.endsWith('/') ? to : `${to}/`);
for (const [, file] of sources) if (!existsSync(file)) throw new Error(`Missing ${file}. Run "npx tauri build --no-bundle" first.`);

const mtime = new Date('2026-01-01T00:00:00Z');
const entries = Object.fromEntries(sources.sort(([a], [b]) => (a < b ? -1 : 1)).map(([rel, file]) => [rel, [new Uint8Array(readFileSync(file)), { mtime }]]));
const payload = path.join(release, 'setup-payload.zip');
writeFileSync(payload, zipSync(entries, { level: 9 }));
console.log(`payload: ${sources.length} files, ${(statSync(payload).size / 1048576).toFixed(1)} MB`);

execFileSync('cargo', ['build', '-p', 'modsmith-setup', '--release'], { cwd: root, stdio: 'inherit', env: { ...process.env, MODSMITH_SETUP_PAYLOAD: payload, MODSMITH_SETUP_VERSION: version } });

const outDir = path.join(release, 'bundle', 'setup');
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${conf.productName}_${version}_x64-setup.exe`);
copyFileSync(path.join(release, 'modsmith-setup.exe'), out);
const bytes = readFileSync(out);
console.log(`${path.relative(root, out)}  ${(bytes.length / 1048576).toFixed(1)} MB  sha256 ${crypto.createHash('sha256').update(bytes).digest('hex')}`);
