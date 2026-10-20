import fs from 'node:fs';
import path from 'node:path';
import type { LockEntry, ModRef } from './manifest';
import type { ModMetadata } from './jarmeta';
import { allModIds } from './jarmeta';
import type { ModrinthProject, ModrinthVersion } from './modrinth';
import { satisfies } from './versionrange';
import { pickVersion, primaryFile } from './modrinth';

export interface ResolveIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export type ProviderId = 'modrinth' | 'curseforge';

export type ResolvedVersion = ModrinthVersion & { distribution?: 'direct' | 'manual'; manualUrl?: string };

export interface ModProviderApi {
  project(id: string): Promise<ModrinthProject>;
  versions(projectId: string, loader: string, minecraft: string): Promise<ResolvedVersion[]>;
  version(versionId: string, projectId?: string): Promise<ResolvedVersion>;
  pick?(versions: ResolvedVersion[], loader: string, minecraft: string): ResolvedVersion | null;
}

export interface ResolverProvider {
  providers: Partial<Record<ProviderId, ModProviderApi>>;
  fetchFile(entry: LockEntry): Promise<string>;
  readMetadata(file: string): ModMetadata[];
  hashLocal(file: string): Promise<{ sha1: string; sha512: string; size: number }>;
}

export interface ResolveInput {
  loader: string;
  minecraft: string;
  side: 'client' | 'server';
  refs: { ref: ModRef; reason: string }[];
  providedModIds: string[];
  providedModrinthProjects: Record<string, string>;
  baseDir: string;
  extraEntries?: LockEntry[];
}

export interface ResolveResult {
  entries: LockEntry[];
  issues: ResolveIssue[];
  files: Record<string, string>;
  metadata: Record<string, ModMetadata[]>;
  optionalSuggestions: { projectId: string; provider: ProviderId; requestedBy: string }[];
}

interface QueueItem {
  provider: ProviderId;
  projectId: string;
  versionId?: string;
  reason: string;
  required: boolean;
  pinned: boolean;
}

const PROVIDER_LABEL: Record<ProviderId, string> = { modrinth: 'Modrinth', curseforge: 'CurseForge' };

function sideAllowed(project: ModrinthProject, side: 'client' | 'server'): boolean {
  const v = side === 'client' ? project.client_side : project.server_side;
  return v !== 'unsupported';
}

