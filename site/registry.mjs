import fs from 'node:fs';
import path from 'node:path';

export const ID = /^[a-z0-9][a-z0-9-]{0,38}\.[a-z0-9][a-z0-9-]{0,63}$/;
export const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const RELEASE = /^\d+\.\d+\.\d+$/;
export const PERMISSIONS = ['project.read', 'project.write', 'game', 'build', 'network', 'companion'];
export const FIELDS = ['id', 'version', 'name', 'publisher', 'description', 'repository', 'license', 'url', 'sha256', 'size', 'modsmith', 'permissions'];

const parts = (v) => v.split(/[-+]/)[0].split('.').map(Number);

export function compareVersions(a, b) {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const c = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (c) return Math.sign(c);
  }
  return 0;
}

export function githubRepo(link) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(link ?? '');
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

export function releaseRepo(url) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/releases\/download\/[^/]+\/[^/]+\.zip$/i.exec(url ?? '');
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

export function checkEntry(e, file) {
  const problems = [];
  const where = file ? `${file}: ` : '';
  const bad = (msg) => problems.push(`${where}${msg}`);
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return [`${where}is not a JSON object`];
  for (const k of Object.keys(e)) if (!FIELDS.includes(k)) bad(`unknown field ${k}`);
  if (typeof e.id !== 'string' || !ID.test(e.id)) bad('id must be publisher.name in lowercase letters, digits and dashes');
  if (typeof e.version !== 'string' || !VERSION.test(e.version)) bad('version must look like 1.2.3');
  if (typeof e.name !== 'string' || !e.name.trim() || e.name.length > 60) bad('name is required (60 characters at most)');
  if (typeof e.publisher !== 'string' || !e.publisher.trim() || e.publisher.length > 60) bad('publisher is required (60 characters at most)');
  if (e.description !== undefined && (typeof e.description !== 'string' || e.description.length > 300)) bad('description must be text of 300 characters at most');
  if (e.license !== undefined && (typeof e.license !== 'string' || e.license.length > 60)) bad('license must be text');
  const repo = githubRepo(e.repository);
  if (!repo) bad('repository must be the https://github.com/owner/name link of the extension source');
  const from = releaseRepo(e.url);
  if (!from) bad('url must be a .zip asset of a GitHub release (https://github.com/owner/name/releases/download/tag/file.zip)');
  else if (repo && from !== repo) bad(`url must be a release asset of ${e.repository}`);
  if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) bad('sha256 must be 64 lowercase hex digits');
  if (!Number.isInteger(e.size) || e.size <= 0) bad('size must be the package size in bytes');
  if (typeof e.modsmith !== 'string' || !RELEASE.test(e.modsmith)) bad('modsmith must be a version like 0.1.12');
  if (!Array.isArray(e.permissions) || e.permissions.some((p) => !PERMISSIONS.includes(p)) || new Set(e.permissions).size !== e.permissions.length) bad(`permissions must list each of ${PERMISSIONS.join(', ')} at most once`);
  if (file) {
    const rel = file.replace(/\\/g, '/');
    const m = /(?:^|\/)extensions\/([^/]+)\/([^/]+)\.json$/.exec(rel);
    if (!m || m[1] !== e.id || m[2] !== e.version) bad(`must be saved as registry/extensions/${e.id}/${e.version}.json`);
  }
  return problems;
}

export function readRegistry(root) {
  const dir = path.join(root, 'extensions');
  const entries = [];
  const problems = [];
  if (!fs.existsSync(dir)) return { entries, problems };
  for (const id of fs.readdirSync(dir).sort()) {
    const idDir = path.join(dir, id);
    if (!fs.statSync(idDir).isDirectory()) continue;
    for (const name of fs.readdirSync(idDir).sort()) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(idDir, name);
      const rel = path.relative(path.dirname(root), file).replace(/\\/g, '/');
      let e;
      try {
        e = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        problems.push(`${rel}: ${err.message}`);
        continue;
      }
      const p = checkEntry(e, rel);
      if (p.length) problems.push(...p);
      else entries.push({ ...e, file: rel });
    }
  }
  const byId = new Map();
  for (const e of entries) byId.set(e.id, [...(byId.get(e.id) ?? []), e]);
  for (const [id, list] of byId) {
    const repos = new Set(list.map((e) => githubRepo(e.repository)));
    if (repos.size > 1) problems.push(`${id}: every version must come from the same repository (${[...repos].join(', ')})`);
  }
  return { entries, problems };
}

export function buildIndex(root, generatedAt = new Date().toISOString()) {
  const { entries, problems } = readRegistry(root);
  if (problems.length) throw new Error(`The extension registry has problems:\n${problems.join('\n')}`);
  const byId = new Map();
  for (const e of entries) byId.set(e.id, [...(byId.get(e.id) ?? []), e]);
  const extensions = [...byId.values()]
    .map((list) => {
      const sorted = list.sort((a, b) => compareVersions(b.version, a.version));
      const top = sorted[0];
      const out = { id: top.id, name: top.name, publisher: top.publisher };
      if (top.description) out.description = top.description;
      out.repository = top.repository;
      if (top.license) out.license = top.license;
      out.versions = sorted.map((e) => ({ version: e.version, url: e.url, sha256: e.sha256, size: e.size, modsmith: e.modsmith, permissions: e.permissions }));
      return out;
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { schemaVersion: 1, generatedAt, extensions };
}
