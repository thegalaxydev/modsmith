import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { PRODUCT } from '../shared/product';
import type { EventBus } from './events';

export const HelloSchema = z.object({
  type: z.literal('hello'),
  protocol: z.number().int(),
  session: z.string().min(8).max(128),
  token: z.string().min(16).max(256),
  game: z.object({
    minecraft: z.string(),
    loader: z.string(),
    loaderVersion: z.string(),
    side: z.enum(['client', 'server']),
    bridgeVersion: z.string(),
    capabilities: z.array(z.string()).default([])
  }).passthrough()
});

export const BridgeInboundSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('response'), id: z.number().int(), ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional() }),
  z.object({ type: z.literal('event'), event: z.string().max(128), data: z.unknown().optional() })
]);

export interface BridgeSession {
  id: string;
  token: string;
  instanceId: string;
  socket?: WebSocket;
  hello?: z.infer<typeof HelloSchema>;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; method: string }>;
  nextId: number;
  connectedAt?: number;
}

const MAX_PAYLOAD = 48 * 1024 * 1024;

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export class BridgeHost {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private sessions = new Map<string, BridgeSession>();
  port = 0;

  constructor(private bus: EventBus) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/bridge' || req.headers.origin) {
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  url(): string {
    return `ws://127.0.0.1:${this.port}/bridge`;
  }

  createSession(instanceId: string): BridgeSession {
    const s: BridgeSession = { id: crypto.randomUUID(), token: crypto.randomBytes(32).toString('base64url'), instanceId, pending: new Map(), nextId: 1 };
    this.sessions.set(s.id, s);
    return s;
  }

  closeSession(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    for (const p of s.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Bridge session closed'));
    }
    s.socket?.close();
    this.sessions.delete(id);
  }

  sessionFor(instanceId: string): BridgeSession | undefined {
    return [...this.sessions.values()].find((s) => s.instanceId === instanceId);
  }

  private onConnection(ws: WebSocket): void {
    let session: BridgeSession | null = null;
    const helloTimer = setTimeout(() => ws.close(4001, 'hello timeout'), 10000);
    ws.on('message', (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.close(4002, 'invalid json');
        return;
      }
      if (!session) {
        const hello = HelloSchema.safeParse(msg);
        if (!hello.success) {
          ws.close(4003, 'invalid hello');
          return;
        }
        const s = this.sessions.get(hello.data.session);
        if (!s || !constantTimeEqual(s.token, hello.data.token)) {
          ws.close(4004, 'authentication failed');
          return;
        }
        if (hello.data.protocol !== PRODUCT.bridgeProtocolVersion) {
          ws.send(JSON.stringify({ type: 'welcome', ok: false, error: `Unsupported protocol ${hello.data.protocol}; expected ${PRODUCT.bridgeProtocolVersion}` }));
          ws.close(4005, 'protocol mismatch');
          return;
        }
        clearTimeout(helloTimer);
        if (s.socket && s.socket !== ws) s.socket.close(4006, 'replaced');
        session = s;
        s.socket = ws;
        s.hello = hello.data;
        s.connectedAt = Date.now();
        ws.send(JSON.stringify({ type: 'welcome', ok: true, protocol: PRODUCT.bridgeProtocolVersion }));
        this.bus.emit('bridge.connected', { instanceId: s.instanceId, game: hello.data.game });
        return;
      }
      const parsed = BridgeInboundSchema.safeParse(msg);
      if (!parsed.success) return;
      const m = parsed.data;
      if (m.type === 'response') {
        const p = session.pending.get(m.id);
        if (!p) return;
        clearTimeout(p.timer);
        session.pending.delete(m.id);
        if (m.ok) p.resolve(m.result);
        else p.reject(new Error(m.error ?? `Bridge call ${p.method} failed`));
      } else {
        this.bus.emit('bridge.event', { instanceId: session.instanceId, event: m.event, data: m.data });
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (session && session.socket === ws) {
        session.socket = undefined;
        for (const p of session.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error('Bridge disconnected'));
        }
        session.pending.clear();
        this.bus.emit('bridge.disconnected', { instanceId: session.instanceId });
      }
    });
    ws.on('error', () => void 0);
  }

  call(instanceId: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 20000): Promise<unknown> {
    const s = this.sessionFor(instanceId);
    if (!s || !s.socket || s.socket.readyState !== s.socket.OPEN) return Promise.reject(new Error('Bridge is not connected for this instance'));
    const caps = s.hello?.game.capabilities ?? [];
    if (caps.length && !caps.includes(method) && !method.startsWith('ext.')) return Promise.reject(new Error(`Bridge method ${method} is not supported by this game instance (supported: ${caps.join(', ')})`));
    const id = s.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        s.pending.delete(id);
        reject(new Error(`Bridge call ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      s.pending.set(id, { resolve, reject, timer, method });
      s.socket!.send(JSON.stringify({ type: 'request', id, method, params }));
    });
  }

  status(instanceId: string): { connected: boolean; protocol?: number; game?: Record<string, unknown>; connectedAt?: number } {
    const s = this.sessionFor(instanceId);
    if (!s) return { connected: false };
    return { connected: !!s.socket, protocol: s.hello?.protocol, game: s.hello?.game, connectedAt: s.connectedAt };
  }

  async stop(): Promise<void> {
    for (const id of [...this.sessions.keys()]) this.closeSession(id);
    this.wss?.close();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
  }
}
