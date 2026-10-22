import { useState } from 'react';
import { store, useAsync, useStore } from '../store';
import { PERMISSIONS, type CatalogExtension, type ExtensionManifest, type ExtensionPermission, type InstalledExtension } from '../../shared/extensions';
import { Button, Notice, Switch } from '../ui/controls';
import { Ico } from '../ui/icons';
import { ask } from '../dialogs';

interface Inspected {
  manifest: ExtensionManifest;
  file: string;
  sha256: string;
  size: number;
  compatible: boolean;
  source: { kind: 'url' | 'file'; location: string };
  installed: string | null;
}

interface Catalog {
  source: string;
  fetchedAt: number;
  stale: boolean;
  error: string | null;
  extensions: CatalogExtension[];
}

function Permissions({ list }: { list: ExtensionPermission[] }) {
  if (!list.length) return <div className="mute small">Needs no permissions.</div>;
  return (
    <ul className="ext-perms">
      {list.map((p) => (
        <li key={p}>{PERMISSIONS[p]?.label ?? p}</li>
      ))}
    </ul>
  );
}

function Badge({ verified }: { verified: boolean }) {
  return verified ? (
    <span className="ext-badge verified" title="Reviewed and approved by the Modsmith maintainers">
      <Ico name="verified" size={13} /> Verified
    </span>
  ) : (
    <span className="ext-badge unverified" title="Installed from a link or file; nobody has reviewed it">
      Unverified
    </span>
  );
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function ExtensionSettings() {
  const installed = useStore((s) => s.extensions);
  const [refresh, setRefresh] = useState(0);
  const catalog = useAsync(() => store.call<Catalog>('extension.catalog', { force: refresh > 0 }, { quiet: true }), [refresh]);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Inspected | null>(null);
  const [error, setError] = useState<string | null>(null);

  const done = async (text: string) => {
    await store.loadExtensions();
    catalog.reload();
    store.toast('success', text);
  };

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const inspect = (params: { url?: string; file?: string }) =>
    run('inspect', async () => {
      setPending(await store.call<Inspected>('extension.inspect', params, { quiet: true }));
    });

  const chooseFile = async () => {
    const file = await window.workbench?.chooseFile('Choose an extension package', [{ name: 'Modsmith extension', extensions: ['zip'] }]);
    if (file) await inspect({ file });
  };

  const installPending = (p: Inspected) =>
    run('install', async () => {
      const r = await store.call<{ installed: InstalledExtension; previous: string | null }>('extension.install', { file: p.file, sha256: p.sha256, ...(p.source.kind === 'url' ? { url: p.source.location } : {}) }, { quiet: true });
      setPending(null);
      setLink('');
      await done(r.previous ? `Updated ${r.installed.name} to ${r.installed.version}` : `Installed ${r.installed.name}`);
    });

  const installVerified = (e: CatalogExtension) =>
    run(`verified:${e.id}`, async () => {
      const perms = e.latest.permissions.map((p) => `• ${PERMISSIONS[p]?.label ?? p}`).join('\n');
      if (!(await ask(`${e.installed ? 'Update' : 'Install'} ${e.name} ${e.latest.version} by ${e.publisher}?\n\n${perms ? `It can:\n${perms}` : 'It needs no permissions.'}`, { yes: e.installed ? 'Update' : 'Install', no: 'Cancel' }))) return;
      const r = await store.call<{ installed: InstalledExtension; previous: string | null }>('extension.install', { registry: e.id }, { quiet: true });
      await done(r.previous ? `Updated ${r.installed.name} to ${r.installed.version}` : `Installed ${r.installed.name}`);
    });

  const remove = (e: InstalledExtension) =>
    run(`remove:${e.id}`, async () => {
      if (!(await ask(`Uninstall ${e.name}? Its files are deleted.`, { yes: 'Uninstall', no: 'Cancel', danger: true }))) return;
      await store.call('extension.remove', { id: e.id }, { quiet: true });
      await done(`Uninstalled ${e.name}`);
    });

  const toggle = (e: InstalledExtension, enabled: boolean) =>
    run(`toggle:${e.id}`, async () => {
      await store.call('extension.set_enabled', { id: e.id, enabled }, { quiet: true });
      await store.loadExtensions();
    });

  const updates = new Map((catalog.data?.extensions ?? []).filter((c) => c.update).map((c) => [c.id, c]));

  return (
    <div className="col">
      <div className="callout info">
        Extensions add file viewers and panels to Modsmith. Each one runs in a sandbox and can only do what its permissions allow. Verified extensions were reviewed by the Modsmith maintainers before they were listed. Extensions from links and files are Unverified.
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {pending && (
        <div className="ext-confirm">
          <div className="row tight">
            <strong>
              {pending.manifest.name} {pending.manifest.version}
            </strong>
            <span className="mute">by {pending.manifest.publisher}</span>
            <Badge verified={false} />
          </div>
          {pending.manifest.description && <div>{pending.manifest.description}</div>}
          <Permissions list={pending.manifest.permissions} />
          <div className="mute small mono">
            {pending.source.location} · {kb(pending.size)} · SHA-256 {pending.sha256.slice(0, 16)}…
          </div>
          {pending.installed && (
            <div className="small">
              Replaces the installed version {pending.installed}.
            </div>
          )}
          {!pending.compatible && <Notice tone="warn">This extension needs Modsmith {pending.manifest.modsmith} or newer.</Notice>}
          <Notice tone="warn">Nobody has reviewed this extension. Only install extensions from people you trust.</Notice>
          <div className="row end">
            <Button variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button variant="primary" busy={busy === 'install'} disabled={!pending.compatible} onClick={() => void installPending(pending)}>
              Install
            </Button>
          </div>
        </div>
      )}

      <h4>Installed</h4>
      {!installed.length && <div className="mute">No extensions are installed.</div>}
      {installed.map((e) => {
        const update = updates.get(e.id);
        return (
          <div key={e.id} className={`ext-row ${e.enabled ? '' : 'off'}`}>
            <Ico name="extension" size={20} />
            <div className="col tight grow">
              <div className="row tight">
                <strong>{e.name}</strong>
                <span className="mute">
                  {e.version} · {e.publisher}
                </span>
                <Badge verified={e.verified} />
              </div>
              {e.description && <div className="small">{e.description}</div>}
              <Permissions list={e.manifest.permissions} />
              <div className="mute small">
                {e.manifest.contributes.viewers.map((v) => `Viewer: ${v.title} (${v.files.join(', ')})`).concat(e.manifest.contributes.panels.map((p) => `Panel: ${p.title}`)).join(' · ') || 'Adds no viewers or panels.'}
              </div>
            </div>
            <div className="row tight nowrap">
              {update && (
                <Button size="sm" variant="primary" busy={busy === `verified:${e.id}`} onClick={() => void installVerified(update)}>
                  Update to {update.latest.version}
                </Button>
              )}
              <Switch checked={e.enabled} label={e.enabled ? `Turn off ${e.name}` : `Turn on ${e.name}`} onChange={(v) => void toggle(e, v)} />
              <Button size="sm" variant="ghost" busy={busy === `remove:${e.id}`} onClick={() => void remove(e)}>
                Uninstall
              </Button>
            </div>
          </div>
        );
      })}

      <div className="row tight">
        <h4 className="grow">Verified extensions</h4>
        <Button size="sm" variant="ghost" icon="restart" busy={catalog.loading} onClick={() => setRefresh((n) => n + 1)}>
          Refresh
        </Button>
      </div>
      {catalog.data?.error && <Notice tone={catalog.data.extensions.length ? 'warn' : 'error'}>Could not load the extension registry: {catalog.data.error}</Notice>}
      {catalog.data && !catalog.data.error && !catalog.data.extensions.length && <div className="mute">No Verified extensions are listed yet.</div>}
      {(catalog.data?.extensions ?? []).map((e) => (
        <div key={e.id} className="ext-row">
          <Ico name="verified" size={20} />
          <div className="col tight grow">
            <div className="row tight">
              <strong>{e.name}</strong>
              <span className="mute">
                {e.latest.version} · {e.publisher}
              </span>
              {e.license && <span className="mute small">{e.license}</span>}
            </div>
            {e.description && <div className="small">{e.description}</div>}
            <Permissions list={e.latest.permissions} />
            {e.repository && (
              <a className="small" href={e.repository} target="_blank" rel="noreferrer">
                Source code
              </a>
            )}
            {!e.compatible && <div className="small warn">Needs Modsmith {e.latest.modsmith} or newer.</div>}
          </div>
          <div className="row tight nowrap">
            {e.installed && !e.update ? (
              <span className="mute small">Installed</span>
            ) : (
              <Button size="sm" variant="primary" disabled={!e.compatible} busy={busy === `verified:${e.id}`} onClick={() => void installVerified(e)}>
                {e.update ? `Update to ${e.latest.version}` : 'Install'}
              </Button>
            )}
          </div>
        </div>
      ))}

      <h4>Install from a link or file</h4>
      <form
        className="row tight"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (link.trim()) void inspect({ url: link.trim() });
        }}
      >
        <input className="grow mono" value={link} onChange={(ev) => setLink(ev.target.value)} placeholder="https://github.com/owner/extension or a link to a .zip" aria-label="Extension link" />
        <Button type="submit" busy={busy === 'inspect'} disabled={!link.trim()}>
          Check link
        </Button>
        <Button variant="ghost" icon="openFolder" onClick={() => void chooseFile()}>
          Choose a .zip…
        </Button>
      </form>
      <div className="hint">A GitHub repository link installs the .zip attached to its latest release. You see the extension's permissions before anything is installed.</div>
    </div>
  );
}
