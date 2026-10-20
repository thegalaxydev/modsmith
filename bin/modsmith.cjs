#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const exe = process.platform === 'win32' ? 'modsmith-service.exe' : 'modsmith-service';
const root = path.join(__dirname, '..');
const candidates = [process.env.MODSMITH_SERVICE_BIN, path.join(root, 'target', 'release', exe), path.join(root, 'target', 'debug', exe)];
const bin = candidates.find((c) => c && fs.existsSync(c));
if (!bin) {
  console.error(`${exe} not found; build it with "npm run build:service"`);
  process.exit(1);
}
const r = spawnSync(bin, ['cli', ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
