import fs from 'node:fs';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import type { InstanceInfo } from '../shared/types';
import { PRODUCT } from '../shared/product';
import type { Services } from './context';
import { readLock } from './manifest';
import { stateDir } from './workspace';
import { execCapture } from './proc';
import { redactText } from './redact';
import { findCrashReport } from './instances';

export interface CrashAnalysis {
  instance: Pick<InstanceInfo, 'id' | 'profileId' | 'side' | 'mode' | 'status' | 'exitCode' | 'startedAt' | 'endedAt' | 'javaExecutable'>;
  crashReport: string | null;
  observed: {
    description?: string;
    exception?: string;
    stackHead: string[];
    suspectedModsFromReport: string[];
    javaVersion?: string;
    minecraftVersion?: string;
    loadedModsCount?: number;
    errorLines: string[];
    exitCode?: number | null;
  };
  hypotheses: { text: string; basis: string }[];
  recentChanges: string[];
  note: string;
}

function section(text: string, header: string): string | undefined {
  const i = text.indexOf(header);
  if (i < 0) return undefined;
  return text.slice(i + header.length);
}

export function parseCrashReport(text: string) {
  const description = text.match(/^Description: (.*)$/m)?.[1];
  const lines = text.split(/\r?\n/);
  const descIdx = lines.findIndex((l) => l.startsWith('Description:'));
  let exception: string | undefined;
  const stackHead: string[] = [];
  if (descIdx >= 0) {
    for (let i = descIdx + 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      exception = lines[i].trim();
      for (let j = i + 1; j < lines.length && stackHead.length < 15 && lines[j].startsWith('\t'); j++) stackHead.push(lines[j].trim());
      break;
    }
  }
  const suspects: string[] = [];
  const sus = section(text, 'Suspected Mods:');
  if (sus) {
    for (const l of sus.split(/\r?\n/).slice(0, 20)) {
      const m = l.match(/^\s+([^(]+) \(([^)]+)\)/);
      if (m) suspects.push(`${m[1].trim()} (${m[2]})`);
      else if (l.trim() && !l.startsWith('\t') && !l.startsWith(' ')) break;
    }
  }
  const javaVersion = text.match(/Java Version: (.*)$/m)?.[1];
  const minecraftVersion = text.match(/Minecraft Version: (.*)$/m)?.[1];
  const modsCount = text.match(/Fabric Mods:\s*\n([\s\S]*?)\n\s*\n/)?.[1]?.split('\n').filter((l) => /^\t\t\S/.test(l)).length;
  return { description, exception, stackHead, suspectedModsFromReport: suspects, javaVersion, minecraftVersion, loadedModsCount: modsCount };
}

export function hypothesize(text: string): { text: string; basis: string }[] {
  const out: { text: string; basis: string }[] = [];
  const rules: [RegExp, string][] = [
    [/Mixin apply (?:for mod (\S+) )?failed|InvalidInjectionException|InjectionError/, 'A mixin failed to apply; a mod targets code that differs in this Minecraft or mod version.'],
    [/Incompatible mods? found|Mod resolution encountered an incompatible mod set/, 'Fabric Loader rejected the mod set because of missing or incompatible dependencies.'],
    [/requires (?:any version|version [^ ]+) of ([\w-]+), which is missing/, 'A declared dependency is missing from the instance.'],
    [/NoSuchMethodError|NoSuchFieldError|NoClassDefFoundError|ClassNotFoundException/, 'A class or member is missing at runtime: likely a version mismatch or a development-only dependency that is absent in production.'],
    [/OutOfMemoryError/, 'The JVM ran out of memory; increase the profile memory or look for leaks.'],
    [/Registry is already frozen|Duplicate registration|already registered/i, 'A registry entry was registered twice or too late.'],
    [/Failed to remap mods|ClassNotFoundException: net\.minecraft\.class_\d+|Found a remappable @Shadow annotation/, 'A released mod cannot run in the development environment (it relies on production class names). Turn on Release build for this profile to test with the built JAR in a normal game.'],
    [/Could not find any mod with id|refmap/i, 'Mapping or refmap problem; development and production namespaces may differ.'],
    [/UnsupportedClassVersionError/, 'A class was compiled for a newer Java version than the runtime.'],
    [/GLFW error|OpenGL|Pixel format not accelerated/i, 'Graphics driver or OpenGL context problem.']
  ];
  for (const [re, msg] of rules) {
    const m = text.match(re);
    if (m) out.push({ text: msg, basis: `matched "${m[0].slice(0, 120)}"` });
  }
  return out;
}

export class CrashService {
  constructor(private s: Services) {}

