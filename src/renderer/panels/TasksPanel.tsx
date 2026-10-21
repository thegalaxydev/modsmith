import { useEffect, useRef, useState } from 'react';
import { store } from '../store';
import type { HotswapClass, HotswapResult, OperationInfo } from '../../shared/types';

const STATUS: Record<NonNullable<HotswapClass['status']>, string> = {
  redefined: 'Updated',
  'not-loaded': 'Loads when used',
  added: 'New class',
  restart: 'Needs restart',
  skipped: 'Not applied',
  rejected: 'Rejected'
};

function HotswapSummary({ result }: { result: HotswapResult }) {
  const head = result.applied
    ? `Hot reload applied: ${result.redefined} class${result.redefined === 1 ? '' : 'es'} updated in the running game`
    : result.restartRequired
      ? 'Nothing was applied. These changes need a restart:'
      : 'No compiled classes changed';
  return (
    <div className="hotswap-result">
      <div className="hotswap-summary">{head}</div>
      {result.error && <div className="err">{result.error}</div>}
      {result.classes.map((c) => (
        <div key={c.class}>
          <div className="hotswap-class">
            <span className={`hotswap-status ${c.status ?? ''}`}>{c.status ? STATUS[c.status] : c.change}</span>
            <span className="mono ellipsis">{c.class}</span>
            {c.methods.length > 0 && <span className="dim ellipsis">{c.methods.join(', ')}</span>}
          </div>
          {c.reasons.length > 0 && (
            <ul className="hotswap-reasons">
              {c.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

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
        {op?.kind === 'instance.hotswap' && op.status === 'succeeded' && op.result ? <HotswapSummary result={op.result as HotswapResult} /> : null}
        <pre ref={pre} className="console" style={{ margin: 0, flex: 1, overflow: 'auto', padding: '6px 10px', whiteSpace: 'pre-wrap' }}>
          {log.join('\n')}
        </pre>
      </div>
    </div>
  );
}
