import { useEffect, useRef, useState } from 'react';
import { store, useStore } from '../store';
import { derivePlayState } from '../session';
import { Button, EmptyState, IconButton, Kv, Notice, Section } from '../ui/controls';
import { Ico } from '../ui/icons';
import type { InstanceInfo } from '../../shared/types';

interface Target {
  kind: 'block' | 'entity' | 'miss';
  block?: string;
  type?: string;
  name?: string;
  uuid?: string;
  pos?: { x: number; y: number; z: number };
  dimension?: string;
  properties?: Record<string, string>;
  tags?: string[];
  biome?: string;
  lightLevel?: number;
  face?: string;
  health?: number;
  maxHealth?: number;
  blockEntity?: { type: string; nbt: string };
  nbt?: string;
  source?: string;
  note?: string;
}

export function Inspector() {
  const ws = useStore((s) => s.workspace)!;
  const operations = useStore((s) => s.operations);
  const instances = useStore((s) => s.instances);
  const activeProfile = useStore((s) => s.activeProfile);
  const inspectRequest = useStore((s) => s.inspectRequest);
  const state = derivePlayState(operations, instances, ws.path, activeProfile);
  const [pick, setPick] = useState<string | null>(null);
  const clients = instances.filter((i) => i.workspace === ws.path && i.side === 'client' && ['starting', 'running', 'stopping'].includes(i.status)).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  const inst = clients.find((i) => i.id === pick) ?? state.instance;
  return (
    <aside className="side-panel inspector" aria-label="Inspector">
      <div className="scroll grow">
        {clients.length > 1 && (
          <label className="field inspector-target">
            <span>Inspect</span>
            <select value={inst?.id ?? ''} onChange={(e) => setPick(e.target.value)} aria-label="Client to inspect">
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.player ?? c.profileId}
                  {c.player ? ` (${c.profileId})` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {!inst ? (
          <EmptyState icon="inspect" title="Client not running">
            Launch a client configuration from the toolbar to inspect blocks, entities and game data.
          </EmptyState>
        ) : !inst.bridge.connected ? (
          <div className="pad">
            <Notice tone="warn">
              {inst.status === 'starting' ? 'Waiting for the game to finish loading.' : 'The development bridge is not connected, so the game cannot be inspected.'}{' '}
              {inst.status !== 'starting' && 'Enable "Development bridge" for this configuration in Run configurations and restart.'}
            </Notice>
          </div>
        ) : (
          <Connected inst={inst} request={inspectRequest} />
        )}
      </div>
    </aside>
  );
}

function Connected({ inst, request }: { inst: InstanceInfo; request: number }) {
  const [target, setTarget] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const firstRequest = useRef(request);
  const run = <T,>(method: string, params: Record<string, unknown> = {}) => store.call<T>(method, { id: inst.id, ...params });

  useEffect(() => {
    const load = () => void store.call<Record<string, unknown>>('game.status', { id: inst.id }, { quiet: true }).then(setStatus).catch(() => undefined);
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [inst.id]);

  const inspect = async () => {
    setBusy(true);
    setError(null);
    try {
      setTarget(await run<Target>('world.inspect_target'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (request !== firstRequest.current && (inst.side === 'server' || status?.inWorld !== false)) void inspect();
  }, [request]);

  const inWorld = inst.side === 'server' || !!status?.inWorld;

  useEffect(() => {
    if (inWorld) setError(null);
  }, [inWorld]);

  return (
    <div className="col">
      {!inWorld && inst.side === 'client' && <NoWorld inst={inst} loading={!!status?.loading} />}
      {inWorld && (
        <div className="pad col">
          <Button icon="inspect" busy={busy} onClick={() => void inspect()} title="Inspect the block or entity under the crosshair">
            Inspect what you are looking at
          </Button>
          {error && <div className="err small">{error}</div>}
          {target && <TargetView t={target} />}
        </div>
      )}
      {inWorld && (
        <>
          <Section title="Quick actions" collapsible>
            <QuickActions inst={inst} />
          </Section>
          <Section title="Registries" collapsible defaultOpen={false}>
            <RegistryTool inst={inst} />
          </Section>
          <Section title="Recipes and tags" collapsible defaultOpen={false}>
            <RecipeTagTool inst={inst} />
          </Section>
          <Section title="Nearby entities" collapsible defaultOpen={false}>
            <EntitiesTool inst={inst} />
          </Section>
        </>
      )}
      <Section title="Performance" collapsible defaultOpen={false}>
        <Telemetry inst={inst} />
      </Section>
      <Section title="Loaded mods" collapsible defaultOpen={false}>
        <LoadedMods inst={inst} />
      </Section>
    </div>
  );
}

function NoWorld({ inst, loading }: { inst: InstanceInfo; loading: boolean }) {
  const [name, setName] = useState('modsmith-test');
  const [busy, setBusy] = useState(false);
  return (
    <div className="pad col">
      <Notice tone="info">{loading ? 'Minecraft is still loading resources.' : 'No world is open. Open or create a test world to inspect it.'}</Notice>
      <label className="field">
        <span>World name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="row wrap">
        <Button
          variant="primary"
          icon="add"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await store.call('world.open', { id: inst.id, name, create: true, flat: true });
            } finally {
              setBusy(false);
            }
          }}
        >
          Create flat world
        </Button>
        <Button onClick={() => void store.call('world.open', { id: inst.id, name, create: false })}>Open existing</Button>
      </div>
    </div>
  );
}

function TargetView({ t }: { t: Target }) {
  if (t.kind === 'miss') return <div className="dim small">Nothing is under the crosshair. Look at a block or entity in game and inspect again.</div>;
  const pos = t.pos ? `${fmt(t.pos.x)}, ${fmt(t.pos.y)}, ${fmt(t.pos.z)}` : '';
  return (
    <div className="target">
      <div className="target-head">
        <Ico name={t.kind === 'block' ? 'mods' : 'inspect'} size={16} />
        <div className="col tight grow">
          <b className="mono ellipsis">{t.kind === 'block' ? t.block : t.type}</b>
          <span className="small dim">
            {t.kind === 'entity' && t.name ? `${t.name} · ` : ''}
            {pos}
            {t.face ? ` · ${t.face} face` : ''}
          </span>
        </div>
      </div>
      {t.note && <div className="small warn">{t.note}</div>}
      <Kv
        rows={[
          ...(t.kind === 'entity' && t.health !== undefined ? ([['Health', `${t.health} / ${t.maxHealth}`]] as [string, string][]) : []),
          ...(t.biome ? ([['Biome', t.biome]] as [string, string][]) : []),
          ...(t.lightLevel !== undefined ? ([['Light', String(t.lightLevel)]] as [string, string][]) : []),
          ...(t.dimension ? ([['Dimension', t.dimension]] as [string, string][]) : [])
        ]}
      />
      {t.properties && Object.keys(t.properties).length > 0 && (
        <div>
          <div className="label">Block state</div>
          <Kv rows={Object.entries(t.properties)} />
        </div>
      )}
      {t.tags && t.tags.length > 0 && (
        <details>
          <summary>{t.tags.length} tags</summary>
          <div className="mono small dim wrap-text">{t.tags.join(', ')}</div>
        </details>
      )}
      {t.blockEntity && (
        <details>
          <summary>Block entity data ({t.blockEntity.type})</summary>
          <pre className="code-block">{t.blockEntity.nbt}</pre>
        </details>
      )}
      {t.nbt && (
        <details>
          <summary>Entity data</summary>
          <pre className="code-block">{t.nbt}</pre>
        </details>
      )}
      <div className="small mute">Read from {t.source === 'logical-server' ? 'the local game server' : 'the client copy of the world'}.</div>
    </div>
  );
}

function fmt(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function QuickActions({ inst }: { inst: InstanceInfo }) {
  const [item, setItem] = useState('');
  const [count, setCount] = useState(1);
  const [cmd, setCmd] = useState('');
  const [history, setHistory] = useState<{ cmd: string; out: string; ok: boolean }[]>([]);
  const exec = async (command: string) => {
    if (!command.trim()) return;
    try {
      const r = await store.call<{ success: boolean; result: number; output: string[] }>('world.run_command', { id: inst.id, command });
      setHistory((h) => [{ cmd: command, out: r.output.join('\n') || 'Done', ok: r.success }, ...h].slice(0, 20));
    } catch (e) {
      setHistory((h) => [{ cmd: command, out: (e as Error).message, ok: false }, ...h].slice(0, 20));
    }
  };
  return (
    <div className="col">
      <label className="field">
        <span>Give item</span>
        <div className="row">
          <input value={item} onChange={(e) => setItem(e.target.value)} placeholder="minecraft:diamond" className="mono grow" />
          <input type="number" value={count} min={1} max={6400} onChange={(e) => setCount(Number(e.target.value))} style={{ width: 64 }} aria-label="Count" />
          <Button size="sm" disabled={!item} onClick={() => void store.call('world.give_item', { id: inst.id, item, count }).then(() => store.toast('success', `Gave ${count} ${item}`))}>
            Give
          </Button>
        </div>
      </label>
      <label className="field">
        <span>Run command</span>
        <div className="row">
          <input
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void exec(cmd);
                setCmd('');
              }
            }}
            placeholder="time set day"
            className="mono grow"
          />
          <Button
            size="sm"
            disabled={!cmd}
            onClick={() => {
              void exec(cmd);
              setCmd('');
            }}
          >
            Run
          </Button>
        </div>
      </label>
      <div className="row wrap">
        {['time set day', 'weather clear', 'gamemode creative', 'gamemode survival'].map((c) => (
          <button key={c} type="button" className="chip" onClick={() => void exec(c)}>
            {c}
          </button>
        ))}
      </div>
      {history.map((h, i) => (
        <div key={i} className="small">
          <div className="mono">/{h.cmd}</div>
          <div className={`mono ${h.ok ? 'dim' : 'err'} wrap-text`}>{h.out}</div>
        </div>
      ))}
    </div>
  );
}

