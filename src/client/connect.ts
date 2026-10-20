import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RpcClient, type ClientKind } from '../shared/rpc-client';
import { appPaths } from '../core/paths';

export interface ServiceFile {
  pid: number;
  port: number;
  token: string;
  version: string;
  startedAt: number;
}

export function readServiceFile(): ServiceFile | null {
  const f = appPaths().serviceFile;
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as ServiceFile;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function serviceScript(): string {
  const candidates = [path.join(__dirname, '..', 'service', 'main.cjs'), path.join(__dirname, 'service', 'main.cjs')];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error(`Service entry point not found near ${__dirname}`);
  return found;
}

export function serviceBinary(): string | null {
  const bin = process.platform === 'win32' ? 'modsmith-service.exe' : 'modsmith-service';
  const candidates = [process.env.MODSMITH_SERVICE_BIN, path.join(__dirname, '..', '..', '..', bin), path.join(__dirname, '..', '..', 'target', 'release', bin)];
  return candidates.find((c): c is string => !!c && fs.existsSync(c)) ?? null;
}

export function spawnService(): void {
  const bin = serviceBinary();
  const child = bin ? spawn(bin, [], { detached: true, stdio: 'ignore', env: process.env, windowsHide: true }) : spawn(process.execPath, [serviceScript()], { detached: true, stdio: 'ignore', env: process.env, windowsHide: true });
  child.unref();
}

async function tryConnect(kind: ClientKind, events: boolean): Promise<RpcClient | null> {
  const sf = readServiceFile();
  if (!sf || !alive(sf.pid)) return null;
  const client = new RpcClient({ url: `ws://127.0.0.1:${sf.port}/rpc`, token: sf.token }, kind, events);
  try {
    await client.connect(4000);
    return client;
  } catch {
    return null;
  }
}

export async function connectService(kind: ClientKind, opts: { events?: boolean; autoStart?: boolean; timeoutMs?: number } = {}): Promise<RpcClient> {
  const events = opts.events ?? false;
  const existing = await tryConnect(kind, events);
  if (existing) return existing;
  if (opts.autoStart === false) throw new Error('The Modsmith service is not running');
  spawnService();
  const deadline = Date.now() + (opts.timeoutMs ?? 20000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const c = await tryConnect(kind, events);
    if (c) return c;
  }
  throw new Error(`The Modsmith service did not start; see ${appPaths().serviceLog}`);
}
