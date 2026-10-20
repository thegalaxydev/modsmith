import fs from 'node:fs';
import path from 'node:path';
import type { Services } from './context';
import type { WorkspaceService } from './workspace';
import { stateDir } from './workspace';
import { readLock, writeManifest, type LockEntry, type ModRef } from './manifest';
import { readJarMetadata } from './jarmeta';

export interface BisectUnit {
  key: string;
  title: string;
  requires: string[];
}

export interface BisectState {
  profile: string;
  bisectProfile: string;
  predicate: string;
  units: BisectUnit[];
  candidates: string[];
  cleared: string[];
  current: string[] | null;
  attempts: { tested: string[]; outcome: 'good' | 'bad' | 'skip'; at: string }[];
  skips: number;
  done: boolean;
  conclusion?: string;
}

export function closure(keys: string[], units: BisectUnit[]): string[] {
  const byKey = new Map(units.map((u) => [u.key, u]));
  const out = new Set<string>();
  const stack = [...keys];
  while (stack.length) {
    const k = stack.pop()!;
    if (out.has(k)) continue;
    out.add(k);
    for (const r of byKey.get(k)?.requires ?? []) stack.push(r);
  }
  return [...out];
}

export function nextSplit(candidates: string[], skips: number): string[] {
  const n = candidates.length;
  if (n <= 1) return candidates;
  const rotated = [...candidates.slice(skips % n), ...candidates.slice(0, skips % n)];
  return rotated.slice(0, Math.ceil(n / 2));
}

export function applyOutcome(state: BisectState, outcome: 'good' | 'bad' | 'skip'): BisectState {
  if (!state.current) throw new Error('No attempt in progress');
  const tested = state.current;
  const next = { ...state, attempts: [...state.attempts, { tested, outcome, at: new Date().toISOString() }] };
  const testedCandidates = state.candidates.filter((c) => tested.includes(c));
  if (outcome === 'bad') next.candidates = testedCandidates;
  else if (outcome === 'good') {
    next.candidates = state.candidates.filter((c) => !tested.includes(c));
    next.cleared = [...state.cleared, ...testedCandidates];
  } else next.skips = state.skips + 1;
  if (next.candidates.length <= 1) {
    next.done = true;
    next.current = null;
    const u = state.units.find((x) => x.key === next.candidates[0]);
    next.conclusion = next.candidates.length
      ? `The problem reproduced with a set containing ${u?.title ?? next.candidates[0]} (plus its required dependencies) and not without it. This is evidence that it is involved, not proof that it alone is defective; interactions with its dependencies or the remaining mods are possible.`
      : 'Every candidate was cleared; the problem did not reproduce with any tested subset. It may need the full combination, the source mod alone, or depend on world/config state.';
  } else {
    next.current = closure(nextSplit(next.candidates, next.skips), state.units);
  }
  return next;
}

export class BisectService {
  constructor(private s: Services, private ws: WorkspaceService) {}

  private file(dir: string): string {
    return path.join(stateDir(dir), 'bisect.json');
  }

  status(workspace: string): BisectState | null {
    const f = this.file(this.ws.normalize(workspace));
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  }

  start(workspace: string, profileId: string, predicate: string): BisectState {
    const dir = this.ws.normalize(workspace);
    const manifest = this.ws.requireManifest(dir);
    const profile = manifest.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`Unknown profile ${profileId}`);
    const lock = readLock(dir).profiles[profileId];
    if (!lock) throw new Error(`Resolve profile ${profileId} before bisecting`);
    const entries = lock.entries.filter((e) => e.provider === 'modrinth' || e.provider === 'local');
    if (entries.length < 2) throw new Error('Bisection needs at least two external mods in the profile');
    const filesMap = this.resolvedFiles(dir, profileId);
    const idOwner = new Map<string, string>();
    const metas = new Map<string, string[]>();
    for (const e of entries) {
      for (const id of e.modIds) idOwner.set(id, e.key);
      const f = filesMap[e.key];
      try {
        metas.set(e.key, f ? readJarMetadata(f).flatMap((m) => Object.keys(m.depends)) : []);
      } catch {
        metas.set(e.key, []);
      }
    }
    const units: BisectUnit[] = entries.map((e) => {
      const requires = new Set<string>();
      for (const dep of metas.get(e.key) ?? []) {
        const owner = idOwner.get(dep);
        if (owner && owner !== e.key) requires.add(owner);
      }
      return { key: e.key, title: e.title, requires: [...requires] };
    });
    for (const e of entries) {
      const m = e.reason.match(/^required by (.+)$/);
      if (!m) continue;
      const parent = entries.find((p) => p.title === m[1]);
      if (parent) {
        const u = units.find((x) => x.key === parent.key)!;
        if (!u.requires.includes(e.key)) u.requires.push(e.key);
      }
    }
    const requiredByOthers = new Set(units.flatMap((u) => u.requires));
    const candidates = units.filter((u) => !requiredByOthers.has(u.key)).map((u) => u.key);
    const state: BisectState = { profile: profileId, bisectProfile: `${profileId}-bisect`.slice(0, 48), predicate, units, candidates, cleared: [], current: null, attempts: [], skips: 0, done: false };
    state.current = closure(nextSplit(candidates, 0), units);
    this.applyProfile(dir, state, lock.entries);
    fs.writeFileSync(this.file(dir), JSON.stringify(state, null, 2));
    return state;
  }

  record(workspace: string, outcome: 'good' | 'bad' | 'skip'): BisectState {
    const dir = this.ws.normalize(workspace);
    const state = this.status(dir);
    if (!state) throw new Error('No bisection in progress');
    const next = applyOutcome(state, outcome);
    const lock = readLock(dir).profiles[state.profile];
    if (next.current && lock) this.applyProfile(dir, next, lock.entries);
    fs.writeFileSync(this.file(dir), JSON.stringify(next, null, 2));
    return next;
  }

  reset(workspace: string): void {
    const dir = this.ws.normalize(workspace);
    const state = this.status(dir);
    if (state) {
      const manifest = this.ws.requireManifest(dir);
      manifest.profiles = manifest.profiles.filter((p) => p.id !== state.bisectProfile);
      writeManifest(dir, manifest);
    }
    fs.rmSync(this.file(dir), { force: true });
  }

  private resolvedFiles(dir: string, profileId: string): Record<string, string> {
    const f = path.join(stateDir(dir), `resolved-${profileId}.files.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).files : {};
  }

  private applyProfile(dir: string, state: BisectState, entries: LockEntry[]): void {
    const manifest = this.ws.requireManifest(dir);
    const base = manifest.profiles.find((p) => p.id === state.profile)!;
    const mods: ModRef[] = [];
    for (const key of state.current ?? []) {
      const e = entries.find((x) => x.key === key);
      if (!e) continue;
      if (e.provider === 'modrinth' && e.projectId) mods.push({ source: 'modrinth', projectId: e.projectId, versionId: e.versionId, title: e.title, required: true, usage: 'runtime', environment: 'both' });
      else if (e.provider === 'local') mods.push({ source: 'local', path: e.key.replace(/^local:/, ''), title: e.title, required: true, usage: 'runtime', environment: 'both' });
    }
    const bisectProfile = { ...structuredClone(base), id: state.bisectProfile, name: `${base.name} (bisect)`, mods };
    const idx = manifest.profiles.findIndex((p) => p.id === state.bisectProfile);
    if (idx >= 0) manifest.profiles[idx] = bisectProfile;
    else manifest.profiles.push(bisectProfile);
    writeManifest(dir, manifest);
    this.s.bus.emit('workspace.changed', { workspace: dir });
  }
}
