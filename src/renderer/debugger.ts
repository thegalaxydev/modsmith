import { store, IDLE_DEBUG, type DebugFrame, type DebugState } from './store';
import type { InstanceInfo, OperationInfo } from '../shared/types';
import { waitForOperation } from './store';
import { javaClient, lspStatus, restartLanguageServer, startLanguageServer } from './lsp';
import { navContext, openLocation, revealLine } from './javaNav';

interface DapMessage {
  seq: number;
  type: 'request' | 'response' | 'event';
  command?: string;
  event?: string;
  request_seq?: number;
  success?: boolean;
  message?: string;
  body?: Record<string, unknown>;
}

export interface DebugVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

const MAX_OUTPUT = 500;

export function relativeToWorkspace(workspace: string, file: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const ws = norm(workspace);
  const f = norm(file);
  const prefix = `${ws}/`;
  const caseless = /^[A-Za-z]:\//.test(ws);
  const starts = caseless ? f.toLowerCase().startsWith(prefix.toLowerCase()) : f.startsWith(prefix);
  return starts ? f.slice(prefix.length) : null;
}

export function absoluteInWorkspace(workspace: string, file: string): string {
  const sep = workspace.includes('\\') ? '\\' : '/';
  return `${workspace.replace(/[\\/]+$/, '')}${sep}${file.split('/').join(sep)}`;
}

export function toggleLine(lines: number[], line: number): number[] {
  return lines.includes(line) ? lines.filter((l) => l !== line) : [...lines, line].sort((a, b) => a - b);
}

function patch(p: Partial<DebugState>) {
  store.set((s) => ({ debug: { ...s.debug, ...p } }));
}

class Debugger {
  private seq = 0;
  private pending = new Map<number, { resolve: (m: DapMessage) => void; reject: (e: Error) => void }>();
  private listener: ((session: string, message: string | null) => void) | null = null;

  private get state() {
    return store.state.debug;
  }

  private workspace() {
    return store.state.workspace?.path ?? '';
  }

  breakpointsFor(file: string): number[] {
    return store.state.breakpoints[this.workspace()]?.[file] ?? [];
  }

  toggleBreakpoint(file: string, line: number) {
    const ws = this.workspace();
    const current = store.state.breakpoints[ws] ?? {};
    const next = toggleLine(current[file] ?? [], line);
    const files = { ...current, [file]: next };
    if (!next.length) delete files[file];
    const all = { ...store.state.breakpoints, [ws]: files };
    store.set({ breakpoints: all });
    try {
      localStorage.setItem('mwb.breakpoints', JSON.stringify(all));
    } catch {
      void 0;
    }
    if (this.state.session) void this.syncFile(file).catch((e: Error) => this.out(`Breakpoint: ${e.message}`));
  }

  clearBreakpoints() {
    const ws = this.workspace();
    const files = Object.keys(store.state.breakpoints[ws] ?? {});
    const all = { ...store.state.breakpoints, [ws]: {} };
    store.set({ breakpoints: all });
    try {
      localStorage.setItem('mwb.breakpoints', JSON.stringify(all));
    } catch {
      void 0;
    }
    if (this.state.session) for (const f of files) void this.syncFile(f).catch(() => undefined);
  }

  private out(line: string) {
    patch({ output: [...this.state.output, line].slice(-MAX_OUTPUT) });
  }

