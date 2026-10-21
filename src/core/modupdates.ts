import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OperationInfo } from '../shared/types';
import type { Services } from './context';
import type { OpContext } from './operations';
import type { WorkspaceService } from './workspace';
import { stateDir } from './workspace';
import { readLock, writeManifest, type LockEntry, type LockFile, type Manifest, type Profile } from './manifest';
import { pickVersion, type ModrinthVersion } from './modrinth';
import { lockKey, refKey, refPin, withPin, type ProfileService } from './profiles';

type Mode = 'development' | 'production';
type Issue = { severity: 'error' | 'warning' | 'info'; message: string };

export interface ModUpdate {
  key: string;
  provider: 'modrinth' | 'curseforge';
  projectId: string;
  title: string;
  direct: boolean;
  pinned: boolean;
  from: { versionId?: string; versionNumber?: string };
  to: { versionId: string; versionNumber: string };
}

export interface LockDiff {
  changed: { key: string; title: string; from?: string; to?: string }[];
  added: { key: string; title: string; version?: string }[];
  removed: { key: string; title: string; version?: string }[];
  newIssues: Issue[];
  fixedIssues: Issue[];
}

interface RollbackPoint {
  id: string;
  profile: string;
  mode: Mode;
  createdAt: string;
  keys: string[];
  pins: Record<string, string | null>;
  before: LockFile['profiles'][string];
  diff: LockDiff;
  rolledBackAt?: string;
}

const PROVIDERS = ['modrinth', 'curseforge'];

export function diffLock(before: LockEntry[], after: LockEntry[], beforeIssues: Issue[], afterIssues: Issue[]): LockDiff {
  const old = new Map(before.map((e) => [e.key, e]));
  const now = new Map(after.map((e) => [e.key, e]));
  const changed: LockDiff['changed'] = [];
  const added: LockDiff['added'] = [];
  const removed: LockDiff['removed'] = [];
  for (const e of after) {
    const o = old.get(e.key);
    if (!o) added.push({ key: e.key, title: e.title, version: e.versionNumber });
    else if ((o.versionId ?? o.sha1) !== (e.versionId ?? e.sha1)) changed.push({ key: e.key, title: e.title, from: o.versionNumber, to: e.versionNumber });
  }
  for (const e of before) if (!now.has(e.key)) removed.push({ key: e.key, title: e.title, version: e.versionNumber });
  const serious = (l: Issue[]) => l.filter((i) => i.severity !== 'info');
  const sig = (i: Issue) => `${i.severity}|${i.message}`;
  const was = new Set(serious(beforeIssues).map(sig));
  const is = new Set(serious(afterIssues).map(sig));
  return { changed, added, removed, newIssues: serious(afterIssues).filter((i) => !was.has(sig(i))), fixedIssues: serious(beforeIssues).filter((i) => !is.has(sig(i))) };
}

function newer(candidate: ModrinthVersion, current: ModrinthVersion | null): boolean {
  if (!current) return true;
  return Date.parse(candidate.date_published) > Date.parse(current.date_published);
}

export class ModUpdateService {
  constructor(private s: Services, private ws: WorkspaceService, private profiles: ProfileService) {}

  private dir(root: string) {
    return path.join(stateDir(this.ws.normalize(root)), 'updates');
  }

  private load(root: string, id: string, requested?: Mode) {
    const dir = this.ws.normalize(root);
    const manifest = this.ws.requireManifest(dir);
    const profile = manifest.profiles.find((p) => p.id === id);
    if (!profile) throw new Error(`Unknown profile ${id}`);
    const mode = requested ?? profile.mode;
    const previous = readLock(dir).profiles[lockKey(id, mode)];
    if (!previous) throw new Error(`Profile ${id} has not been resolved yet. Resolve it first so there is a lock file to compare with.`);
    return { dir, manifest, profile, mode, previous };
  }

  private refs(manifest: Manifest, profile: Profile) {
    return [...manifest.dependencies, ...profile.mods];
  }

