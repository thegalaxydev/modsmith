import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Workbench } from '../src/core/workbench';
import { RpcClient } from '../src/shared/rpc-client';
import type { ActivitySource, OperationInfo } from '../src/shared/types';

type Source = Exclude<ActivitySource, 'system'>;

export interface ServiceUnderTest {
  mode: 'in-process' | 'binary';
  workbench: Workbench | null;
  call<T = unknown>(method: string, params: Record<string, unknown> | undefined, source: Source): Promise<T>;
  waitOperation(id: string, timeoutMs?: number): Promise<OperationInfo>;
  stop(): Promise<void>;
}

export const serviceBinary = process.env.MODSMITH_TEST_SERVICE || null;

async function waitFor<T>(fn: () => T | null | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function readServiceFile(dataDir: string): { pid: number; port: number; token: string; version: string; startedAt: number } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'service.json'), 'utf8'));
  } catch {
    return null;
  }
}

export async function startBinary(bin: string, env: NodeJS.ProcessEnv): Promise<{ child: ChildProcess; info: NonNullable<ReturnType<typeof readServiceFile>> }> {
  const dataDir = env.MODSMITH_DATA_DIR!;
  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn(bin, [], { env, stdio: 'ignore', windowsHide: true });
  const info = await waitFor(() => {
    const sf = readServiceFile(dataDir);
    return sf && sf.pid === child.pid ? sf : null;
  }, 60000, 'service.json');
  return { child, info };
}

export function waitExit(child: ChildProcess, timeoutMs = 30000): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

function inProcess(): ServiceUnderTest {
  const wb = new Workbench();
  return {
    mode: 'in-process',
    workbench: wb,
    call: <T>(method: string, params: Record<string, unknown> | undefined, source: Source) => wb.call(method, params, source) as Promise<T>,
    async waitOperation(id, timeoutMs = 20000) {
      const op = await wb.s.ops.wait(id, timeoutMs);
      if (!op) throw new Error(`Unknown operation ${id}`);
      return op;
    },
    stop: () => wb.stop(false)
  };
}

function binary(bin: string): ServiceUnderTest {
  const started = startBinary(bin, process.env);
  const clients = new Map<Source, Promise<RpcClient>>();
  const client = (source: Source) => {
    let c = clients.get(source);
    if (!c) {
      c = started.then(async ({ info }) => {
        const rpc = new RpcClient({ url: `ws://127.0.0.1:${info.port}/rpc`, token: info.token }, source, false);
        await rpc.connect(10000);
        return rpc;
      });
      clients.set(source, c);
    }
    return c;
  };
  const svc: ServiceUnderTest = {
    mode: 'binary',
    workbench: null,
    call: async <T>(method: string, params: Record<string, unknown> | undefined, source: Source) => (await client(source)).call<T>(method, params),
    waitOperation: (id, timeoutMs = 20000) => svc.call<OperationInfo>('operation.wait', { id, timeoutMs }, 'ui'),
    async stop() {
      const { child } = await started;
      await svc.call('service.shutdown', { stopInstances: false }, 'cli').catch(() => undefined);
      for (const c of clients.values()) (await c.catch(() => null))?.close();
      if ((await waitExit(child)) === null) child.kill();
    }
  };
  return svc;
}

export function createService(): ServiceUnderTest {
  return serviceBinary ? binary(serviceBinary) : inProcess();
}
