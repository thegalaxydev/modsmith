import { useEffect, useRef } from 'react';
import { store, useStore } from '../store';
import { frameContext, frameUrl, hostMessage, themeVars } from '../extensions';
import { bridgePrefix, type InstalledExtension } from '../../shared/extensions';

export function ExtensionFrame({ ext, kind, contribution, file = null, title }: { ext: InstalledExtension; kind: 'viewer' | 'panel'; contribution: string; file?: string | null; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const fileVersion = useStore((s) => s.fileVersion);
  const wsPath = useStore((s) => s.workspace?.path ?? null);
  const latest = useRef({ ext, kind, contribution, file });
  latest.current = { ext, kind, contribution, file };

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win) return;
      const m = e.data;
      if (!m || m.__modsmith !== true || typeof m.id !== 'number' || typeof m.type !== 'string') return;
      const cur = latest.current;
      if (m.type === 'ready') {
        win.postMessage({ __modsmith: true, type: 'init', context: frameContext(cur.ext, cur.kind, cur.contribution, cur.file), theme: themeVars() }, '*');
        return;
      }
      hostMessage(cur.ext, m).then(
        (value) => win.postMessage({ __modsmith: true, type: 'result', id: m.id, value: value ?? null }, '*'),
        (err: Error) => win.postMessage({ __modsmith: true, type: 'result', id: m.id, error: err.message || String(err) }, '*')
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    const send = () => frame.current?.contentWindow?.postMessage({ __modsmith: true, type: 'theme', vars: themeVars() }, '*');
    const observer = new MutationObserver(send);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ __modsmith: true, type: 'filesChanged' }, '*');
  }, [fileVersion]);

  useEffect(() => {
    const listener = (instanceId: string, event: string, data: unknown) => {
      const ws = store.state.workspace;
      if (!ws || !event.startsWith(bridgePrefix(latest.current.ext.id))) return;
      if (!store.state.instances.some((i) => i.id === instanceId && i.workspace === ws.path)) return;
      frame.current?.contentWindow?.postMessage({ __modsmith: true, type: 'bridgeEvent', instanceId, event, data }, '*');
    };
    store.bridgeListeners.add(listener);
    return () => {
      store.bridgeListeners.delete(listener);
    };
  }, []);

  return <iframe key={`${ext.id}:${ext.installedAt}:${kind}:${contribution}:${file ?? ''}:${wsPath ?? ''}`} ref={frame} className="ext-frame" sandbox="allow-scripts" src={frameUrl(ext)} title={title} referrerPolicy="no-referrer" />;
}

export function ExtensionUnavailable({ id, onClose }: { id: string; onClose: () => void }) {
  return (
    <div className="empty col" style={{ gap: 8, alignItems: 'center' }}>
      <span>This extension panel is not available. The extension may be turned off or uninstalled.</span>
      <div className="row tight">
        <button className="small" onClick={() => store.openSettings('extensions')}>
          Manage extensions
        </button>
        <button className="small ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <span className="mute small">{id}</span>
    </div>
  );
}
