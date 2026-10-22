import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE, PLATFORMS } from './site.config.mjs';
import { PAGES, NAV, DOCS } from './pages.mjs';
import { buildIndex } from './registry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const outDir = path.resolve(args.find((a) => a.startsWith('--out='))?.slice(6) ?? path.join(here, 'dist'));
const base = args.find((a) => a.startsWith('--base='))?.slice(7) ?? SITE.basePath;
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const repoUrl = `https://github.com/${SITE.repository}`;
const releaseUrl = `${repoUrl}/releases/tag/v${version}`;
const absolute = (p) => new URL(`${SITE.basePath}${p}`, SITE.origin).toString();

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function downloads() {
  return Object.fromEntries(Object.entries(PLATFORMS).map(([k, p]) => [k, { ...p, name: p.file(version), url: `${repoUrl}/releases/download/v${version}/${p.file(version)}` }]));
}

export function openpgpFingerprint(armored) {
  const lines = armored.replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => l.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----'));
  if (start < 0) throw new Error('Not an armored OpenPGP public key');
  let i = start + 1;
  while (i < lines.length && lines[i].trim() !== '') i++;
  const b64 = [];
  for (i++; i < lines.length && !lines[i].startsWith('-----END') && !lines[i].startsWith('='); i++) b64.push(lines[i].trim());
  const bytes = Buffer.from(b64.join(''), 'base64');
  let p = 0;
  const head = bytes[p++];
  let tag;
  let len;
  if (head & 0x40) {
    tag = head & 0x3f;
    const l1 = bytes[p++];
    if (l1 < 192) len = l1;
    else if (l1 < 224) len = ((l1 - 192) << 8) + bytes[p++] + 192;
    else if (l1 === 255) {
      len = bytes.readUInt32BE(p);
      p += 4;
    } else throw new Error('Unsupported OpenPGP packet length');
  } else {
    tag = (head >> 2) & 0x0f;
    const type = head & 3;
    if (type === 0) len = bytes[p++];
    else if (type === 1) {
      len = bytes.readUInt16BE(p);
      p += 2;
    } else if (type === 2) {
      len = bytes.readUInt32BE(p);
      p += 4;
    } else throw new Error('Unsupported OpenPGP packet length');
  }
  if (tag !== 6) throw new Error('The key does not start with a public key packet');
  const packet = bytes.subarray(p, p + len);
  if (packet[0] === 4) {
    const prefix = Buffer.from([0x99, (len >> 8) & 0xff, len & 0xff]);
    return crypto.createHash('sha1').update(prefix).update(packet).digest('hex').toUpperCase();
  }
  if (packet[0] === 6) {
    const prefix = Buffer.alloc(5);
    prefix[0] = 0x9b;
    prefix.writeUInt32BE(len, 1);
    return crypto.createHash('sha256').update(prefix).update(packet).digest('hex').toUpperCase();
  }
  throw new Error(`Unsupported OpenPGP key version ${packet[0]}`);
}

const aptKey = path.join(root, 'packaging', 'apt', 'modsmith-archive-keyring.asc');

function aptSection() {
  if (!fs.existsSync(aptKey)) return '';
  const fpr = openpgpFingerprint(fs.readFileSync(aptKey, 'utf8'));
  const repo = absolute('apt/');
  return `<h2 id="apt">Install and update with APT</h2>
<p>On Ubuntu, Kubuntu, Debian and other distributions that use APT, add the Modsmith repository once. Modsmith then installs and updates through your software center, such as KDE Discover or GNOME Software, or with <code>apt</code>, and the software center shows its name, developer, icon and description.</p>
<pre><code>sudo install -d -m 0755 /etc/apt/keyrings
wget -qO- ${repo}modsmith-archive-keyring.gpg | sudo tee /etc/apt/keyrings/modsmith.gpg &gt; /dev/null
wget -qO- ${repo}modsmith.sources | sudo tee /etc/apt/sources.list.d/modsmith.sources &gt; /dev/null
sudo apt update
sudo apt install modsmith</code></pre>
<p>The repository is signed with the key <code>${fpr.match(/.{4}/g).join(' ')}</code>. Compare it with the output of <code>gpg --show-keys /etc/apt/keyrings/modsmith.gpg</code> before you install. The repository keeps the three newest releases, so <code>sudo apt install modsmith=&lt;version&gt;</code> can go back one or two versions.</p>
`;
}

function fill(text) {
  const dl = downloads();
  return text
    .replaceAll('{{apt}}', aptSection())
    .replaceAll('{{base}}', base)
    .replaceAll('{{version}}', version)
    .replaceAll('{{repo}}', repoUrl)
    .replaceAll('{{release}}', releaseUrl)
    .replaceAll('{{releases}}', `${repoUrl}/releases`)
    .replace(/\{\{download:(\w+):(url|name)\}\}/g, (_, k, f) => dl[k][f]);
}