  private async available(manifest: Manifest, profile: Profile, previous: LockFile['profiles'][string], ctx: OpContext) {
    const apis = this.profiles.providerApis(ctx.signal, 0);
    const refs = this.refs(manifest, profile);
    const entries = previous.entries.filter((e) => PROVIDERS.includes(e.provider) && e.projectId && e.versionId);
    const updates: ModUpdate[] = [];
    const failed: { key: string; title: string; error: string }[] = [];
    const { loader, minecraft } = manifest.platform;
    for (const [i, e] of entries.entries()) {
      ctx.throwIfCancelled();
      ctx.progress(i / Math.max(1, entries.length), `Checking ${e.title}`);
      const api = apis[e.provider as 'modrinth' | 'curseforge'];
      if (!api) {
        failed.push({ key: e.key, title: e.title, error: 'CurseForge is not configured' });
        continue;
      }
      try {
        const all = await api.versions(e.projectId!, loader, minecraft);
        const latest = api.pick ? api.pick(all, loader, minecraft) : pickVersion(all, loader, minecraft);
        if (!latest || latest.id === e.versionId) continue;
        const current = all.find((v) => v.id === e.versionId) ?? (await api.version(e.versionId!, e.projectId).catch(() => null));
        if (!newer(latest, current)) continue;
        const matching = refs.filter((r) => refKey(r) === e.key);
        updates.push({ key: e.key, provider: e.provider as ModUpdate['provider'], projectId: e.projectId!, title: e.title, direct: matching.length > 0, pinned: matching.some((r) => !!refPin(r)), from: { versionId: e.versionId, versionNumber: e.versionNumber }, to: { versionId: latest.id, versionNumber: latest.version_number } });
      } catch (err) {
        failed.push({ key: e.key, title: e.title, error: (err as Error).message });
      }
    }
    return { checked: entries.length, updates, failed };
  }

  private select(updates: ModUpdate[], keys?: string[]) {
    if (!keys) return updates;
    for (const k of keys) if (!updates.some((u) => u.key === k)) throw new Error(`${k} has no update available`);
    return updates.filter((u) => keys.includes(u.key));
  }

  check(p: { path: string; id: string; mode?: Mode }): OperationInfo {
    const { dir, manifest, profile, mode, previous } = this.load(p.path, p.id, p.mode);
    return this.s.ops.start({ kind: 'profile.check_updates', title: `Check updates for ${profile.name}`, workspace: dir }, async (ctx) => {
      const r = await this.available(manifest, profile, previous, ctx);
      ctx.log(`${r.updates.length} of ${r.checked} mods have a newer version`);
      return { profile: profile.id, mode, ...r };
    });
  }

  preview(p: { path: string; id: string; mode?: Mode; keys?: string[] }): OperationInfo {
    const { dir, manifest, profile, mode, previous } = this.load(p.path, p.id, p.mode);
    return this.s.ops.start({ kind: 'profile.preview_update', title: `Preview updates for ${profile.name}`, workspace: dir }, async (ctx) => {
      const chosen = this.select((await this.available(manifest, profile, previous, ctx)).updates, p.keys);
      const pins = Object.fromEntries(chosen.filter((u) => u.pinned).map((u) => [u.key, u.to.versionId]));
      ctx.progress(0.8, 'Resolving with the updates');
      const res = await this.profiles.resolve(dir, profile.id, ctx, { mode, plan: { update: chosen.map((u) => u.key), pins, dryRun: true } });
      return { profile: profile.id, mode, updates: chosen, diff: diffLock(previous.entries, res.entries, previous.issues, res.issues) };
    });
  }

