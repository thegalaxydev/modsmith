import { useEffect, useState } from 'react';
import { store, useStore, waitForOperation } from '../store';
import type { OperationInfo } from '../../shared/types';
import { Button, IconButton, Notice, Switch, useOverlay } from '../ui/controls';
import { ask } from '../dialogs';
import { profileLabel } from '../session';

type Mode = 'mods' | 'full';
type Preset = 'bisect' | 'sftp';

interface Target {
  host: string;
  port: number;
  username: string;
  remoteDir: string;
  mode: Mode;
  removeStale: boolean;
}

interface Saved {
  target: Target | null;
  hasPassword: boolean;
  hostKey: string | null;
}

interface HostKey {
  hostKey: string;
  algorithm: string;
  trusted: boolean;
  changed: boolean;
}

interface Result {
  upload: { path: string; size: number; reason: 'new' | 'changed' }[];
  remove: string[];
  unchanged: number;
  uploadBytes: number;
  dryRun: boolean;
  host: string;
}

const LOADER: Record<string, string> = { fabric: 'Fabric Loader', neoforge: 'NeoForge', forge: 'Forge' };

function size(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function DeployDialog({ onClose }: { onClose: () => void }) {
  useOverlay(true);
  const ws = useStore((s) => s.workspace)!;
  const platform = ws.manifest?.platform;
  const servers = (ws.manifest?.profiles ?? []).filter((p) => p.side === 'server');
  const active = useStore((s) => s.activeProfile);
  const [profile, setProfile] = useState(servers.find((p) => p.id === active)?.id ?? servers[0]?.id ?? '');
  const [preset, setPreset] = useState<Preset>('bisect');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('2022');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [remoteDir, setRemoteDir] = useState('/');
  const [mode, setMode] = useState<Mode>('mods');
  const [removeStale, setRemoveStale] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<HostKey | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (!profile) return;
    let live = true;
    void store.call<Saved>('deploy.target_get', { path: ws.path, profile }, { quiet: true }).then((s) => {
      if (!live) return;
      setHasPassword(s.hasPassword);
      setResult(null);
      if (!s.target) return;
      setHost(s.target.host);
      setPort(String(s.target.port));
      setUsername(s.target.username);
      setRemoteDir(s.target.remoteDir);
      setMode(s.target.mode);
      setRemoveStale(s.target.removeStale);
      setPreset(s.target.port === 2022 ? 'bisect' : 'sftp');
    });
    return () => {
      live = false;
    };
  }, [ws.path, profile]);

  useEffect(() => setResult(null), [host, port, username, remoteDir, mode, removeStale]);

  const choosePreset = (p: Preset) => {
    setPreset(p);
    if (p === 'bisect' && port === '22') setPort('2022');
    if (p === 'sftp' && port === '2022') setPort('22');
    if (p === 'bisect') setMode('mods');
  };

  const portNumber = Number(port);
  const blocked = !profile || !host.trim() || !username.trim() || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535 || (!password && !hasPassword);
  const target = (): Target => ({ host: host.trim(), port: portNumber, username: username.trim(), remoteDir: remoteDir.trim() || '/', mode, removeStale });

  const run = async (dryRun: boolean, trust?: HostKey) => {
    setBusy(true);
    setError(null);
    try {
      if (ws.manifest?.source.kind === 'gradle' && !ws.trusted) {
        if (!(await ask("Deploying builds this project's Gradle scripts. Trust this project?"))) return;
        await store.call('workspace.trust', { path: ws.path, trusted: true });
        await store.refreshWorkspace();
      }
      const t = target();
      const saved = await store.call<Saved>('deploy.target_set', { path: ws.path, profile, target: t, ...(remember ? (password ? { password } : {}) : { password: null }) });
      setHasPassword(saved.hasPassword);
      if (trust) {
        await store.call('deploy.trust_host', { host: t.host, port: t.port, hostKey: trust.hostKey });
        setPendingKey(null);
      } else {
        const key = await store.call<HostKey>('deploy.host_key', { target: t });
        if (!key.trusted) {
          setPendingKey(key);
          return;
        }
      }
      if (!dryRun && !(await ask(`Upload ${result ? `${result.upload.length} files` : 'the server profile'} to ${t.host}${result?.remove.length ? ` and remove ${result.remove.length} mods that Modsmith uploaded earlier` : ''}?`))) return;
      const op = await store.call<OperationInfo>('server.deploy', { path: ws.path, profile, dryRun, confirm: !dryRun, ...(remember ? {} : { password }) });
      const done = await waitForOperation(op.id);
      if (done.status !== 'succeeded') {
        setError(done.error ?? 'The deploy did not finish');
        return;
      }
      const r = done.result as Result;
      setResult(r);
      if (!dryRun) store.toast('success', `Deployed to ${r.host}: ${r.upload.length} uploaded, ${r.remove.length} removed. Restart the server from your host's panel to load the changes.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const loaderText = platform ? `${LOADER[platform.loader] ?? platform.loader} ${platform.loaderVersion} for Minecraft ${platform.minecraft}` : '';

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal deploy-modal" role="dialog" aria-label="Deploy to a server" onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}>
        <div className="modal-head">
          <h2>Deploy to a server</h2>
          <div className="spacer" />
          <IconButton icon="close" label="Close" onClick={onClose} disabled={busy} />
        </div>
        <div className="modal-body col">
          <div className="small dim">Builds the server profile and uploads it to your server over SFTP. Only new and changed files are sent; server.properties, eula.txt and the world are never touched.</div>
          {!servers.length ? (
            <Notice tone="warn">This project needs a server run configuration. Add one in Run configurations.</Notice>
          ) : (
            <>
              <div className="row wrap">
                <label className="field grow">
                  <span>Server configuration</span>
                  <select value={profile} onChange={(e) => setProfile(e.target.value)} disabled={busy}>
                    {servers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {profileLabel(p)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field grow">
                  <span>Host</span>
                  <select value={preset} onChange={(e) => choosePreset(e.target.value as Preset)} disabled={busy}>
                    <option value="bisect">BisectHosting</option>
                    <option value="sftp">Another SFTP server</option>
                  </select>
                </label>
              </div>
              {preset === 'bisect' && (
                <div className="small mute">
                  In the BisectHosting panel, open your server, go to <b>Files</b> and click <b>SFTP Credentials</b> for the address and user name (username.serverid). The password is your panel password. {mode === 'mods' && loaderText ? `Set the server to ${loaderText} in the panel first.` : ''}
                </div>
              )}
              <div className="row wrap">
                <label className="field grow">
                  <span>Server address</span>
                  <input value={host} onChange={(e) => setHost(e.target.value)} disabled={busy} placeholder={preset === 'bisect' ? 'for example node.bisecthosting.com' : 'host name or IP address'} spellCheck={false} />
                </label>
                <label className="field deploy-port">
                  <span>Port</span>
                  <input value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} disabled={busy} inputMode="numeric" />
                </label>
              </div>
              <div className="row wrap">
                <label className="field grow">
                  <span>User name</span>
                  <input value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} placeholder={preset === 'bisect' ? 'username.serverid' : ''} spellCheck={false} autoComplete="off" />
                </label>
                <label className="field grow">
                  <span>Password</span>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} placeholder={hasPassword ? 'Saved' : ''} autoComplete="off" />
                </label>
              </div>
              <div className="toggle-row">
                <span className="col tight grow">
                  <span>Remember the password</span>
                  <span className="small dim">Kept in the system's secure storage, never in the project.</span>
                </span>
                <Switch checked={remember} onChange={setRemember} disabled={busy} label="Remember the password" />
              </div>
              <div className="row wrap">
                <label className="field grow">
                  <span>What to upload</span>
                  <select value={mode} onChange={(e) => setMode(e.target.value as Mode)} disabled={busy}>
                    <option value="mods">Mods and configs (the host runs the loader)</option>
                    <option value="full">The whole server, including the loader</option>
                  </select>
                </label>
                <label className="field grow">
                  <span>Folder on the server</span>
                  <input value={remoteDir} onChange={(e) => setRemoteDir(e.target.value)} disabled={busy} spellCheck={false} />
                </label>
              </div>
              <div className="toggle-row">
                <span className="col tight grow">
                  <span>Remove mods you took out of the configuration</span>
                  <span className="small dim">Only mods that Modsmith uploaded earlier. Files you added on the server yourself are left alone.</span>
                </span>
                <Switch checked={removeStale} onChange={setRemoveStale} disabled={busy} label="Remove mods you took out of the configuration" />
              </div>
              {pendingKey && (
                <Notice
                  tone={pendingKey.changed ? 'error' : 'warn'}
                  action={
                    <Button size="sm" onClick={() => void run(true, pendingKey)} disabled={busy}>
                      Trust and preview
                    </Button>
                  }
                >
                  {pendingKey.changed ? 'The key of this server has changed since the last deploy. Only continue if your host moved your server; otherwise someone may be intercepting the connection.' : 'Modsmith has not connected to this server before.'} Check that its key matches the one your host shows:{' '}
                  <span className="mono">
                    {pendingKey.algorithm} {pendingKey.hostKey}
                  </span>
                </Notice>
              )}
              {result && (
                <div className="deploy-result">
                  <div className="small">
                    {result.dryRun ? 'Preview: ' : 'Deployed: '}
                    {result.upload.length} {result.dryRun ? 'to upload' : 'uploaded'} ({size(result.uploadBytes)}), {result.remove.length} {result.dryRun ? 'to remove' : 'removed'}, {result.unchanged} unchanged
                  </div>
                  {(result.upload.length > 0 || result.remove.length > 0) && (
                    <ul className="deploy-files mono small">
                      {result.upload.slice(0, 40).map((f) => (
                        <li key={f.path}>
                          {f.reason === 'new' ? '+' : '~'} {f.path} <span className="mute">{size(f.size)}</span>
                        </li>
                      ))}
                      {result.remove.map((f) => (
                        <li key={f}>- {f}</li>
                      ))}
                      {result.upload.length > 40 && <li className="mute">and {result.upload.length - 40} more</li>}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
          {error && <Notice tone="error">{error}</Notice>}
        </div>
        <div className="modal-foot">
          <div className="spacer" />
          <Button onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button icon="search" onClick={() => void run(true)} disabled={blocked || busy} busy={busy}>
            Preview
          </Button>
          <Button variant="primary" icon="export" onClick={() => void run(false)} disabled={blocked || busy || !result?.dryRun}>
            Deploy
          </Button>
        </div>
      </div>
    </div>
  );
}
