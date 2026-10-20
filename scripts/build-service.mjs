import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = process.argv.includes('--debug') ? 'debug' : 'release';
const host = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (\S+)$/m)?.[1];
if (!host) throw new Error('Could not determine the Rust host target');
execFileSync('cargo', ['build', '-p', 'modsmith-service', ...(profile === 'release' ? ['--release'] : [])], { cwd: root, stdio: 'inherit' });
const ext = process.platform === 'win32' ? '.exe' : '';
const outDir = path.join(root, 'src-tauri', 'binaries');
mkdirSync(outDir, { recursive: true });
copyFileSync(path.join(root, 'target', profile, `modsmith-service${ext}`), path.join(outDir, `modsmith-service-${host}${ext}`));
console.log(`modsmith-service (${profile}) copied to src-tauri/binaries`);
