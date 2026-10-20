export type ClientKind = 'ui' | 'mcp' | 'cli';

export interface ServiceEndpoint {
  url: string;
  token: string;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class RpcClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(event: string, data: unknown) => void>();
  private closeListeners = new Set<() => void>();
  serverInfo: Record<string, unknown> | null = null;

  constructor(private endpoint: ServiceEndpoint, private kind: ClientKind, private events: boolean) {}

  connect(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.endpoint.url);
      this.ws = ws;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.close();
          reject(new Error('Timed out connecting to the Modsmith service'));
        }
      }, timeoutMs);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: this.endpoint.token, client: this.kind, events: this.events, protocol: 1 }));
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('Could not connect to the Modsmith service'));
        }
      };
      ws.onclose = () => {
        for (const p of this.pending.values()) p.reject(new Error('Service connection closed'));
        this.pending.clear();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('Service closed the connection (authentication failed?)'));
        }
        this.closeListeners.forEach((l) => l());
      };
      ws.onmessage = (ev) => {
        let msg: { type: string; id?: number; ok?: boolean; result?: unknown; error?: string; event?: string; data?: unknown; server?: Record<string, unknown> };
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        } catch {
          return;
        }
        if (msg.type === 'ready') {
          this.serverInfo = msg.server ?? null;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        } else if (msg.type === 'result' && msg.id !== undefined) {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error(msg.error ?? 'Unknown error'));
        } else if (msg.type === 'event' && msg.event) {
          this.listeners.forEach((l) => l(msg.event!, msg.data));
        }
      };
    });
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Not connected to the Modsmith service'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ type: 'call', id, method, params }));
    });
  }

  onEvent(l: (event: string, data: unknown) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onClose(l: () => void): () => void {
    this.closeListeners.add(l);
    return () => this.closeListeners.delete(l);
  }

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.ws?.close();
  }
}
