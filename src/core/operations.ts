import { randomUUID } from 'node:crypto';
import type { OperationInfo } from '../shared/types';
import type { EventBus } from './events';
import type { Store } from './db';
import { redactText } from './redact';

export class CancelledError extends Error {
  constructor(message = 'Operation cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

export interface OpContext {
  id: string;
  signal: AbortSignal;
  progress(fraction: number | null, message?: string): void;
  log(line: string): void;
  throwIfCancelled(): void;
}

interface OpRecord {
  info: OperationInfo;
  controller: AbortController;
  promise: Promise<unknown>;
  fullLog: string[];
}

const LOG_TAIL = 200;
const FULL_LOG = 20000;

export class OperationManager {
  private ops = new Map<string, OpRecord>();

  constructor(private bus: EventBus, private store: Store) {}

  start<T>(spec: { kind: string; title: string; workspace?: string }, fn: (ctx: OpContext) => Promise<T>): OperationInfo {
    const id = randomUUID();
    const controller = new AbortController();
    const info: OperationInfo = { id, kind: spec.kind, title: spec.title, workspace: spec.workspace, status: 'running', progress: null, message: 'Starting', startedAt: Date.now(), logTail: [] };
    const record: OpRecord = { info, controller, promise: Promise.resolve(), fullLog: [] };
    this.ops.set(id, record);
    let lastEmit = 0;
    const emit = (force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit < 150) return;
      lastEmit = now;
      this.bus.emit('operation.updated', this.snapshot(record));
    };
    const ctx: OpContext = {
      id,
      signal: controller.signal,
      progress: (fraction, message) => {
        info.progress = fraction;
        if (message) info.message = message;
        emit();
      },
      log: (line) => {
        const clean = redactText(line);
        info.logTail.push(clean);
        if (info.logTail.length > LOG_TAIL) info.logTail.splice(0, info.logTail.length - LOG_TAIL);
        record.fullLog.push(clean);
        if (record.fullLog.length > FULL_LOG) record.fullLog.splice(0, record.fullLog.length - FULL_LOG);
        this.bus.emit('operation.log', { id, line: clean });
      },
      throwIfCancelled: () => {
        if (controller.signal.aborted) throw new CancelledError();
      }
    };
    this.store.saveOperation(info);
    emit(true);
    record.promise = (async () => {
      try {
        const result = await fn(ctx);
        info.status = controller.signal.aborted ? 'cancelled' : 'succeeded';
        info.result = result;
        info.message = info.status === 'cancelled' ? 'Cancelled' : 'Completed';
        info.progress = 1;
        return result;
      } catch (err) {
        if (controller.signal.aborted || err instanceof CancelledError) {
          info.status = 'cancelled';
          info.message = 'Cancelled';
        } else {
          info.status = 'failed';
          info.error = err instanceof Error ? err.message : String(err);
          info.message = 'Failed';
          ctx.log(`ERROR: ${info.error}`);
        }
        return undefined;
      } finally {
        info.endedAt = Date.now();
        this.store.saveOperation(info);
        emit(true);
      }
    })();
    return this.snapshot(record);
  }

  private snapshot(r: OpRecord): OperationInfo {
    return { ...r.info, logTail: [...r.info.logTail] };
  }

  get(id: string): OperationInfo | undefined {
    const r = this.ops.get(id);
    return r ? this.snapshot(r) : undefined;
  }

  fullLog(id: string): string[] {
    return this.ops.get(id)?.fullLog ?? [];
  }

  list(): OperationInfo[] {
    return [...this.ops.values()].map((r) => this.snapshot(r)).sort((a, b) => b.startedAt - a.startedAt);
  }

  cancel(id: string): boolean {
    const r = this.ops.get(id);
    if (!r || r.info.status !== 'running') return false;
    r.controller.abort();
    r.info.message = 'Cancelling';
    this.bus.emit('operation.updated', this.snapshot(r));
    return true;
  }

  async wait(id: string, timeoutMs: number): Promise<OperationInfo | undefined> {
    const r = this.ops.get(id);
    if (!r) return undefined;
    await Promise.race([r.promise, new Promise((res) => setTimeout(res, timeoutMs))]);
    return this.snapshot(r);
  }
}
