import { useEffect, useState, type ReactNode } from 'react';
import { store, useStore } from '../store';
import { Button, Notice, Popover } from '../ui/controls';
import { Ico } from '../ui/icons';
import { summarizeChanges } from '../session';
import { activeInstance, applyResources, enableHotReload, hotReload, restart } from '../actions';

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
      width={380}
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

type Part = 'code' | 'resources' | 'datapacks';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function ApplyPanel({ summary, close }: { summary: ReturnType<typeof summarizeChanges>; close: () => void }) {
  const inst = activeInstance();
  const [caps, setCaps] = useState<ReloadAction[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [picked, setPicked] = useState<Record<Part, boolean>>({ code: summary.code > 0, resources: summary.assets > 0, datapacks: summary.data > 0 });
  useEffect(() => {
    if (!inst) return;
    void store.call<{ actions: ReloadAction[] }>('game.reload_capabilities', { id: inst.id }, { quiet: true }).then((r) => setCaps(r.actions)).catch(() => setCaps([]));
  }, [inst?.id, inst?.bridge.connected]);
  if (!inst) return <div className="pad">Minecraft is not running.</div>;
  const cap = (id: string) => caps?.find((c) => c.id === id);
  const dev = inst.mode !== 'production';
  const supported: Record<Part, boolean> = { code: dev && !!inst.debugPort, resources: dev && !!cap('resources')?.supported, datapacks: dev && !!cap('datapacks')?.supported };
  const chosen = (['code', 'resources', 'datapacks'] as Part[]).filter((p) => picked[p] && supported[p]);
  const run = async (id: string, fn: () => Promise<boolean | void>) => {
    setBusy(id);
    try {
      if ((await fn()) !== false) close();
    } catch {
      void 0;
    } finally {
      setBusy(null);
    }
  };
  const apply = () =>
    run('apply', async () => {
      if (chosen.includes('code')) {
        const r = await hotReload();
        if (!r || r.restartRequired) return false;
      }
      if (chosen.includes('resources')) await applyResources('resources');
      if (chosen.includes('datapacks')) await applyResources('datapacks');
    });
  const unavailable = (part: Part) => {
    if (!dev) return 'Release build: rebuild and restart';
    if (part === 'resources' && inst.side === 'server') return 'Dedicated servers have no client assets';
    if (!caps) return 'Checking…';
    return inst.bridge.connected ? 'Not available for this game' : 'Waiting for the game to connect';
  };
  const tracked = summary.files.length > 0;
  return (
    <div className="col apply-panel">
      <div className="popover-title">Apply changes</div>
      {tracked ? (
        <div className="small dim">
          Edited since launch: {[summary.code && `${summary.code} source`, summary.assets && `${summary.assets} asset`, summary.data && `${summary.data} game data`, summary.restart && `${summary.restart} metadata or build`, summary.config && `${summary.config} config`, summary.other && `${summary.other} other`].filter(Boolean).join(', ')} file{summary.files.length === 1 ? '' : 's'}.
        </div>
      ) : (
        <div className="small dim">No edits were tracked in the workbench since launch. Choose what to apply.</div>
      )}
      {summary.restart > 0 && <Notice tone="warn">Mod metadata, build files or mixin configuration changed. Those need a restart.</Notice>}
      <div className="apply-rows">
        <ApplyRow
          part="code"
          title={`Code${summary.code ? `: ${plural(summary.code, 'class', 'classes')}` : ''}`}
          detail={!dev ? unavailable('code') : inst.debugPort ? 'Compiles and hot-reloads changed method bodies' : 'Hot reload is off for this profile'}
          checked={picked.code && supported.code}
          disabled={!supported.code || !!busy}
          onChange={(v) => setPicked({ ...picked, code: v })}
          action={
            dev && !inst.debugPort ? (
              <Button size="sm" busy={busy === 'enable'} disabled={!!busy} onClick={() => void run('enable', enableHotReload)}>
                Turn on and restart
              </Button>
            ) : undefined
          }
        />
        <ApplyRow
          part="resources"
          title={`Assets${summary.assets ? `: ${plural(summary.assets, 'file')}` : ''}`}
          detail={supported.resources ? 'Textures, models, sounds and translations' : unavailable('resources')}
          checked={picked.resources && supported.resources}
          disabled={!supported.resources || !!busy}
          onChange={(v) => setPicked({ ...picked, resources: v })}
        />
        <ApplyRow
          part="datapacks"
          title={`Game data${summary.data ? `: ${plural(summary.data, 'file')}` : ''}`}
          detail={supported.datapacks ? 'Recipes, tags, loot tables, advancements' : unavailable('datapacks')}
          checked={picked.datapacks && supported.datapacks}
          disabled={!supported.datapacks || !!busy}
          onChange={(v) => setPicked({ ...picked, datapacks: v })}
        />
      </div>
      <div className="row apply-actions">
        <Button variant="primary" busy={busy === 'apply'} disabled={!chosen.length || (!!busy && busy !== 'apply')} onClick={() => void apply()}>
          Apply
        </Button>
        <Button icon="restart" busy={busy === 'restart'} disabled={!!busy && busy !== 'restart'} onClick={() => void run('restart', restart)}>
          Rebuild and restart
        </Button>
      </div>
      {inst.debugPort ? (
        <div className="small dim">
          <Ico name="debug" size={14} /> Debug port 127.0.0.1:{inst.debugPort}. An IDE debugger can attach there; hot reload needs the port free while it applies code.
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

function ApplyRow({ part, title, detail, checked, disabled, onChange, action }: { part: Part; title: string; detail: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void; action?: ReactNode }) {
  return (
    <div className={`apply-row ${disabled && !action ? 'off' : ''}`}>
      <label className="apply-row-main">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={`Apply ${part === 'resources' ? 'assets' : part === 'datapacks' ? 'game data' : 'code'}`} />
        <span className="col tight grow">
          <b>{title}</b>
          <span className="small dim">{detail}</span>
        </span>
      </label>
      {action}
    </div>
  );
}
