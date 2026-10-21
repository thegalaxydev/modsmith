import { useEffect, useState } from 'react';
import { DockviewReact, type AddPanelOptions, type DockviewApi, type DockviewGroupPanel, type DockviewReadyEvent, type DockviewTheme, type IDockviewHeaderActionsProps, type IDockviewPanelHeaderProps, type IDockviewPanelProps } from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { store, useStore } from './store';
import { Ico, type IconName } from './ui/icons';
import { fileIconUrl } from './icons';
import { Explorer } from './panels/Explorer';
import { EditorPane } from './panels/EditorPane';
import { MinecraftPane } from './panels/MinecraftPane';
import { Inspector } from './panels/Inspector';
import { ProjectHome } from './pages/ProjectHome';
import { ModsPage } from './pages/ModsPage';
import { ProfilesPage } from './pages/ProfilesPage';
import { TestsPage } from './pages/TestsPage';
import { DiagnosticsPage } from './pages/DiagnosticsPage';
import { ActivityTool, ConsoleTool, ProblemsTool, TasksTool, TestResultsTool } from './components/ToolPanels';

export type ToolId = 'explorer' | 'console' | 'problems' | 'tasks' | 'test-results' | 'activity' | 'inspector';
type Slot = 'left' | 'bottom' | 'right';

const TOOLS: Record<ToolId, { title: string; icon: IconName; slot: Slot }> = {
  explorer: { title: 'Project', icon: 'files', slot: 'left' },
  console: { title: 'Console', icon: 'console', slot: 'bottom' },
  problems: { title: 'Problems', icon: 'problems', slot: 'bottom' },
  tasks: { title: 'Tasks', icon: 'build', slot: 'bottom' },
  'test-results': { title: 'Test results', icon: 'tests', slot: 'bottom' },
  activity: { title: 'Activity', icon: 'activity', slot: 'bottom' },
  inspector: { title: 'Inspect', icon: 'inspect', slot: 'right' }
};

export const OUTPUT_TOOLS: ToolId[] = ['console', 'problems', 'tasks', 'test-results', 'activity'];

const PAGES: Record<string, { title: string; icon: IconName }> = {
  home: { title: 'Home', icon: 'home' },
  minecraft: { title: 'Minecraft', icon: 'minecraft' },
  'page:mods': { title: 'Mods', icon: 'mods' },
  'page:profiles': { title: 'Test Profiles', icon: 'profiles' },
  'page:tests': { title: 'Tests', icon: 'tests' },
  'page:diagnostics': { title: 'Diagnostics', icon: 'diagnostics' }
};

const PINNED = new Set(['home', 'minecraft']);
const LAYOUT_KEY = 'mwb.dock.v1';
const SIZE: Record<Slot, number> = { left: 280, bottom: 260, right: 340 };

export const isTool = (id: string): id is ToolId => id in TOOLS;
const isKnown = (id: string) => isTool(id) || id in PAGES || id.startsWith('file:');

export function titleOf(id: string): string {
  if (isTool(id)) return TOOLS[id].title;
  if (PAGES[id]) return PAGES[id].title;
  return id.slice(5).split('/').pop() ?? id;
}

export interface DockController {
  open(id: string, opts?: { inactive?: boolean }): void;
  close(id: string): void;
  toggle(id: string): void;
  toggleOutput(): void;
  isOpen(id: string): boolean;
  closeFiles(): void;
  reset(): void;
}

