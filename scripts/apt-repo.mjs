import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE } from '../site/site.config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_KEY = path.join(root, 'packaging', 'apt', 'modsmith-archive-keyring.asc');
const REPOSITORY = 'thegalaxydev/modsmith';
const SUITE = 'stable';
const COMPONENT = 'main';
const ARCH = 'amd64';
const ICON_SIZES = ['48x48', '64x64', '64x64@2', '128x128', '128x128@2'];

function args(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) if (list[i].startsWith('--')) out[list[i].slice(2)] = list[i + 1] && !list[i + 1].startsWith('--') ? list[++i] : true;
  return out;
}

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { encoding: opts.encoding === null ? null : 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} failed (${r.status}): ${String(r.stderr ?? '').trim()}`);
  return r.stdout;
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const compare = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

async function githubDebs(keep, dest) {
  const headers = { 'User-Agent': 'modsmith-apt-repo', Accept: 'application/vnd.github+json' };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`, { headers });
  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
  const releases = (await res.json())
    .filter((r) => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name))
    .map((r) => ({ version: r.tag_name.slice(1), asset: r.assets.find((a) => a.name.endsWith(`_${ARCH}.deb`)) }))
    .filter((r) => r.asset)
    .sort((a, b) => compare(b.version, a.version))
    .slice(0, keep);
  const out = [];
  for (const r of releases) {
    const file = path.join(dest, `modsmith_${r.version}_${ARCH}.deb`);
    const bytes = Buffer.from(await (await fetch(r.asset.browser_download_url, { headers: { 'User-Agent': 'modsmith-apt-repo' } })).arrayBuffer());
    if (r.asset.digest?.startsWith('sha256:') && crypto.createHash('sha256').update(bytes).digest('hex') !== r.asset.digest.slice(7)) throw new Error(`${r.asset.name} does not match the SHA-256 GitHub recorded for it`);
    if (r.asset.size && bytes.length !== r.asset.size) throw new Error(`${r.asset.name} is ${bytes.length} bytes, expected ${r.asset.size}`);
    fs.writeFileSync(file, bytes);
    out.push({ version: r.version, file });
  }
  return out;
}

function localDebs(dir, keep, dest) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(`_${ARCH}.deb`))
    .map((f) => {
      const version = run('dpkg-deb', ['--field', path.join(dir, f), 'Version']).trim();
      const file = path.join(dest, `modsmith_${version}_${ARCH}.deb`);
      fs.copyFileSync(path.join(dir, f), file);
      return { version, file };
    })
    .sort((a, b) => compare(b.version, a.version))
    .slice(0, keep);
}

function composeCatalog(deb, dep11, work) {
  const unpacked = path.join(work, 'unpacked');
  const composed = path.join(work, 'composed');
  run('dpkg-deb', ['-x', deb, unpacked]);
  run('appstreamcli', ['compose', '--no-net', '--origin=modsmith', `--result-root=${composed}`, unpacked]);
  const xmlFile = path.join(composed, 'usr', 'share', 'swcatalog', 'xml', 'modsmith.xml.gz');
  let xml = run('gzip', ['-dc', xmlFile]);
  if (!xml.includes('<id>dev.modsmith.workbench</id>')) throw new Error('The composed catalog has no dev.modsmith.workbench component');
  xml = xml.replace(/<components version="([^"]+)">/, '<components version="$1" origin="modsmith">').replace('<id>dev.modsmith.workbench</id>', '<id>dev.modsmith.workbench</id>\n    <pkgname>modsmith</pkgname>');
  const xmlIn = path.join(work, 'catalog.xml');
  const yamlOut = path.join(work, `Components-${ARCH}.yml`);
  fs.writeFileSync(xmlIn, xml);
  run('appstreamcli', ['convert', '--format=yaml', xmlIn, yamlOut]);
  const yaml = fs.readFileSync(yamlOut, 'utf8');
  if (!/^Package: modsmith$/m.test(yaml) || !/^Origin: modsmith$/m.test(yaml)) throw new Error('The DEP-11 catalog is missing its package or origin');
  fs.mkdirSync(dep11, { recursive: true });
  fs.copyFileSync(yamlOut, path.join(dep11, `Components-${ARCH}.yml`));
  fs.writeFileSync(path.join(dep11, `Components-${ARCH}.yml.gz`), run('gzip', ['-9n', '-c', yamlOut], { encoding: null }));
  const icons = path.join(composed, 'usr', 'share', 'swcatalog', 'icons', 'modsmith');
  for (const size of ICON_SIZES) {
    const dir = path.join(icons, size);
    if (!fs.existsSync(dir)) throw new Error(`The composed catalog has no ${size} icon`);
    const tar = run('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '--mtime=@0', '-C', dir, '-cf', '-', ...fs.readdirSync(dir).sort()], { encoding: null });
    fs.writeFileSync(path.join(work, `icons-${size}.tar`), tar);
    fs.writeFileSync(path.join(dep11, `icons-${size}.tar`), tar);
    fs.writeFileSync(path.join(dep11, `icons-${size}.tar.gz`), run('gzip', ['-9n', '-c', path.join(work, `icons-${size}.tar`)], { encoding: null }));
  }
}

function fingerprintOf(gpgHome, armored) {
  const out = run('gpg', ['--homedir', gpgHome, '--batch', '--with-colons', '--import-options', 'show-only', '--import'], { input: armored });
  const fpr = out.split('\n').find((l) => l.startsWith('fpr:'));
  if (!fpr) throw new Error('Could not read a key fingerprint');
  return fpr.split(':')[9];
}

