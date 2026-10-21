import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { store, useAsync, useStore } from '../store';
import { ago, derivePlayState, profileLabel, uptime } from '../session';
import { Button } from '../ui/controls';
import { Ico } from '../ui/icons';
import type { LogLine } from '../../shared/types';

interface Launch {
  id: string;
  profile: string;
  side: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  exit_code: number | null;
}

function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const i = line.search(/[=:]/);
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function relativeTo(root: string, file: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const r = norm(root);
  const f = norm(file);
  if (f.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return f.slice(r.length + 1);
  return null;
}

function duration(ms: number) {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'under a minute' : m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

export function ServerPane({ visible }: { visible: boolean }) {
  const ws = useStore((s) => s.workspace)!;
  const operations = useStore((s) => s.operations);
  const instances = useStore((s) => s.instances);
  const activeProfile = useStore((s) => s.activeProfile);
  const state = derivePlayState(operations, instances, ws.path, activeProfile);
  const instance = state.instance?.side === 'server' ? state.instance : undefined;
  const profile = ws.manifest?.profiles.find((p) => p.id === (instance?.profileId ?? activeProfile));
  const mode = instance?.mode ?? profile?.mode ?? 'development';
  const [lines, setLines] = useState<LogLine[]>([]);
  const [command, setCommand] = useState('');
  const [, tick] = useState(0);

  const eula = useAsync(
    () => (profile ? store.call<{ instanceDir: string; accepted: boolean }>('instance.eula_status', { path: ws.path, profile: profile.id, mode }, { quiet: true }) : Promise.resolve(null)),
    [ws.path, profile?.id, mode, instance?.status]
  );
  const instanceDir = instance?.instanceDir ?? eula.data?.instanceDir ?? null;
  const propsRel = instanceDir ? relativeTo(ws.path, `${instanceDir}/server.properties`) : null;
  const props = useAsync(
    () =>
      propsRel
        ? store
            .call<{ content: string }>('workspace.read_file', { path: ws.path, file: propsRel }, { quiet: true })
            .then((r) => parseProperties(r.content))
            .catch(() => null)
        : Promise.resolve(null),
    [propsRel, instance?.status]
  );
  const history = useAsync(() => store.call<Launch[]>('instance.history', { path: ws.path }, { quiet: true }), [ws.path, instances.map((i) => i.status).join()]);
  const last = history.data?.find((h) => h.profile === profile?.id && h.status !== 'running' && h.status !== 'starting');

  useEffect(() => {
    if (instance?.status !== 'running') return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [instance?.status]);

  useEffect(() => {
    setLines([]);
    if (!instance) return;
    let alive = true;
    void store
      .call<{ lines: LogLine[] }>('logs.read', { id: instance.id, limit: 5000 }, { quiet: true })
      .then((r) => alive && setLines(r.lines))
      .catch(() => undefined);
    const l = (id: string, add: LogLine[]) => {
      if (id === instance.id) setLines((prev) => prev.concat(add).slice(-5000));
    };
    store.logListeners.add(l);
    return () => {
      alive = false;
      store.logListeners.delete(l);
    };
  }, [instance?.id]);

  const players = useMemo(() => {
    const online = new Set<string>();
    for (const l of lines) {
      const text = l.message ?? l.text;
      const joined = text.match(/^(\w{3,16}) joined the game$/);
      const left = text.match(/^(\w{3,16}) left the game$/);
      if (joined) online.add(joined[1]);
      if (left) online.delete(left[1]);
    }
    return [...online];
  }, [lines]);

  const recent = lines.filter((l) => l.stream !== 'system').slice(-6);
  const running = instance?.status === 'running';
  const port = props.data?.['server-port'];
  const ip = props.data?.['server-ip'];
  const showOutput = (id?: string) => {
    if (id) store.set({ selectedInstance: id });
    store.showTool('console');
  };
  const send = async () => {
    const line = command.trim();
    if (!line || !instance) return;
    await store.call('instance.send_input', { id: instance.id, line });
    setCommand('');
  };

  if (!profile) {
    return (
      <div className="run-view" style={{ display: visible ? 'flex' : 'none' }}>
        <div className="view-empty">
          <div className="view-empty-title">No server configuration selected</div>
          <div className="dim">Choose a run configuration in the toolbar.</div>
        </div>
      </div>
    );
  }

  const title = instance ? (state.phase === 'running' ? 'Server running' : state.phase === 'stopping' ? 'Server stopping' : 'Server starting') : state.busy ? state.label : state.failed ? state.label : 'Server stopped';

  return (
    <div className="run-view server-view" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="view-bar">
        <span className={`dot ${state.tone}`} />
        <b>{title}</b>
        <span className="mute ellipsis">{profileLabel(profile)}</span>
        <div className="spacer" />
        <Button size="sm" variant="ghost" icon="console" onClick={() => showOutput(instance?.id ?? last?.id)}>
          Output
        </Button>
        {instanceDir && (
          <Button size="sm" variant="ghost" icon="openFolder" onClick={() => void window.workbench?.openPath(instanceDir)}>
            Folder
          </Button>
        )}
        {propsRel && props.data && (
          <Button size="sm" variant="ghost" icon="code" onClick={() => store.openTab(`file:${propsRel}`)}>
            server.properties
          </Button>
        )}
      </div>

      <div className="view-scroll">
        {state.failed && (
          <div className="view-alert err">
            <Ico name="problems" size={15} />
            <div className="col tight grow">
              <b>{state.label}</b>
              {state.detail && <span className="small dim">{state.detail}</span>}
            </div>
            <Button size="sm" onClick={() => (state.phase === 'crashed' ? showOutput(last?.id) : store.showTool('tasks'))}>
              {state.phase === 'crashed' ? 'Show log' : 'Show details'}
            </Button>
          </div>
        )}

        <section className="view-section">
          <h3>Process</h3>
          <dl className="kv">
            <Row label="Status">
              {instance ? (running ? `Running for ${uptime(Date.now() - instance.startedAt)}` : state.label) : state.busy ? state.detail ?? state.label : 'Stopped'}
            </Row>
            {instance?.pid != null && <Row label="Process ID">{instance.pid}</Row>}
            {instance?.javaExecutable && (
              <Row label="Java">
                <span className="mono small ellipsis" title={instance.javaExecutable}>
                  {instance.javaExecutable}
                </span>
              </Row>
            )}
            {!instance && (
              <Row label="Last run">
                {last ? (
                  <>
                    {last.status === 'exited' ? `Stopped normally after ${duration((last.ended_at ?? last.started_at) - last.started_at)}` : last.status === 'crashed' ? `Crashed${last.exit_code != null ? ` with exit code ${last.exit_code}` : ''}` : 'Failed to start'}
                    <span className="mute"> · {ago(last.ended_at ?? last.started_at)}</span>
                  </>
                ) : (
                  <span className="mute">Not run yet</span>
                )}
              </Row>
            )}
          </dl>
        </section>

        <section className="view-section">
          <h3>Network and world</h3>
          {props.data ? (
            <dl className="kv">
              <Row label="Address">
                <span className="mono">{ip ? `${ip}:${port ?? '25565'}` : `localhost:${port ?? '25565'}`}</span>
                {!ip && <span className="mute"> · listening on all interfaces</span>}
              </Row>
              <Row label="World">{props.data['level-name'] ?? 'world'}</Row>
              {props.data.gamemode && <Row label="Game mode">{props.data.gamemode}</Row>}
              {props.data.difficulty && <Row label="Difficulty">{props.data.difficulty}</Row>}
              {props.data['max-players'] && <Row label="Max players">{props.data['max-players']}</Row>}
              {props.data['online-mode'] && <Row label="Online mode">{props.data['online-mode'] === 'true' ? 'On (Microsoft accounts required)' : 'Off'}</Row>}
            </dl>
          ) : (
            <p className="mute small">The server writes server.properties on its first start. Address and world appear here after that.</p>
          )}
        </section>

        {running && (
          <section className="view-section">
            <h3>
              Players online <span className="mute">· from the server log</span>
            </h3>
            {players.length ? (
              <ul className="plain-list">
                {players.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : (
              <p className="mute small">Nobody has joined since the server started.</p>
            )}
          </section>
        )}

        <section className="view-section">
          <h3>Configuration</h3>
          <dl className="kv">
            <Row label="Build">{mode === 'production' ? 'Release JAR' : 'Development (project code from Gradle)'}</Row>
            <Row label="Memory">{profile.jvm.memoryMb} MB</Row>
            <Row label="Extra mods">{profile.mods.length}</Row>
            <Row label="EULA">{eula.data ? (eula.data.accepted ? 'Accepted' : 'Not accepted. You are asked before the first start.') : <span className="mute">Unknown</span>}</Row>
            {instanceDir && (
              <Row label="Folder">
                <span className="mono small ellipsis" title={instanceDir}>
                  {instanceDir}
                </span>
              </Row>
            )}
          </dl>
          <button type="button" className="link-btn" onClick={() => store.openTab('page:profiles')}>
            Edit run configuration
          </button>
        </section>
      </div>

      {instance && (
        <div className="server-console">
          <div className="server-tail mono" aria-label="Latest server output">
            {recent.length ? recent.map((l) => <div key={l.seq} className={`log-line ${l.level === 'ERROR' || l.level === 'FATAL' ? 'err' : l.level === 'WARN' ? 'warn' : ''}`}>{l.text}</div>) : <div className="mute">Waiting for output…</div>}
          </div>
          <form
            className="command-line"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <span className="mono mute">/</span>
            <input value={command} onChange={(e) => setCommand(e.target.value.replace(/^\//, ''))} placeholder={running ? 'Server command, for example list or op <player>' : 'Commands are available once the server is running'} aria-label="Server command" disabled={!running} spellCheck={false} />
            <Button size="sm" type="submit" disabled={!running || !command.trim()}>
              Send
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
