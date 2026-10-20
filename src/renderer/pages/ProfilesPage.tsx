import { useEffect, useState } from 'react';
import { store, useAsync, useStore, type ProfileView } from '../store';
import { profileDescription, profileLabel } from '../session';
import { play } from '../actions';
import { Button, Kv, Section, Segmented, Switch } from '../ui/controls';
import { Ico } from '../ui/icons';
import { LinkedPacks } from '../components/LinkedPacks';
import { ImportedPacks } from '../components/ImportPack';
import type { JavaInstallation } from '../../shared/types';
import { ask } from '../dialogs';

export function ProfilesPage() {
  const ws = useStore((s) => s.workspace)!;
  const activeProfile = useStore((s) => s.activeProfile);
  const m = ws.manifest;
  const [selected, setSelected] = useState(activeProfile ?? m?.profiles[0]?.id ?? '');
  const [creating, setCreating] = useState(false);
  if (!m) return <div className="page dim">Set up the project first.</div>;
  const profile = m.profiles.find((p) => p.id === selected) ?? m.profiles[0];

  return (
    <div className="page split-page">
      <div className="page-main narrow">
        <header className="page-head">
          <h1>Test Profiles</h1>
          <div className="spacer" />
          <Button icon="add" onClick={() => setCreating(true)}>
            New profile
          </Button>
        </header>
        <p className="dim">Each profile runs in its own isolated game folder with its own mods, settings and worlds.</p>
        <div className="profile-list" role="list">
          {m.profiles.map((p) => (
            <button key={p.id} type="button" role="listitem" className={`profile-card ${p.id === profile?.id ? 'selected' : ''}`} onClick={() => setSelected(p.id)}>
              <Ico name={p.side === 'server' ? 'server' : 'minecraft'} size={20} />
              <span className="col tight grow">
                <b>
                  {profileLabel(p)}
                  {p.id === activeProfile && <span className="tag">Active</span>}
                </b>
                <span className="small dim">{profileDescription(p, m)}</span>
              </span>
            </button>
          ))}
        </div>
        {creating && <NewProfile onDone={(id) => (setCreating(false), id && setSelected(id))} />}
      </div>
      <aside className="page-detail wide">{profile && <ProfileEditor key={profile.id} profile={profile} />}</aside>
    </div>
  );
}

