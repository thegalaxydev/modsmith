import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OperationInfo } from '../shared/types';
import type { Services } from './context';
import type { OpContext } from './operations';
import type { WorkspaceService } from './workspace';
import type { LaunchService, Prepared, Seat } from './launch';

const DONE_TIMEOUT_MS = 600_000;
const ENDED = ['exited', 'crashed', 'failed'];

export interface SessionClient {
  profile: string;
  slot: number;
  player: string;
  instance: string | null;
}

export interface SessionRecord {
  id: string;
  workspace: string;
  status: 'starting' | 'running' | 'failed' | 'stopped';
  port: number | null;
  startedAt: number;
  server: { profile: string; instance: string | null };
  clients: SessionClient[];
  operationId?: string;
}

function keyOf(line: string): string | null {
  const t = line.trimStart();
  if (t.startsWith('#') || t.startsWith('!')) return null;
  const m = /[=:]/.exec(t);
  return m ? t.slice(0, m.index).trim() : null;
}

export function property(text: string, key: string): string | undefined {
  for (const l of text.split('\n')) {
    if (keyOf(l) === key) return l.trimStart().slice(l.trimStart().search(/[=:]/) + 1).trim();
  }
  return undefined;
}

export function setProperties(text: string, pairs: [string, string][]): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.split('\n').map((l) => l.replace(/\r$/, '')) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [key, value] of pairs) {
    const i = lines.findIndex((l) => keyOf(l) === key);
    if (i >= 0) lines[i] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  return lines.join(eol) + eol;
}

export function setOption(text: string, key: string, value: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.split('\n').map((l) => l.replace(/\r$/, '')) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const i = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (i >= 0) lines[i] = `${key}:${value}`;
  else lines.push(`${key}:${value}`);
  return lines.join(eol) + eol;
}

function skipOnboarding(gameDir: string) {
  const file = path.join(gameDir, 'options.txt');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const next = setOption(text, 'onboardAccessibility', 'false');
  if (next === text) return;
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(file, next);
}

export function playerNames(count: number, names?: unknown): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error('A session needs between 1 and 4 clients');
  const given = Array.isArray(names) ? names.map((n) => String(n).trim()) : [];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = given[i] || `Player${i + 1}`;
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new Error(`Player name "${name}" must be 3 to 16 letters, digits or underscores`);
    if (out.some((o) => o.toLowerCase() === name.toLowerCase())) throw new Error(`Player name "${name}" is used twice`);
    out.push(name);
  }
  return out;
}

function bindable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

async function serverPort(preferred: number): Promise<number> {
  for (let p = preferred; p < preferred + 50; p++) {
    if ((await bindable(p, '0.0.0.0')) && (await bindable(p, '127.0.0.1'))) return p;
  }
  throw new Error(`No free server port near ${preferred}`);
}

export class SessionService {
  private sessions: SessionRecord[] = [];

  constructor(private s: Services, private ws: WorkspaceService, private launcher: LaunchService) {}

  private update(id: string, f: (r: SessionRecord) => void) {
    const r = this.sessions.find((x) => x.id === id);
    if (r) f(r);
  }

  private live(id: string): boolean {
    const info = this.s.instances.get(id);
    return !!info && !ENDED.includes(info.status);
  }

  start(p: { path: string; server: string; client: string; clients?: number; names?: string[] }): OperationInfo {
    const names = playerNames(p.clients ?? 2, p.names);
    const dir = this.ws.normalize(p.path);
    const manifest = this.ws.requireManifest(dir);
    for (const [id, side] of [[p.server, 'server'], [p.client, 'client']] as const) {
      const profile = manifest.profiles.find((x) => x.id === id);
      if (!profile) throw new Error(`Unknown profile ${id}`);
      if (profile.side !== side) throw new Error(`Profile ${id} is not a ${side} profile`);
    }
    const session = randomUUID().slice(0, 8);
    const serverSeat: Seat = { session, slot: 0 };
    const server = this.launcher.prepareLaunch(p.path, p.server, undefined, serverSeat);
    const seats = names.map((player, i) => {
      const seat: Seat = { session, slot: i + 1, player };
      return { seat, prepared: this.launcher.prepareLaunch(p.path, p.client, undefined, seat) };
    });
    this.sessions.push({
      id: session,
      workspace: dir,
      status: 'starting',
      port: null,
      startedAt: Date.now(),
      server: { profile: p.server, instance: null },
      clients: names.map((player, i) => ({ profile: p.client, slot: i + 1, player, instance: null }))
    });
    const title = `Multiplayer test: ${server.profile.name} + ${names.length} ${names.length === 1 ? 'client' : 'clients'}`;
    const op = this.s.ops.start({ kind: 'session.start', title, workspace: dir }, async (ctx) => {
      const started: string[] = [];
      try {
        const out = await this.run(session, server, serverSeat, seats, started, ctx);
        this.update(session, (r) => (r.status = 'running'));
        return out;
      } catch (e) {
        ctx.log(`Session failed: ${(e as Error).message}`);
        for (const id of [...started].reverse()) await this.launcher.stop(id, false).catch(() => undefined);
        this.update(session, (r) => (r.status = 'failed'));
        throw e;
      }
    });
    this.update(session, (r) => (r.operationId = op.id));
    return op;
  }