  private request(command: string, args: Record<string, unknown> = {}, timeoutMs = 30000): Promise<DapMessage> {
    const session = this.state.session;
    if (!session) return Promise.reject(new Error('The debugger is not attached'));
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`The debugger did not answer ${command}`));
      }, timeoutMs);
      this.pending.set(seq, {
        resolve: (m) => {
          clearTimeout(timer);
          if (m.success === false) reject(new Error(m.message || `${command} failed`));
          else resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        }
      });
      store.call('debug.send', { session, message: JSON.stringify({ seq, type: 'request', command, arguments: args }) }, { quiet: true }).catch((e: Error) => {
        this.pending.get(seq)?.reject(e);
        this.pending.delete(seq);
      });
    });
  }

  private onMessage(raw: string) {
    let m: DapMessage;
    try {
      m = JSON.parse(raw) as DapMessage;
    } catch {
      return;
    }
    if (m.type === 'response' && m.request_seq !== undefined) {
      this.pending.get(m.request_seq)?.resolve(m);
      this.pending.delete(m.request_seq);
      return;
    }
    if (m.type !== 'event') return;
    const body = (m.body ?? {}) as Record<string, unknown>;
    switch (m.event) {
      case 'initialized':
        void this.configure();
        break;
      case 'stopped':
        void this.onStopped(Number(body.threadId), String(body.reason ?? 'pause'));
        break;
      case 'continued':
        patch({ status: 'running', location: null, frames: [], scopes: [], frameId: null, reason: null, message: 'Running' });
        break;
      case 'output':
        if (body.category !== 'telemetry' && typeof body.output === 'string') this.out(body.output.replace(/\n$/, ''));
        break;
      case 'terminated':
      case 'exited':
        void this.close('The game is no longer being debugged');
        break;
    }
  }

  private async configure() {
    const ws = this.workspace();
    for (const file of Object.keys(store.state.breakpoints[ws] ?? {})) await this.syncFile(file).catch((e: Error) => this.out(`Breakpoints in ${file}: ${e.message}`));
    await this.request('configurationDone').catch((e: Error) => this.out(e.message));
  }

  private async syncFile(file: string) {
    const lines = this.breakpointsFor(file);
    const r = await this.request('setBreakpoints', { source: { path: absoluteInWorkspace(this.workspace(), file), name: file.split('/').pop() }, breakpoints: lines.map((line) => ({ line })) });
    const bps = (r.body?.breakpoints as { verified?: boolean; line?: number; message?: string }[] | undefined) ?? [];
    for (const b of bps) if (b.verified === false && b.message) this.out(`Breakpoint at ${file}:${b.line ?? '?'}: ${b.message}`);
  }

  async start(inst: InstanceInfo) {
    if (this.state.status !== 'idle') return;
    const ws = this.workspace();
    if (!inst.debugPort) throw new Error('This run has no debug port. Turn on "Hot reload and debugger" for the run configuration and restart the game.');
    patch({ ...IDLE_DEBUG, status: 'starting', instance: inst.id, message: 'Preparing the debugger', output: this.state.output });
    try {
      let st = await lspStatus(ws);
      if (!st.installed || !st.trusted || !st.java) throw new Error('Debugging uses Java support. Turn on Java completion for this project first (open a .java file).');
      let restart = false;
      if (!st.debugger?.installed) {
        patch({ message: 'Downloading the Java debugger' });
        const op = await store.call<OperationInfo>('lsp.install', { language: 'java' });
        const done = await waitForOperation(op.id);
        if (done.status !== 'succeeded') throw new Error(done.error ?? 'The debugger could not be installed');
        st = await lspStatus(ws);
        restart = true;
      }
      patch({ message: restart ? 'Restarting Java support with the debugger' : 'Starting the debug adapter' });
      if (restart || st.session) {
        if (restart) await restartLanguageServer(ws);
      } else await startLanguageServer(ws);
      const client = await javaClient(ws);
      if (!client) throw new Error('Java support is not running');
      patch({ message: 'Waiting for Java support to finish loading the project' });
      const port = await client.request<{ command: string; arguments: unknown[] }, number>('workspace/executeCommand', { command: 'vscode.java.startDebugSession', arguments: [] });
      if (typeof port !== 'number') throw new Error('Java support has no debugger. Restart Java support and try again.');
      const { session } = await store.call<{ session: string }>('debug.connect', { path: ws, port, instance: inst.id });
      this.listener = (sid, message) => {
        if (sid !== session) return;
        if (message === null) void this.close('The debug adapter closed the connection');
        else this.onMessage(message);
      };
      store.debugListeners.add(this.listener);
      patch({ session, message: 'Attaching' });
      await this.request('initialize', { clientID: 'modsmith', clientName: 'Modsmith', adapterID: 'java', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path', supportsVariableType: true });
      await this.request('attach', { type: 'java', request: 'attach', name: 'Modsmith', hostName: '127.0.0.1', port: inst.debugPort, timeout: 15000 }, 45000);
      if ((store.state.debug.status as DebugState['status']) === 'starting') patch({ status: 'running', message: 'Running' });
    } catch (e) {
      await this.close((e as Error).message);
      throw e;
    }
  }

  private async onStopped(threadId: number, reason: string) {
    patch({ status: 'paused', threadId, reason, message: `Paused (${reason})` });
    try {
      const threads = ((await this.request('threads')).body?.threads as { id: number; name: string }[]) ?? [];
      patch({ threads });
      await this.loadStack(threadId);
      store.showTool('debug');
    } catch (e) {
      this.out((e as Error).message);
    }
  }

  async loadStack(threadId: number) {
    const r = await this.request('stackTrace', { threadId, startFrame: 0, levels: 60 });
    const ws = this.workspace();
    const frames: DebugFrame[] = ((r.body?.stackFrames as { id: number; name: string; line: number; source?: { path?: string; name?: string } }[]) ?? []).map((f) => {
      const p = f.source?.path ?? null;
      return { id: f.id, name: f.name, line: f.line, file: p && !p.startsWith('jdt:') ? relativeToWorkspace(ws, p) : null, uri: p, source: f.source?.name ?? '' };
    });
    patch({ threadId, frames });
    const first = frames.find((f) => f.file) ?? frames[0];
    if (first) await this.selectFrame(first, frames[0] === first);
  }

  async selectFrame(frame: DebugFrame, reveal = true) {
    const scopes = ((await this.request('scopes', { frameId: frame.id })).body?.scopes as { name: string; variablesReference: number }[]) ?? [];
    patch({ frameId: frame.id, scopes: scopes.map((s) => ({ name: s.name, ref: s.variablesReference })), location: frame.file ? { file: frame.file, line: frame.line } : null });
    if (reveal) await this.reveal(frame);
  }

  async reveal(frame: DebugFrame) {
    if (frame.file) await revealLine(frame.file, frame.line);
    else if (frame.uri?.startsWith('jdt:')) {
      const client = await javaClient(this.workspace());
      const ctx = client ? navContext(client) : null;
      if (ctx) await openLocation(ctx, frame.uri, { start: { line: frame.line - 1, character: 0 }, end: { line: frame.line - 1, character: 0 } });
    }
  }

  async variables(ref: number): Promise<DebugVariable[]> {
    const r = await this.request('variables', { variablesReference: ref });
    return (r.body?.variables as DebugVariable[]) ?? [];
  }

  async evaluate(expression: string): Promise<DebugVariable> {
    const r = await this.request('evaluate', { expression, frameId: this.state.frameId ?? undefined, context: 'repl' });
    return { name: expression, value: String(r.body?.result ?? ''), type: r.body?.type as string | undefined, variablesReference: Number(r.body?.variablesReference ?? 0) };
  }

  async step(kind: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause') {
    const threadId = this.state.threadId ?? this.state.threads[0]?.id;
    if (threadId === undefined || threadId === null) return;
    await this.request(kind, { threadId });
    if (kind !== 'pause') patch({ status: 'running', location: null, frames: [], scopes: [], frameId: null, reason: null, message: 'Running' });
  }

  async stop() {
    if (!this.state.session) return void (await this.close(''));
    patch({ status: 'stopping', message: 'Detaching' });
    await this.request('disconnect', { terminateDebuggee: false, restart: false }, 10000).catch(() => undefined);
    await this.close('');
  }

  private async close(message: string) {
    const session = this.state.session;
    if (this.listener) store.debugListeners.delete(this.listener);
    this.listener = null;
    for (const p of this.pending.values()) p.reject(new Error('The debugger stopped'));
    this.pending.clear();
    if (session) await store.call('debug.disconnect', { session }, { quiet: true }).catch(() => undefined);
    patch({ ...IDLE_DEBUG, output: message ? [...this.state.output, message].slice(-MAX_OUTPUT) : this.state.output, message });
  }
}

export const debuggerController = new Debugger();
