import { useEffect, useState } from 'react';
import { store, useStore } from '../store';
import { debuggerController, type DebugVariable } from '../debugger';
import { Button, IconButton } from '../ui/controls';
import { Ico } from '../ui/icons';
import { revealLine } from '../javaNav';

function VariableNode({ v, depth }: { v: DebugVariable; depth: number }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DebugVariable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const expandable = v.variablesReference > 0;
  const toggle = async () => {
    if (!expandable) return;
    const next = !open;
    setOpen(next);
    if (next && !children) {
      try {
        setChildren(await debuggerController.variables(v.variablesReference));
      } catch (e) {
        setError((e as Error).message);
      }
    }
  };
  return (
    <>
      <div className="dbg-var" style={{ paddingLeft: 6 + depth * 14 }} onClick={() => void toggle()} role={expandable ? 'button' : undefined} aria-expanded={expandable ? open : undefined}>
        <span className="dbg-twisty">{expandable ? <Ico name={open ? 'chevronDown' : 'chevronRight'} size={12} /> : null}</span>
        <span className="dbg-name">{v.name}</span>
        <span className="dbg-value mono ellipsis" title={v.type ? `${v.type}: ${v.value}` : v.value}>
          {v.value}
        </span>
      </div>
      {open && error && <div className="small err" style={{ paddingLeft: 20 + depth * 14 }}>{error}</div>}
      {open && children?.map((c, i) => <VariableNode key={`${c.name}-${i}`} v={c} depth={depth + 1} />)}
    </>
  );
}

function Scope({ name, ref }: { name: string; ref: number }) {
  const [vars, setVars] = useState<DebugVariable[] | null>(null);
  useEffect(() => {
    let alive = true;
    void debuggerController.variables(ref).then((v) => alive && setVars(v)).catch(() => alive && setVars([]));
    return () => {
      alive = false;
    };
  }, [ref]);
  return (
    <div className="dbg-scope">
      <div className="dbg-head small dim">{name}</div>
      {!vars && <div className="small mute dbg-pad">Loading…</div>}
      {vars?.length === 0 && <div className="small mute dbg-pad">No variables</div>}
      {vars?.map((v, i) => <VariableNode key={`${v.name}-${i}`} v={v} depth={0} />)}
    </div>
  );
}

