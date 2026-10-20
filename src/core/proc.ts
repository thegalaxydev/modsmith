import { spawn, execFile, type ChildProcess, type SpawnOptions } from 'node:child_process';
import readline from 'node:readline';
import { CancelledError } from './operations';

export function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          void 0;
        }
      }
      resolve();
    }
  });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function streamLines(child: ChildProcess, onLine: (line: string, stream: 'stdout' | 'stderr') => void): void {
  if (child.stdout) readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (l) => onLine(l, 'stdout'));
  if (child.stderr) readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (l) => onLine(l, 'stderr'));
}

export function runProcess(
  command: string,
  args: string[],
  opts: SpawnOptions & { signal?: AbortSignal; onLine?: (line: string, stream: 'stdout' | 'stderr') => void }
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new CancelledError());
    const { signal, onLine, ...spawnOpts } = opts;
    const child = spawn(command, args, { windowsHide: true, ...spawnOpts, stdio: ['ignore', 'pipe', 'pipe'] });
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      if (child.pid) void killTree(child.pid);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (onLine) streamLines(child, onLine);
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code, sig) => {
      signal?.removeEventListener('abort', onAbort);
      if (cancelled) reject(new CancelledError());
      else resolve({ code, signal: sig });
    });
  });
}

export function execCapture(command: string, args: string[], timeoutMs = 20000, env?: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: env ?? process.env }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : err ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
