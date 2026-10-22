import { useEffect, useRef, useState } from 'react';
import { store, useStore } from './store';
import { Welcome } from './views/Welcome';
import { WorkspaceView } from './views/Workspace';
import { NewProjectWizard } from './views/NewProjectWizard';
import { SettingsModal } from './views/Settings';
import { PRODUCT } from '../shared/product';
import { Ico } from './ui/icons';
import { Button, useOverlay } from './ui/controls';
import { UpdateBanner } from './components/UpdateBanner';
import { checkForUpdates, updateCheckEnabled } from './updates';

export function App() {
  const connection = useStore((s) => s.connection);
  const connectionError = useStore((s) => s.connectionError);
  const workspace = useStore((s) => s.workspace);
  const toasts = useStore((s) => s.toasts);
  const [wizard, setWizard] = useState(false);
  const settings = useStore((s) => s.settingsTab);
  const setSettings = (tab: string | null) => store.set({ settingsTab: tab });

  useEffect(() => {
    store.set({ modalOpen: wizard || !!settings });
  }, [wizard, settings]);

  const checkedUpdates = useRef(false);
  useEffect(() => {
    if (connection !== 'connected' || checkedUpdates.current || !updateCheckEnabled()) return;
    checkedUpdates.current = true;
    const t = setTimeout(() => void checkForUpdates(), 2000);
    return () => clearTimeout(t);
  }, [connection]);

  useEffect(() => {
    if (connection !== 'connected' || workspace) return;
    const last = localStorage.getItem('mwb.lastWorkspace');
    if (last) void store.openWorkspace(last).catch(() => localStorage.removeItem('mwb.lastWorkspace'));
  }, [connection]);

  return (
    <div className="app">
      {connection !== 'connected' && (
        <div className="conn-banner" role="status">
          <Ico name="loading" className="spin" />
          {connection === 'connecting' ? `Connecting to the ${PRODUCT.name} service…` : `Reconnecting to the ${PRODUCT.name} service… ${connectionError ?? ''}`}
        </div>
      )}
      <UpdateBanner />
      {workspace ? <WorkspaceView onNewProject={() => setWizard(true)} onSettings={(tab) => setSettings(tab ?? 'java')} /> : <Welcome onNewProject={() => setWizard(true)} onSettings={(tab) => setSettings(tab ?? 'java')} />}
      {wizard && <NewProjectWizard onClose={() => setWizard(false)} />}
      {settings && <SettingsModal initialTab={settings} onClose={() => setSettings(null)} />}
      <PromptDialog />
      <MessageDialog />
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <Ico name={t.kind === 'error' ? 'problems' : t.kind === 'success' ? 'success' : 'info'} />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MessageDialog() {
  const message = useStore((s) => s.messages[0]);
  const box = useRef<HTMLDivElement>(null);
  useOverlay(!!message);
  useEffect(() => {
    if (message) setTimeout(() => box.current?.querySelector<HTMLButtonElement>(message.danger ? '.btn-ghost' : '.btn-primary')?.focus(), 0);
  }, [message]);
  if (!message) return null;
  const confirm = message.kind === 'confirm';
  const [lead, ...rest] = message.text.split(/\n\s*\n/);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && store.closeMessage(false)}>
      <div ref={box} className="dialog message-dialog" role={confirm ? 'alertdialog' : 'dialog'} aria-modal="true" aria-label={lead} onKeyDown={(e) => e.key === 'Escape' && store.closeMessage(false)}>
        <div className="message-body">
          <span className={`message-icon ${message.danger ? 'danger' : confirm ? 'ask' : 'info'}`}>
            <Ico name={message.danger ? 'warning' : confirm ? 'help' : 'info'} size={20} />
          </span>
          <div className="message-text">
            <p className="message-lead">{lead}</p>
            {rest.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        </div>
        <div className="row end">
          {confirm && (
            <Button variant="ghost" onClick={() => store.closeMessage(false)}>
              {message.no ?? 'No'}
            </Button>
          )}
          <Button variant={message.danger ? 'danger' : 'primary'} onClick={() => store.closeMessage(true)}>
            {confirm ? (message.yes ?? 'Yes') : 'OK'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PromptDialog() {
  const prompt = useStore((s) => s.prompt);
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (prompt) {
      setValue(prompt.value);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [prompt]);
  if (!prompt) return null;
  const finish = (v: string | null) => {
    prompt.resolve(v);
    store.set({ prompt: null });
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && finish(null)}>
      <form
        className="dialog"
        role="dialog"
        aria-label={prompt.title}
        onSubmit={(e) => {
          e.preventDefault();
          finish(value.trim() || null);
        }}
        onKeyDown={(e) => e.key === 'Escape' && finish(null)}
      >
        <h2>{prompt.title}</h2>
        <label className="field">
          <span>{prompt.label}</span>
          <input ref={input} value={value} onChange={(e) => setValue(e.target.value)} className="mono" />
        </label>
        <div className="row end">
          <Button variant="ghost" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!value.trim()}>
            OK
          </Button>
        </div>
      </form>
    </div>
  );
}
