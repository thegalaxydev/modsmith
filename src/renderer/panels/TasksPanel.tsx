import { useEffect, useRef, useState } from 'react';
import { store } from '../store';
import type { OperationInfo } from '../../shared/types';

export function TasksPanel({ operations }: { operations: OperationInfo[] }) {
  const [selected, setSelected] = useState<string | null>(operations[0]?.id ?? null);
  const [log, setLog] = useState<string[]>([]);
  const pre = useRef<HTMLPreElement>(null);
  const op = operations.find((o) => o.id === selected) ?? operations[0];

  useEffect(() => {
    if (!op) return;
    let alive = true;
    void store.call<{ lines: string[] }>('operation.log', { id: op.id, tail: 3000 }, { quiet: true }).then((r) => alive && setLog(r.lines)).catch(() => setLog(op.logTail));
    const l = (id: string, line: string) => id === op.id && setLog((x) => [...x.slice(-5000), line]);
    store.opLogListeners.add(l);
    return () => {
      alive = false;
      store.opLogListeners.delete(l);
    };
  }, [op?.id]);
  useEffect(() => {
    pre.current?.scrollTo(0, pre.current.scrollHeight);
  }, [log.length]);

  return (
    <div className="row" style={{ flex: 1, minHeight: 0, alignItems: 'stretch', gap: 0 }}>
      <div className="scroll" style={{ width: 340, borderRight: '1px solid var(--line)' }}>
        {!operations.length && <div className="empty">No tasks yet.</div>}
        {operations.map((o) => (
          <div key={o.id} className={`list-item clickable ${o.id === op?.id ? 'selected' : ''}`} onClick={() => setSelected(o.id)}>
            <span className={`dot ${o.status === 'succeeded' ? 'ok' : o.status === 'failed' ? 'err' : o.status === 'running' ? 'warn' : ''}`} />
            <div className="grow">
              <div className="ellipsis">{o.title}</div>
              <div className="mute ellipsis" style={{ fontSize: 11.5 }}>
                {o.status === 'running' ? o.message : `${o.status} · ${o.endedAt ? ((o.endedAt - o.startedAt) / 1000).toFixed(1) + ' s' : ''}`}
              </div>
            </div>
            {o.status === 'running' && (
              <button className="small danger" onClick={(e) => (e.stopPropagation(), void store.call('operation.cancel', { id: o.id }))}>
                Cancel
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="col grow" style={{ minHeight: 0, gap: 0 }}>
        {op && (
          <div className="toolbar">
            <b>{op.title}</b>
            <span className="dim">{op.message}</span>
            {op.error && <span className="err ellipsis">{op.error}</span>}
          </div>
        )}
        <pre ref={pre} className="console" style={{ margin: 0, flex: 1, overflow: 'auto', padding: '6px 10px', whiteSpace: 'pre-wrap' }}>
          {log.join('\n')}
        </pre>
      </div>
    </div>
  );
}