  private async run(sid: string, server: Prepared, serverSeat: Seat, seats: { seat: Seat; prepared: Prepared }[], started: string[], ctx: OpContext) {
    const props = path.join(server.idir, 'server.properties');
    const text = fs.existsSync(props) ? fs.readFileSync(props, 'utf8') : '';
    const preferred = Number.parseInt(property(text, 'server-port') ?? '', 10);
    const port = await serverPort(preferred >= 1 && preferred <= 65535 ? preferred : 25565);
    fs.mkdirSync(server.idir, { recursive: true });
    fs.writeFileSync(props, setProperties(text, [['online-mode', 'false'], ['server-port', String(port)]]));
    ctx.log(`server.properties: online-mode=false, server-port=${port}`);
    this.update(sid, (r) => (r.port = port));
    ctx.progress(0.05, 'Starting the server');
    const info = await this.launcher.runPrepared(server, serverSeat, ctx);
    started.push(info.id);
    this.update(sid, (r) => (r.server.instance = info.id));
    ctx.progress(0.3, 'Waiting for the server to finish starting');
    await this.waitUntilDone(info.id, ctx);
    ctx.log(`Server is ready on port ${port}`);
    const clients: { instance: string; player: string; slot: number }[] = [];
    for (const [i, { seat, prepared }] of seats.entries()) {
      ctx.throwIfCancelled();
      ctx.progress(0.4 + (0.6 * i) / seats.length, `Starting client ${seat.slot} (${seat.player})`);
      skipOnboarding(prepared.idir);
      const c = await this.launcher.runPrepared(prepared, { ...seat, join: `127.0.0.1:${port}` }, ctx);
      started.push(c.id);
      this.update(sid, (r) => (r.clients[seat.slot - 1].instance = c.id));
      clients.push({ instance: c.id, player: seat.player ?? '', slot: seat.slot });
    }
    return { id: sid, port, server: { instance: info.id }, clients };
  }

  private async waitUntilDone(id: string, ctx: OpContext) {
    const begin = Date.now();
    for (;;) {
      ctx.throwIfCancelled();
      const info = this.s.instances.get(id);
      if (!info) throw new Error(`Unknown instance ${id}`);
      if (ENDED.includes(info.status)) throw new Error(`The server stopped before it finished starting (${info.status})`);
      if (this.s.instances.logs(id, { search: 'Done (' }).lines.some((l) => /Done \(\d/.test(l.text))) return;
      if (Date.now() - begin > DONE_TIMEOUT_MS) throw new Error('The server did not finish starting within 10 minutes');
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  list(root?: string): SessionRecord[] {
    const ws = root ? this.ws.normalize(root) : undefined;
    return this.sessions
      .filter((r) => !ws || r.workspace === ws)
      .map((r) => {
        const ids = [...r.clients.map((c) => c.instance), r.server.instance].filter((x): x is string => !!x);
        return r.status === 'running' && !ids.some((i) => this.live(i)) ? { ...r, status: 'stopped' as const } : { ...r };
      })
      .reverse();
  }

  async stop(id: string): Promise<SessionRecord> {
    const rec = this.sessions.find((r) => r.id === id);
    if (!rec) throw new Error(`Unknown session ${id}`);
    if (rec.operationId) this.s.ops.cancel(rec.operationId);
    await Promise.all(rec.clients.filter((c) => c.instance && this.live(c.instance)).map((c) => this.launcher.stop(c.instance!, false).catch(() => undefined)));
    if (rec.server.instance && this.live(rec.server.instance)) await this.launcher.stop(rec.server.instance, false);
    rec.status = 'stopped';
    return { ...rec };
  }
}