const opts = args(process.argv.slice(2));
const outDir = path.resolve(opts.out ?? path.join(root, 'site', 'dist', 'apt'));
const keep = Number(opts.keep ?? 3);

if (!fs.existsSync(PUBLIC_KEY)) {
  console.log(`No public key at ${path.relative(root, PUBLIC_KEY)}; the APT repository is not published yet.`);
  process.exit(0);
}
const secretKey = process.env.APT_SIGNING_KEY;
const passphrase = process.env.APT_SIGNING_PASSPHRASE ?? '';
if (!secretKey) {
  console.error('APT_SIGNING_KEY is not set. Refusing to publish an unsigned APT repository.');
  process.exit(1);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'modsmith-apt-'));
const gpgHome = path.join(work, 'gnupg');
fs.mkdirSync(gpgHome, { mode: 0o700 });
try {
  const publicArmored = fs.readFileSync(PUBLIC_KEY, 'utf8');
  const expected = fingerprintOf(gpgHome, publicArmored);
  run('gpg', ['--homedir', gpgHome, '--batch', '--import'], { input: secretKey });
  const secrets = run('gpg', ['--homedir', gpgHome, '--batch', '--with-colons', '--list-secret-keys']);
  if (!secrets.split('\n').some((l) => l.startsWith('fpr:') && l.split(':')[9] === expected)) throw new Error(`APT_SIGNING_KEY is not the secret key for ${expected}, the key in ${path.relative(root, PUBLIC_KEY)}`);

  fs.rmSync(outDir, { recursive: true, force: true });
  const pool = path.join(outDir, 'pool', COMPONENT, 'm', 'modsmith');
  fs.mkdirSync(pool, { recursive: true });
  const debs = opts.debs ? localDebs(path.resolve(opts.debs), keep, pool) : await githubDebs(keep, pool);
  if (!debs.length) throw new Error('No .deb releases found');
  for (const d of debs) {
    const pkg = run('dpkg-deb', ['--field', d.file, 'Package']).trim();
    if (pkg !== 'modsmith') throw new Error(`${path.basename(d.file)} is package ${pkg}, not modsmith`);
  }

  const dist = path.join(outDir, 'dists', SUITE);
  const binary = path.join(dist, COMPONENT, `binary-${ARCH}`);
  fs.mkdirSync(binary, { recursive: true });
  const packages = run('apt-ftparchive', ['packages', `pool/${COMPONENT}`], { cwd: outDir });
  fs.writeFileSync(path.join(binary, 'Packages'), packages);
  fs.writeFileSync(path.join(binary, 'Packages.gz'), run('gzip', ['-9n', '-c', path.join(binary, 'Packages')], { encoding: null }));

  composeCatalog(debs[0].file, path.join(dist, COMPONENT, 'dep11'), work);

  const release = run('apt-ftparchive', [
    '-o', 'APT::FTPArchive::Release::Origin=Modsmith',
    '-o', 'APT::FTPArchive::Release::Label=Modsmith',
    '-o', `APT::FTPArchive::Release::Suite=${SUITE}`,
    '-o', `APT::FTPArchive::Release::Codename=${SUITE}`,
    '-o', `APT::FTPArchive::Release::Architectures=${ARCH}`,
    '-o', `APT::FTPArchive::Release::Components=${COMPONENT}`,
    '-o', 'APT::FTPArchive::Release::Description=Modsmith, the Minecraft Development Studio',
    'release', '.'
  ], { cwd: dist });
  fs.writeFileSync(path.join(dist, 'Release'), release);

  const sign = (extra, output) => run('gpg', ['--homedir', gpgHome, '--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase-fd', '0', '--local-user', expected, '--digest-algo', 'SHA512', ...extra, '--output', output, path.join(dist, 'Release')], { input: passphrase });
  sign(['--clearsign'], path.join(dist, 'InRelease'));
  sign(['--armor', '--detach-sign'], path.join(dist, 'Release.gpg'));

  const keyring = path.join(outDir, 'modsmith-archive-keyring.gpg');
  fs.writeFileSync(keyring, run('gpg', ['--homedir', gpgHome, '--batch', '--dearmor'], { input: publicArmored, encoding: null }));
  fs.copyFileSync(PUBLIC_KEY, path.join(outDir, 'modsmith-archive-keyring.asc'));
  run('gpgv', ['--keyring', keyring, path.join(dist, 'InRelease')]);
  run('gpgv', ['--keyring', keyring, path.join(dist, 'Release.gpg'), path.join(dist, 'Release')]);
  fs.writeFileSync(path.join(outDir, 'modsmith.sources'), `Types: deb\nURIs: ${new URL(`${SITE.basePath}apt/`, SITE.origin)}\nSuites: ${SUITE}\nComponents: ${COMPONENT}\nArchitectures: ${ARCH}\nSigned-By: /etc/apt/keyrings/modsmith.gpg\n`);

  console.log(`APT repository: ${debs.map((d) => d.version).join(', ')} signed with ${expected}`);
  for (const d of debs) console.log(`  ${path.basename(d.file)} sha256 ${sha256(d.file)}`);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  spawnSync('gpgconf', ['--homedir', gpgHome, '--kill', 'all']);
  fs.rmSync(work, { recursive: true, force: true });
}