class Dock implements DockController {
  private lastDocGroup: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private api: DockviewApi) {}

  private docGroup(): DockviewGroupPanel | undefined {
    const groups = this.api.groups.filter((g) => g.panels.some((p) => !isTool(p.id)));
    return groups.find((g) => g.id === this.lastDocGroup) ?? groups.find((g) => g.api.location.type === 'grid') ?? groups[0];
  }

  private toolGroup(slot: Slot): DockviewGroupPanel | undefined {
    return this.api.groups.find((g) => g.api.location.type === 'grid' && g.panels.some((p) => isTool(p.id) && TOOLS[p.id].slot === slot));
  }

  private placement(id: string): Partial<AddPanelOptions> {
    if (!isTool(id)) {
      const doc = this.docGroup();
      if (doc) return { position: { referenceGroup: doc } };
      const left = this.toolGroup('left');
      return { position: left ? { referenceGroup: left, direction: 'right' } : { direction: 'right' } };
    }
    const slot = TOOLS[id].slot;
    const same = this.toolGroup(slot);
    if (same) return { position: { referenceGroup: same } };
    const doc = this.docGroup();
    if (slot === 'bottom') return { position: doc ? { referenceGroup: doc, direction: 'below' } : { direction: 'below' }, initialHeight: SIZE.bottom };
    return { position: doc ? { referenceGroup: doc, direction: slot } : { direction: slot }, initialWidth: SIZE[slot] };
  }

  open(id: string, opts: { inactive?: boolean } = {}) {
    const existing = this.api.getPanel(id);
    if (existing) {
      if (!opts.inactive) existing.api.setActive();
      return;
    }
    this.api.addPanel({
      id,
      component: 'panel',
      tabComponent: 'tab',
      title: titleOf(id),
      renderer: id === 'minecraft' || id.startsWith('file:') ? 'always' : 'onlyWhenVisible',
      inactive: opts.inactive,
      ...this.placement(id)
    } as AddPanelOptions);
  }

  close(id: string) {
    const panel = this.api.getPanel(id);
    if (!panel) return;
    const lastInGroup = panel.group.panels.length === 1;
    const keep = lastInGroup
      ? this.api.groups
          .filter((g) => g !== panel.group && g.api.location.type === 'grid' && g.panels.length > 0 && g.panels.every((p) => isTool(p.id)))
          .map((g) => ({ g, width: g.api.width, height: g.api.height, slot: TOOLS[g.panels[0].id as ToolId].slot }))
      : [];
    panel.api.close();
    if (!keep.length) return;
    requestAnimationFrame(() => {
      for (const k of keep) if (this.api.groups.includes(k.g)) k.g.api.setSize(k.slot === 'bottom' ? { height: k.height } : { width: k.width });
    });
  }

  isOpen(id: string) {
    return !!this.api.getPanel(id);
  }

  closeFiles() {
    for (const p of [...this.api.panels]) if (p.id.startsWith('file:')) p.api.close();
  }

  toggle(id: string) {
    if (this.isOpen(id)) this.close(id);
    else this.open(id);
  }

  toggleOutput() {
    const open = OUTPUT_TOOLS.filter((t) => this.isOpen(t));
    if (open.length) {
      open.forEach((t) => this.close(t));
      return;
    }
    for (const t of OUTPUT_TOOLS) this.open(t, { inactive: t !== 'console' });
    this.open('console');
  }

  buildDefault() {
    this.open('home');
    this.open('minecraft', { inactive: true });
    this.open('explorer', { inactive: true });
    this.api.getPanel('home')?.api.setActive();
  }

  reset() {
    this.api.clear();
    this.buildDefault();
    this.save();
  }

  restore() {
    try {
      const saved = localStorage.getItem(LAYOUT_KEY);
      if (saved) this.api.fromJSON(JSON.parse(saved));
    } catch {
      this.api.clear();
    }
    for (const p of [...this.api.panels]) if (!isKnown(p.id) || p.id.startsWith('file:')) p.api.close();
    if (!this.api.panels.length) this.buildDefault();
    if (!this.isOpen('home')) this.open('home');
    if (!this.isOpen('minecraft')) this.open('minecraft', { inactive: true });
  }

  save() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(this.api.toJSON()));
      } catch {
        return;
      }
    }, 400);
  }

  sync() {
    for (const g of this.api.groups) {
      const view = g as unknown as { _priority?: string };
      if ('_priority' in view) view._priority = g.panels.some((p) => !isTool(p.id)) ? 'high' : 'low';
    }
    const panels = this.api.panels.map((p) => p.id);
    const docs = panels.filter((id) => !isTool(id));
    const active = this.api.activePanel;
    let activeTab = store.state.activeTab;
    if (active && !isTool(active.id)) {
      activeTab = active.id;
      this.lastDocGroup = active.group.id;
    }
    if (!docs.includes(activeTab)) activeTab = docs[0] ?? 'home';
    store.set({ tabs: docs, activeTab, openPanels: panels });
  }
}

export function clearSavedDock() {
  try {
    localStorage.removeItem(LAYOUT_KEY);
  } catch {
    return;
  }
}

function usePanelVisible(api: IDockviewPanelProps['api']) {
  const [visible, setVisible] = useState(api.isVisible);
  useEffect(() => {
    const d = api.onDidVisibilityChange((e) => setVisible(e.isVisible));
    setVisible(api.isVisible);
    return () => d.dispose();
  }, [api]);
  return visible;
}

function PanelContent(props: IDockviewPanelProps) {
  const id = props.api.id;
  const visible = usePanelVisible(props.api);
  let body: React.ReactNode = null;
  if (id === 'minecraft') body = <MinecraftPane visible={visible} />;
  else if (id.startsWith('file:')) body = <EditorPane file={id.slice(5)} visible={visible} />;
  else if (id === 'home') body = <ProjectHome />;
  else if (id === 'page:mods') body = <ModsPage />;
  else if (id === 'page:profiles') body = <ProfilesPage />;
  else if (id === 'page:tests') body = <TestsPage />;
  else if (id === 'page:diagnostics') body = <DiagnosticsPage />;
  else if (id === 'explorer') body = <Explorer />;
  else if (id === 'inspector') body = <Inspector />;
  else if (id === 'console') body = <ConsoleTool />;
  else if (id === 'problems') body = <ProblemsTool />;
  else if (id === 'tasks') body = <TasksTool />;
  else if (id === 'test-results') body = <TestResultsTool />;
  else if (id === 'activity') body = <ActivityTool />;
  return <div className={`dock-panel ${isTool(id) ? 'dock-tool' : 'dock-doc'}`}>{body}</div>;
}