  apply(p: { path: string; id: string; mode?: Mode; keys?: string[] }): OperationInfo {
    const { dir, profile, mode, previous } = this.load(p.path, p.id, p.mode);
    return this.s.ops.start({ kind: 'profile.apply_update', title: `Update mods of ${profile.name}`, workspace: dir }, async (ctx) => {
      const manifest = this.ws.requireManifest(dir);
      const current = manifest.profiles.find((x) => x.id === profile.id)!;
      const chosen = this.select((await this.available(manifest, current, previous, ctx)).updates, p.keys);
      if (!chosen.length) throw new Error('There are no updates to apply');
      const pins: Record<string, string | null> = {};
      for (const u of chosen.filter((x) => x.pinned)) pins[u.key] = this.refs(manifest, current).filter((r) => refKey(r) === u.key).map(refPin).find(Boolean) ?? null;
      this.repin(manifest, current, Object.fromEntries(chosen.filter((u) => u.pinned).map((u) => [u.key, u.to.versionId])));
      writeManifest(dir, manifest);
      ctx.progress(0.8, 'Resolving with the updates');
      const res = await this.profiles.resolve(dir, profile.id, ctx, { mode, plan: { update: chosen.map((u) => u.key) } });
      const diff = diffLock(previous.entries, res.entries, previous.issues, res.issues);
      const point: RollbackPoint = { id: randomUUID().slice(0, 8), profile: profile.id, mode, createdAt: new Date().toISOString(), keys: chosen.map((u) => u.key), pins, before: previous, diff };
      fs.mkdirSync(this.dir(dir), { recursive: true });
      fs.writeFileSync(path.join(this.dir(dir), `${point.id}.json`), JSON.stringify(point, null, 2));
      ctx.log(`Rollback point ${point.id}: ${diff.changed.length} changed, ${diff.added.length} added, ${diff.removed.length} removed`);
      return { profile: profile.id, mode, rollback: point.id, updates: chosen, diff };
    });
  }

  private repin(manifest: Manifest, profile: Profile, pins: Record<string, string | null>) {
    const apply = (list: Manifest['dependencies']) =>
      list.map((r) => {
        const k = refKey(r);
        return k && k in pins ? withPin(r, pins[k] ?? undefined) : r;
      });
    manifest.dependencies = apply(manifest.dependencies);
    profile.mods = apply(profile.mods);
  }

  history(p: { path: string; id?: string }) {
    const d = this.dir(p.path);
    if (!fs.existsSync(d)) return [];
    return fs
      .readdirSync(d)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) as RollbackPoint)
      .filter((r) => !p.id || r.profile === p.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => ({ id: r.id, profile: r.profile, mode: r.mode, createdAt: r.createdAt, rolledBackAt: r.rolledBackAt ?? null, keys: r.keys, diff: r.diff }));
  }

  rollback(p: { path: string; rollback: string }): OperationInfo {
    const dir = this.ws.normalize(p.path);
    const file = path.join(this.dir(dir), `${p.rollback}.json`);
    if (!/^[A-Za-z0-9-]+$/.test(p.rollback) || !fs.existsSync(file)) throw new Error(`Unknown rollback point ${p.rollback}`);
    const point = JSON.parse(fs.readFileSync(file, 'utf8')) as RollbackPoint;
    const manifest = this.ws.requireManifest(dir);
    const profile = manifest.profiles.find((x) => x.id === point.profile);
    if (!profile) throw new Error(`Unknown profile ${point.profile}`);
    return this.s.ops.start({ kind: 'profile.rollback_update', title: `Roll back mod updates of ${profile.name}`, workspace: dir }, async (ctx) => {
      const current = readLock(dir).profiles[lockKey(profile.id, point.mode)];
      this.repin(manifest, profile, point.pins);
      writeManifest(dir, manifest);
      const held = Object.fromEntries(point.before.entries.filter((e) => PROVIDERS.includes(e.provider) && e.versionId).map((e) => [e.key, e.versionId!]));
      const res = await this.profiles.resolve(dir, profile.id, ctx, { mode: point.mode, plan: { held } });
      point.rolledBackAt = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify(point, null, 2));
      return { profile: profile.id, mode: point.mode, rollback: point.id, diff: diffLock(current?.entries ?? [], res.entries, current?.issues ?? [], res.issues) };
    });
  }
}
