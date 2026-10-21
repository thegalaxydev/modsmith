import fs from 'node:fs';
import path from 'node:path';
import type { InstanceInfo, LogLine } from '../shared/types';
import type { Services } from './context';
import type { OpContext } from './operations';
import type { Prepared } from './launch';
import { setOption, setProperties } from './sessions';

export const ENDED = ['exited', 'crashed', 'failed'];
const READY_TIMEOUT_MS = 600_000;

export interface TestWorld {
  name: string;
  seed: number;
  flat: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function swap(file: string, next: (text: string) => string): () => void {
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next(original ?? ''));
  return () => {
    if (original === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, original);
  };
}

export function serverTestWorld(dir: string, world: TestWorld): () => void {
  fs.rmSync(path.join(dir, world.name), { recursive: true, force: true });
  return swap(path.join(dir, 'server.properties'), (t) => setProperties(t, [['level-name', world.name], ['level-seed', String(world.seed)], ['level-type', world.flat ? 'minecraft\\:flat' : 'minecraft\\:normal']]));
}

export function clientTestOptions(dir: string, extra: [string, string][] = []): () => void {
  return swap(path.join(dir, 'options.txt'), (t) => [['onboardAccessibility', 'false'], ['pauseOnLostFocus', 'false'], ...extra].reduce((acc, [k, v]) => setOption(acc, k, v), t));
}

export function prepareTestWorld(prepared: Prepared, world: TestWorld, clientExtra: [string, string][] = []): () => void {
  if (prepared.profile.side === 'server') return serverTestWorld(prepared.idir, world);
  fs.rmSync(path.join(prepared.idir, 'saves', world.name), { recursive: true, force: true });
  return clientTestOptions(prepared.idir, clientExtra);
}

export async function waitForGame<T>(s: Services, ctx: OpContext, id: string, what: string, check: () => Promise<T | null> | T | null): Promise<T> {
  const begin = Date.now();
  for (;;) {
    ctx.throwIfCancelled();
    const now = s.instances.get(id);
    if (!now || ENDED.includes(now.status)) throw new Error(`The game stopped while waiting for ${what} (${now?.status ?? 'gone'})`);
    const v = await Promise.resolve()
      .then(check)
      .catch(() => null);
    if (v !== null) return v;
    if (Date.now() - begin > READY_TIMEOUT_MS) throw new Error(`Timed out waiting for ${what}`);
    await sleep(500);
  }
}

export function waitServerDone(s: Services, ctx: OpContext, inst: InstanceInfo): Promise<LogLine> {
  return waitForGame(s, ctx, inst.id, 'the server to start', () => s.instances.logs(inst.id, { search: 'Done (' }).lines.find((l) => /Done \(\d/.test(l.text)) ?? null);
}

export function waitBridge(s: Services, ctx: OpContext, inst: InstanceInfo): Promise<true> {
  return waitForGame(s, ctx, inst.id, 'the development bridge', () => (s.bridge.status(inst.id).connected ? true : null));
}

export function waitTitleScreen(s: Services, ctx: OpContext, inst: InstanceInfo): Promise<true> {
  return waitForGame(s, ctx, inst.id, 'the title screen', async () => {
    if (!s.bridge.status(inst.id).connected) return null;
    const st = (await s.bridge.call(inst.id, 'client.status', {}, 5000)) as { loading?: boolean };
    return st.loading === false ? true : null;
  });
}

export async function enterWorld(s: Services, ctx: OpContext, inst: InstanceInfo, world: TestWorld): Promise<number> {
  const t0 = Date.now();
  await s.bridge.call(inst.id, 'world.open', { name: world.name, create: true, flat: world.flat, seed: world.seed }, 120000);
  await waitForGame(s, ctx, inst.id, 'the world', async () => (((await s.bridge.call(inst.id, 'client.status', {}, 5000)) as { inWorld?: boolean }).inWorld ? true : null));
  return Date.now() - t0;
}

export function waitPlayersJoined(s: Services, ctx: OpContext, server: InstanceInfo, players: string[]): Promise<true> {
  return waitForGame(s, ctx, server.id, `${players.join(', ')} to join`, () => {
    const lines = s.instances.logs(server.id, { search: 'joined the game' }).lines.map((l) => l.text);
    return players.every((p) => lines.some((t) => t.includes(`${p} joined the game`))) ? true : null;
  });
}