function closePanel(id: string) {
  if (isTool(id)) store.closeTool(id);
  else void store.closeTab(id);
}

function Tab(props: IDockviewPanelHeaderProps) {
  const id = props.api.id;
  const file = id.startsWith('file:') ? id.slice(5) : null;
  const dirty = useStore((s) => (file ? s.dirtyFiles.includes(file) : false));
  const errors = useStore((s) => (id === 'problems' ? s.diagnostics.filter((d) => d.severity === 'error').length : 0));
  const running = useStore((s) => (id === 'tasks' ? s.operations.filter((o) => o.status === 'running' && (!o.workspace || o.workspace === s.workspace?.path)).length : 0));
  const title = titleOf(id);
  const icon: IconName = isTool(id) ? TOOLS[id].icon : PAGES[id]?.icon ?? 'files';
  return (
    <div
      className="dtab"
      title={file ?? title}
      onMouseUp={(e) => {
        if (e.button === 1 && !PINNED.has(id)) closePanel(id);
      }}
    >
      {file ? <img className="file-icon" src={fileIconUrl(title)} alt="" /> : <Ico name={icon} size={15} />}
      <span className="ellipsis">{title}</span>
      {dirty && <span className="dirty-dot" aria-label="Unsaved changes" />}
      {errors > 0 && <span className="count err">{errors}</span>}
      {running > 0 && <span className="count">{running}</span>}
      {!PINNED.has(id) && (
        <button
          type="button"
          className="dtab-close"
          aria-label={`Close ${title}`}
          title={`Close ${title}`}
          draggable={false}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            closePanel(id);
          }}
        >
          <Ico name="close" size={13} />
        </button>
      )}
    </div>
  );
}

function GroupActions(props: IDockviewHeaderActionsProps) {
  const [maximized, setMaximized] = useState(props.api.isMaximized());
  const floating = props.api.location.type === 'floating';
  useEffect(() => {
    const d = props.containerApi.onDidMaximizedGroupChange(() => setMaximized(props.api.isMaximized()));
    return () => d.dispose();
  }, [props.api, props.containerApi]);
  if (floating) return null;
  return (
    <div className="dock-actions">
      <button
        type="button"
        className="dock-action"
        title={maximized ? 'Restore' : 'Maximize'}
        aria-label={maximized ? 'Restore group' : 'Maximize group'}
        onClick={() => (maximized ? props.api.exitMaximized() : props.api.maximize())}
      >
        <Ico name="layout" size={14} />
      </button>
    </div>
  );
}

const THEME: DockviewTheme = { name: 'modsmith', className: 'dockview-theme-modsmith', colorScheme: 'dark' };

export function DockArea() {
  useEffect(() => () => store.attachDock(null), []);

  const onReady = (event: DockviewReadyEvent) => {
    const dock = new Dock(event.api);
    let releaseDrag: (() => void) | null = null;
    const endDrag = () => {
      releaseDrag?.();
      releaseDrag = null;
      window.dispatchEvent(new Event('resize'));
    };
    const startDrag = () => {
      if (!releaseDrag) releaseDrag = store.pushOverlay();
    };
    event.api.onWillDragPanel(startDrag);
    event.api.onWillDragGroup(startDrag);
    window.addEventListener('dragend', endDrag, true);
    window.addEventListener('drop', () => setTimeout(endDrag, 0), true);
    const changed = () => {
      dock.sync();
      dock.save();
      window.dispatchEvent(new Event('resize'));
    };
    event.api.onDidAddPanel(changed);
    event.api.onDidRemovePanel(changed);
    event.api.onDidActivePanelChange(changed);
    event.api.onDidMovePanel(changed);
    event.api.onDidLayoutChange(changed);
    dock.restore();
    dock.sync();
    store.attachDock(dock);
  };

  return (
    <DockviewReact
      className="dock-area"
      theme={THEME}
      proportionalLayout={false}
      components={{ panel: PanelContent }}
      tabComponents={{ tab: Tab }}
      defaultTabComponent={Tab}
      rightHeaderActionsComponent={GroupActions}
      getTabContextMenuItems={({ panel }) => [
        ...(PINNED.has(panel.id) ? [] : [{ label: 'Close', action: () => closePanel(panel.id) }, 'separator' as const]),
        'maximize',
        'float'
      ]}
      onReady={onReady}
    />
  );
}