function NewProfile({ onDone }: { onDone: (id: string | null) => void }) {
  const ws = useStore((s) => s.workspace)!;
  const [name, setName] = useState('');
  const [side, setSide] = useState<'client' | 'server'>('client');
  const [mode, setMode] = useState<'development' | 'production'>('development');
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return (
    <div className="card-flat form-stack">
      <h3>New profile</h3>
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Compatibility pack" autoFocus />
      </label>
      <Segmented
        label="Runs as"
        value={side}
        options={[
          { value: 'client', label: 'Client' },
          { value: 'server', label: 'Dedicated server' }
        ]}
        onChange={(v) => {
          setSide(v);
          if (v === 'client') setMode('development');
        }}
      />
      {side === 'server' && (
        <label className="check">
          <input type="checkbox" checked={mode === 'production'} onChange={(e) => setMode(e.target.checked ? 'production' : 'development')} />
          Test the built release JAR on a real server
        </label>
      )}
      <div className="row">
        <Button variant="primary" disabled={!id} onClick={() => void store.call('profile.create', { path: ws.path, profile: { id, name, side, mode, includeSourceMod: ws.manifest?.source.kind === 'gradle' } }).then(() => onDone(id))}>
          Create
        </Button>
        <Button variant="ghost" onClick={() => onDone(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ProfileEditor({ profile }: { profile: ProfileView }) {
  const ws = useStore((s) => s.workspace)!;
  const activeProfile = useStore((s) => s.activeProfile);
  const m = ws.manifest!;
  const baseline = { ...profile, name: profileLabel(profile) };
  const [draft, setDraft] = useState(baseline);
  const [eula, setEula] = useState<boolean | null>(null);
  const [compareWith, setCompareWith] = useState('');
  const javas = useAsync(() => store.call<JavaInstallation[]>('java.list', {}, { quiet: true }), []);
  useEffect(() => {
    if (profile.side === 'server') void store.call<{ accepted: boolean }>('instance.eula_status', { path: ws.path, profile: profile.id, mode: profile.mode }, { quiet: true }).then((r) => setEula(r.accepted));
  }, [profile.id]);
  const changed = JSON.stringify(draft) !== JSON.stringify(baseline);
  const instanceDir = `${ws.stateDir}\\instances\\${profile.id}${profile.mode === 'production' ? '-prod' : ''}-${profile.side}`;
  const save = () =>
    void store.call('profile.update', {
      path: ws.path,
      id: profile.id,
      patch: { name: draft.name, mode: draft.mode, jvm: draft.jvm, debug: draft.debug, bridge: draft.bridge, includeSourceMod: draft.includeSourceMod, java: draft.java, configDir: draft.configDir || undefined, world: draft.world?.name ? draft.world : undefined, programArgs: draft.programArgs }
    }).then(() => store.toast('success', 'Profile saved'));
  const clone = async () => {
    const name = await store.askText('Duplicate profile', 'Name for the copy', `${profileLabel(profile)} copy`);
    if (!name) return;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    await store.call('profile.clone', { path: ws.path, source: profile.id, id, name });
  };
  return (
    <div className="col">
      <div className="row">
        <h2 className="grow">{profileLabel(profile)}</h2>
        {profile.id !== activeProfile && (
          <Button size="sm" onClick={() => store.selectProfile(profile.id)}>
            Make active
          </Button>
        )}
        <Button size="sm" variant="primary" icon="play" onClick={() => (store.selectProfile(profile.id), void play(profile.id))}>
          Play
        </Button>
      </div>
      <p className="dim">{profileDescription(profile, m)}</p>
      <div className="form-stack">
        <label className="field">
          <span>Name</span>
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label className="field">
          <span>Memory</span>
          <div className="row">
            <input type="range" min={1024} max={16384} step={512} value={draft.jvm.memoryMb} onChange={(e) => setDraft({ ...draft, jvm: { ...draft.jvm, memoryMb: Number(e.target.value) } })} className="grow" aria-label="Memory in megabytes" />
            <span className="mono nowrap">{(draft.jvm.memoryMb / 1024).toFixed(1)} GB</span>
          </div>
        </label>
        <div className="toggle-row">
          <span className="col tight grow">
            <span>Include project code</span>
            <span className="small dim">Turn off to test only the mods in this profile.</span>
          </span>
          <Switch checked={draft.includeSourceMod} label="Include project code" onChange={(v) => setDraft({ ...draft, includeSourceMod: v })} disabled={m.source.kind !== 'gradle'} />
        </div>
        <div className="toggle-row">
          <span className="col tight grow">
            <span>Development bridge</span>
            <span className="small dim">Lets the workbench and assistants inspect the running game. Never included in your release JAR.</span>
          </span>
          <Switch checked={draft.bridge} label="Development bridge" onChange={(v) => setDraft({ ...draft, bridge: v })} />
        </div>
        <div className="toggle-row">
          <span className="col tight grow">
            <span>Release build</span>
            <span className="small dim">
              {draft.mode === 'production'
                ? `Builds the release JAR and runs a normal ${profile.side === 'server' ? 'server' : 'game'}, like players get. Slower to start; code changes need a new Play.`
                : 'Turn on to test the built release JAR instead of the development setup. Use it when mods from a modpack fail to load in development.'}
            </span>
          </span>
          <Switch checked={draft.mode === 'production'} label="Release build" onChange={(v) => setDraft({ ...draft, mode: v ? 'production' : 'development' })} />
        </div>
        <div className="toggle-row">
          <span className="col tight grow">
            <span>Allow debugger</span>
            <span className="small dim">{draft.debug.enabled ? `Attach your IDE to port ${draft.debug.port}.` : 'Enables attaching an IDE debugger and HotSwap.'}</span>
          </span>
          <Switch checked={draft.debug.enabled} label="Allow debugger" onChange={(v) => setDraft({ ...draft, debug: { ...draft.debug, enabled: v } })} />
        </div>
        {profile.side === 'server' && <div className="small dim">Minecraft EULA for this server: {eula === null ? '…' : eula ? 'accepted' : 'not accepted yet (you will be asked when you press Play)'}</div>}
      </div>
      <Section title="Modpacks">
        <ImportedPacks profile={profile} />
        <LinkedPacks key={profile.id} profileId={profile.id} />
      </Section>
      <Section title="Advanced settings" collapsible defaultOpen={false}>
        <div className="form-stack">
          <Kv
            rows={[
              ['Profile ID', <span className="mono">{profile.id}</span>],
              ['Runs as', `${profile.side === 'server' ? 'Dedicated server' : 'Client'}, ${profile.mode === 'production' ? 'release JAR validation' : 'development'}`],
              ['Game folder', <a className="mono wrap-text" onClick={() => void window.workbench?.openPath(instanceDir).catch(() => store.toast('info', 'The folder is created on first launch'))}>{instanceDir}</a>]
            ]}
          />
          <label className="field">
            <span>Java runtime</span>
            <select value={draft.java.home ?? ''} onChange={(e) => setDraft({ ...draft, java: { ...draft.java, home: e.target.value || undefined } })}>
              <option value="">Automatic</option>
              {javas.data?.map((j) => (
                <option key={j.home} value={j.home}>
                  Java {j.major} · {j.vendor} · {j.home}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>JVM arguments</span>
            <input value={draft.jvm.args.join(' ')} onChange={(e) => setDraft({ ...draft, jvm: { ...draft.jvm, args: e.target.value.split(/\s+/).filter(Boolean) } })} className="mono" placeholder="-XX:+UseZGC" />
          </label>
          <label className="field">
            <span>Game arguments</span>
            <input value={draft.programArgs.join(' ')} onChange={(e) => setDraft({ ...draft, programArgs: e.target.value.split(/\s+/).filter(Boolean) })} className="mono" />
          </label>
          <div className="row">
            <label className="field grow">
              <span>Debugger port</span>
              <input type="number" value={draft.debug.port} onChange={(e) => setDraft({ ...draft, debug: { ...draft.debug, port: Number(e.target.value) } })} />
            </label>
            <label className="check">
              <input type="checkbox" checked={draft.debug.suspend} onChange={(e) => setDraft({ ...draft, debug: { ...draft.debug, suspend: e.target.checked } })} />
              Wait for debugger
            </label>
          </div>
          <label className="field">
            <span>Config folder (copied into the game folder)</span>
            <input value={draft.configDir ?? ''} onChange={(e) => setDraft({ ...draft, configDir: e.target.value })} className="mono" placeholder="profiles/test/config" />
          </label>
          <label className="field">
            <span>World name (for data packs and snapshots)</span>
            <input value={draft.world?.name ?? ''} onChange={(e) => setDraft({ ...draft, world: { ...(draft.world ?? {}), name: e.target.value } })} />
          </label>
        </div>
      </Section>
      <Section title="Compare with another profile" collapsible defaultOpen={false}>
        <select value={compareWith} onChange={(e) => setCompareWith(e.target.value)} aria-label="Compare with">
          <option value="">Choose a profile</option>
          {m.profiles
            .filter((p) => p.id !== profile.id)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {profileLabel(p)}
              </option>
            ))}
        </select>
        {compareWith && <Compare a={profile.id} b={compareWith} />}
      </Section>
      <div className="row sticky-actions">
        <Button variant="primary" disabled={!changed} onClick={save}>
          Save changes
        </Button>
        <Button variant="ghost" disabled={!changed} onClick={() => setDraft(baseline)}>
          Discard
        </Button>
        <div className="spacer" />
        <Button size="sm" onClick={() => void clone()}>
          Duplicate
        </Button>
        <Button size="sm" variant="danger" icon="remove" onClick={() => void ask(`Delete the profile ${profileLabel(profile)}? Its game folder is kept on disk.`).then((ok) => ok && store.call('profile.remove', { path: ws.path, id: profile.id, confirm: true }))}>
          Delete
        </Button>
      </div>
    </div>
  );
}

function Compare({ a, b }: { a: string; b: string }) {
  const ws = useStore((s) => s.workspace)!;
  const r = useAsync(() => store.call<{ onlyA: string[]; onlyB: string[]; changed: { title: string; a: string; b: string }[]; settings: { field: string; a: unknown; b: unknown }[]; resolved: { a: boolean; b: boolean } }>('profile.compare', { path: ws.path, a, b }), [a, b, ws.lockProfiles.join()]);
  if (!r.data) return <div className="small mute">{r.error ?? 'Comparing…'}</div>;
  const d = r.data;
  return (
    <div className="small col">
      {(!d.resolved.a || !d.resolved.b) && <div className="warn">Check compatibility for both profiles to compare exact mod versions.</div>}
      {d.settings.map((s) => (
        <div key={s.field}>
          <span className="dim">{s.field}:</span> <span className="mono">{JSON.stringify(s.a)}</span> → <span className="mono">{JSON.stringify(s.b)}</span>
        </div>
      ))}
      {d.onlyA.length > 0 && <div>Only in this profile: {d.onlyA.join(', ')}</div>}
      {d.onlyB.length > 0 && <div>Only in the other: {d.onlyB.join(', ')}</div>}
      {d.changed.map((c) => (
        <div key={c.title}>
          {c.title}: {c.a} → {c.b}
        </div>
      ))}
      {!d.settings.length && !d.onlyA.length && !d.onlyB.length && !d.changed.length && <div className="ok">No differences.</div>}
    </div>
  );
}