  async inspect(id: string): Promise<CrashAnalysis> {
    const info = this.s.instances.get(id);
    if (!info) throw new Error(`Unknown instance ${id}`);
    const report = info.crashReport ?? findCrashReport(info.instanceDir, info.startedAt) ?? null;
    const reportText = report && fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : '';
    const { lines } = this.s.instances.logs(id, { limit: 50000 });
    const errorLines = lines.filter((l) => l.level === 'ERROR' || l.level === 'FATAL').slice(-60).map((l) => l.text);
    const logText = lines.slice(-4000).map((l) => l.text).join('\n');
    const parsed = reportText ? parseCrashReport(reportText) : { stackHead: [], suspectedModsFromReport: [] };
    const recentChanges = await this.recentChanges(info.workspace);
    return {
      instance: { id: info.id, profileId: info.profileId, side: info.side, mode: info.mode, status: info.status, exitCode: info.exitCode, startedAt: info.startedAt, endedAt: info.endedAt, javaExecutable: info.javaExecutable },
      crashReport: report,
      observed: { ...parsed, errorLines, exitCode: info.exitCode },
      hypotheses: hypothesize(`${reportText}\n${logText}`),
      recentChanges,
      note: 'Observed facts come from the crash report, the process exit code and the captured log. Hypotheses are automated pattern matches and may be wrong; "Suspected Mods" is Minecraft\'s own stack-based heuristic.'
    };
  }

  async recentChanges(workspace: string): Promise<string[]> {
    if (fs.existsSync(path.join(workspace, '.git'))) {
      const st = await execCapture('git', ['-C', workspace, 'status', '--porcelain'], 10000);
      const log = await execCapture('git', ['-C', workspace, 'log', '-5', '--pretty=%h %ad %s', '--date=iso'], 10000);
      return [...st.stdout.split('\n').filter(Boolean).map((l) => `uncommitted: ${l.trim()}`), ...log.stdout.split('\n').filter(Boolean).map((l) => `commit: ${l}`)].slice(0, 60);
    }
    const out: { f: string; t: number }[] = [];
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const walk = (d: string, depth: number) => {
      if (depth > 8) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (['build', '.gradle', '.git', PRODUCT.stateDir, 'run', 'node_modules'].includes(e.name)) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else {
          const t = fs.statSync(full).mtimeMs;
          if (t > cutoff) out.push({ f: path.relative(workspace, full), t });
        }
      }
    };
    if (fs.existsSync(workspace)) walk(workspace, 0);
    return out.sort((a, b) => b.t - a.t).slice(0, 40).map((x) => `modified ${new Date(x.t).toISOString()}: ${x.f}`);
  }

  async bundle(id: string, notes?: string): Promise<{ file: string }> {
    const a = await this.inspect(id);
    const info = this.s.instances.get(id)!;
    const files: Record<string, Uint8Array> = {};
    const add = (name: string, text: string) => (files[name] = strToU8(redactText(text)));
    add('analysis.json', JSON.stringify(a, null, 2));
    if (a.crashReport && fs.existsSync(a.crashReport)) add(`crash-report/${path.basename(a.crashReport)}`, fs.readFileSync(a.crashReport, 'utf8'));
    if (fs.existsSync(info.logFile)) add('logs/session.log', fs.readFileSync(info.logFile, 'utf8'));
    const latest = path.join(info.instanceDir, 'logs', 'latest.log');
    if (fs.existsSync(latest)) add('logs/latest.log', fs.readFileSync(latest, 'utf8'));
    try {
      const lock = readLock(info.workspace);
      add('profile/resolved.json', JSON.stringify(lock.profiles[info.mode === 'production' ? `${info.profileId}@production` : info.profileId] ?? null, null, 2));
    } catch {
      void 0;
    }
    const manifestFile = path.join(info.workspace, PRODUCT.manifestFile);
    if (fs.existsSync(manifestFile)) add('profile/manifest.json', fs.readFileSync(manifestFile, 'utf8'));
    add('environment.txt', `java: ${info.javaExecutable}\nside: ${info.side}\nmode: ${info.mode}\nos: ${process.platform} ${process.arch}\n${PRODUCT.name}: ${PRODUCT.version}\nbridge game: ${JSON.stringify(info.bridge.game ?? null)}\n`);
    add('recent-changes.txt', a.recentChanges.join('\n'));
    add('reproduction-notes.md', `# Reproduction notes\n\n${notes ?? '(none provided)'}\n\n## Observed\n\n- Exit code: ${a.observed.exitCode}\n- Description: ${a.observed.description ?? 'n/a'}\n- Exception: ${a.observed.exception ?? 'n/a'}\n\n## Automated hypotheses (unverified)\n\n${a.hypotheses.map((h) => `- ${h.text} (${h.basis})`).join('\n') || '- none'}\n`);
    const dir = path.join(stateDir(info.workspace), 'crash-bundles');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `crash-${info.profileId}-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
    fs.writeFileSync(file, zipSync(files));
    return { file };
  }
}
