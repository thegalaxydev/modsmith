import { useEffect, useRef, useState } from 'react';
import { store, useAsync, useStore } from '../store';
import { derivePlayState, profileDescription, profileLabel } from '../session';
import { inspectTarget } from '../actions';
import { Button, IconButton } from '../ui/controls';
import { Ico } from '../ui/icons';
import type { LogLine } from '../../shared/types';

function rectOf(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

export function MinecraftPane({ visible }: { visible: boolean }) {
  const ws = useStore((s) => s.workspace)!;
  const operations = useStore((s) => s.operations);
  const instances = useStore((s) => s.instances);
  const activeProfile = useStore((s) => s.activeProfile);
  const modalOpen = useStore((s) => s.modalOpen || !!s.prompt || s.overlays > 0);
  const host = useRef<HTMLDivElement>(null);
  const [docked, setDocked] = useState<{ instanceId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoDock, setAutoDock] = useState(localStorage.getItem('mwb.autoDock') !== '0');
  const [detachedFor, setDetachedFor] = useState<string | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [lastLine, setLastLine] = useState<string>('');
  const shell = useAsync(() => window.workbench?.info() ?? Promise.resolve(null), []);
  const native = !!shell.data?.nativeViewport;
  const nativeWayland = !!shell.data?.display?.nativeWayland;
  const state = derivePlayState(operations, instances, ws.path, activeProfile);
  const instance = state.instance;
  const clientRunning = !!instance && instance.side === 'client' && ['starting', 'running'].includes(instance.status);
  const profile = ws.manifest?.profiles.find((p) => p.id === (instance?.profileId ?? activeProfile));
  const isDocked = !!docked && docked.instanceId === instance?.id;

  useEffect(() => {
    if (!window.workbench) return;
    void window.workbench.viewport.status().then((s) => setDocked(s.docked ? { instanceId: s.instanceId! } : null));
    return window.workbench.viewport.onState((s) => {
      if (s.docked) setDocked({ instanceId: String(s.instanceId) });
      else {
        setDocked(null);
        if (s.reason && !['detached by user', 'replaced', 'game window closed'].includes(String(s.reason))) setError(`The game window was released: ${String(s.reason)}`);
      }
    });
  }, []);

  useEffect(() => {
    if (!instance || instance.status !== 'starting') return;
    const l = (id: string, lines: LogLine[]) => {
      if (id !== instance.id) return;
      const last = [...lines].reverse().find((x) => x.message && x.stream !== 'system');
      if (last?.message) setLastLine(last.message.slice(0, 140));
    };
    store.logListeners.add(l);
    return () => void store.logListeners.delete(l);
  }, [instance?.id, instance?.status]);

  const attach = async () => {
    if (!instance || !host.current || !window.workbench) return;
    setError(null);
    setDetachedFor(null);
    const r = await window.workbench.viewport.attach(instance.id, rectOf(host.current));
    if (!r.ok) setError(r.error ?? 'Could not embed the game window');
    else void window.workbench.viewport.focus();
  };

  useEffect(() => {
    if (!autoDock || !native || !clientRunning || isDocked || !visible || detachedFor === instance?.id) return;
    let cancelled = false;
    let tries = 0;
    const tick = async () => {
      if (cancelled || !host.current || !instance) return;
      const r = await window.workbench!.viewport.attach(instance.id, rectOf(host.current));
      if (!r.ok && !cancelled && tries++ < 40) setTimeout(tick, 1500);
    };
    const t = setTimeout(tick, 1500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [autoDock, native, clientRunning, instance?.id, visible, isDocked, detachedFor]);

  useEffect(() => {
    if (!docked || !window.workbench) return;
    const show = visible && !modalOpen;
    void window.workbench.viewport.setVisible(show);
    if (!show || !host.current) return;
    const el = host.current;
    let last = '';
    let inFlight = false;
    let pending: ReturnType<typeof rectOf> | null = null;
    let frame = 0;
    const send = (r: ReturnType<typeof rectOf>) => {
      if (inFlight) {
        pending = r;
        return;
      }
      inFlight = true;
      void window.workbench!.viewport.update(r).finally(() => {
        inFlight = false;
        const next = pending;
        pending = null;
        if (next) send(next);
      });
    };
    const follow = () => {
      const r = rectOf(el);
      const key = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`;
      if (key !== last) {
        last = key;
        send(r);
      }
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [docked, visible, modalOpen]);

  const capture = async () => {
    if (!instance) return;
    const r = await store.call<{ file: string; pngBase64: string }>('viewport.capture', { id: instance.id });
    setShot(`data:image/png;base64,${r.pngBase64}`);
    store.toast('success', `Screenshot saved to ${r.file}`);
  };

  const name = profile ? profileLabel(profile) : 'No run configuration';
  const showDetails = () => {
    if (state.phase === 'crashed') {
      if (state.last) store.set({ selectedInstance: state.last.id });
      store.showTool('console');
    } else store.showTool(state.phase === 'build-failed' && store.state.diagnostics.some((d) => d.severity === 'error') ? 'problems' : 'tasks');
  };

  return (
    <div className="run-view client-view" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="view-bar">
        {clientRunning ? (
          <span className="mode-tag">{isDocked ? 'Embedded' : 'Separate window'}</span>
        ) : (
          <span className="mute small">Viewport</span>
        )}
        <div className="spacer" />
        {clientRunning && (
          <>
            {(profile?.bridge || instance?.bridge.connected) && (
              <>
                <IconButton icon="screenshot" label={instance?.bridge.connected ? 'Take a screenshot' : 'Take a screenshot (waiting for the bridge)'} onClick={() => void capture()} disabled={!instance?.bridge.connected} />
                <IconButton icon="inspect" label={instance?.bridge.connected ? 'Inspect what you are looking at' : 'Inspect (waiting for the bridge)'} onClick={() => void inspectTarget()} disabled={!instance?.bridge.connected} />
              </>
            )}
            {native &&
              (isDocked ? (
                <IconButton
                  icon="detached"
                  label="Move to a separate window"
                  onClick={() => {
                    setDetachedFor(instance?.id ?? null);
                    void window.workbench?.viewport.detach();
                  }}
                />
              ) : (
                <IconButton icon="minecraft" label="Embed in this view" onClick={() => void attach()} />
              ))}
          </>
        )}
        {native && (
          <label className="check small dim" title="Embed new game windows in this view automatically">
            <input
              type="checkbox"
              checked={autoDock}
              onChange={(e) => {
                setAutoDock(e.target.checked);
                localStorage.setItem('mwb.autoDock', e.target.checked ? '1' : '0');
              }}
            />
            Auto-embed
          </label>
        )}
      </div>
      <div className={`mc-host ${isDocked ? 'docked' : ''}`} ref={host} onMouseDown={() => isDocked && void window.workbench?.viewport.focus()}>
        {!isDocked && (
          <div className="mc-overlay">
            {!state.active && !state.failed && (
              <div className="view-empty">
                <div className="view-empty-title">Client stopped</div>
                {profile && <div className="dim">{name}: {profileDescription(profile, ws.manifest)}</div>}
                {state.detail && <div className="mute small">{state.detail}.</div>}
                <div className="mute small">Use Launch client in the toolbar to start it. {native ? (autoDock ? 'The game window will be embedded here.' : 'Auto-embed is off, so the game opens in its own window.') : ''}</div>
              </div>
            )}
            {state.busy && !clientRunning && (
              <div className="view-empty">
                <div className="view-empty-title">
                  <Ico name="loading" size={16} className="spin" /> {state.label}
                </div>
                {state.detail && <div className="dim mono small ellipsis-2">{state.detail}</div>}
              </div>
            )}
            {clientRunning && instance?.status === 'starting' && (
              <div className="view-empty">
                <div className="view-empty-title">
                  <Ico name="loading" size={16} className="spin" /> Starting the client
                </div>
                <div className="dim small">{autoDock && native ? 'The game will appear here when its window opens.' : 'The game opens in its own window.'}</div>
                {lastLine && <div className="mono small mute ellipsis-2">{lastLine}</div>}
              </div>
            )}
            {clientRunning && instance?.status === 'running' && (
              <div className="view-empty">
                <div className="view-empty-title">Running in a separate window</div>
                <div className="row center wrap">
                  <Button icon="external" onClick={() => instance && void window.workbench?.viewport.bringToFront(instance.id)}>
                    Show game window
                  </Button>
                  {native && (
                    <Button icon="minecraft" onClick={() => void attach()}>
                      Embed here
                    </Button>
                  )}
                </div>
                {!native && shell.data && <div className="small mute">{nativeWayland ? 'Embedding needs X11. Turn off "Use native Wayland" in Settings to embed the game.' : 'Embedding is available on Windows and on Linux with X11.'}</div>}
                {shot && <img className="mc-shot" src={shot} alt="Last screenshot" />}
              </div>
            )}
            {state.failed && (
              <div className="view-empty">
                <div className="view-empty-title err">{state.phase === 'crashed' ? `Client ${state.label.toLowerCase()}` : state.label}</div>
                {state.detail && <div className="dim small ellipsis-2">{state.detail}</div>}
                <Button icon={state.phase === 'crashed' ? 'console' : 'problems'} onClick={showDetails}>
                  {state.phase === 'crashed' ? 'Show log' : 'Show details'}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
      {error && <div className="mc-foot err small">{error}</div>}
      {isDocked && <div className="mc-foot small mute">Click the game to type into it. Press Esc in game to release the mouse. Fullscreen is not available while embedded.</div>}
    </div>
  );
}
