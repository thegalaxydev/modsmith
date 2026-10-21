import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JavaInstallation } from '../shared/types';
import { execCapture } from './proc';
import type { Store } from './db';

const exe = process.platform === 'win32' ? 'java.exe' : 'java';
const javacExe = process.platform === 'win32' ? 'javac.exe' : 'javac';

function childDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .map((name) => path.join(dir, name))
      .filter((p) => {
        try {
          return fs.statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

export function candidateHomes(): { home: string; source: string }[] {
  const out: { home: string; source: string }[] = [];
  const add = (home: string | undefined, source: string) => {
    if (!home) return;
    out.push({ home: path.resolve(home), source });
  };
  add(process.env.JAVA_HOME, 'JAVA_HOME');
  for (const p of (process.env.PATH ?? '').split(path.delimiter)) {
    if (p && fs.existsSync(path.join(p, exe))) add(path.dirname(p), 'PATH');
  }
  const roots: string[] = [];
  if (process.platform === 'win32') {
    for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files']) {
      if (!pf) continue;
      for (const vendor of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru', 'GraalVM', 'Temurin']) {
        roots.push(path.join(pf, vendor));
      }
    }
  } else if (process.platform === 'darwin') {
    roots.push('/Library/Java/JavaVirtualMachines');
  } else {
    roots.push('/usr/lib/jvm');
  }
  roots.push(path.join(os.homedir(), '.jdks'), path.join(os.homedir(), '.gradle', 'jdks'));
  for (const r of roots) {
    for (const d of childDirs(r)) {
      add(d, r);
      if (process.platform === 'darwin') add(path.join(d, 'Contents', 'Home'), r);
    }
  }
  return out;
}

export function parseJavaSettings(text: string): { version: string; vendor: string; arch: string; home: string } | null {
  const get = (k: string) => {
    const m = text.match(new RegExp(`^\\s*${k.replace('.', '\\.')} = (.*)$`, 'm'));
    return m ? m[1].trim() : '';
  };
  const version = get('java.version');
  if (!version) return null;
  return { version, vendor: get('java.vendor'), arch: get('os.arch'), home: get('java.home') };
}

export function majorOf(version: string): number {
  const parts = version.split(/[.+-]/);
  const first = parseInt(parts[0], 10);
  if (first === 1) return parseInt(parts[1], 10);
  return first;
}

export async function probeJava(home: string): Promise<Omit<JavaInstallation, 'sources'> | null> {
  const bin = path.join(home, 'bin', exe);
  if (!fs.existsSync(bin)) return null;
  const res = await execCapture(bin, ['-XshowSettings:properties', '-version'], 15000);
  const parsed = parseJavaSettings(res.stderr + '\n' + res.stdout);
  if (!parsed) return null;
  const realHome = parsed.home ? path.resolve(parsed.home) : path.resolve(home);
  return {
    home: realHome,
    executable: path.join(realHome, 'bin', exe),
    version: parsed.version,
    major: majorOf(parsed.version),
    vendor: parsed.vendor,
    arch: parsed.arch,
    isJdk: fs.existsSync(path.join(realHome, 'bin', javacExe))
  };
}

export class JavaService {
  private cache: JavaInstallation[] | null = null;

  constructor(private store: Store) {}

  async list(refresh = false): Promise<JavaInstallation[]> {
    if (this.cache && !refresh) return this.cache;
    if (!refresh) {
      const stored = this.store.getKv<{ at: number; list: JavaInstallation[] }>('java.installations');
      if (stored && Date.now() - stored.at < 6 * 3600 * 1000 && stored.list.every((j) => fs.existsSync(j.executable))) {
        this.cache = stored.list;
        return stored.list;
      }
    }
    const seen = new Map<string, JavaInstallation>();
    const extra = this.store.getKv<string[]>('java.extraHomes') ?? [];
    const candidates = [...candidateHomes(), ...extra.map((h) => ({ home: h, source: 'user' }))];
    const probed = await Promise.all(candidates.map(async (c) => ({ c, info: await probeJava(c.home).catch(() => null) })));
    for (const { c, info } of probed) {
      if (!info) continue;
      const key = info.home.toLowerCase();
      const existing = seen.get(key);
      if (existing) {
        if (!existing.sources.includes(c.source)) existing.sources.push(c.source);
      } else {
        seen.set(key, { ...info, sources: [c.source] });
      }
    }
    const list = [...seen.values()].sort((a, b) => b.major - a.major || a.home.localeCompare(b.home));
    this.cache = list;
    this.store.setKv('java.installations', { at: Date.now(), list });
    return list;
  }

  async addHome(home: string): Promise<JavaInstallation> {
    const info = await probeJava(home);
    if (!info) throw new Error(`No Java runtime found at ${home}`);
    const extra = new Set(this.store.getKv<string[]>('java.extraHomes') ?? []);
    extra.add(info.home);
    this.store.setKv('java.extraHomes', [...extra]);
    await this.list(true);
    return { ...info, sources: ['user'] };
  }

  async select(opts: { minMajor: number; maxMajor?: number; requireJdk?: boolean; preferHome?: string }): Promise<JavaInstallation | null> {
    const list = await this.list();
    if (opts.preferHome) {
      const pref = list.find((j) => j.home.toLowerCase() === path.resolve(opts.preferHome!).toLowerCase());
      if (pref && pref.major >= opts.minMajor && (!opts.maxMajor || pref.major <= opts.maxMajor) && (!opts.requireJdk || pref.isJdk)) return pref;
    }
    const ok = list.filter((j) => j.major >= opts.minMajor && (!opts.maxMajor || j.major <= opts.maxMajor) && (!opts.requireJdk || j.isJdk) && (j.arch.includes('64') || j.arch === ''));
    ok.sort((a, b) => a.major - b.major);
    return ok[0] ?? null;
  }
}
