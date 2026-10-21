import { useEffect, useState } from 'react';
import { store, useStore } from '../store';
import type { InstanceInfo } from '../../shared/types';
import { Button, IconButton, Notice, useOverlay } from '../ui/controls';
import { registryIndex } from '../registryComplete';
import { profileLabel } from '../session';

export type Step = { action: string } & Record<string, unknown>;
type Phase = 'setup' | 'steps' | 'cleanup';

export interface ScenarioDraft {
  schemaVersion: 1;
  name: string;
  description?: string;
  profile: string;
  snapshot?: string;
  requires: string[];
  timeoutMs: number;
  setup: Step[];
  steps: Step[];
  cleanup: Step[];
}

export const ACTIONS: { action: string; label: string; hint: string; make: () => Step }[] = [
  { action: 'command', label: 'Run a command', hint: 'Runs a command on the logical server. Optionally checks its output.', make: () => ({ action: 'command', command: '' }) },
  { action: 'give', label: 'Give an item', hint: 'Gives the player an item.', make: () => ({ action: 'give', item: '', count: 1 }) },
  { action: 'wait_ticks', label: 'Wait', hint: 'Waits for game ticks (20 ticks is one second).', make: () => ({ action: 'wait_ticks', ticks: 20 }) },
  { action: 'assert_block', label: 'Check a block', hint: 'Passes when the block at a position matches.', make: () => ({ action: 'assert_block', x: 0, y: 64, z: 0, block: '' }) },
  { action: 'assert_inventory', label: 'Check the inventory', hint: 'Passes when the player has at least this many of an item.', make: () => ({ action: 'assert_inventory', item: '', minCount: 1 }) },
  { action: 'assert_registry', label: 'Check a registry entry', hint: 'Passes when an ID is registered, for example an item your mod adds.', make: () => ({ action: 'assert_registry', registry: 'item', id: '' }) },
  { action: 'assert_log', label: 'Check the log', hint: 'Passes when the game log since the run started matches (or does not match) a regular expression.', make: () => ({ action: 'assert_log', pattern: '', absent: false }) },
  { action: 'screenshot', label: 'Take a screenshot', hint: 'Saves a screenshot from the client with the run results.', make: () => ({ action: 'screenshot' }) }
];

const PHASES: { key: Phase; label: string; hint: string }[] = [
  { key: 'setup', label: 'Setup', hint: 'Runs first. A failure here stops the scenario.' },
  { key: 'steps', label: 'Steps', hint: 'The test itself. Stops at the first failing step.' },
  { key: 'cleanup', label: 'Cleanup', hint: 'Always runs at the end, even after a failure.' }
];

export function newDraft(profile: string): ScenarioDraft {
  return { schemaVersion: 1, name: '', profile, requires: [], timeoutMs: 120000, setup: [], steps: [], cleanup: [] };
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'scenario';
}

export function propertiesText(p: unknown): string {
  return p && typeof p === 'object' ? Object.entries(p as Record<string, string>).map(([k, v]) => `${k}=${v}`).join(', ') : '';
}

export function parseProperties(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const part of text.split(',')) {
    const [k, ...v] = part.split('=');
    if (k.trim() && v.length) out[k.trim()] = v.join('=').trim();
  }
  return Object.keys(out).length ? out : undefined;
}

export function stepSummary(s: Step): string {
  switch (s.action) {
    case 'command':
      return `/${String(s.command ?? '').replace(/^\//, '')}`;
    case 'give':
      return `${s.count ?? 1} × ${s.item}`;
    case 'wait_ticks':
      return `${s.ticks} ticks`;
    case 'assert_block':
      return `${s.block} at ${s.x} ${s.y} ${s.z}`;
    case 'assert_inventory':
      return `at least ${s.minCount ?? 1} × ${s.item}`;
    case 'assert_registry':
      return `${s.registry ?? 'item'} ${s.id}`;
    case 'assert_log':
      return `${s.absent ? 'no line matches' : 'a line matches'} /${s.pattern}/`;
    default:
      return String(s.label ?? '');
  }
}

function clean(step: Step): Step {
  return Object.fromEntries(Object.entries(step).filter(([, v]) => v !== '' && v !== undefined)) as Step;
}