function RegistryTool({ inst }: { inst: InstanceInfo }) {
  const [registry, setRegistry] = useState('item');
  const [query, setQuery] = useState('');
  const [res, setRes] = useState<{ total: number; matched: number; entries: { id: string; name?: string }[] } | null>(null);
  const search = async () => setRes(await store.call('registry.search', { id: inst.id, registry, query, limit: 200 }));
  return (
    <div className="col">
      <div className="row">
        <select value={registry} onChange={(e) => setRegistry(e.target.value)} aria-label="Registry">
          {['item', 'block', 'entity_type', 'block_entity_type', 'enchantment', 'biome', 'sound_event', 'particle_type', 'potion', 'mob_effect'].map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void search()} placeholder="Filter" className="grow" aria-label="Registry filter" />
        <IconButton icon="search" label="Search registry" onClick={() => void search()} />
      </div>
      {res && (
        <div className="small">
          <div className="mute">
            {res.matched} of {res.total}
          </div>
          {res.entries.map((e) => (
            <div key={e.id} className="row hover-row">
              <span className="mono ellipsis grow" title={e.name}>
                {e.id}
              </span>
              {registry === 'item' && (
                <button type="button" className="link-btn" onClick={() => void store.call('world.give_item', { id: inst.id, item: e.id, count: 1 }).then(() => store.toast('success', `Gave ${e.id}`))}>
                  Give
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecipeTagTool({ inst }: { inst: InstanceInfo }) {
  const [q, setQ] = useState('');
  const [recipes, setRecipes] = useState<{ matched: number; recipes: { id: string; type: string; result: string; count: number; ingredients: string[][] }[] } | null>(null);
  const [tags, setTags] = useState<{ matched: number; tags: { tag: string; size: number; members: string[] }[] } | null>(null);
  return (
    <div className="col">
      <div className="row">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Item, recipe or tag id" className="grow" aria-label="Recipe or tag filter" />
        <Button size="sm" onClick={() => void store.call<typeof recipes>('world.recipes', { id: inst.id, query: q, limit: 40 }).then(setRecipes)}>
          Recipes
        </Button>
        <Button size="sm" onClick={() => void store.call<typeof tags>('world.tags', { id: inst.id, registry: 'item', query: q, limit: 40 }).then(setTags)}>
          Tags
        </Button>
      </div>
      {recipes && (
        <div className="small">
          <div className="mute">{recipes.matched} recipes</div>
          {recipes.recipes.map((r) => (
            <div key={r.id} className="list-line">
              <div className="mono">{r.id}</div>
              <div className="dim">
                {r.result} ×{r.count} · {r.type.replace('minecraft:', '')}
              </div>
            </div>
          ))}
        </div>
      )}
      {tags && (
        <div className="small">
          <div className="mute">{tags.matched} item tags</div>
          {tags.tags.map((t) => (
            <details key={t.tag}>
              <summary className="mono">
                #{t.tag} <span className="mute">({t.size})</span>
              </summary>
              <div className="mono dim wrap-text">{t.members.join(', ')}</div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function EntitiesTool({ inst }: { inst: InstanceInfo }) {
  const [res, setRes] = useState<{ total: number; entities: { type: string; name: string; distance: number }[] } | null>(null);
  return (
    <div className="col">
      <Button size="sm" icon="search" onClick={() => void store.call<typeof res>('world.entities', { id: inst.id, radius: 32 }).then(setRes)}>
        Scan 32 blocks
      </Button>
      {res && (
        <div className="small">
          <div className="mute">{res.total} entities</div>
          {res.entities.map((e, i) => (
            <div key={i} className="row">
              <span className="mono ellipsis grow">{e.type}</span>
              <span className="mute">{e.distance.toFixed(1)} m</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Telemetry({ inst }: { inst: InstanceInfo }) {
  const [t, setT] = useState<{ tps?: number; mspt?: number; entities?: number; memory?: { usedMb: number; maxMb: number } } | null>(null);
  useEffect(() => {
    const load = () => void store.call<typeof t>('game.telemetry', { id: inst.id }, { quiet: true }).then(setT).catch(() => undefined);
    load();
    const i = setInterval(load, 3000);
    return () => clearInterval(i);
  }, [inst.id]);
  if (!t) return <div className="mute small">Loading…</div>;
  return (
    <Kv
      rows={[
        ...(t.tps !== undefined ? ([['Ticks per second', `${t.tps.toFixed(1)} (${t.mspt?.toFixed(1)} ms per tick)`], ['Entities', String(t.entities)]] as [string, string][]) : []),
        ['Memory', t.memory ? `${t.memory.usedMb} of ${t.memory.maxMb} MB` : '-']
      ]}
    />
  );
}

function LoadedMods({ inst }: { inst: InstanceInfo }) {
  const [mods, setMods] = useState<{ id: string; version: string; name: string; nested: boolean }[] | null>(null);
  useEffect(() => {
    void store.call<typeof mods>('game.mods', { id: inst.id }, { quiet: true }).then(setMods).catch(() => setMods([]));
  }, [inst.id]);
  if (!mods) return <div className="mute small">Loading…</div>;
  const top = mods.filter((m) => !m.nested);
  return (
    <div className="small">
      {top.map((m) => (
        <div key={m.id} className="row">
          <span className="ellipsis grow">{m.name}</span>
          <span className="mono mute">{m.version}</span>
        </div>
      ))}
      <div className="mute">{mods.length - top.length} bundled libraries not shown</div>
    </div>
  );
}