export function DebugPanel() {
  const ws = useStore((s) => s.workspace)!;
  const debug = useStore((s) => s.debug);
  const instances = useStore((s) => s.instances);
  const breakpoints = useStore((s) => s.breakpoints[ws.path] ?? {});
  const candidates = instances.filter((i) => i.workspace === ws.path && ['starting', 'running'].includes(i.status) && i.mode === 'development');
  const [pick, setPick] = useState<string>('');
  const [expr, setExpr] = useState('');
  const [results, setResults] = useState<(DebugVariable & { error?: string })[]>([]);
  const [error, setError] = useState<string | null>(null);
  const target = candidates.find((i) => i.id === pick) ?? candidates.find((i) => i.debugPort) ?? candidates[0];
  const idle = debug.status === 'idle';
  const paused = debug.status === 'paused';
  const attached = debug.instance ? instances.find((i) => i.id === debug.instance) : undefined;
  const bpList = Object.entries(breakpoints).flatMap(([file, lines]) => lines.map((line) => ({ file, line })));

  const start = async () => {
    if (!target) return;
    setError(null);
    try {
      await debuggerController.start(target);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const act = (kind: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause') => void debuggerController.step(kind).catch((e: Error) => setError(e.message));
  const evaluate = async () => {
    const e = expr.trim();
    if (!e) return;
    try {
      const r = await debuggerController.evaluate(e);
      setResults((l) => [r, ...l].slice(0, 30));
    } catch (err) {
      setResults((l) => [{ name: e, value: '', variablesReference: 0, error: (err as Error).message }, ...l].slice(0, 30));
    }
    setExpr('');
  };

  return (
    <div className="debug-panel col">
      <div className="debug-bar row">
        {idle ? (
          <>
            {candidates.length > 1 && (
              <select aria-label="Game to debug" value={target?.id ?? ''} onChange={(e) => setPick(e.target.value)}>
                {candidates.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.profileId}
                    {i.player ? ` · ${i.player}` : ''}
                    {i.debugPort ? ` · port ${i.debugPort}` : ' · no debug port'}
                  </option>
                ))}
              </select>
            )}
            <Button size="sm" variant="primary" icon="debug" disabled={!target?.debugPort} onClick={() => void start()} title={target?.debugPort ? `Attach to ${target.profileId} on port ${target.debugPort}` : undefined}>
              Start debugging
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" icon="play" disabled={!paused} onClick={() => act('continue')} title="Continue (F5)">
              Continue
            </Button>
            <Button size="sm" disabled={paused || debug.status !== 'running'} onClick={() => act('pause')}>
              Pause
            </Button>
            <Button size="sm" disabled={!paused} onClick={() => act('next')} title="Step over (F10)">
              Step over
            </Button>
            <Button size="sm" disabled={!paused} onClick={() => act('stepIn')} title="Step into (F11)">
              Step into
            </Button>
            <Button size="sm" disabled={!paused} onClick={() => act('stepOut')} title="Step out (Shift+F11)">
              Step out
            </Button>
            <Button size="sm" variant="danger" icon="stop" disabled={debug.status === 'stopping'} onClick={() => void debuggerController.stop()}>
              Stop debugging
            </Button>
          </>
        )}
        <span className={`small ${paused ? 'warn' : 'dim'} ellipsis grow`}>
          {idle
            ? !candidates.length
              ? 'Start a development run to debug it. Breakpoints can be set any time in the gutter of a Java file.'
              : !target?.debugPort
                ? 'This run has no debug port. Turn on "Hot reload and debugger" for its run configuration and restart it.'
                : debug.message || `Ready to attach to ${target.profileId}`
            : `${debug.message}${attached ? ` · ${attached.profileId}` : ''}`}
        </span>
      </div>
      {error && <div className="small err dbg-pad">{error}</div>}
      <div className="debug-body row">
        <section className="debug-col">
          <div className="dbg-head small dim">Call stack</div>
          {paused && debug.threads.length > 1 && (
            <select aria-label="Thread" className="dbg-thread" value={debug.threadId ?? ''} onChange={(e) => void debuggerController.loadStack(Number(e.target.value)).catch((err: Error) => setError(err.message))}>
              {debug.threads.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
          {!paused && <div className="small mute dbg-pad">{debug.status === 'running' ? 'Running. The game stops here at a breakpoint.' : 'Not debugging.'}</div>}
          {paused &&
            debug.frames.map((f) => (
              <button type="button" key={f.id} className={`dbg-frame ${f.id === debug.frameId ? 'selected' : ''} ${f.file ? '' : 'dim'}`} onClick={() => void debuggerController.selectFrame(f).catch((e: Error) => setError(e.message))} title={f.uri ?? f.source}>
                <span className="ellipsis">{f.name}</span>
                <span className="small dim">
                  {f.source || '?'}:{f.line}
                </span>
              </button>
            ))}
        </section>
        <section className="debug-col">
          <div className="dbg-head small dim">Variables</div>
          {!paused && <div className="small mute dbg-pad">Shown while paused.</div>}
          {paused && debug.scopes.map((s) => <Scope key={`${debug.frameId}-${s.ref}`} name={s.name} ref={s.ref} />)}
        </section>
        <section className="debug-col">
          <div className="dbg-head small dim row">
            <span className="grow">Breakpoints ({bpList.length})</span>
            {bpList.length > 0 && (
              <button type="button" className="link-btn small" onClick={() => debuggerController.clearBreakpoints()}>
                Remove all
              </button>
            )}
          </div>
          {!bpList.length && <div className="small mute dbg-pad">Click in the gutter left of the line numbers in a Java file.</div>}
          {bpList.map((b) => (
            <div key={`${b.file}:${b.line}`} className="dbg-bp row">
              <span className="dbg-dot" />
              <button type="button" className="link-btn ellipsis grow mono small" onClick={() => void revealLine(b.file, b.line)} title={b.file}>
                {b.file.split('/').pop()}:{b.line}
              </button>
              <IconButton icon="close" size={12} label={`Remove breakpoint ${b.file}:${b.line}`} onClick={() => debuggerController.toggleBreakpoint(b.file, b.line)} />
            </div>
          ))}
          <div className="dbg-head small dim">Evaluate</div>
          <input
            className="mono dbg-eval"
            value={expr}
            disabled={!paused}
            placeholder={paused ? 'Expression in the selected frame, for example player.getName()' : 'Available while paused'}
            onChange={(e) => setExpr(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void evaluate()}
            aria-label="Evaluate expression"
          />
          {results.map((r, i) => (
            <div key={i} className="dbg-result">
              {r.error ? (
                <div className="small mono">
                  <span className="dim">{r.name} → </span>
                  <span className="err">{r.error}</span>
                </div>
              ) : (
                <VariableNode v={{ ...r, name: `${r.name} =` }} depth={0} />
              )}
            </div>
          ))}
          {debug.output.length > 0 && (
            <>
              <div className="dbg-head small dim">Debugger output</div>
              <pre className="dbg-output mono small">{debug.output.slice(-50).join('\n')}</pre>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

export function debugKeys(e: KeyboardEvent) {
  const st = store.state.debug;
  if (st.status === 'idle') return;
  const paused = st.status === 'paused';
  const run = (k: 'continue' | 'next' | 'stepIn' | 'stepOut') => {
    e.preventDefault();
    void debuggerController.step(k).catch(() => undefined);
  };
  if (e.key === 'F5' && paused && !e.shiftKey) run('continue');
  else if (e.key === 'F5' && e.shiftKey) {
    e.preventDefault();
    void debuggerController.stop();
  } else if (e.key === 'F10' && paused) run('next');
  else if (e.key === 'F11' && paused) run(e.shiftKey ? 'stepOut' : 'stepIn');
}
