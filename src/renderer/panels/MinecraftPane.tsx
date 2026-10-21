import { useEffect, useRef, useState } from 'react';
import { store, useAsync, useStore } from '../store';
import { derivePlayState, profileLabel } from '../session';
import { play, restart, stop, inspectTarget } from '../actions';
import { Button, IconButton } from '../ui/controls';
import { Ico } from '../ui/icons';
import { ApplyChanges } from '../components/ApplyChanges';
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
    const update = () => void window.workbench!.viewport.update(rectOf(el));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [docked, visible, modalOpen]);

  const capture = async () => {
    if (!instance) return;
    const r = await store.call<{ file: string; pngBase64: string }>('viewport.capture', { id: instance.id });
    setShot(`data:image/png;base64,${r.pngBase64}`);
    store.toast('success', `Screenshot saved to ${r.file}`);
  };

  const name = profile ? profileLabel(profile) : 'Test Client';
  const failed = state.phase === 'build-failed' || state.phase === 'launch-failed';

  return (
    <div className="mc-pane" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="mc-bar">
        <span className={`dot ${state.phase === 'running' ? 'ok' : failed ? 'err' : state.busy ? 'busy' : ''}`} />
        <b>{name}</b>
        <span className="dim">{state.label}</span>
        {clientRunning && <span className="mode-tag">{isDocked ? 'Embedded' : 'Separate window'}</span>}
        <div className="spacer" />
        {state.active && (
          <>
            <Button size="sm" variant="danger" icon="stop" onClick={() => void stop()} disabled={state.phase === 'stopping'}>
              {state.op ? 'Cancel' : 'Stop'}
            </Button>
            {state.phase === 'running' && <IconButton icon="restart" label="Restart" onClick={() => void restart()} />}
            {state.phase === 'running' && <ApplyChanges compact />}
            <IconButton icon="screenshot" label="Screenshot" onClick={() => void capture()} disabled={!instance?.bridge.connected || instance.side !== 'client'} />
            <IconButton icon="inspect" label="Inspect what you are looking at" onClick={() => void inspectTarget()} disabled={!instance?.bridge.connected} />
            {native && clientRunning && (isDocked ? <IconButton icon="detached" label="Move to a separate window" onClick={() => {
                  setDetachedFor(instance?.id ?? null);
                  void window.workbench?.viewport.detach();
                }} /> : <IconButton icon="minecraft" label="Embed in this tab" onClick={() => void attach()} />)}
          </>
        )}
        {native && (
          <label className="check small dim" title="Embed new game windows in this tab automatically">
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
            {state.phase === 'idle' && (
              <div className="mc-state">
                <span className="empty-icon"><Ico name="minecraft" size={20} /></span>
                <div className="mc-title">Minecraft is not running</div>
                <div className="dim">Profile: {name}</div>
                <Button variant="primary" size="lg" icon="play" onClick={() => void play()} disabled={!profile}>
                  Play
                </Button>
              </div>
            )}
            {state.busy && !clientRunning && (
              <div className="mc-state">
                <span className="empty-icon"><Ico name="loading" size={20} className="spin" /></span>
                <div className="mc-title">{state.label}</div>
                {state.detail && <div className="dim mono small ellipsis-2">{state.detail}</div>}
                {state.op && (
                  <Button size="sm" icon="close" onClick={() => void stop()}>
                    Cancel
                  </Button>
                )}
              </div>
            )}
            {clientRunning && instance?.status === 'starting' && (
              <div className="mc-state">
                <span className="empty-icon"><Ico name="loading" size={20} className="spin" /></span>
                <div className="mc-title">Starting Minecraft</div>
                <div className="dim small">{autoDock && native ? 'The game will appear here when its window opens.' : 'The game opens in its own window.'}</div>
                {lastLine && <div className="mono small mute ellipsis-2">{lastLine}</div>}
              </div>
            )}
            {clientRunning && instance?.status === 'running' && (
              <div className="mc-state">
                <span className="empty-icon"><Ico name="detached" size={20} /></span>
                <div className="mc-title">Running in a separate window</div>
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
            {instance && instance.side === 'server' && state.phase === 'running' && (
              <div className="mc-state">
                <span className="empty-icon"><Ico name="server" size={20} /></span>
                <div className="mc-title">Dedicated server is running</div>
                <Button icon="console" onClick={() => store.showTool('console')}>
                  Open server console
                </Button>
              </div>
            )}
            {failed && (
              <div className="mc-state">
                <span className="empty-icon err"><Ico name="problems" size={20} /></span>
                <div className="mc-title">{state.label}</div>
                {state.detail && <div className="dim small ellipsis-2">{state.detail}</div>}
                <div className="row center wrap">
                  <Button icon="problems" onClick={() => store.showTool(store.state.diagnostics.some((d) => d.severity === 'error') ? 'problems' : 'tasks')}>
                    Show details
                  </Button>
                  <Button variant="primary" icon="play" onClick={() => void play()}>
                    Try again
                  </Button>
                </div>
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
