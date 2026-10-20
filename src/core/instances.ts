import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { InstanceInfo, LaunchMode, Side } from '../shared/types';
import { ENV } from '../shared/product';
import type { BridgeHost } from './bridge';
import type { EventBus } from './events';
import type { Store } from './db';
import { LogBuffer } from './logs';
import { isAlive, killTree, streamLines } from './proc';
import { redactText } from './redact';

export interface LaunchSpec {
  workspace: string;
  profileId: string;
  side: Side;
  mode: LaunchMode;
  instanceDir: string;
  java: string;
  args: string[];
  env?: Record<string, string>;
  bridge: boolean;
  debugPort?: number;
  operationId?: string;
}

interface Running {
  info: InstanceInfo;
  child: ChildProcess;
  logs: LogBuffer;
  logStream: fs.WriteStream;
  exited: Promise<void>;
  bridgeSessionId?: string;
}

export class InstanceManager {
  private running = new Map<string, Running>();
  private history = new Map<string, { info: InstanceInfo; logs: LogBuffer }>();

  constructor(private bus: EventBus, private store: Store, private bridge: BridgeHost) {
    bus.on((event, data) => {
      if (event === 'bridge.connected' || event === 'bridge.disconnected') {
        const d = data as { instanceId: string; game?: Record<string, unknown> };
        const r = this.running.get(d.instanceId);
        if (!r) return;
        r.info.bridge = { connected: event === 'bridge.connected', protocol: event === 'bridge.connected' ? 1 : r.info.bridge.protocol, game: d.game ?? r.info.bridge.game };
        r.logs.push('system', event === 'bridge.connected' ? '[Modsmith] Bridge connected' : '[Modsmith] Bridge disconnected');
        this.emit(r);
      }
    });
  }

  private emit(r: Running): void {
    this.bus.emit('instance.updated', { ...r.info });
  }

  activeForDir(instanceDir: string): InstanceInfo | undefined {
    const key = path.resolve(instanceDir).toLowerCase();
    return [...this.running.values()].map((r) => r.info).find((i) => path.resolve(i.instanceDir).toLowerCase() === key && !['exited', 'crashed', 'failed'].includes(i.status));
  }

