import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE, PLATFORMS } from './site.config.mjs';
import { PAGES, NAV, DOCS } from './pages.mjs';

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

function fill(text) {
  const dl = downloads();
  return text
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
console.log(`Built ${PAGES.length} pages for ${absolute('')} into ${outDir}${base !== SITE.basePath ? ` (links use ${base})` : ''}`);
