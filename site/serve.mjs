import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE } from './site.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
const port = Number(process.argv[2] ?? 4321);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.xml': 'application/xml', '.txt': 'text/plain' };

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith(SITE.basePath)) {
      res.writeHead(302, { location: SITE.basePath });
      return res.end();
    }
    let file = path.join(dist, decodeURIComponent(url.pathname.slice(SITE.basePath.length)));
    if (!file.startsWith(dist)) return res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        res.writeHead(301, { location: `${url.pathname}/` });
        return res.end();
      }
      file = path.join(file, 'index.html');
    }
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': types['.html'] });
      return res.end(fs.readFileSync(path.join(dist, '404.html')));
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  })
  .listen(port, '127.0.0.1', () => console.log(`Serving ${dist} at http://127.0.0.1:${port}${SITE.basePath}`));
