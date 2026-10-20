import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { store, useStore } from '../store';
import type { FileNode } from '../../shared/types';
import { fileIconUrl, folderIconUrl } from '../icons';
import { Ico, type IconName } from '../ui/icons';
import { IconButton, Segmented } from '../ui/controls';

type GroupId = 'code' | 'assets' | 'data' | 'config' | 'build' | 'other';

const GROUPS: { id: GroupId; label: string; icon: IconName; defaultOpen: boolean }[] = [
  { id: 'code', label: 'Code', icon: 'code', defaultOpen: true },
  { id: 'assets', label: 'Textures & Models', icon: 'files', defaultOpen: true },
  { id: 'data', label: 'Recipes & Game Data', icon: 'tests', defaultOpen: false },
  { id: 'config', label: 'Mod Configuration', icon: 'settings', defaultOpen: true },
  { id: 'build', label: 'Build Files', icon: 'build', defaultOpen: false },
  { id: 'other', label: 'Other Files', icon: 'more', defaultOpen: false }
];

export function classifyPath(p: string): { group: GroupId; display: string } {
  let m = p.match(/^src\/([^/]+)\/(java|kotlin|scala|groovy)\/(.+)$/);
  if (m) return { group: 'code', display: (m[1] === 'main' ? '' : `${m[1]}/`) + m[3] };
  m = p.match(/^src\/[^/]+\/(?:resources|generated|generated\/resources)\/assets\/(.+)$/);
  if (m) return { group: 'assets', display: m[1] };
  m = p.match(/^src\/[^/]+\/(?:resources|generated|generated\/resources)\/data\/(.+)$/);
  if (m) return { group: 'data', display: m[1] };
  if (/(^|\/)(fabric\.mod\.json|quilt\.mod\.json|neoforge\.mods\.toml|mods\.toml|pack\.mcmeta)$/.test(p) || /\.mixins\.json$/.test(p) || /\.accesswidener$/.test(p) || /^src\/[^/]+\/templates\//.test(p) || /^modsmith\.json$/.test(p) || /^profiles\//.test(p)) return { group: 'config', display: p.replace(/^src\/[^/]+\/(resources|templates)\//, '') };
  if (/^(build|settings)\.gradle(\.kts)?$/.test(p) || /^gradle(w|w\.bat|\.properties)$/.test(p) || /^gradle\//.test(p) || /^modsmith\.(dependencies\.gradle|lock\.json)$/.test(p) || /libs\.versions\.toml$/.test(p)) return { group: 'build', display: p };
  return { group: 'other', display: p };
}

interface TNode {
  name: string;
  path: string;
  real?: string;
  children: Map<string, TNode>;
}

function buildTree(entries: { display: string; real: string }[]): TNode {
  const root: TNode = { name: '', path: '', children: new Map() };
  for (const e of entries) {
    const parts = e.display.split('/');
    let cur = root;
    parts.forEach((part, i) => {
      const key = parts.slice(0, i + 1).join('/');
      if (!cur.children.has(part)) cur.children.set(part, { name: part, path: key, children: new Map() });
      cur = cur.children.get(part)!;
      if (i === parts.length - 1) cur.real = e.real;
    });
  }
  const compact = (n: TNode): TNode => {
    for (const [k, c] of [...n.children]) {
      let child = c;
      while (!child.real && child.children.size === 1) {
        const only = [...child.children.values()][0];
        if (only.real) break;
        child = { ...only, name: `${child.name}/${only.name}` };
      }
      n.children.set(k, compact(child));
    }
    return n;
  };
  return compact(root);
}

function sortedChildren(n: TNode): TNode[] {
  return [...n.children.values()].sort((a, b) => Number(!!a.real) - Number(!!b.real) || a.name.localeCompare(b.name));
}

function flatten(nodes: FileNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.dir) flatten(n.children ?? [], out);
    else out.push(n.path);
  }
  return out;
}