export async function resolveProfile(input: ResolveInput, provider: ResolverProvider): Promise<ResolveResult> {
  const issues: ResolveIssue[] = [];
  const entries: LockEntry[] = [...(input.extraEntries ?? [])];
  const files: Record<string, string> = {};
  const metadata: Record<string, ModMetadata[]> = {};
  const optionalSuggestions: ResolveResult['optionalSuggestions'] = [];
  const chosen = new Map<string, { versionId: string; pinned: boolean; reason: string }>();
  const incompatibilities: { key: string; by: string }[] = [];
  const queue: QueueItem[] = [];

  for (const { ref, reason } of input.refs) {
    if (ref.enabled === false) {
      issues.push({ severity: 'info', message: `${ref.title ?? describeRef(ref)} is disabled in this profile` });
      continue;
    }
    if (ref.environment !== 'both' && ref.environment !== input.side) {
      issues.push({ severity: 'info', message: `${ref.title ?? describeRef(ref)} skipped: ${ref.environment}-only and this profile is ${input.side}` });
      continue;
    }
    if (ref.source === 'modrinth') {
      if (ref.usage === 'compile') continue;
      queue.push({ provider: 'modrinth', projectId: ref.projectId, versionId: ref.versionId, reason, required: ref.required, pinned: !!ref.versionId });
    } else if (ref.source === 'curseforge') {
      queue.push({ provider: 'curseforge', projectId: ref.projectId, versionId: ref.fileId, reason, required: ref.required, pinned: !!ref.fileId });
    } else if (ref.source === 'local') {
      const abs = path.resolve(input.baseDir, ref.path);
      if (!fs.existsSync(abs)) {
        issues.push({ severity: ref.required ? 'error' : 'warning', message: `Local mod file not found: ${ref.path}` });
        continue;
      }
      const h = await provider.hashLocal(abs);
      let meta: ModMetadata[] = [];
      try {
        meta = provider.readMetadata(abs);
      } catch (err) {
        issues.push({ severity: 'warning', message: `Could not read mod metadata from ${path.basename(abs)}: ${(err as Error).message}` });
      }
      const e: LockEntry = { key: `local:${ref.path}`, provider: 'local', title: ref.title ?? meta[0]?.name ?? path.basename(abs), fileName: path.basename(abs), sha1: h.sha1, sha512: h.sha512, size: h.size, modIds: allModIds(meta), license: meta[0]?.license, reason, required: ref.required };
      entries.push(e);
      files[e.key] = abs;
      metadata[e.key] = meta;
    }
  }

  while (queue.length) {
    const item = queue.shift()!;
    const api = provider.providers[item.provider];
    const label = PROVIDER_LABEL[item.provider];
    const key = `${item.provider}:${item.projectId}`;
    if (!api) {
      issues.push({ severity: item.required ? 'error' : 'warning', message: `${label} project ${item.projectId} cannot be resolved: ${label} is not configured (${item.reason})` });
      continue;
    }
    if (item.provider === 'modrinth' && input.providedModrinthProjects[item.projectId]) {
      issues.push({ severity: 'info', message: `${input.providedModrinthProjects[item.projectId]} (${item.projectId}) is already provided by the development classpath; not added to the instance (${item.reason})` });
      continue;
    }
    const existing = chosen.get(key);
    if (existing) {
      if (item.versionId && item.versionId !== existing.versionId) {
        if (item.pinned && !existing.pinned) {
          issues.push({ severity: 'warning', message: `${label} project ${item.projectId}: pinned version ${item.versionId} replaces ${existing.versionId} chosen for ${existing.reason}` });
          const idx = entries.findIndex((e) => e.key === key);
          if (idx >= 0) entries.splice(idx, 1);
          chosen.delete(key);
        } else {
          issues.push({ severity: 'warning', message: `${label} project ${item.projectId}: ${item.reason} requests version ${item.versionId} but ${existing.versionId} is already selected (${existing.reason}). Keeping the existing selection; compatibility is unknown.` });
          continue;
        }
      } else {
        continue;
      }
    }
    let project: ModrinthProject;
    try {
      project = await api.project(item.projectId);
    } catch (err) {
      issues.push({ severity: item.required ? 'error' : 'warning', message: `Could not fetch ${label} project ${item.projectId}: ${(err as Error).message}` });
      continue;
    }
    if (!sideAllowed(project, input.side)) {
      issues.push({ severity: 'info', message: `${project.title} skipped: ${label} marks it unsupported on the ${input.side} side` });
      continue;
    }
    let version: ResolvedVersion | null = null;
    try {
      if (item.versionId) {
        version = await api.version(item.versionId, project.id);
        if (!version.loaders.includes(input.loader) || !version.game_versions.includes(input.minecraft)) {
          issues.push({ severity: 'warning', message: `${project.title} ${version.version_number} does not declare ${input.loader} ${input.minecraft} support on ${label}` });
        }
      } else {
        const all = await api.versions(project.id, input.loader, input.minecraft);
        version = api.pick ? api.pick(all, input.loader, input.minecraft) : pickVersion(all, input.loader, input.minecraft);
      }
    } catch (err) {
      issues.push({ severity: item.required ? 'error' : 'warning', message: `Could not fetch versions for ${project.title}: ${(err as Error).message}` });
      continue;
    }
    if (!version) {
      issues.push({ severity: item.required ? 'error' : 'warning', message: `${project.title} has no ${input.loader} version for Minecraft ${input.minecraft} on ${label} (${item.reason})` });
      continue;
    }
    const file = primaryFile(version);
    if (!file) {
      issues.push({ severity: 'error', message: `${project.title} ${version.version_number} has no downloadable file` });
      continue;
    }
    chosen.set(key, { versionId: version.id, pinned: item.pinned, reason: item.reason });
    const entry: LockEntry = {
      key,
      provider: item.provider,
      projectId: project.id,
      versionId: version.id,
      versionNumber: version.version_number,
      title: project.title,
      fileName: file.filename,
      url: file.url || undefined,
      sha1: file.hashes.sha1 || undefined,
      sha512: file.hashes.sha512 || undefined,
      size: file.size,
      modIds: [],
      license: project.license?.id,
      environment: { client: project.client_side, server: project.server_side },
      distribution: version.distribution ?? 'direct',
      manualUrl: version.manualUrl,
      reason: item.reason,
      required: item.required
    };
    entries.push(entry);
    if (entry.distribution === 'manual') {
      issues.push({ severity: 'warning', message: `${project.title}: the author does not allow third-party downloads. Download ${file.filename} manually from ${version.manualUrl} and provide it with Mods > Provide downloaded file.` });
    }
    for (const dep of version.dependencies) {
      if (dep.dependency_type === 'embedded') continue;
      let depProject = dep.project_id;
      if (!depProject && dep.version_id) {
        try {
          depProject = (await api.version(dep.version_id)).project_id;
        } catch {
          depProject = null;
        }
      }
      if (!depProject) continue;
      if (dep.dependency_type === 'required') queue.push({ provider: item.provider, projectId: depProject, versionId: dep.version_id ?? undefined, reason: `required by ${project.title}`, required: true, pinned: false });
      else if (dep.dependency_type === 'optional') optionalSuggestions.push({ projectId: depProject, provider: item.provider, requestedBy: project.title });
      else if (dep.dependency_type === 'incompatible') incompatibilities.push({ key: `${item.provider}:${depProject}`, by: project.title });
    }
  }

  for (const e of entries) {
    if (e.provider !== 'modrinth' && e.provider !== 'curseforge') continue;
    let f: string;
    try {
      f = await provider.fetchFile(e);
      files[e.key] = f;
    } catch (err) {
      issues.push({ severity: e.required ? 'error' : 'warning', message: `${e.distribution === 'manual' ? 'Manual file missing' : 'Download failed'} for ${e.title}: ${(err as Error).message}` });
      continue;
    }
    let meta: ModMetadata[];
    try {
      meta = provider.readMetadata(f);
    } catch (err) {
      metadata[e.key] = [];
      issues.push({ severity: 'warning', message: `Could not read the mod metadata of ${e.fileName}: ${(err as Error).message}. It is still loaded; its dependencies were not checked.` });
      continue;
    }
    metadata[e.key] = meta;
    e.modIds = allModIds(meta);
    if (!meta.length) issues.push({ severity: 'warning', message: `${e.fileName} has no recognizable mod metadata` });
    else if (meta[0].loader !== input.loader) {
      issues.push({ severity: 'error', message: `${e.fileName} is a ${meta[0].loader} mod, not ${input.loader}` });
    }
  }

  for (const inc of incompatibilities) {
    if (chosen.has(inc.key)) {
      const other = entries.find((e) => e.key === inc.key);
      issues.push({ severity: 'error', message: `${inc.by} declares ${other?.title ?? inc.key} incompatible` });
    }
  }

  const provided = new Set([...input.providedModIds, ...(input.extraEntries ?? []).flatMap((e) => e.modIds ?? [])]);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e.reason.startsWith('pack ') && !e.reason.startsWith('linked pack ')) continue;
    const own = (metadata[e.key] ?? []).flatMap((m) => [m.id, ...m.provides]);
    const clash = own.find((id) => provided.has(id));
    if (!clash) continue;
    entries.splice(i, 1);
    delete files[e.key];
    delete metadata[e.key];
    chosen.delete(e.key);
    issues.push({ severity: 'info', message: `${e.title} from the ${e.reason.replace(/^(linked )?pack /, '')} pack not loaded: "${clash}" comes from this project's development build instead` });
  }

  const loaderIds = input.loader === 'neoforge' ? ['neoforge'] : input.loader === 'forge' ? ['forge'] : ['fabricloader'];
  issues.push(...checkModGraph(entries, metadata, [...input.providedModIds, ...loaderIds.filter((id) => !input.providedModIds.includes(id))]));
  return { entries, issues, files, metadata, optionalSuggestions };
}

