import { useState } from 'react';
import { store, useStore } from '../store';
import type { InstanceInfo, OperationInfo } from '../../shared/types';
import { Button, IconButton, Notice, useOverlay } from '../ui/controls';
import { Ico } from '../ui/icons';
import { ask } from '../dialogs';
import { ensureJava } from '../java';
import { profileLabel } from '../session';

const LIVE = ['starting', 'running', 'stopping'];
const NAME = /^[A-Za-z0-9_]{3,16}$/;

export interface LiveSession {
  id: string | null;
  op?: OperationInfo;
  members: InstanceInfo[];
}

export function liveSession(ops: OperationInfo[], instances: InstanceInfo[], workspace: string): LiveSession | null {
  const members = instances.filter((i) => i.workspace === workspace && i.session && LIVE.includes(i.status));
  const op = ops.find((o) => o.kind === 'session.start' && o.workspace === workspace && o.status === 'running');
  if (!members.length && !op) return null;
  const id = members[0]?.session ?? null;
  return { id, op, members: id ? members.filter((m) => m.session === id).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0)) : [] };
}

export function memberLabel(i: InstanceInfo) {
  return i.player ?? (i.side === 'server' ? 'Server' : i.profileId);
}

export async function stopSession(s: LiveSession) {
  if (s.id) await store.call('session.stop', { id: s.id });
  else if (s.op) await store.call('operation.cancel', { id: s.op.id });
}

export function SessionChip() {
  const ws = useStore((s) => s.workspace)!;
  const operations = useStore((s) => s.operations);
  const instances = useStore((s) => s.instances);
  const s = liveSession(operations, instances, ws.path);
  if (!s) return null;
  const players = s.members.filter((m) => m.side === 'client').map(memberLabel);
  const text = s.op ? (s.op.message ?? 'Starting the session') : `Multiplayer · ${players.join(', ') || 'server only'}`;
  return (
    <span className="session-chip">
      <button type="button" className={`process-status ${s.op ? 'busy' : 'ok'}`} title={text} onClick={() => (s.id ? (store.set({ selectedInstance: `session:${s.id}` }), store.showTool('console')) : store.showTool('tasks'))}>
        <span className={`dot ${s.op ? 'busy' : 'ok'}`} />
        <Ico name="multiplayer" size={14} />
        <span className="ellipsis">{text}</span>
      </button>
      <IconButton icon="stop" label="Stop the multiplayer session" onClick={() => void stopSession(s)} />
    </span>
  );
}

export function MultiplayerDialog({ onClose }: { onClose: () => void }) {
  useOverlay(true);
  const ws = useStore((s) => s.workspace)!;
  const profiles = ws.manifest?.profiles ?? [];
  const servers = profiles.filter((p) => p.side === 'server');
  const clients = profiles.filter((p) => p.side === 'client');
  const prefer = <T extends { id: string; mode: string }>(list: T[]) => (list.find((p) => p.mode === 'development') ?? list[0])?.id ?? '';
  const [server, setServer] = useState(prefer(servers));
  const [client, setClient] = useState(prefer(clients));
  const [count, setCount] = useState(2);
  const [names, setNames] = useState(['Player1', 'Player2', 'Player3', 'Player4']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const used = names.slice(0, count).map((n) => n.trim());
  const nameError = used.map((n, i) => (!NAME.test(n) ? '3 to 16 letters, digits or underscores' : used.findIndex((o) => o.toLowerCase() === n.toLowerCase()) < i ? 'Already used' : null));
  const blocked = !server || !client || nameError.some(Boolean);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!ws.trusted) {
        if (!(await ask('A multiplayer test builds and runs code from this project (Gradle scripts and mods). Trust this project?'))) return;
        await store.call('workspace.trust', { path: ws.path, trusted: true });
        await store.refreshWorkspace();
      }
      const sp = servers.find((p) => p.id === server)!;
      const eula = await store.call<{ accepted: boolean }>('instance.eula_status', { path: ws.path, profile: sp.id, mode: sp.mode });
      if (!eula.accepted) {
        if (!(await ask('Running a Minecraft server requires accepting the Minecraft End User License Agreement (https://aka.ms/MinecraftEULA).\n\nDo you accept the EULA for this test server?'))) return;
        await store.call('instance.accept_eula', { path: ws.path, profile: sp.id, mode: sp.mode, accept: true });
      }
      const cp = clients.find((p) => p.id === client)!;
      if (!(await ensureJava({ path: ws.path, profile: sp.id, mode: sp.mode }))) return;
      if (!(await ensureJava({ path: ws.path, profile: cp.id, mode: cp.mode }))) return;
      await store.call<OperationInfo>('session.start', { path: ws.path, server, client, clients: count, names: used });
      const [latest] = await store.call<{ id: string }[]>('session.list', { path: ws.path }, { quiet: true });
      if (latest) store.set({ selectedInstance: `session:${latest.id}` });
      store.showTool('console');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal multiplayer-modal" role="dialog" aria-label="Multiplayer test" onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}>
        <div className="modal-head">
          <h2>Multiplayer test</h2>
          <div className="spacer" />
          <IconButton icon="close" label="Close" onClick={onClose} disabled={busy} />
        </div>
        <div className="modal-body col">
          <div className="small dim">
            Starts the server in offline mode on this computer, waits until it is ready, then opens each client with its own player name, offline UUID and game folder, already connected to the server. Their output is grouped in the Console.
          </div>
          {!servers.length || !clients.length ? (
            <Notice tone="warn">This project needs a server and a client run configuration. Add them in Run configurations.</Notice>
          ) : (
            <>
              <div className="row wrap">
                <label className="field grow">
                  <span>Server</span>
                  <select value={server} onChange={(e) => setServer(e.target.value)} disabled={busy}>
                    {servers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {profileLabel(p)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field grow">
                  <span>Clients</span>
                  <select value={client} onChange={(e) => setClient(e.target.value)} disabled={busy}>
                    {clients.map((p) => (
                      <option key={p.id} value={p.id}>
                        {profileLabel(p)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>How many</span>
                  <select value={count} onChange={(e) => setCount(Number(e.target.value))} disabled={busy} aria-label="Number of clients">
                    {[1, 2, 3, 4].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="multiplayer-names">
                {used.map((n, i) => (
                  <label key={i} className="field">
                    <span>Player {i + 1}</span>
                    <input value={names[i]} onChange={(e) => setNames((all) => all.map((x, j) => (j === i ? e.target.value : x)))} disabled={busy} aria-invalid={!!nameError[i]} spellCheck={false} />
                    {nameError[i] && <span className="field-error">{nameError[i]}</span>}
                  </label>
                ))}
              </div>
              <div className="small mute">Each client after the first uses its own folder next to the configuration's (for example {client}-client-2), so worlds, options and logs stay apart. The server's server.properties is set to online-mode=false.</div>
            </>
          )}
          {error && <Notice tone="error">{error}</Notice>}
        </div>
        <div className="modal-foot">
          <div className="spacer" />
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon="multiplayer" onClick={() => void start()} disabled={blocked || busy} busy={busy}>
            Start
          </Button>
        </div>
      </div>
    </div>
  );
}