  launch(spec: LaunchSpec): InstanceInfo {
    const conflict = this.activeForDir(spec.instanceDir);
    if (conflict) throw new Error(`Instance directory ${spec.instanceDir} is already in use by instance ${conflict.id} (pid ${conflict.pid}). Stop it first or use another profile.`);
    fs.mkdirSync(spec.instanceDir, { recursive: true });
    const id = crypto.randomUUID();
    const logDir = path.join(spec.instanceDir, 'logs', 'modsmith');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `session-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    const env: NodeJS.ProcessEnv = { ...process.env, ...(spec.env ?? {}) };
    delete env.JAVA_TOOL_OPTIONS;
    delete env._JAVA_OPTIONS;
    if (process.platform === 'linux' && spec.side === 'client' && process.env.MODSMITH_NATIVE_WAYLAND !== '1' && process.env.DISPLAY) delete env.WAYLAND_DISPLAY;
    let sessionId: string | undefined;
    if (spec.bridge) {
      const s = this.bridge.createSession(id);
      sessionId = s.id;
      env[ENV.bridgeUrl] = this.bridge.url();
      env[ENV.bridgeToken] = s.token;
      env[ENV.bridgeSession] = s.id;
    } else {
      delete env[ENV.bridgeUrl];
      delete env[ENV.bridgeToken];
      delete env[ENV.bridgeSession];
    }
    const info: InstanceInfo = {
      id,
      workspace: spec.workspace,
      profileId: spec.profileId,
      side: spec.side,
      mode: spec.mode,
      status: 'starting',
      instanceDir: spec.instanceDir,
      startedAt: Date.now(),
      bridge: { connected: false },
      debugPort: spec.debugPort,
      javaExecutable: spec.java,
      operationId: spec.operationId,
      logFile
    };
    const logs = new LogBuffer();
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    const child = spawn(spec.java, spec.args, { cwd: spec.instanceDir, env, windowsHide: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    info.pid = child.pid;
    const startedAt = info.startedAt;
    let resolveExit!: () => void;
    const exited = new Promise<void>((r) => (resolveExit = r));
    const r: Running = { info, child, logs, logStream, exited, bridgeSessionId: sessionId };
    this.running.set(id, r);
    logs.push('system', `[Modsmith] Launching ${spec.side} (${spec.mode}) profile ${spec.profileId} in ${spec.instanceDir}`);
    logs.push('system', `[Modsmith] Java: ${spec.java}`);
    if (spec.debugPort) logs.push('system', `[Modsmith] JDWP debugger listening on 127.0.0.1:${spec.debugPort}`);
    let earlyDisplayFailed = false;
    let batch: unknown[] = [];
    let flushTimer: NodeJS.Timeout | null = null;
    const flush = () => {
      flushTimer = null;
      if (batch.length) this.bus.emit('instance.log', { id, lines: batch });
      batch = [];
    };
    streamLines(child, (text, stream) => {
      const clean = redactText(text);
      logStream.write(clean + '\n');
      const line = logs.push(stream, clean);
      batch.push(line);
      if (!flushTimer) flushTimer = setTimeout(flush, 100);
      if (info.status === 'starting' && (/Sound engine started|Done \(\d/.test(text) || /Starting Minecraft server/.test(text))) {
        info.status = 'running';
        this.emit(r);
      }
      if (info.status === 'starting' && /\[EARLYDISPLAY\/\]: ERROR DISPLAY|Failed to initialize the mod loading system and display/.test(text) && !earlyDisplayFailed) {
        earlyDisplayFailed = true;
        logs.push('system', '[Modsmith] NeoForge could not start its early loading window and is waiting on an error dialog. Terminating the process; the next development launch disables the early window (config/fml.toml earlyWindowControl = false).');
        if (child.pid) void killTree(child.pid);
      }
    });
    child.on('error', (err) => {
      logs.push('system', `[Modsmith] Failed to start process: ${err.message}`);
      info.status = 'failed';
      info.endedAt = Date.now();
      this.finish(r);
      resolveExit();
    });
    child.on('exit', (code) => {
      flush();
      info.exitCode = code;
      info.endedAt = Date.now();
      const crash = findCrashReport(spec.instanceDir, startedAt);
      if (crash) info.crashReport = crash;
      info.status = info.status === 'stopping' && !crash ? 'exited' : crash || (code !== 0 && code !== null) ? 'crashed' : 'exited';
      logs.push('system', `[Modsmith] Process exited with code ${code}${crash ? `; crash report ${crash}` : ''}`);
      this.finish(r);
      resolveExit();
    });
    this.store.saveLaunch({ id, workspace: spec.workspace, profile: spec.profileId, side: spec.side, mode: spec.mode, pid: child.pid, startedAt, status: info.status, logFile });
    this.emit(r);
    return { ...info };
  }

  private finish(r: Running): void {
    r.logStream.end();
    if (r.bridgeSessionId) this.bridge.closeSession(r.bridgeSessionId);
    r.info.bridge = { connected: false, game: r.info.bridge.game };
    this.store.saveLaunch({ id: r.info.id, workspace: r.info.workspace, profile: r.info.profileId, side: r.info.side, mode: r.info.mode, pid: r.info.pid, startedAt: r.info.startedAt, endedAt: r.info.endedAt, exitCode: r.info.exitCode, status: r.info.status, logFile: r.info.logFile, crashReport: r.info.crashReport });
    this.running.delete(r.info.id);
    this.history.set(r.info.id, { info: { ...r.info }, logs: r.logs });
    if (this.history.size > 20) this.history.delete(this.history.keys().next().value!);
    this.emit(r);
  }

  get(id: string): InstanceInfo | undefined {
    const r = this.running.get(id);
    if (r) return { ...r.info, bridge: { ...r.info.bridge } };
    return this.history.get(id)?.info;
  }

  list(): InstanceInfo[] {
    return [...[...this.running.values()].map((r) => ({ ...r.info })), ...[...this.history.values()].map((h) => h.info)].sort((a, b) => b.startedAt - a.startedAt);
  }

  logs(id: string, opts: Parameters<LogBuffer['query']>[0]) {
    const buf = this.running.get(id)?.logs ?? this.history.get(id)?.logs;
    if (!buf) throw new Error(`Unknown instance ${id}`);
    return { lines: buf.query(opts), lastSeq: buf.lastSeq };
  }

  sendInput(id: string, line: string): void {
    const r = this.running.get(id);
    if (!r) throw new Error(`Instance ${id} is not running`);
    if (r.info.side !== 'server') throw new Error('Console input is only supported for dedicated servers');
    r.child.stdin?.write(line.replace(/[\r\n]+/g, ' ') + '\n');
    r.logs.push('system', `> ${line}`);
  }

  async stop(id: string, opts: { force?: boolean; timeoutMs?: number; graceful?: () => Promise<boolean> } = {}): Promise<InstanceInfo> {
    const r = this.running.get(id);
    if (!r) {
      const h = this.history.get(id);
      if (h) return h.info;
      throw new Error(`Unknown instance ${id}`);
    }
    if (!opts.force) {
      r.info.status = 'stopping';
      this.emit(r);
      let requested = false;
      if (opts.graceful) {
        try {
          requested = await opts.graceful();
        } catch (err) {
          r.logs.push('system', `[Modsmith] Graceful stop via bridge failed: ${(err as Error).message}`);
        }
      }
      if (!requested && r.info.side === 'server') {
        r.child.stdin?.write('stop\n');
        requested = true;
      }
      if (!requested && r.info.side === 'client' && process.platform === 'win32' && r.child.pid) {
        try {
          const w = await import('../native/win32');
          const win = w.findGameWindow([r.child.pid]);
          if (win) requested = w.closeWindow(win.hwnd);
        } catch (err) {
          r.logs.push('system', `[Modsmith] Window close request failed: ${(err as Error).message}`);
        }
      }
      r.logs.push('system', requested ? '[Modsmith] Graceful stop requested' : '[Modsmith] No graceful stop mechanism available; terminating');
      const timeout = opts.timeoutMs ?? 30000;
      const done = await Promise.race([r.exited.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), requested ? timeout : 0))]);
      if (done) return this.get(id)!;
      r.logs.push('system', `[Modsmith] Process did not exit within ${timeout} ms; forcing termination`);
    }
    r.info.status = 'stopping';
    if (r.child.pid && isAlive(r.child.pid)) await killTree(r.child.pid);
    await Promise.race([r.exited, new Promise((res) => setTimeout(res, 10000))]);
    return this.get(id)!;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id, { timeoutMs: 15000 }).catch(() => undefined)));
  }
}

export function findCrashReport(instanceDir: string, since: number): string | undefined {
  const dir = path.join(instanceDir, 'crash-reports');
  if (!fs.existsSync(dir)) return undefined;
  const files = fs.readdirSync(dir).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).mtimeMs >= since - 1000).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}
