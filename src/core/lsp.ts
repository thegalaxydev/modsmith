import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { OperationInfo } from '../shared/types';
import type { Services } from './context';
import type { WorkspaceService } from './workspace';
import type { ProjectService } from './projects';
import type { OpContext } from './operations';

interface ServerDef {
  name: string;
  version: string;
  url: string;
  sha256: string;
  size: number;
  javaMin: number;
}

interface Session {
  workspace: string;
  language: string;
  child: ChildProcessWithoutNullStreams;
}

function configDirName(): string {
  if (process.platform === 'win32') return 'config_win';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'config_mac_arm' : 'config_mac';
  return process.arch === 'arm64' ? 'config_linux_arm' : 'config_linux';
}

function launcherJar(dir: string): string | null {
  const plugins = path.join(dir, 'plugins');
  if (!fs.existsSync(plugins)) return null;
  const jars = fs
    .readdirSync(plugins)
    .filter((n) => n.startsWith('org.eclipse.equinox.launcher_') && n.endsWith('.jar'))
    .sort();
  return jars.length ? path.join(plugins, jars[jars.length - 1]) : null;
}

export function fileUri(p: string): string {
  const segments = p
    .replace(/\\/g, '/')
    .split('/')
    .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)));
  const joined = segments.join('/');
  return joined.startsWith('/') ? `file://${joined}` : `file:///${joined}`;
}

function tarProgram(): string {
  if (process.platform === 'win32' && process.env.SystemRoot) {
    const p = path.join(process.env.SystemRoot, 'System32', 'tar.exe');
    if (fs.existsSync(p)) return p;
  }
  return 'tar';
}