function Text({ label, value, onChange, list, placeholder, mono, grow }: { label: string; value: unknown; onChange: (v: string) => void; list?: string; placeholder?: string; mono?: boolean; grow?: boolean }) {
  return (
    <label className={`field ${grow ? 'grow' : ''}`}>
      <span>{label}</span>
      <input className={mono ? 'mono' : undefined} value={String(value ?? '')} list={list} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Num({ label, value, onChange, min }: { label: string; value: unknown; onChange: (v: number) => void; min?: number }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" className="sb-num" value={Number(value ?? 0)} min={min} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function StepCard({ step, index, count, live, onChange, onMove, onDuplicate, onRemove }: { step: Step; index: number; count: number; live?: InstanceInfo; onChange: (s: Step) => void; onMove: (d: -1 | 1) => void; onDuplicate: () => void; onRemove: () => void }) {
  const [note, setNote] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [inventory, setInventory] = useState<{ item: string; count: number }[] | null>(null);
  const set = (patch: Record<string, unknown>) => onChange({ ...step, ...patch });
  const meta = ACTIONS.find((a) => a.action === step.action);
  const canUseGame = !!live && live.bridge.connected;

  const capture = async (what: 'block' | 'inventory' | 'try') => {
    if (!live) return;
    setNote(null);
    try {
      if (what === 'block') {
        const t = await store.call<{ kind: string; block?: string; pos?: { x: number; y: number; z: number }; properties?: Record<string, string> }>('world.inspect_target', { id: live.id });
        if (t.kind !== 'block' || !t.pos) throw new Error('Look at a block in the game first.');
        set({ x: t.pos.x, y: t.pos.y, z: t.pos.z, block: t.block, properties: t.properties && Object.keys(t.properties).length ? t.properties : undefined });
      } else if (what === 'inventory') {
        const r = await store.call<{ items: { item: string; count: number }[] }>('bridge.call', { id: live.id, method: 'player.inventory', params: {} });
        if (!r.items.length) throw new Error('The inventory is empty.');
        setInventory(r.items);
      } else {
        const r = await store.call<{ output: string[]; result: number }>('world.run_command', { id: live.id, command: String(step.command ?? '').replace(/^\//, '') });
        setNote({ tone: 'info', text: `Result ${r.result}${r.output.length ? `: ${r.output.join(' | ')}` : ''}` });
      }
    } catch (e) {
      setNote({ tone: 'error', text: (e as Error).message });
    }
  };

  let regexError: string | null = null;
  if (step.action === 'assert_log') {
    try {
      new RegExp(String(step.pattern ?? ''));
    } catch (e) {
      regexError = (e as Error).message;
    }
  }

  return (
    <div className="sb-step" role="listitem">
      <div className="sb-step-head row">
        <span className="sb-index">{index + 1}</span>
        <select aria-label={`Action of step ${index + 1}`} value={step.action} onChange={(e) => onChange(ACTIONS.find((a) => a.action === e.target.value)!.make())}>
          {ACTIONS.map((a) => (
            <option key={a.action} value={a.action}>
              {a.label}
            </option>
          ))}
        </select>
        <span className="grow small dim ellipsis" title={meta?.hint}>
          {meta?.hint}
        </span>
        <IconButton icon="chevronDown" className="flip" label="Move up" disabled={index === 0} onClick={() => onMove(-1)} />
        <IconButton icon="chevronDown" label="Move down" disabled={index === count - 1} onClick={() => onMove(1)} />
        <IconButton icon="copy" label="Duplicate step" onClick={onDuplicate} />
        <IconButton icon="remove" label="Remove step" onClick={onRemove} />
      </div>
      <div className="sb-fields row wrap">
        {step.action === 'command' && (
          <>
            <Text label="Command" value={step.command} onChange={(v) => set({ command: v })} placeholder="time set day" mono grow />
            <Text label="Output must contain (optional)" value={step.expectOutputContains} onChange={(v) => set({ expectOutputContains: v || undefined })} />
            {canUseGame && (
              <Button size="sm" disabled={!String(step.command ?? '').trim()} onClick={() => void capture('try')}>
                Try in game
              </Button>
            )}
          </>
        )}
        {(step.action === 'give' || step.action === 'assert_inventory') && (
          <>
            <Text label="Item" value={step.item} onChange={(v) => set({ item: v })} list="sb-items" placeholder="minecraft:diamond" mono grow />
            {step.action === 'give' ? <Num label="Count" value={step.count ?? 1} min={1} onChange={(v) => set({ count: v })} /> : <Num label="At least" value={step.minCount ?? 1} min={1} onChange={(v) => set({ minCount: v })} />}
            {canUseGame && (
              <Button size="sm" onClick={() => void capture('inventory')}>
                Pick from inventory
              </Button>
            )}
          </>
        )}
        {step.action === 'wait_ticks' && (
          <>
            <Num label="Ticks" value={step.ticks} min={1} onChange={(v) => set({ ticks: v })} />
            <span className="small dim">{(Number(step.ticks ?? 0) / 20).toFixed(2)} s at 20 ticks per second</span>
          </>
        )}
        {step.action === 'assert_block' && (
          <>
            <Num label="X" value={step.x} onChange={(v) => set({ x: v })} />
            <Num label="Y" value={step.y} onChange={(v) => set({ y: v })} />
            <Num label="Z" value={step.z} onChange={(v) => set({ z: v })} />
            <Text label="Block" value={step.block} onChange={(v) => set({ block: v })} list="sb-blocks" placeholder="minecraft:stone" mono grow />
            <Text label="Properties (optional)" value={propertiesText(step.properties)} onChange={(v) => set({ properties: parseProperties(v) })} placeholder="facing=north, lit=true" mono />
            {canUseGame && (
              <Button size="sm" onClick={() => void capture('block')}>
                Use the block I am looking at
              </Button>
            )}
          </>
        )}
        {step.action === 'assert_registry' && (
          <>
            <Text label="Registry" value={step.registry ?? 'item'} onChange={(v) => set({ registry: v })} list="sb-registries" mono />
            <Text label="ID" value={step.id} onChange={(v) => set({ id: v })} list={step.registry === 'block' ? 'sb-blocks' : step.registry === 'entity_type' ? 'sb-entities' : step.registry === 'item' || !step.registry ? 'sb-items' : undefined} placeholder="mymod:my_item" mono grow />
          </>
        )}
        {step.action === 'assert_log' && (
          <>
            <Text label="Regular expression" value={step.pattern} onChange={(v) => set({ pattern: v })} placeholder="Loaded \d+ recipes" mono grow />
            <label className="check">
              <input type="checkbox" checked={step.absent === true} onChange={(e) => set({ absent: e.target.checked })} /> Must not appear
            </label>
          </>
        )}
        {step.action === 'screenshot' && <Text label="Label (optional)" value={step.label} onChange={(v) => set({ label: v || undefined })} placeholder="after-setup" grow />}
      </div>
      {regexError && <div className="small err">{regexError}</div>}
      {inventory && (
        <div className="row wrap sb-inventory">
          {inventory.map((it) => (
            <button
              type="button"
              key={`${it.item}-${it.count}`}
              className="chip mono small"
              onClick={() => {
                set(step.action === 'give' ? { item: it.item, count: it.count } : { item: it.item, minCount: it.count });
                setInventory(null);
              }}
            >
              {it.count} × {it.item}
            </button>
          ))}
        </div>
      )}
      {note && <div className={`small ${note.tone === 'error' ? 'err' : 'dim'} mono`}>{note.text}</div>}
    </div>
  );
}

export function ScenarioBuilder({ file, initial, live, onClose, onSaved }: { file?: string; initial: ScenarioDraft; live?: InstanceInfo; onClose: () => void; onSaved: (file: string, run: boolean) => void }) {
  useOverlay(true);
  const ws = useStore((s) => s.workspace)!;
  const profiles = ws.manifest?.profiles ?? [];
  const [draft, setDraft] = useState<ScenarioDraft>(initial);
  const [name, setName] = useState(file?.replace(/\.json$/, '') ?? '');
  const [phase, setPhase] = useState<Phase>('steps');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ids, setIds] = useState<{ items: string[]; blocks: string[]; entities: string[] }>({ items: [], blocks: [], entities: [] });
  const fileName = name || slugify(draft.name);
  const steps = draft[phase];

  useEffect(() => {
    void registryIndex(ws.path).then((r) => setIds({ items: r.items.map((e) => e.id), blocks: r.blocks.map((e) => e.id), entities: r.entities.map((e) => e.id) })).catch(() => undefined);
  }, [ws.path]);

  const setSteps = (list: Step[]) => setDraft((d) => ({ ...d, [phase]: list }));
  const move = (i: number, d: -1 | 1) => {
    const list = [...steps];
    [list[i], list[i + d]] = [list[i + d], list[i]];
    setSteps(list);
  };
  const scenario = { ...draft, description: draft.description || undefined, setup: draft.setup.map(clean), steps: draft.steps.map(clean), cleanup: draft.cleanup.map(clean) };
  const liveMatches = !!live && live.profileId === draft.profile && ['running', 'starting'].includes(live.status);

  const save = async (run: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await store.call<{ file: string }>('scenario.save', { path: ws.path, file: fileName, scenario });
      onSaved(r.file, run);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal scenario-builder" role="dialog" aria-label="Scenario builder" onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}>
        <div className="modal-head">
          <h2>{file ? `Edit ${file}` : 'New scenario'}</h2>
          <div className="spacer" />
          <IconButton icon="close" label="Close" onClick={onClose} disabled={busy} />
        </div>
        <div className="modal-body col">
          <div className="row wrap">
            <Text label="Name" value={draft.name} onChange={(v) => setDraft((d) => ({ ...d, name: v }))} placeholder="Crate drops its contents" grow />
            <label className="field">
              <span>Run configuration</span>
              <select value={draft.profile} onChange={(e) => setDraft((d) => ({ ...d, profile: e.target.value }))}>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {profileLabel(p)}
                  </option>
                ))}
                {!profiles.some((p) => p.id === draft.profile) && <option value={draft.profile}>{draft.profile}</option>}
              </select>
            </label>
            <Num label="Time limit (s)" value={Math.round(draft.timeoutMs / 1000)} min={1} onChange={(v) => setDraft((d) => ({ ...d, timeoutMs: Math.max(1, v) * 1000 }))} />
            {!file && <Text label="File" value={name} onChange={setName} placeholder={slugify(draft.name)} mono />}
          </div>
          <Text label="Description (optional)" value={draft.description} onChange={(v) => setDraft((d) => ({ ...d, description: v }))} grow />
          <div className="sb-phases row" role="tablist" aria-label="Scenario phases">
            {PHASES.map((p) => (
              <button key={p.key} type="button" role="tab" aria-selected={phase === p.key} className={`sb-phase ${phase === p.key ? 'active' : ''}`} onClick={() => setPhase(p.key)}>
                {p.label} <span className="dim">({draft[p.key].length})</span>
              </button>
            ))}
            <span className="small dim grow">{PHASES.find((p) => p.key === phase)!.hint}</span>
          </div>
          <div className="sb-steps col" role="list" aria-label={`${phase} steps`}>
            {!steps.length && <div className="small mute">No steps yet.</div>}
            {steps.map((s, i) => (
              <StepCard
                key={`${phase}-${i}`}
                step={s}
                index={i}
                count={steps.length}
                live={liveMatches ? live : undefined}
                onChange={(n) => setSteps(steps.map((x, j) => (j === i ? n : x)))}
                onMove={(d) => move(i, d)}
                onDuplicate={() => setSteps([...steps.slice(0, i + 1), { ...s }, ...steps.slice(i + 1)])}
                onRemove={() => setSteps(steps.filter((_, j) => j !== i))}
              />
            ))}
          </div>
          <div className="row wrap">
            {ACTIONS.map((a) => (
              <Button key={a.action} size="sm" icon="add" onClick={() => setSteps([...steps, a.make()])}>
                {a.label}
              </Button>
            ))}
          </div>
          {!liveMatches && <div className="small mute">Launch {draft.profile} and enter a world to try commands and capture blocks and items from the game.</div>}
          <details>
            <summary className="small dim">JSON</summary>
            <pre className="sb-json mono small">{JSON.stringify(scenario, null, 2)}</pre>
          </details>
          {error && <Notice tone="error">{error}</Notice>}
        </div>
        <div className="modal-foot">
          <span className="small dim">scenarios/{fileName}.json</span>
          <div className="spacer" />
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save(false)} busy={busy} disabled={!draft.name.trim()}>
            Save
          </Button>
          <Button variant="primary" icon="play" onClick={() => void save(true)} busy={busy} disabled={!draft.name.trim() || !liveMatches}>
            Save and run
          </Button>
        </div>
        <datalist id="sb-items">
          {ids.items.map((i) => (
            <option key={i} value={i} />
          ))}
        </datalist>
        <datalist id="sb-blocks">
          {ids.blocks.map((i) => (
            <option key={i} value={i} />
          ))}
        </datalist>
        <datalist id="sb-entities">
          {ids.entities.map((i) => (
            <option key={i} value={i} />
          ))}
        </datalist>
        <datalist id="sb-registries">
          {['item', 'block', 'entity_type', 'fluid', 'sound_event', 'particle_type', 'menu', 'block_entity_type', 'enchantment'].map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
      </div>
    </div>
  );
}
