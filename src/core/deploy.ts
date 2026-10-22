import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ssh2 from 'ssh2';
import type { OperationInfo } from '../shared/types';
import type { Services } from './context';
import { hashFile } from './http';
import type { LaunchService } from './launch';
import type { Manifest, Profile } from './manifest';
import type { OpContext } from './operations';
import { SecretStore } from './secrets';
import { stateDir, type WorkspaceService } from './workspace';

export const DEPLOY_MANIFEST = '.modsmith-deploy.json';
const CHUNK = 256 * 1024;

export interface DeployTarget {
  host: string;
  port: number;
  username: string;
  remoteDir: string;
  mode: 'mods' | 'full';
  removeStale: boolean;
}

export interface LocalFile {
  rel: string;
  path: string;
  size: number;
  sha1: string;
}

type Previous = Record<string, { sha1?: string; size?: number }>;

export function normalizeRemote(dir: string): string {
  return `/${dir.split(/[/\\]/).filter((p) => p && p !== '.').join('/')}`;
}

const remotePath = (dir: string, rel: string) => (dir === '/' ? `/${rel}` : `${dir}/${rel}`);

export function parseTarget(v: Record<string, unknown>): DeployTarget {
  const host = String(v.host ?? '').trim();
  if (!host || /\s/.test(host) || host.includes('/')) throw new Error("Enter the server's host name, for example the one in your host's SFTP details");
  const username = String(v.username ?? '').trim();
  if (!username) throw new Error('Enter the SFTP user name');
  const port = Number(v.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The port must be between 1 and 65535');
  return { host, port, username, remoteDir: normalizeRemote(String(v.remoteDir ?? '')), mode: v.mode === 'full' ? 'full' : 'mods', removeStale: v.removeStale !== false };
}

export function selected(rel: string, mode: string): boolean {
  if (rel === 'server.properties' || rel === 'eula.txt' || rel === DEPLOY_MANIFEST) return false;
  if (mode === 'full') return !rel.startsWith('world/') || rel.startsWith('world/datapacks/');
  return rel.startsWith('mods/') || rel.startsWith('config/');
}

export const secretName = (t: DeployTarget) => `deploy:${t.username}@${t.host}:${t.port}`;
const hostId = (host: string, port: number) => `${host}:${port}`;

function readJson(file: string): Record<string, unknown> {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeJson(file: string, v: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(v, null, 2));
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
}

export async function localFiles(root: string, mode: string): Promise<LocalFile[]> {
  const paths: string[] = [];
  walk(root, paths);
  const out: LocalFile[] = [];
  for (const p of paths) {
    const rel = path.relative(root, p).replace(/\\/g, '/');
    if (!selected(rel, mode)) continue;
    out.push({ rel, path: p, size: fs.statSync(p).size, sha1: await hashFile(p, 'sha1') });
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

export function plan(local: LocalFile[], remote: Map<string, number | null>, previous: Previous, removeStale: boolean) {
  const upload: { index: number; reason: 'new' | 'changed' }[] = [];
  let unchanged = 0;
  local.forEach((f, index) => {
    const size = remote.get(f.rel) ?? null;
    if (size === null) upload.push({ index, reason: 'new' });
    else if (size !== f.size) upload.push({ index, reason: 'changed' });
    else if (previous[f.rel]?.sha1 !== f.sha1) upload.push({ index, reason: 'changed' });
    else unchanged++;
  });
  const remove: string[] = [];
  if (removeStale) {
    for (const [rel, p] of Object.entries(previous)) {
      if (!rel.startsWith('mods/') || local.some((f) => f.rel === rel)) continue;
      if ((remote.get(rel) ?? null) === (typeof p.size === 'number' ? p.size : undefined)) remove.push(rel);
    }
  }
  return { upload, remove, unchanged };
}

function fingerprint(key: Buffer): string {
  return `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function keyAlgorithm(key: Buffer): string {
  const len = key.readUInt32BE(0);
  return key.subarray(4, 4 + len).toString('ascii');
}

interface Connection {
  client: ssh2.Client;
  sftp?: ssh2.SFTPWrapper;
  fingerprint: string;
  algorithm: string;
}

function connect(t: DeployTarget, expected: string | null, password: string | null): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    let seen = '';
    let algorithm = '';
    let settled = false;
    const done = (err: Error | null, value?: Connection) => {
      if (settled) return;
      settled = true;
      if (err) {
        client.end();
        reject(err);
      } else resolve(value!);
    };
    const timer = setTimeout(() => done(new Error(`Could not reach ${t.host}:${t.port} within 20 seconds`)), 20000);
    client.on('ready', () => {
      clearTimeout(timer);
      if (password === null) return done(null, { client, fingerprint: seen, algorithm });
      client.sftp((err, sftp) => {
        if (err) return done(new Error(`The server did not start SFTP: ${err.message}`));
        done(null, { client, sftp, fingerprint: seen, algorithm });
      });
    });
    client.on('error', (err: Error & { level?: string }) => {
      clearTimeout(timer);
      if (seen && expected && seen !== expected) {
        return done(new Error(`The host key of ${t.host}:${t.port} has changed: Modsmith trusted ${expected} but the server now presents ${seen}. If the host moved your server, check the new key with your host and trust it again; otherwise someone may be intercepting the connection.`));
      }
      if (err.level === 'client-authentication') return done(new Error(`The server refused the user name or password for ${t.username}`));
      done(new Error(`Could not connect to ${t.host}:${t.port}: ${err.message}`));
    });
    client.connect({
      host: t.host,
      port: t.port,
      username: t.username,
      password: password ?? undefined,
      readyTimeout: 20000,
      tryKeyboard: false,
      hostVerifier: (key: Buffer) => {
        seen = fingerprint(key);
        algorithm = keyAlgorithm(key);
        if (password === null && expected === null) {
          resolve({ client, fingerprint: seen, algorithm });
          settled = true;
          clearTimeout(timer);
          setImmediate(() => client.end());
          return false;
        }
        return expected === null || expected === seen;
      }
    });
  });
}

export async function probeHostKey(t: DeployTarget): Promise<{ fingerprint: string; algorithm: string }> {
  const c = await connect(t, null, null);
  return { fingerprint: c.fingerprint, algorithm: c.algorithm };
}

const p = <T>(fn: (cb: (err: Error | null | undefined, v?: T) => void) => void) => new Promise<T>((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v as T))));

async function stat(sftp: ssh2.SFTPWrapper, file: string): Promise<ssh2.Stats | null> {
  try {
    return await p<ssh2.Stats>((cb) => sftp.stat(file, cb));
  } catch {
    return null;
  }
}

async function readRemote(sftp: ssh2.SFTPWrapper, file: string): Promise<Buffer | null> {
  try {
    return await p<Buffer>((cb) => sftp.readFile(file, cb));
  } catch {
    return null;
  }
}

async function ensureDir(sftp: ssh2.SFTPWrapper, dir: string, made: Set<string>): Promise<void> {
  let current = '';
  for (const part of dir.split('/').filter(Boolean)) {
    current = `${current}/${part}`;
    if (made.has(current)) continue;
    const st = await stat(sftp, current);
    if (st && !st.isDirectory()) throw new Error(`${current} exists on the server and is not a folder`);
    if (!st) {
      try {
        await p<void>((cb) => sftp.mkdir(current, cb));
      } catch (e) {
        throw new Error(`Could not create ${current}: ${(e as Error).message}`);
      }
    }
    made.add(current);
  }
}

async function writeRemote(sftp: ssh2.SFTPWrapper, file: string, data: Buffer, ctx: OpContext, onChunk: (n: number) => void): Promise<void> {
  const tmp = `${file}.modsmith-upload`;
  let handle: Buffer;
  try {
    handle = await p<Buffer>((cb) => sftp.open(tmp, 'w', cb));
  } catch (e) {
    throw new Error(`Could not write ${tmp}: ${(e as Error).message}`);
  }
  try {
    for (let offset = 0; offset < data.length; offset += CHUNK) {
      if (ctx.signal.aborted) throw new Error('Cancelled');
      const chunk = data.subarray(offset, offset + CHUNK);
      await p<void>((cb) => sftp.write(handle, chunk, 0, chunk.length, offset, cb));
      onChunk(chunk.length);
    }
  } catch (e) {
    await p<void>((cb) => sftp.close(handle, cb)).catch(() => undefined);
    await p<void>((cb) => sftp.unlink(tmp, cb)).catch(() => undefined);
    throw e instanceof Error && e.message === 'Cancelled' ? e : new Error(`Upload of ${file} failed: ${(e as Error).message}`);
  }
  await p<void>((cb) => sftp.close(handle, cb));
  if (await stat(sftp, file)) {
    try {
      await p<void>((cb) => sftp.unlink(file, cb));
    } catch (e) {
      throw new Error(`Could not replace ${file}: ${(e as Error).message}`);
    }
  }
  try {
    await p<void>((cb) => sftp.rename(tmp, file, cb));
  } catch (e) {
    throw new Error(`Could not move ${tmp} into place: ${(e as Error).message}`);
  }
}

export async function runDeploy(t: DeployTarget, key: string, password: string, local: LocalFile[], profile: string, dryRun: boolean, ctx: OpContext) {
  ctx.progress(0.3, `Connecting to ${t.host}:${t.port}`);
  const conn = await connect(t, key, password);
  const sftp = conn.sftp!;
  try {
    ctx.log(`Connected to ${t.host}:${t.port} as ${t.username}`);
    const manifestPath = remotePath(t.remoteDir, DEPLOY_MANIFEST);
    let previous: Previous = {};
    const prevBytes = await readRemote(sftp, manifestPath);
    if (prevBytes) {
      try {
        const files = JSON.parse(prevBytes.toString('utf8')).files;
        if (files && typeof files === 'object' && !Array.isArray(files)) previous = files;
      } catch {
        previous = {};
      }
    }
    ctx.progress(0.35, 'Comparing with the files on the server');
    const remote = new Map<string, number | null>();
    for (const rel of [...local.map((f) => f.rel), ...Object.keys(previous)]) {
      if (remote.has(rel)) continue;
      const st = await stat(sftp, remotePath(t.remoteDir, rel));
      remote.set(rel, st && !st.isDirectory() ? st.size : null);
    }
    const pl = plan(local, remote, previous, t.removeStale);
    const total = pl.upload.reduce((a, u) => a + local[u.index].size, 0);
    const upload = pl.upload.map((u) => ({ path: local[u.index].rel, size: local[u.index].size, reason: u.reason }));
    if (!dryRun) {
      const made = new Set<string>();
      await ensureDir(sftp, t.remoteDir, made);
      let done = 0;
      for (const u of pl.upload) {
        const f = local[u.index];
        const target = remotePath(t.remoteDir, f.rel);
        await ensureDir(sftp, target.slice(0, target.lastIndexOf('/')), made);
        ctx.progress(null, `Uploading ${f.rel}`);
        await writeRemote(sftp, target, fs.readFileSync(f.path), ctx, (n) => {
          done += n;
          if (total > 0) ctx.progress(0.4 + 0.55 * (done / total));
        });
        ctx.log(`Uploaded ${f.rel} (${f.size} bytes)`);
      }
      for (const rel of pl.remove) {
        try {
          await p<void>((cb) => sftp.unlink(remotePath(t.remoteDir, rel), cb));
        } catch (e) {
          throw new Error(`Could not remove ${rel}: ${(e as Error).message}`);
        }
        ctx.log(`Removed ${rel}`);
      }
      const files: Previous = {};
      for (const [rel, v] of Object.entries(previous)) {
        if (!pl.remove.includes(rel) && !local.some((f) => f.rel === rel) && (remote.get(rel) ?? null) !== null) files[rel] = v;
      }
      for (const f of local) files[f.rel] = { sha1: f.sha1, size: f.size };
      const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      const doc = { version: 1, profile, deployedAt: new Date().toISOString(), files: sorted };
      await writeRemote(sftp, manifestPath, Buffer.from(JSON.stringify(doc, null, 2)), ctx, () => undefined);
    }
    return { upload, remove: pl.remove, unchanged: pl.unchanged, uploadBytes: total };
  } finally {
    conn.client.end();
  }
}

export class DeployService {
  constructor(private s: Services, private ws: WorkspaceService, private launcher: LaunchService) {}

  private get targetsFile() {
    return path.join(this.s.paths.data, 'deploy-targets.json');
  }

  private get knownHostsFile() {
    return path.join(this.s.paths.data, 'known-hosts.json');
  }

  private get secrets() {
    return new SecretStore(path.join(this.s.paths.data, 'secrets.json'));
  }

  private serverProfile(root: string, profileId: string): { dir: string; manifest: Manifest; profile: Profile } {
    const dir = this.ws.normalize(root);
    const manifest = this.ws.requireManifest(dir);
    const profile = manifest.profiles.find((x) => x.id === profileId);
    if (!profile) throw new Error(`Unknown profile ${profileId}`);
    if (profile.side !== 'server') throw new Error(`Profile ${profileId} is not a server profile`);
    return { dir, manifest, profile };
  }

  targetGet(root: string, profileId: string) {
    const { dir } = this.serverProfile(root, profileId);
    const saved = readJson(this.targetsFile)[`${dir}#${profileId}`] as Record<string, unknown> | undefined;
    if (!saved) return { target: null, hasPassword: false, hostKey: null };
    const t = parseTarget(saved);
    return { target: t, hasPassword: this.secrets.has(secretName(t)), hostKey: (readJson(this.knownHostsFile)[hostId(t.host, t.port)] as string | undefined) ?? null };
  }

  targetSet(root: string, profileId: string, target: Record<string, unknown>, password?: string | null) {
    const { dir } = this.serverProfile(root, profileId);
    const t = parseTarget(target);
    const all = readJson(this.targetsFile);
    all[`${dir}#${profileId}`] = t;
    writeJson(this.targetsFile, all);
    if (typeof password === 'string' && password) this.secrets.set(secretName(t), password);
    else if (password === null) this.secrets.delete(secretName(t));
    return this.targetGet(root, profileId);
  }

  async hostKey(target: Record<string, unknown>) {
    const t = parseTarget(target);
    const { fingerprint, algorithm } = await probeHostKey(t);
    const trusted = readJson(this.knownHostsFile)[hostId(t.host, t.port)] as string | undefined;
    return { host: t.host, port: t.port, hostKey: fingerprint, algorithm, trusted: trusted === fingerprint, changed: trusted !== undefined && trusted !== fingerprint };
  }

  trustHost(host: string, port: number, hostKey: string) {
    if (!hostKey.startsWith('SHA256:')) throw new Error('hostKey must be a SHA256 fingerprint from deploy.host_key');
    const all = readJson(this.knownHostsFile);
    all[hostId(host.trim(), port)] = hostKey;
    writeJson(this.knownHostsFile, all);
    return { host: host.trim(), port, hostKey, trusted: true };
  }

  deploy(root: string, profileId: string, dryRun: boolean, confirm: boolean, password?: string): OperationInfo {
    const { dir, manifest, profile } = this.serverProfile(root, profileId);
    if (!dryRun && !confirm) throw new Error('A deploy changes files on the server; preview it with dryRun, then pass confirm: true');
    const loader = manifest.platform.loader;
    if (!['fabric', 'neoforge', 'forge'].includes(loader)) throw new Error(`Server deploys are not implemented for ${loader}`);
    if (manifest.source.kind === 'gradle') this.ws.requireTrusted(dir);
    const saved = readJson(this.targetsFile)[`${dir}#${profileId}`] as Record<string, unknown> | undefined;
    if (!saved) throw new Error(`Set up where to deploy ${profileId} first (deploy.target_set)`);
    const t = parseTarget(saved);
    const key = readJson(this.knownHostsFile)[hostId(t.host, t.port)] as string | undefined;
    if (!key) throw new Error(`Modsmith has not seen the host key of ${t.host}:${t.port} yet; check it with deploy.host_key and trust it first`);
    const pass = password || this.secrets.get(secretName(t));
    if (!pass) throw new Error(`No password is saved for ${t.username}; enter it to deploy`);
    const title = `${dryRun ? 'Preview deploy of' : 'Deploy'} ${profile.name} to ${t.host}`;
    return this.s.ops.start({ kind: 'server.deploy', title, workspace: dir }, async (ctx) => {
      const staging = path.join(stateDir(dir), 'deploy', profile.id);
      fs.rmSync(staging, { recursive: true, force: true });
      ctx.progress(0.02, 'Preparing the server pack');
      await this.launcher.exportServerPackInto(dir, manifest, profile, staging, false, t.mode === 'full', ctx);
      const local = await localFiles(staging, t.mode);
      ctx.log(`${local.length} files to compare (${t.mode} mode)`);
      const out = await runDeploy(t, key, pass, local, profile.id, dryRun, ctx);
      fs.rmSync(staging, { recursive: true, force: true });
      ctx.progress(1, dryRun ? 'Preview ready' : 'Deployed');
      return { ...out, host: t.host, port: t.port, remoteDir: t.remoteDir, mode: t.mode, dryRun, minecraft: manifest.platform.minecraft, loader: manifest.platform.loader, loaderVersion: manifest.platform.loaderVersion };
    });
  }
}