async function sha256(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export class LspService {
  private sessions = new Map<string, Session>();

  constructor(
    private s: Services,
    private ws: WorkspaceService,
    private projects: ProjectService
  ) {}

  private server(language: string): ServerDef {
    const all = JSON.parse(fs.readFileSync(path.join(this.s.paths.resources, 'lsp.json'), 'utf8')) as Record<string, ServerDef>;
    const def = all[language];
    if (!def || typeof def !== 'object') throw new Error(`No language server is configured for ${language}`);
    return def;
  }

  private debuggerDef(): { name: string; version: string; url: string; sha256: string; size: number } | null {
    const all = JSON.parse(fs.readFileSync(path.join(this.s.paths.resources, 'lsp.json'), 'utf8')) as Record<string, ServerDef>;
    return all.javaDebug ?? null;
  }

  debuggerJar(): string | null {
    const def = this.debuggerDef();
    return def ? path.join(this.s.paths.data, 'lsp', `java-debug-${def.version}.jar`) : null;
  }

  private async installDebugger(ctx: OpContext) {
    const def = this.debuggerDef();
    const jar = this.debuggerJar();
    if (!def || !jar || fs.existsSync(jar)) return;
    ctx.progress(0.95, `Downloading ${def.name}`);
    ctx.log(`Downloading ${def.url}`);
    const res = await fetch(def.url, { signal: ctx.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${def.url}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== def.sha256.toLowerCase()) throw new Error(`Hash verification failed for ${def.url}: sha256 mismatch`);
    fs.mkdirSync(path.dirname(jar), { recursive: true });
    fs.writeFileSync(`${jar}.part`, bytes);
    fs.renameSync(`${jar}.part`, jar);
    ctx.log(`${def.name} ${def.version} installed (SHA-256 verified)`);
  }

  private installDir(def: ServerDef): string {
    return path.join(this.s.paths.data, 'lsp', `jdtls-${def.version}`);
  }

  async status(root: string, language: string) {
    const def = this.server(language);
    const dir = this.ws.normalize(root);
    const java = await this.s.java.select({ minMajor: def.javaMin ?? 21 });
    const session = [...this.sessions.entries()].find(([, v]) => v.workspace === dir && v.language === language)?.[0] ?? null;
    const dbg = this.debuggerDef();
    const jar = this.debuggerJar();
    return { language, server: def.name, version: def.version, size: def.size, installed: !!launcherJar(this.installDir(def)), javaMin: def.javaMin ?? 21, java: java?.version ?? null, trusted: this.s.store.isTrusted(dir), session, debugger: dbg ? { version: dbg.version, installed: !!jar && fs.existsSync(jar) } : null };
  }

  install(language: string): OperationInfo {
    const def = this.server(language);
    return this.s.ops.start({ kind: 'lsp.install', title: `Install ${def.name} ${def.version}` }, (ctx) => this.installInto(def, ctx));
  }

  private async installInto(def: ServerDef, ctx: OpContext) {
    const dir = this.installDir(def);
    if (launcherJar(dir)) {
      ctx.log(`Already installed in ${dir}`);
      await this.installDebugger(ctx);
      return { installed: true, dir };
    }
    const name = def.url.split('/').pop() ?? 'jdtls.tar.gz';
    const archive = path.join(this.s.paths.downloads, 'lsp', name);
    const want = def.sha256.toLowerCase();
    if (fs.existsSync(archive) && (await sha256(archive)) === want) ctx.log(`Using the downloaded ${name}`);
    else {
      fs.mkdirSync(path.dirname(archive), { recursive: true });
      const tmp = `${archive}.part`;
      ctx.log(`Downloading ${def.url}`);
      const res = await fetch(def.url, { signal: ctx.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} downloading ${def.url}`);
      const total = Number(res.headers.get('content-length') ?? 0);
      const out = fs.createWriteStream(tmp);
      let got = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        out.write(chunk);
        got += chunk.length;
        if (total) ctx.progress((got / total) * 0.85, `Downloading ${Math.floor(got / 1e6)} of ${Math.floor(total / 1e6)} MB`);
      }
      await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
      if ((await sha256(tmp)) !== want) {
        fs.rmSync(tmp, { force: true });
        throw new Error(`Hash verification failed for ${def.url}: sha256 mismatch`);
      }
      fs.renameSync(tmp, archive);
      ctx.log('Download verified (SHA-256)');
    }
    ctx.progress(0.9, 'Unpacking');
    const part = `${dir}.part`;
    fs.rmSync(part, { recursive: true, force: true });
    fs.mkdirSync(part, { recursive: true });
    const r = spawnSync(tarProgram(), ['-xzf', archive, '-C', part], { windowsHide: true, stdio: 'ignore' });
    if (r.status !== 0 || !launcherJar(part)) {
      fs.rmSync(part, { recursive: true, force: true });
      throw new Error(`Could not unpack ${name} (tar exit ${r.status})`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(part, dir);
    ctx.log(`Installed in ${dir}`);
    await this.installDebugger(ctx);
    return { installed: true, dir };
  }

  async start(root: string, language: string) {
    const dir = this.ws.normalize(root);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a folder`);
    this.ws.requireTrusted(dir);
    const def = this.server(language);
    const install = this.installDir(def);
    const jar = launcherJar(install);
    if (!jar) throw new Error(`${def.name} is not installed yet`);
    const min = def.javaMin ?? 21;
    const java = await this.s.java.select({ minMajor: min });
    if (!java) throw new Error(`${def.name} needs Java ${min} or newer`);
    for (const [id, v] of [...this.sessions.entries()]) {
      if (v.workspace !== dir || v.language !== language) continue;
      const exited = new Promise<void>((r) => (v.child.exitCode !== null ? r() : v.child.once('exit', () => r())));
      this.stop(id);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
    const key = crypto.createHash('sha1').update(dir.toLowerCase()).digest('hex').slice(0, 16);
    const data = path.join(this.s.paths.data, 'lsp', 'workspaces', key);
    fs.mkdirSync(data, { recursive: true });
    const child = spawn(
      java.executable,
      [
        '-Declipse.application=org.eclipse.jdt.ls.core.id1',
        '-Dosgi.bundles.defaultStartLevel=4',
        '-Declipse.product=org.eclipse.jdt.ls.core.product',
        '-Dlog.level=WARNING',
        '-Djava.import.generatesMetadataFilesAtProjectRoot=false',
        '-Xms256m',
        '-Xmx2G',
        '--add-modules=ALL-SYSTEM',
        '--add-opens',
        'java.base/java.util=ALL-UNNAMED',
        '--add-opens',
        'java.base/java.lang=ALL-UNNAMED',
        '-jar',
        jar,
        '-configuration',
        path.join(install, configDirName()),
        '-data',
        data
      ],
      { cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const id = crypto.randomBytes(8).toString('hex');
    this.sessions.set(id, { workspace: dir, language, child });
    let buf = Buffer.alloc(0);
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const m = /Content-Length:\s*(\d+)/i.exec(buf.subarray(0, end).toString('ascii'));
        const n = m ? Number(m[1]) : 0;
        if (buf.length < end + 4 + n) return;
        const message = buf.subarray(end + 4, end + 4 + n).toString('utf8');
        buf = buf.subarray(end + 4 + n);
        if (m) this.s.bus.emit('lsp.message', { session: id, message });
      }
    });
    child.on('exit', (code) => {
      this.sessions.delete(id);
      this.s.bus.emit('lsp.exited', { session: id, code });
    });
    let gradleHome: string | null = null;
    try {
      gradleHome = (await this.projects.resolveGradleJava(dir)).java.home;
    } catch {
      gradleHome = null;
    }
    return {
      session: id,
      rootUri: fileUri(dir),
      server: def.name,
      version: def.version,
      initializationOptions: {
        bundles: [this.debuggerJar()].filter((j): j is string => !!j && fs.existsSync(j)),
        settings: {
          java: {
            import: { generatesMetadataFilesAtProjectRoot: false, gradle: { enabled: true, wrapper: { enabled: true }, java: { home: gradleHome } }, maven: { enabled: false } },
            configuration: { updateBuildConfiguration: 'automatic' },
            eclipse: { downloadSources: true },
            completion: { enabled: true },
            signatureHelp: { enabled: true },
            format: { enabled: true }
          }
        },
        extendedClientCapabilities: { classFileContentsSupport: true, progressReportProvider: false }
      }
    };
  }

  send(session: string, message: string) {
    const target = this.sessions.get(session);
    if (!target) throw new Error(`No language server session ${session}`);
    target.child.stdin.write(`Content-Length: ${Buffer.byteLength(message, 'utf8')}\r\n\r\n${message}`);
    return { sent: true };
  }

  stop(session: string) {
    const target = this.sessions.get(session);
    this.sessions.delete(session);
    if (target) {
      const write = (m: string) => target.child.stdin.write(`Content-Length: ${Buffer.byteLength(m, 'utf8')}\r\n\r\n${m}`);
      try {
        write('{"jsonrpc":"2.0","id":"modsmith-shutdown","method":"shutdown"}');
        write('{"jsonrpc":"2.0","method":"exit"}');
      } catch {
        target.child.kill();
      }
      setTimeout(() => {
        if (target.child.exitCode === null) target.child.kill();
      }, 5000).unref();
    }
    return { stopped: !!target };
  }

  stopAll() {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }
}
