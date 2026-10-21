import { useEffect, useMemo, useRef, useState } from 'react';
import { store, useStore } from '../store';
import type { InstanceInfo, LogLine } from '../../shared/types';
import { Ico } from '../ui/icons';
import { Button, Popover } from '../ui/controls';

const LEVELS = ['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'STDERR'];
const LIVE = ['starting', 'running', 'stopping'];

type Line = LogLine & { src?: string };

function sourceLabel(i: InstanceInfo) {
  return i.player ?? (i.side === 'server' ? 'Server' : i.profileId);
}

function instanceLabel(i: InstanceInfo) {
  return `${i.profileId}${i.player ? ` · ${i.player}` : i.session ? ' · session server' : ''} · ${i.status} · ${new Date(i.startedAt).toLocaleTimeString()}`;
}

export function mergeLogs(parts: { src: string; lines: LogLine[] }[]): Line[] {
  return parts
    .flatMap((p) => p.lines.map((l, n) => ({ l: { ...l, src: p.src }, n })))
    .sort((a, b) => a.l.ts - b.l.ts || a.n - b.n)
    .map((x) => x.l);
}
const MAX = 30000;
const RENDER = 2500;

export function ConsolePanel({ instances, current, group, onOpenFile }: { instances: InstanceInfo[]; current?: InstanceInfo; group?: { id: string; members: InstanceInfo[] }; onOpenFile: (p: string) => void }) {
  const ws = useStore((s) => s.workspace)!;
  const [lines, setLines] = useState<Line[]>([]);
  const [levels, setLevels] = useState<Set<string>>(new Set(LEVELS));
  const [search, setSearch] = useState('');
  const [logger, setLogger] = useState('');
  const [thread, setThread] = useState('');
  const [follow, setFollow] = useState(true);
  const [input, setInput] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const id = current?.id;
  const sources = group ? group.members : current ? [current] : [];
  const key = group ? `session:${group.id}:${sources.map((i) => i.id).join(',')}` : (id ?? '');

  useEffect(() => {
    setLines([]);
    if (!sources.length) return;
    let alive = true;
    const labels = new Map(sources.map((i) => [i.id, group ? sourceLabel(i) : undefined]));
    void Promise.all(sources.map((i) => store.call<{ lines: LogLine[] }>('logs.read', { id: i.id, limit: 5000 }, { quiet: true }).then((r) => ({ src: labels.get(i.id) ?? '', lines: r.lines })).catch(() => ({ src: '', lines: [] as LogLine[] }))))
      .then((parts) => alive && setLines(group ? mergeLogs(parts) : parts[0].lines))
      .catch(() => undefined);
    const l = (iid: string, add: LogLine[]) => {
      if (!labels.has(iid)) return;
      const src = labels.get(iid);
      setLines((prev) => {
        const next = prev.concat(src ? add.map((x) => ({ ...x, src })) : add);
        return next.length > MAX ? next.slice(next.length - MAX) : next;
      });
    };
    store.logListeners.add(l);
    return () => {
      alive = false;
      store.logListeners.delete(l);
    };
  }, [key]);

  const filtered = useMemo(() => {
    const s = search.toLowerCase();
    return lines.filter((l) => (!l.level || levels.has(l.level) || (l.level === 'TRACE' && levels.has('ERROR'))) && (!s || l.text.toLowerCase().includes(s)) && (!logger || l.logger === logger) && (!thread || l.thread === thread));
  }, [lines, levels, search, logger, thread]);
  const shown = filtered.slice(-RENDER);
  const loggers = useMemo(() => [...new Set(lines.map((l) => l.logger).filter(Boolean) as string[])].sort(), [lines.length > 0 ? Math.floor(lines.length / 200) : 0]);
  const threads = useMemo(() => [...new Set(lines.map((l) => l.thread).filter(Boolean) as string[])].sort(), [lines.length > 0 ? Math.floor(lines.length / 200) : 0]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown.length, follow, lines]);

  const openSource = async (cls: string, file: string, line: number) => {
    const pkgPath = cls.split('.').slice(0, -1).join('/');
    for (const root of ['src/main/java', 'src/client/java', 'src/test/java', 'src/main/kotlin']) {
      const rel = `${root}/${pkgPath}/${file}`;
      try {
        await store.call('workspace.read_file', { path: ws.path, file: rel }, { quiet: true });
        onOpenFile(rel);
        store.toast('info', `${rel}:${line}`);
        return;
      } catch {
        void 0;
      }
    }
    store.toast('info', `${file} is not part of this workspace`);
  };

  const renderText = (l: LogLine) => {
    const m = l.text.match(/^(\s+at )([\w$.]+)\.[\w$<>]+\((\w+\.(?:java|kt)):(\d+)\)(.*)$/);
    if (m) {
      return (
        <>
          {m[1]}
          <a onClick={() => void openSource(m[2].replace(/\$.*$/, ''), m[3], Number(m[4]))}>{l.text.trim().slice(3)}</a>
        </>
      );
    }
    return l.text;
  };

  const copy = () => void navigator.clipboard.writeText(filtered.map((l) => l.text).join('\n')).then(() => store.toast('success', `Copied ${filtered.length} lines`));

  const severity = levels.size === LEVELS.length ? 'all' : levels.has('INFO') ? 'info' : levels.has('WARN') ? 'warn' : 'error';
  const setSeverity = (v: string) => setLevels(new Set(v === 'all' ? LEVELS : v === 'info' ? ['FATAL', 'ERROR', 'WARN', 'INFO', 'STDERR'] : v === 'warn' ? ['FATAL', 'ERROR', 'WARN', 'STDERR'] : ['FATAL', 'ERROR', 'STDERR']));
  const filtersActive = !!logger || !!thread;

  return (
    <div className="console-wrap">
      <div className="console-bar">
        <label className="search-field">
          <Ico name="search" size={14} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search output" aria-label="Search output" />
        </label>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Severity">
          <option value="all">All messages</option>
          <option value="info">Info and above</option>
          <option value="warn">Warnings and errors</option>
          <option value="error">Errors only</option>
        </select>
        <select value={group ? `session:${group.id}` : (id ?? '')} onChange={(e) => store.set({ selectedInstance: e.target.value })} aria-label="Session" className="session-select">
          {!instances.length && <option value="">No sessions</option>}
          {[...new Set(instances.filter((i) => i.session).map((i) => i.session!))].map((sid) => {
            const members = instances.filter((i) => i.session === sid).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
            return (
              <option key={sid} value={`session:${sid}`}>
                Multiplayer · {members.map(sourceLabel).join(', ')} · {members.some((m) => LIVE.includes(m.status)) ? 'running' : 'ended'}
              </option>
            );
          })}
          {instances.map((i) => (
            <option key={i.id} value={i.id}>
              {instanceLabel(i)}
            </option>
          ))}
        </select>
        <Popover
          label="More filters"
          align="right"
          width={300}
          trigger={(p) => (
            <button type="button" className={`icon-btn ${filtersActive ? 'active' : ''}`} aria-label="More filters" title="More filters" onClick={p.onClick} aria-expanded={p['aria-expanded']}>
              <Ico name="filter" />
            </button>
          )}
        >
          {() => (
            <div className="form-stack">
              <label className="field">
                <span>Thread</span>
                <select value={thread} onChange={(e) => setThread(e.target.value)}>
                  <option value="">All threads</option>
                  {threads.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Logger name</span>
                <select value={logger} onChange={(e) => setLogger(e.target.value)}>
                  <option value="">All loggers</option>
                  {loggers.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <span className="small mute">Logger names are printed by the game and are not always the mod that produced the message.</span>
              </label>
              <fieldset className="levels">
                <legend>Levels</legend>
                {LEVELS.map((lv) => (
                  <label key={lv} className="check small">
                    <input
                      type="checkbox"
                      checked={levels.has(lv)}
                      onChange={(e) =>
                        setLevels((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(lv);
                          else n.delete(lv);
                          return n;
                        })
                      }
                    />
                    {lv}
                  </label>
                ))}
              </fieldset>
              <label className="check">
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow new output
              </label>
              <div className="row wrap">
                <Button size="sm" icon="copy" onClick={copy}>
                  Copy {filtered.length} lines
                </Button>
                {current && (
                  <Button size="sm" icon="external" onClick={() => void window.workbench?.openPath(current.logFile)}>
                    Raw log
                  </Button>
                )}
              </div>
            </div>
          )}
        </Popover>
        <span className="mute small nowrap">
          {filtered.length === lines.length ? `${lines.length} lines` : `${filtered.length} of ${lines.length}`}
        </span>
        {!follow && (
          <Button size="sm" onClick={() => setFollow(true)}>
            Jump to latest
          </Button>
        )}
      </div>
      <div className="console" ref={box} onScroll={(e) => {
        const el = e.currentTarget;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
        if (atBottom !== follow) setFollow(atBottom);
      }}>
        {!current && <div className="drawer-empty">Output appears here when a client or server is running.</div>}
        {filtered.length > RENDER && <div className="log-line log-meta">… {filtered.length - RENDER} earlier lines hidden; use search or open the raw log</div>}
        {shown.map((l) => (
          <div key={l.src ? `${l.src}:${l.seq}` : l.seq} className={`log-line l-${l.level ?? ''} s-${l.stream}`}>
            {l.src && <span className={`log-src src-${sourceIndex(group, l.src)}`}>{l.src}</span>}
            {renderText(l)}
          </div>
        ))}
      </div>
      {current?.side === 'server' && ['running', 'starting'].includes(current.status) && (!group || group.members.includes(current)) && (
        <div className="console-input">
          <span className="mono dim">&gt;</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && input.trim()) {
                void store.call('instance.send_input', { id: current.id, line: input });
                setInput('');
              }
            }}
            placeholder="Server console command"
            className="grow mono"
          />
        </div>
      )}
    </div>
  );
}

function sourceIndex(group: { members: InstanceInfo[] } | undefined, src: string) {
  return Math.max(0, group?.members.findIndex((m) => sourceLabel(m) === src) ?? 0) % 5;
}
