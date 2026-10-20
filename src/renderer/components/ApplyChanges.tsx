import { useEffect, useState } from 'react';
import { store, useStore } from '../store';
import { Button, Notice, Popover } from '../ui/controls';
import { Ico } from '../ui/icons';
import { summarizeChanges } from '../session';
import { activeInstance, applyResources, restart } from '../actions';

interface ReloadAction {
  id: string;
  label: string;
  supported: boolean;
  detail: string;
}

export function ApplyChanges({ compact = false }: { compact?: boolean }) {
  const ws = useStore((s) => s.workspace)!;
  const changes = useStore((s) => s.changes[ws.path] ?? []);
  const instances = useStore((s) => s.instances);
  const inst = activeInstance();
  const summary = summarizeChanges(changes);
  const pending = changes.length > 0;
  void instances;
  return (
    <Popover
      label="Apply changes"
      width={360}
      trigger={(p) =>
        compact ? (
          <button type="button" className={`icon-btn ${pending ? 'has-badge' : ''}`} aria-label="Apply changes" title="Apply changes" onClick={p.onClick} aria-expanded={p['aria-expanded']} disabled={!inst}>
            <Ico name="apply" />
          </button>
        ) : (
          <button type="button" className={`btn btn-default btn-md ${pending ? 'has-badge' : ''}`} onClick={p.onClick} aria-expanded={p['aria-expanded']} disabled={!inst} title="Apply changes to the running game">
            <Ico name="apply" />
            <span>Apply changes</span>
          </button>
        )
      }
    >
      {(close) => <ApplyPanel summary={summary} close={close} />}
    </Popover>
  );
}

function ApplyPanel({ summary, close }: { summary: ReturnType<typeof summarizeChanges>; close: () => void }) {
  const inst = activeInstance();
  const [caps, setCaps] = useState<ReloadAction[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  useEffect(() => {
    if (!inst) return;
    void store.call<{ actions: ReloadAction[] }>('game.reload_capabilities', { id: inst.id }, { quiet: true }).then((r) => setCaps(r.actions)).catch(() => setCaps([]));
  }, [inst?.id, inst?.bridge.connected]);
  if (!inst) return <div className="pad">Minecraft is not running.</div>;
  const cap = (id: string) => caps?.find((c) => c.id === id);
  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
      close();
    } catch {
      void 0;
    } finally {
      setBusy(null);
    }
  };
  const tracked = summary.files.length > 0;
  return (
    <div className="col apply-panel">
      <div className="popover-title">Apply changes</div>
      {tracked ? (
        <div className="small dim">
          Edited since launch: {[summary.assets && `${summary.assets} asset`, summary.data && `${summary.data} game data`, summary.restart && `${summary.restart} code or metadata`, summary.config && `${summary.config} config`, summary.other && `${summary.other} other`].filter(Boolean).join(', ')} file{summary.files.length === 1 ? '' : 's'}.
        </div>
      ) : (
        <div className="small dim">No edits were tracked in the workbench since launch. Choose what to apply.</div>
      )}
      {summary.restart > 0 && (
        <Notice tone="warn" action={<Button size="sm" icon="restart" busy={busy === 'restart'} onClick={() => void run('restart', restart)}>Restart</Button>}>
          This change requires restarting Minecraft.
        </Notice>
      )}
      <div className="apply-options">
        {inst.mode === 'production' && <div className="small dim">This is a release build: it runs the built JAR, so edits need a rebuild and restart.</div>}
        <ApplyOption icon="files" title="Reload assets" text="Textures, models, sounds and translations" recommended={summary.assets > 0 && inst.mode !== 'production'} disabled={!cap('resources')?.supported || inst.mode === 'production'} busy={busy === 'resources'} onClick={() => void run('resources', () => applyResources('resources'))} />
        <ApplyOption icon="tests" title="Reload game data" text="Recipes, tags, loot tables, advancements" recommended={summary.data > 0 && inst.mode !== 'production'} disabled={!cap('datapacks')?.supported || inst.mode === 'production'} busy={busy === 'datapacks'} onClick={() => void run('datapacks', () => applyResources('datapacks'))} />
        <ApplyOption icon="restart" title="Rebuild and restart" text="Code, mixins, registries, mod metadata, build files" recommended={summary.restart > 0 || (inst.mode === 'production' && summary.files.length > 0)} busy={busy === 'restart'} onClick={() => void run('restart', restart)} />
      </div>
      {inst.debugPort ? (
        <div className="small dim">
          <Ico name="debug" size={14} /> Debugger listening on 127.0.0.1:{inst.debugPort}. Use your IDE's HotSwap for method-body changes.
        </div>
      ) : null}
      <button type="button" className="link-btn" aria-expanded={help} onClick={() => setHelp((h) => !h)}>
        <Ico name="help" size={14} /> What can be applied without restarting?
      </button>
      {help && (
        <div className="help-list">
          {caps?.map((c) => (
            <div key={c.id}>
              <b>{c.label}</b>
              {!c.supported && <span className="mute"> (not available now)</span>}
              <div className="small dim">{c.detail}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ApplyOption({ icon, title, text, onClick, disabled, busy, recommended }: { icon: 'files' | 'tests' | 'restart'; title: string; text: string; onClick: () => void; disabled?: boolean; busy?: boolean; recommended?: boolean }) {
  return (
    <button type="button" className={`apply-option ${recommended ? 'recommended' : ''}`} onClick={onClick} disabled={disabled || busy}>
      <Ico name={busy ? 'loading' : icon} className={busy ? 'spin' : ''} />
      <span className="col tight grow">
        <b>
          {title}
          {recommended && <span className="tag">Suggested</span>}
        </b>
        <span className="small dim">{text}</span>
      </span>
    </button>
  );
}
