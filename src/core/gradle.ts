import fs from 'node:fs';
import path from 'node:path';
import type { Diagnostic, JavaInstallation } from '../shared/types';
import { runProcess } from './proc';
import type { OpContext } from './operations';

export interface GradleRunOptions {
  projectDir: string;
  tasks: string[];
  java: JavaInstallation;
  initScript?: string;
  systemProps?: Record<string, string>;
  extraArgs?: string[];
  ctx: OpContext;
  offline?: boolean;
}

export interface GradleResult {
  ok: boolean;
  exitCode: number | null;
  diagnostics: Diagnostic[];
  durationMs: number;
  output: string[];
}

export function wrapperPath(projectDir: string): string | null {
  const name = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  const p = path.join(projectDir, name);
  return fs.existsSync(p) ? p : null;
}

export function wrapperVersion(projectDir: string): string | null {
  const props = path.join(projectDir, 'gradle', 'wrapper', 'gradle-wrapper.properties');
  if (!fs.existsSync(props)) return null;
  const m = fs.readFileSync(props, 'utf8').match(/gradle-([\d.]+(?:-[a-z0-9-]+)?)-(?:bin|all)\.zip/);
  return m ? m[1] : null;
}

export function parseGradleDiagnostics(lines: string[], projectDir: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const javac = /^(?:e: )?(.+\.(?:java|kt|groovy)):(\d+)(?::(\d+))?: (error|warning): (.*)$/;
  const kotlin = /^([ew]): file:\/\/\/?(.+\.kts?):(\d+):(\d+) (.*)$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = line.match(javac);
    if (m) {
      out.push({ severity: m[4] === 'error' ? 'error' : 'warning', message: m[5], file: path.resolve(projectDir, m[1]), line: Number(m[2]), column: m[3] ? Number(m[3]) : undefined, source: 'javac' });
      continue;
    }
    m = line.match(kotlin);
    if (m) {
      out.push({ severity: m[1] === 'e' ? 'error' : 'warning', message: m[5], file: m[2], line: Number(m[3]), column: Number(m[4]), source: 'kotlinc' });
      continue;
    }
    if (line.startsWith('* What went wrong:')) {
      const msg: string[] = [];
      for (let j = i + 1; j < lines.length && !lines[j].startsWith('* Try:') && !lines[j].startsWith('* Exception is:'); j++) {
        if (lines[j].trim()) msg.push(lines[j].trim());
      }
      out.push({ severity: 'error', message: msg.join(' ').slice(0, 2000), source: 'gradle' });
    }
    const buildFile = line.match(/^Build file '(.+)' line: (\d+)/);
    if (buildFile) out.push({ severity: 'error', message: 'Build script error', file: buildFile[1], line: Number(buildFile[2]), source: 'gradle' });
  }
  return out;
}

export async function runGradle(opts: GradleRunOptions): Promise<GradleResult> {
  const wrapper = wrapperPath(opts.projectDir);
  const wrapperJar = path.join(opts.projectDir, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  if (!wrapper || !fs.existsSync(wrapperJar)) throw new Error(`No Gradle wrapper found in ${opts.projectDir}. Modsmith only runs builds through the project's own wrapper.`);
  const args = ['--console=plain', '--no-configuration-cache'];
  if (opts.offline) args.push('--offline');
  if (opts.initScript) args.push('-I', opts.initScript);
  for (const [k, v] of Object.entries(opts.systemProps ?? {})) args.push(`-D${k}=${v}`);
  args.push(...(opts.extraArgs ?? []), ...opts.tasks);
  const env: NodeJS.ProcessEnv = { ...process.env, JAVA_HOME: opts.java.home };
  delete env.JAVA_TOOL_OPTIONS;
  env.PATH = `${path.join(opts.java.home, 'bin')}${path.delimiter}${env.PATH ?? ''}`;
  const output: string[] = [];
  const started = Date.now();
  opts.ctx.log(`> ${path.basename(wrapper)} ${args.join(' ')}`);
  opts.ctx.log(`> JAVA_HOME=${opts.java.home} (Java ${opts.java.version})`);
  let taskCount = 0;
  const jvm = ['-Xmx64m', '-Xms64m', '-Dorg.gradle.appname=gradlew', '-classpath', wrapperJar, 'org.gradle.wrapper.GradleWrapperMain'];
  const res = await runProcess(opts.java.executable, [...jvm, ...args], {
    cwd: opts.projectDir,
    env,
    signal: opts.ctx.signal,
    onLine: (line) => {
      output.push(line);
      opts.ctx.log(line);
      const t = line.match(/^> Task (\S+)/);
      if (t) {
        taskCount++;
        opts.ctx.progress(null, `Gradle ${t[1]} (${taskCount} tasks)`);
      }
    }
  });
  const diagnostics = parseGradleDiagnostics(output, opts.projectDir);
  return { ok: res.code === 0, exitCode: res.code, diagnostics, durationMs: Date.now() - started, output };
}