export function Explorer({ onClose }: { onClose: () => void }) {
  const ws = useStore((s) => s.workspace)!;
  const fileVersion = useStore((s) => s.fileVersion);
  const view = useStore((s) => s.layout.explorerView);
  const activeTab = useStore((s) => s.activeTab);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set(GROUPS.filter((g) => g.defaultOpen).map((g) => `g:${g.id}`)));
  const [ctx, setCtx] = useState<{ x: number; y: number; path: string; dir: boolean } | null>(null);
  const selected = activeTab.startsWith('file:') ? activeTab.slice(5) : null;

  useEffect(() => {
    let alive = true;
    store
      .call<FileNode[]>('workspace.tree', { path: ws.path, dir: '', depth: 8 }, { quiet: true })
      .then((t) => {
        if (alive) {
          setTree(t);
          setError(null);
        }
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [ws.path, fileVersion]);

  const files = useMemo(() => flatten(tree), [tree]);
  const groups = useMemo(() => {
    const byGroup = new Map<GroupId, { display: string; real: string }[]>();
    for (const f of files) {
      const c = classifyPath(f);
      const list = byGroup.get(c.group) ?? [];
      list.push({ display: c.display, real: f });
      byGroup.set(c.group, list);
    }
    return GROUPS.filter((g) => byGroup.get(g.id)?.length).map((g) => ({ ...g, count: byGroup.get(g.id)!.length, tree: buildTree(byGroup.get(g.id)!) }));
  }, [files]);
  const allTree = useMemo(() => buildTree(files.map((f) => ({ display: f, real: f }))), [files]);

  const toggle = (key: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const openFile = (p: string) => store.openTab(`file:${p}`);

  const row = (n: TNode, depth: number, keyPrefix: string): React.ReactNode => {
    const key = `${keyPrefix}${n.path}`;
    if (n.real) {
      return (
        <button
          type="button"
          key={key}
          className={`tree-row ${selected === n.real ? 'selected' : ''}`}
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => openFile(n.real!)}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtx({ x: e.clientX, y: e.clientY, path: n.real!, dir: false });
          }}
          title={n.real}
        >
          <span className="tree-caret" />
          <img className="file-icon" src={fileIconUrl(n.name)} alt="" />
          <span className="ellipsis">{n.name}</span>
        </button>
      );
    }
    const isOpen = open.has(key) || !!query;
    const lastSeg = n.name.split('/').pop()!;
    return (
      <div key={key}>
        <button
          type="button"
          className="tree-row"
          style={{ paddingLeft: 10 + depth * 14 }}
          aria-expanded={isOpen}
          onClick={() => toggle(key)}
          onContextMenu={(e) => {
            e.preventDefault();
            if (keyPrefix === 'all:') setCtx({ x: e.clientX, y: e.clientY, path: n.path, dir: true });
          }}
        >
          <span className={`tree-caret ${isOpen ? 'open' : ''}`}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <img className="file-icon" src={folderIconUrl(lastSeg, isOpen)} alt="" />
          <span className="ellipsis">{n.name}</span>
        </button>
        {isOpen && sortedChildren(n).map((c) => row(c, depth + 1, keyPrefix))}
      </div>
    );
  };

  const q = query.trim().toLowerCase();
  const results = q ? files.filter((f) => f.toLowerCase().includes(q)).slice(0, 300) : [];

  const newFile = async (dir: string) => {
    const name = await store.askText('New file', `Path relative to the project${dir ? ` (in ${dir})` : ''}`, dir ? `${dir}/` : '');
    if (!name) return;
    await store.call('workspace.write_file', { path: ws.path, file: name.replace(/\\/g, '/'), content: '', create: true });
    openFile(name.replace(/\\/g, '/'));
  };

  return (
    <aside className="side-panel" aria-label="Project explorer">
      <div className="side-head">
        <b>Project</b>
        <div className="spacer" />
        <IconButton icon="newFile" label="New file" onClick={() => void newFile('')} />
        <IconButton icon="collapse" label="Hide explorer" onClick={onClose} />
      </div>
      <div className="side-tools">
        <Segmented
          label="Explorer view"
          value={view}
          options={[
            { value: 'project', label: 'Project' },
            { value: 'files', label: 'All Files' }
          ]}
          onChange={(v) => store.setLayout({ explorerView: v })}
        />
        <label className="search-field">
          <Ico name="search" size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find file" aria-label="Find file" />
          {query && <IconButton icon="close" label="Clear search" onClick={() => setQuery('')} size={13} />}
        </label>
      </div>
      <div className="tree scroll">
        {error && <div className="pad err small">{error}</div>}
        {q &&
          (results.length ? (
            results.map((f) => (
              <button type="button" key={f} className={`tree-row ${selected === f ? 'selected' : ''}`} onClick={() => openFile(f)} title={f} onContextMenu={(e) => (e.preventDefault(), setCtx({ x: e.clientX, y: e.clientY, path: f, dir: false }))}>
                <img className="file-icon" src={fileIconUrl(f.split('/').pop()!)} alt="" />
                <span className="ellipsis">{f.split('/').pop()}</span>
                <span className="mute ellipsis small">{f.split('/').slice(0, -1).join('/')}</span>
              </button>
            ))
          ) : (
            <div className="pad mute small">No files match "{query}".</div>
          ))}
        {!q && view === 'project' &&
          groups.map((g) => {
            const key = `g:${g.id}`;
            const isOpen = open.has(key);
            return (
              <div key={g.id} className="tree-group">
                <button type="button" className="group-row" aria-expanded={isOpen} onClick={() => toggle(key)}>
                  <Ico name={isOpen ? 'chevronDown' : 'chevronRight'} size={14} />
                  <Ico name={g.icon} size={15} />
                  <span className="grow">{g.label}</span>
                  <span className="mute small">{g.count}</span>
                </button>
                {isOpen && sortedChildren(g.tree).map((c) => row(c, 1, `${g.id}:`))}
              </div>
            );
          })}
        {!q && view === 'files' && sortedChildren(allTree).map((c) => row(c, 0, 'all:'))}
        {!q && !files.length && !error && <div className="pad mute small">This folder has no files.</div>}
      </div>
      {ctx &&
        createPortal(
          <ContextMenu
            x={ctx.x}
            y={ctx.y}
            onClose={() => setCtx(null)}
            items={[
              ...(!ctx.dir ? [{ label: 'Open', icon: 'code' as IconName, run: () => openFile(ctx.path) }] : []),
              { label: 'New file here…', icon: 'newFile' as IconName, run: () => void newFile(ctx.dir ? ctx.path : ctx.path.split('/').slice(0, -1).join('/')) },
              { label: 'Copy relative path', icon: 'copy' as IconName, run: () => void navigator.clipboard.writeText(ctx.path) },
              { label: 'Copy full path', icon: 'copy' as IconName, run: () => void navigator.clipboard.writeText(`${ws.path}\\${ctx.path.replace(/\//g, '\\')}`) },
              { label: 'Reveal in File Explorer', icon: 'openFolder' as IconName, run: () => void window.workbench?.showItem(`${ws.path}\\${ctx.path.replace(/\//g, '\\')}`) },
              ...(!ctx.dir
                ? [
                    {
                      label: 'Delete…',
                      icon: 'remove' as IconName,
                      danger: true,
                      run: () => {
                        if (window.confirm(`Delete ${ctx.path}? This cannot be undone.`)) void store.call('workspace.delete_file', { path: ws.path, file: ctx.path, confirm: true }).then(() => store.closeTab(`file:${ctx.path}`));
                      }
                    }
                  ]
                : [])
            ]}
          />,
          document.body
        )}
    </aside>
  );
}

function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: { label: string; icon: IconName; run: () => void; danger?: boolean }[]; onClose: () => void }) {
  useEffect(() => store.pushOverlay(), []);
  useEffect(() => {
    const close = () => onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    setTimeout(() => document.addEventListener('mousedown', close), 0);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
    };
  }, []);
  return (
    <div className="menu" role="menu" style={{ top: Math.min(y, window.innerHeight - items.length * 34 - 16), left: Math.min(x, window.innerWidth - 248) }} onMouseDown={(e) => e.stopPropagation()}>
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          className={`menu-item ${it.danger ? 'danger' : ''}`}
          onClick={() => {
            onClose();
            it.run();
          }}
        >
          <span className="menu-icon">
            <Ico name={it.icon} />
          </span>
          {it.label}
        </button>
      ))}
    </div>
  );
}