export function describeRef(ref: ModRef): string {
  if (ref.source === 'modrinth') return `modrinth:${ref.slug ?? ref.projectId}`;
  if (ref.source === 'curseforge') return `curseforge:${ref.projectId}`;
  if (ref.source === 'local') return `local:${ref.path}`;
  return `maven:${ref.coordinates}`;
}

export function checkModGraph(entries: LockEntry[], metadata: Record<string, ModMetadata[]>, providedModIds: string[]): ResolveIssue[] {
  const issues: ResolveIssue[] = [];
  const owners = new Map<string, string[]>();
  const topIds = new Map<string, string[]>();
  for (const e of entries) {
    const meta = metadata[e.key] ?? [];
    for (const m of meta) {
      const list = topIds.get(m.id) ?? [];
      list.push(e.title);
      topIds.set(m.id, list);
    }
    for (const id of e.modIds) {
      const list = owners.get(id) ?? [];
      if (!list.includes(e.title)) list.push(e.title);
      owners.set(id, list);
    }
  }
  for (const [id, list] of topIds) {
    if (list.length > 1) issues.push({ severity: 'error', message: `Duplicate mod ID "${id}" provided by: ${list.join(', ')}` });
    if (providedModIds.includes(id)) issues.push({ severity: 'error', message: `Mod ID "${id}" from ${list.join(', ')} duplicates a mod on the development classpath` });
  }
  const fileNames = new Map<string, string[]>();
  for (const e of entries) {
    const l = fileNames.get(e.fileName.toLowerCase()) ?? [];
    l.push(e.title);
    fileNames.set(e.fileName.toLowerCase(), l);
  }
  for (const [name, list] of fileNames) if (list.length > 1) issues.push({ severity: 'error', message: `Conflicting file name ${name} from: ${list.join(', ')}` });
  const hashes = new Map<string, string[]>();
  for (const e of entries) {
    if (!e.sha1) continue;
    const l = hashes.get(e.sha1) ?? [];
    l.push(`${e.title} (${e.provider})`);
    hashes.set(e.sha1, l);
  }
  for (const [, list] of hashes) if (list.length > 1) issues.push({ severity: 'error', message: `The same file is included more than once: ${list.join(', ')}` });
  const available = new Set<string>([...owners.keys(), ...providedModIds, 'minecraft', 'java', 'fabricloader']);
  const versions = new Map<string, { title: string; version: string }[]>();
  const addVersions = (title: string, m: ModMetadata) => {
    for (const id of [m.id, ...m.provides]) {
      const list = versions.get(id) ?? [];
      list.push({ title, version: m.version });
      versions.set(id, list);
    }
    for (const n of m.nested) addVersions(title, n);
  };
  for (const e of entries) for (const m of metadata[e.key] ?? []) addVersions(e.title, m);
  for (const e of entries) {
    for (const m of metadata[e.key] ?? []) {
      for (const dep of Object.keys(m.depends)) {
        if (!available.has(dep)) issues.push({ severity: 'warning', message: `${e.title} (${m.id}) declares a dependency on "${dep}" which is not present. Version ranges were not evaluated.` });
      }
      for (const [b, range] of [...Object.entries(m.breaks).map(([k, v]) => [k, v, true] as const), ...Object.entries(m.conflicts).map(([k, v]) => [k, v, false] as const)].map(([k, v, hard]) => [k, { range: v, hard }] as const)) {
        if (!owners.has(b)) continue;
        const present = versions.get(b) ?? [];
        const verdicts = present.length ? present.map((v) => satisfies(v.version, range.range)) : [null];
        if (verdicts.every((v) => v === false)) continue;
        const kind = range.hard ? 'breaking' : 'conflicting';
        const which = present.length ? present.map((v) => `${v.title} ${v.version}`).join(', ') : owners.get(b)!.join(', ');
        const known = verdicts.some((v) => v === true);
        const rangeText = range.range && range.range !== '*' ? ` for versions ${range.range}` : '';
        issues.push({ severity: range.hard && known ? 'error' : 'warning', message: `${e.title} (${m.id}) declares "${b}" as ${kind}${rangeText}, and ${known ? 'a matching version is present' : 'it is present (version range could not be checked)'}: ${which}` });
      }
    }
  }
  return issues;
}
