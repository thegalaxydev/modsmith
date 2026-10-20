import { Fragment, useState } from 'react';
import { store, useAsync, useStore } from '../store';
import { PRODUCT } from '../../shared/product';
import { checkForUpdates, dismissUpdate, setUpdateCheckEnabled, updateCheckEnabled } from '../updates';
import { SourceIcon } from '../ui/icons';
import type { CatalogEntry, JavaInstallation } from '../../shared/types';

type SettingsTab = 'java' | 'providers' | 'mcp' | 'interface' | 'catalog' | 'about';

export function SettingsModal({ onClose, initialTab = 'java' }: { onClose: () => void; initialTab?: string }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab as SettingsTab);
  const [refresh, setRefresh] = useState(0);
  const javas = useAsync(() => store.call<JavaInstallation[]>('java.list', { refresh: refresh > 0 }), [refresh]);
  const mcp = useAsync(() => store.call<{ available: boolean; config: unknown; claudeCodeCommand: string; note: string; reason?: string }>('mcp.config'), []);
  const catalog = useAsync(() => store.call<{ updated: string; entries: CatalogEntry[] }>('catalog.list'), []);
  const info = useAsync(() => store.call<Record<string, unknown>>('system.info'), []);
  const shell = useAsync(() => window.workbench?.info() ?? Promise.resolve(null), []);
  const display = shell.data?.display;
  const copy = (t: string) => void navigator.clipboard.writeText(t).then(() => store.toast('success', 'Copied'));

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>Settings</h2>
          {(['java', 'providers', 'mcp', 'interface', 'catalog', 'about'] as const).map((t) => (
            <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t === 'mcp' ? 'MCP' : t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
          <div className="spacer" />
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="modal-body">
          {tab === 'java' && (
            <div className="col">
              <div className="row">
                <span className="grow dim">Detected from JAVA_HOME, PATH, common vendor folders, ~/.jdks and ~/.gradle/jdks.</span>
                <button className="small" onClick={() => setRefresh((r) => r + 1)}>
                  Rescan
                </button>
                <button
                  className="small"
                  onClick={async () => {
                    const d = await window.workbench?.chooseDirectory('Choose a Java home directory');
                    if (d) await store.call('java.add', { home: d }).then(() => setRefresh((r) => r + 1));
                  }}
                >
                  Add Java home
                </button>
              </div>
              <table className="grid">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Kind</th>
                    <th>Vendor</th>
                    <th>Home</th>
                    <th>Found via</th>
                  </tr>
                </thead>
                <tbody>
                  {javas.loading && (
                    <tr>
                      <td colSpan={5} className="mute">
                        Scanning...
                      </td>
                    </tr>
                  )}
                  {javas.data?.map((j) => (
                    <tr key={j.home}>
                      <td>
                        <b>{j.major}</b> <span className="mute">{j.version}</span>
                      </td>
                      <td>{j.isJdk ? 'JDK' : 'JRE'}</td>
                      <td>{j.vendor}</td>
                      <td className="mono">{j.home}</td>
                      <td className="dim">{j.sources.join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {tab === 'providers' && <Providers />}
          {tab === 'interface' && (
            <div className="form-stack">
              <div className="toggle-row">
                <span className="col tight grow">
                  <span>Panel layout</span>
                  <span className="small dim">Restores the default panel sizes and which panels are open.</span>
                </span>
                <button className="btn btn-default btn-md" onClick={() => (store.resetLayout(), store.toast('success', 'Layout reset'))}>
                  Reset layout
                </button>
              </div>
              <div className="toggle-row">
                <span className="col tight grow">
                  <span>Embed the game window</span>
                  <span className="small dim">
                    Turn auto-embed on or off from the Minecraft tab. Embedding is available on Windows and on Linux with X11.
                    {shell.data && !shell.data.nativeViewport && ' It is not available in this session, so the game opens in its own window.'}
                  </span>
                </span>
              </div>
              {display?.waylandSession && (
                <div className="toggle-row">
                  <span className="col tight grow">
                    <span>Use native Wayland</span>
                    <span className="small dim">
                      {display.nativeWayland
                        ? 'Modsmith runs as a native Wayland app. The game opens in its own window because Wayland does not allow embedding other apps.'
                        : 'Modsmith runs through XWayland so the game can be embedded. Turn this on for sharper text with fractional scaling; the game then opens in its own window.'}{' '}
                      Takes effect after restarting Modsmith.
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    aria-label="Use native Wayland"
                    defaultChecked={display.nativeWayland}
                    onChange={(e) => void window.workbench?.setNativeWayland?.(e.target.checked).then(() => store.toast('info', 'Restart Modsmith to apply the display setting'))}
                  />
                </div>
              )}
            </div>
          )}
          {tab === 'mcp' && (
            <div className="col">
              <div className="callout info">
                Modsmith hosts an MCP server over stdio so Claude and other MCP clients can operate the same services as this UI: projects, builds, launches, logs, bridge inspection and tests. Actions are recorded in the Activity panel with source "mcp". The workbench does not run an AI model itself.
              </div>
              {mcp.data?.available ? (
                <>
                  <h4>Claude Code</h4>
                  <pre className="block">{mcp.data.claudeCodeCommand}</pre>
                  <button className="small" style={{ alignSelf: 'flex-start' }} onClick={() => copy(mcp.data!.claudeCodeCommand)}>
                    Copy command
                  </button>
                  <h4>Claude Desktop and other clients (mcpServers JSON)</h4>
                  <pre className="block">{JSON.stringify(mcp.data.config, null, 2)}</pre>
                  <button className="small" style={{ alignSelf: 'flex-start' }} onClick={() => copy(JSON.stringify(mcp.data!.config, null, 2))}>
                    Copy JSON
                  </button>
                  <div className="hint">{mcp.data.note}</div>
                </>
              ) : (
                <div className="mute">{mcp.data?.reason ?? 'Loading...'}</div>
              )}
              <h4>External MCP servers</h4>
              <div className="hint">Consuming external MCP servers from an in-app assistant is a planned extension point and is not implemented yet.</div>
            </div>
          )}
          {tab === 'catalog' && (
            <div className="col">
              <div className="dim">Compatibility catalog updated {catalog.data?.updated}. Project generation is limited to verified entries.</div>
              {catalog.data?.entries.map((e) => (
                <div key={e.id} className="card">
                  <div className="row">
                    <b>{e.id}</b>
                    <span className={`badge ${e.status === 'verified' ? 'ok' : 'warn'}`}>{e.status}</span>
                  </div>
                  <div className="kv" style={{ marginTop: 8 }}>
                    <span>Minecraft / loader</span>
                    <span>
                      {e.minecraft} / {e.loader} {e.loaderVersion}
                    </span>
                    <span>Plugin</span>
                    <span className="mono">
                      {e.plugin.id} {e.plugin.version}
                    </span>
                    <span>Gradle</span>
                    <span>{e.gradleVersion} on JDK {e.gradleJavaMin}+</span>
                    <span>Java</span>
                    <span>
                      release {e.javaRelease}, runtime {e.runtimeJavaMin}+
                    </span>
                    <span>Bridge</span>
                    <span>{e.bridge.available ? e.bridge.jar : 'not available'}</span>
                    <span>Note</span>
                    <span>{e.verificationNote}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {tab === 'about' && <UpdateSettings />}
          {tab === 'about' && info.data && (
            <div className="kv">
              {Object.entries(info.data).map(([k, v]) => (
                <Fragment key={k}>
                  <span>{k}</span>
                  <span className="mono">{Array.isArray(v) ? v.join(', ') : String(v)}</span>
                </Fragment>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Providers() {
  const [n, setN] = useState(0);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const status = useAsync(() => store.call<{ providers: { id: string; name: string; usable: boolean; detail: string; keySource?: string | null; secretStorage?: string }[] }>('provider.status'), [n]);
  const cf = status.data?.providers.find((p) => p.id === 'curseforge');
  return (
    <div className="col">
      {status.data?.providers.map((p) => (
        <div key={p.id} className="card">
          <div className="row">
            <SourceIcon source={p.id} size={16} />
            <b>{p.name}</b>
            <span className={`badge ${p.usable ? 'ok' : 'warn'}`}>{p.usable ? 'ready' : 'not configured'}</span>
            {p.keySource && <span className="badge">key from {p.keySource}</span>}
          </div>
          <div className="hint">{p.detail}</div>
        </div>
      ))}
      {cf && (
        <div className="card">
          <h2>CurseForge API key</h2>
          <div className="hint" style={{ marginBottom: 8 }}>
            Create a key in the CurseForge for Studios console and paste it here. It is verified against the API and stored with {cf.secretStorage}. It is never written to project files, logs or exports, and it cannot be read or set through MCP.
          </div>
          <div className="row">
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="CurseForge API key" className="grow mono" autoComplete="off" />
            <button
              className="small primary"
              disabled={key.length < 10 || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await store.call('provider.set_curseforge_key', { key });
                  setKey('');
                  store.toast('success', 'CurseForge key verified and stored');
                  setN((x) => x + 1);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Verifying...' : 'Save key'}
            </button>
            {cf.keySource === 'os-secret-store' && (
              <button className="small danger" onClick={() => void store.call('provider.clear_curseforge_key').then(() => setN((x) => x + 1))}>
                Remove
              </button>
            )}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <a onClick={() => void window.workbench?.openExternal('https://console.curseforge.com/')}>console.curseforge.com</a>
          </div>
        </div>
      )}
    </div>
  );
}

function UpdateSettings() {
  const update = useStore((s) => s.update);
  const [enabled, setEnabled] = useState(updateCheckEnabled());
  const [busy, setBusy] = useState(false);
  const status = !update
    ? 'Not checked yet in this session.'
    : update.error
      ? `Could not check for updates: ${update.error}`
      : update.available
        ? `${PRODUCT.name} ${update.latest} is available. You have ${update.current}.`
        : update.latest
          ? `You have the latest version (${update.current}).`
          : `No releases are published yet. You have ${update.current}.`;
  return (
    <div className="form-stack update-settings">
      <div className="toggle-row">
        <span className="col tight grow">
          <span>Check for updates when {PRODUCT.name} starts</span>
          <span className="small dim">{status}</span>
        </span>
        <input
          type="checkbox"
          aria-label="Check for updates when Modsmith starts"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            setUpdateCheckEnabled(e.target.checked);
          }}
        />
      </div>
      <div className="row">
        <button
          className="btn btn-default btn-md"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await checkForUpdates(true);
            dismissUpdate(null);
            setBusy(false);
          }}
        >
          {busy ? 'Checking…' : 'Check now'}
        </button>
        {update?.url && (
          <button className="btn btn-ghost btn-md" onClick={() => void window.workbench?.openExternal(update.url)}>
            Releases on GitHub
          </button>
        )}
      </div>
    </div>
  );
}
