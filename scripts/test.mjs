import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.includes('--node-only') ? 'node' : args.includes('--rust-only') ? 'rust' : null;
const passthrough = args.filter((a) => !a.startsWith('--node-only') && !a.startsWith('--rust-only'));
const shell = process.platform === 'win32';

function run(label, cmd, cmdArgs, env = {}) {
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env }, shell });
  if (r.status !== 0) {
    console.error(`${label} failed`);
    process.exit(r.status ?? 1);
  }
}

run('build TypeScript bundles', 'node', ['scripts/build.mjs', '--no-renderer']);
if (only !== 'rust') run('tests against the in-process Workbench', 'npx', ['vitest', 'run', ...passthrough]);
if (only !== 'node') {
  run('build Rust service', 'cargo', ['build', '-p', 'modsmith-service']);
  run('Rust unit tests', 'cargo', ['test', '-p', 'modsmith-service', '--quiet']);
  const bin = path.join(root, 'target', 'debug', process.platform === 'win32' ? 'modsmith-service.exe' : 'modsmith-service');
  run('tests against the Rust service', 'npx', ['vitest', 'run', ...passthrough], { MODSMITH_TEST_SERVICE: bin });
}
