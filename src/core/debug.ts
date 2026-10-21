import net from 'node:net';
import crypto from 'node:crypto';
import type { Services } from './context';
import type { WorkspaceService } from './workspace';

interface DebugSession {
  workspace: string;
  instance: string | null;
  socket: net.Socket;
}

const sessions = new Map<string, DebugSession>();

export function debuggerAttached(instanceId: string): boolean {
  return [...sessions.values()].some((s) => s.instance === instanceId);
}

export class DebugService {
  constructor(private s: Services, private ws: WorkspaceService) {}

  async connect(p: { path: string; port: number; instance?: string }) {
    const workspace = this.ws.normalize(p.path);
    if (p.instance && !this.s.instances.get(p.instance)) throw new Error(`Unknown instance ${p.instance}`);
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: p.port });
      sock.setTimeout(5000, () => sock.destroy(new Error('timeout')));
      sock.once('connect', () => {
        sock.setTimeout(0);
        resolve(sock);
      });
      sock.once('error', () => reject(new Error(`Could not connect to the debug adapter on port ${p.port}`)));
    });
    const id = crypto.randomBytes(8).toString('hex');
    sessions.set(id, { workspace, instance: p.instance ?? null, socket });
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const m = /Content-Length:\s*(\d+)/i.exec(buf.subarray(0, end).toString('ascii'));
        const n = m ? Number(m[1]) : 0;
        if (buf.length < end + 4 + n) return;
        const message = buf.subarray(end + 4, end + 4 + n).toString('utf8');
        buf = buf.subarray(end + 4 + n);
        if (m) this.s.bus.emit('debug.message', { session: id, message });
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      sessions.delete(id);
      this.s.bus.emit('debug.closed', { session: id });
    });
    return { session: id };
  }

  send(p: { session: string; message: string }) {
    const target = sessions.get(p.session);
    if (!target) throw new Error(`No debug session ${p.session}`);
    target.socket.write(`Content-Length: ${Buffer.byteLength(p.message, 'utf8')}\r\n\r\n${p.message}`);
    return { sent: true };
  }

  disconnect(p: { session: string }) {
    const target = sessions.get(p.session);
    if (!target) throw new Error(`No debug session ${p.session}`);
    sessions.delete(p.session);
    target.socket.destroy();
    return { closed: true };
  }

  list(p: { path?: string }) {
    const ws = p.path ? this.ws.normalize(p.path) : null;
    return [...sessions.entries()].filter(([, v]) => !ws || v.workspace === ws).map(([session, v]) => ({ session, workspace: v.workspace, instance: v.instance }));
  }

  stopAll() {
    for (const [id, v] of sessions) {
      sessions.delete(id);
      v.socket.destroy();
    }
  }
}
