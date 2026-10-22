import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const linux = path.join(root, 'src-tauri', 'linux');
const out = path.join(linux, 'generated');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const repo = 'https://github.com/thegalaxydev/modsmith';

function git(args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

const parts = (v) => v.split('.').map(Number);
const newer = (a, b) => {
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
  return 0;
};

const tagged = new Map();
for (const line of git(['tag', '-l', 'v*', '--format=%(refname:short) %(creatordate:short)']).split('\n')) {
  const m = /^v(\d+\.\d+\.\d+) (\d{4}-\d{2}-\d{2})$/.exec(line.trim());
  if (m) tagged.set(m[1], m[2]);
}
if (!tagged.has(version)) {
  const date = git(['log', '-1', '--format=%cs']) || new Date().toISOString().slice(0, 10);
  tagged.set(version, date);
}
const releases = [...tagged.entries()]
  .filter(([v]) => newer(v, version) >= 0)
  .sort((a, b) => newer(a[0], b[0]))
  .map(([v, date]) => `    <release version="${v}" date="${date}">\n      <url type="details">${repo}/releases/tag/v${v}</url>\n    </release>`)
  .join('\n');

fs.mkdirSync(out, { recursive: true });
const template = fs.readFileSync(path.join(linux, 'dev.modsmith.workbench.metainfo.xml.in'), 'utf8');
fs.writeFileSync(path.join(out, 'dev.modsmith.workbench.metainfo.xml'), template.replace('@@RELEASES@@', releases));

const license = fs
  .readFileSync(path.join(root, 'LICENSE'), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\s+$/, '')
  .split('\n')
  .map((l) => (l.trim() ? ` ${l}` : ' .'))
  .join('\n');
const copyright = `Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: Modsmith
Upstream-Contact: Galaxy Development LLC <support@thegalaxy.dev>
Source: ${repo}

Files: *
Copyright: 2026 thegalaxydev
License: Apache-2.0-with-Commons-Clause-1.0

License: Apache-2.0-with-Commons-Clause-1.0
${license}
`;
fs.writeFileSync(path.join(out, 'copyright'), copyright);
console.log(`Linux metadata for ${version}: ${tagged.size} release${tagged.size === 1 ? '' : 's'} -> ${path.relative(root, out)}`);