function structuredData(page) {
  if (!page.software) return '';
  const dl = downloads();
  const data = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE.name,
    alternateName: `${SITE.name} ${SITE.tagline}`,
    description: page.description,
    url: absolute(''),
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Windows 10, Windows 11, Linux',
    softwareVersion: version,
    downloadUrl: Object.values(dl).map((d) => d.url),
    screenshot: absolute('images/screenshot-editor.png'),
    image: absolute(SITE.socialImage),
    license: `${repoUrl}/blob/master/LICENSE`,
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    sameAs: [repoUrl]
  };
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>\n`;
}

function nav(page) {
  const items = NAV.map((n) => {
    const current = page.path === n.path || (n.path === 'docs/' && page.path.startsWith('docs/'));
    return `<a href="${base}${n.path}"${current ? ' aria-current="page"' : ''}>${n.label}</a>`;
  }).join('');
  return `${items}<a href="${repoUrl}" class="nav-external">GitHub</a>`;
}

function docsAside(page) {
  if (!page.path.startsWith('docs/')) return '';
  const links = DOCS.map((d) => `<li><a href="${base}${d.path}"${d.path === page.path ? ' aria-current="page"' : ''}>${d.label}</a></li>`).join('');
  return `<nav class="docs-nav" aria-label="Documentation"><p class="docs-nav-title">Documentation</p><ul>${links}</ul><p class="docs-nav-title">Reference on GitHub</p><ul><li><a href="${repoUrl}/blob/master/docs/status.md">Implementation status</a></li><li><a href="${repoUrl}/blob/master/docs/loader-matrix.md">Loader and version matrix</a></li><li><a href="${repoUrl}/blob/master/docs/editor.md">Editor</a></li><li><a href="${repoUrl}/blob/master/docs/manifest.md">Project files</a></li><li><a href="${repoUrl}/blob/master/docs/mcp.md">MCP server</a></li></ul></nav>`;
}

function layout(page, body) {
  const url = page.noindex ? null : absolute(page.path);
  const title = page.path === '' ? `${SITE.name} — ${SITE.tagline}` : `${page.title} — ${SITE.name}`;
  const image = absolute(SITE.socialImage);
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(page.description)}">`,
    page.noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${url}">`,
    `<meta name="theme-color" content="${SITE.themeColor}">`,
    `<link rel="icon" href="${base}favicon.ico" sizes="any">`,
    `<link rel="icon" href="${base}images/logo.svg" type="image/svg+xml">`,
    `<link rel="apple-touch-icon" href="${base}images/logo-512.png">`,
    `<link rel="stylesheet" href="${base}style.css">`,
    `<meta property="og:type" content="${page.path === '' ? 'website' : 'article'}">`,
    `<meta property="og:site_name" content="${SITE.name} — ${SITE.tagline}">`,
    `<meta property="og:title" content="${escapeHtml(page.ogTitle ?? title)}">`,
    `<meta property="og:description" content="${escapeHtml(page.description)}">`,
    url ? `<meta property="og:url" content="${url}">` : '',
    `<meta property="og:image" content="${image}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    `<meta property="og:image:alt" content="${escapeHtml(SITE.socialImageAlt)}">`,
    `<meta property="og:locale" content="${SITE.locale}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${escapeHtml(page.ogTitle ?? title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(page.description)}">`,
    `<meta name="twitter:image" content="${image}">`,
    `<meta name="twitter:image:alt" content="${escapeHtml(SITE.socialImageAlt)}">`
  ]
    .filter(Boolean)
    .join('\n');
  const aside = docsAside(page);
  return `<!doctype html>
<html lang="en">
<head>
${head}
${structuredData(page)}</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
<div class="wrap header-inner">
<a class="brand" href="${base}"><img src="${base}images/logo.svg" alt="" width="32" height="32"><span class="brand-name">${SITE.name}</span><span class="brand-tag">${SITE.tagline}</span></a>
<nav class="site-nav" aria-label="Main">${nav(page)}</nav>
</div>
</header>
<div class="wrap ${aside ? 'with-aside' : ''}">
${aside}
<main id="main" class="content ${page.path === '' ? 'home' : ''}">
${body}
</main>
</div>
<footer class="site-footer">
<div class="wrap footer-inner">
<p>${SITE.name} is a free, source-available desktop application for Minecraft mod development. It is an independent project, not affiliated with or endorsed by Mojang Studios or Microsoft. Minecraft is a trademark of Mojang Synergies AB.</p>
<p><a href="${repoUrl}">Source on GitHub</a> · <a href="${repoUrl}/releases">Releases</a> · <a href="${repoUrl}/issues">Report a problem</a> · <a href="${repoUrl}/blob/master/LICENSE">License</a></p>
</div>
</footer>
</body>
</html>
`;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
copyDir(path.join(here, 'static'), outDir);
fs.mkdirSync(path.join(outDir, 'images'), { recursive: true });
fs.copyFileSync(path.join(root, 'resources', 'brand', 'modsmith.svg'), path.join(outDir, 'images', 'logo.svg'));
fs.copyFileSync(path.join(root, 'resources', 'brand', 'modsmith.png'), path.join(outDir, 'images', 'logo-512.png'));
fs.copyFileSync(path.join(root, 'resources', 'brand', 'modsmith.ico'), path.join(outDir, 'favicon.ico'));

const indexed = [];
for (const page of PAGES) {
  const body = fill(fs.readFileSync(path.join(here, 'content', page.file), 'utf8'));
  const html = layout(page, body);
  const target = page.path === '404' ? path.join(outDir, '404.html') : path.join(outDir, page.path, 'index.html');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, html);
  if (!page.noindex) indexed.push(page);
}

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${indexed.map((p) => `  <url><loc>${absolute(p.path)}</loc></url>`).join('\n')}
</urlset>
`;
fs.writeFileSync(path.join(outDir, 'sitemap.xml'), sitemap);
fs.writeFileSync(path.join(outDir, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${absolute('sitemap.xml')}\n`);
fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
const extensionIndex = buildIndex(path.join(root, 'registry'));
fs.mkdirSync(path.join(outDir, 'extensions'), { recursive: true });
fs.writeFileSync(path.join(outDir, 'extensions', 'index.json'), `${JSON.stringify(extensionIndex, null, 2)}
`);
console.log(`Built ${PAGES.length} pages for ${absolute('')} into ${outDir}${base !== SITE.basePath ? ` (links use ${base})` : ''}`);
