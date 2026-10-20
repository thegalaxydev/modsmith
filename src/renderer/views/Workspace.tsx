import { useEffect, useRef } from 'react';
import { Group, Panel, Separator, type GroupImperativeHandle, type PanelImperativeHandle } from 'react-resizable-panels';
import { store, useStore } from '../store';
import { TopBar } from '../components/TopBar';
import { Rail } from '../components/Rail';
import { StatusBar } from '../components/StatusBar';
import { Drawer } from '../components/Drawer';
import { Explorer } from '../panels/Explorer';
import { EditorPane } from '../panels/EditorPane';
import { MinecraftPane } from '../panels/MinecraftPane';
import { Inspector } from '../panels/Inspector';
import { ProjectHome } from '../pages/ProjectHome';
import { ModsPage } from '../pages/ModsPage';
import { ProfilesPage } from '../pages/ProfilesPage';
import { TestsPage } from '../pages/TestsPage';
import { DiagnosticsPage } from '../pages/DiagnosticsPage';
import { Ico, type IconName } from '../ui/icons';
import { fileIconUrl } from '../icons';

const MAIN_DEFAULT = { side: 20, center: 80, inspector: 0 };
const CENTER_DEFAULT = { work: 70, drawer: 30 };

const PAGE_META: Record<string, { label: string; icon: IconName }> = {
  home: { label: 'Home', icon: 'home' },
  minecraft: { label: 'Minecraft', icon: 'minecraft' },
  'page:mods': { label: 'Mods', icon: 'mods' },
  'page:profiles': { label: 'Test Profiles', icon: 'profiles' },
  'page:tests': { label: 'Tests', icon: 'tests' },
  'page:diagnostics': { label: 'Diagnostics', icon: 'diagnostics' }
};

function usePanelSync(ref: React.RefObject<PanelImperativeHandle | null>, open: boolean, size: number) {
  useEffect(() => {
    const p = ref.current;
    if (!p) return;
    if (open && p.isCollapsed()) {
      p.expand();
      if (p.getSize().asPercentage < size * 0.7) p.resize(`${size}%`);
    } else if (!open && !p.isCollapsed()) p.collapse();
  }, [open]);
}

export function WorkspaceView({ onNewProject, onSettings }: { onNewProject: () => void; onSettings: (tab?: string) => void }) {
  const tabs = useStore((s) => s.tabs);
  const activeTab = useStore((s) => s.activeTab);
  const dirty = useStore((s) => s.dirtyFiles);
  const layout = useStore((s) => s.layout);
  const layoutVersion = useStore((s) => s.layoutVersion);
  const mainGroup = useRef<GroupImperativeHandle | null>(null);
  const centerGroup = useRef<GroupImperativeHandle | null>(null);
  const sideRef = useRef<PanelImperativeHandle | null>(null);
  const inspectorRef = useRef<PanelImperativeHandle | null>(null);
  const drawerRef = useRef<PanelImperativeHandle | null>(null);
  const initial = useRef(layout.groups);

  usePanelSync(sideRef, layout.sidePanel === 'project', 20);
  usePanelSync(inspectorRef, layout.inspector, 24);
  usePanelSync(drawerRef, layout.drawer, 30);

  useEffect(() => {
    if (!layoutVersion) return;
    mainGroup.current?.setLayout({ ...MAIN_DEFAULT });
    centerGroup.current?.setLayout({ ...CENTER_DEFAULT, work: 100, drawer: 0 });
  }, [layoutVersion]);

  useEffect(() => {
    if (activeTab === 'home') store.setLayout({ inspector: false });
  }, [activeTab === 'home']);

  const saveGroup = (id: string, l: Record<string, number>) => {
    const groups = { ...store.state.layout.groups, [id]: l };
    const patch: Partial<typeof layout> = { groups };
    if (id === 'main') {
      if ((l.side ?? 0) < 1 && store.state.layout.sidePanel) patch.sidePanel = null;
      if ((l.side ?? 0) >= 1 && !store.state.layout.sidePanel) patch.sidePanel = 'project';
      if ((l.inspector ?? 0) < 1 && store.state.layout.inspector) patch.inspector = false;
      if ((l.inspector ?? 0) >= 1 && !store.state.layout.inspector) patch.inspector = true;
    }
    if (id === 'center') {
      if ((l.drawer ?? 0) < 1 && store.state.layout.drawer) patch.drawer = false;
      if ((l.drawer ?? 0) >= 1 && !store.state.layout.drawer) patch.drawer = true;
    }
    store.setLayout(patch);
  };

  const mainDefault = initial.current.main ?? { side: layout.sidePanel ? 20 : 0, center: layout.sidePanel ? 80 : 100, inspector: 0 };
  const savedCenter = initial.current.center;
  const centerDefault = savedCenter && (savedCenter.drawer === 0 || savedCenter.drawer >= 18) ? savedCenter : { work: layout.drawer ? 70 : 100, drawer: layout.drawer ? 30 : 0 };

  return (
    <div className="shell">
      <TopBar onNewProject={onNewProject} onSettings={() => onSettings()} />
      <div className="shell-body">
        <Rail onSettings={() => onSettings()} onMcp={() => onSettings('mcp')} />
        <Group id="main" orientation="horizontal" className="grow" groupRef={mainGroup} defaultLayout={mainDefault} onLayoutChanged={(l) => saveGroup('main', l)}>
          <Panel id="side" minSize={220} maxSize="40%" collapsible collapsedSize="0%" panelRef={sideRef} defaultSize={`${mainDefault.side}%`}>
            <Explorer onClose={() => store.setLayout({ sidePanel: null })} />
          </Panel>
          <Separator className="sep-v" />
          <Panel id="center" minSize={420}>
            <Group id="center" orientation="vertical" groupRef={centerGroup} defaultLayout={centerDefault} onLayoutChanged={(l) => saveGroup('center', l)}>
              <Panel id="work" minSize="25%">
                <div className="work">
                  <div className="tabbar" role="tablist" aria-label="Open editors and tools">
                    {tabs.map((t) => {
                      const meta = PAGE_META[t];
                      const file = t.startsWith('file:') ? t.slice(5) : null;
                      const label = meta?.label ?? file!.split('/').pop()!;
                      const isDirty = file ? dirty.includes(file) : false;
                      return (
                        <div key={t} className={`wtab ${activeTab === t ? 'active' : ''}`} role="tab" aria-selected={activeTab === t}>
                          <button type="button" className="wtab-main" onClick={() => store.set({ activeTab: t })} title={file ?? label}>
                            {file ? <img className="file-icon" src={fileIconUrl(label)} alt="" /> : <Ico name={meta.icon} size={16} />}
                            <span className="ellipsis">{label}</span>
                            {isDirty && <span className="dirty-dot" aria-label="Unsaved changes" />}
                          </button>
                          {t !== 'home' && t !== 'minecraft' && (
                            <button type="button" className="wtab-close" aria-label={`Close ${label}`} title={`Close ${label}`} onClick={() => void store.closeTab(t)}>
                              <Ico name="close" size={14} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="work-body">
                    {tabs.map((t) => {
                      const visible = t === activeTab;
                      if (t === 'minecraft') return <MinecraftPane key={t} visible={visible} />;
                      if (t.startsWith('file:')) return <EditorPane key={t} file={t.slice(5)} visible={visible} />;
                      if (!visible) return null;
                      if (t === 'home') return <ProjectHome key={t} />;
                      if (t === 'page:mods') return <ModsPage key={t} />;
                      if (t === 'page:profiles') return <ProfilesPage key={t} />;
                      if (t === 'page:tests') return <TestsPage key={t} />;
                      if (t === 'page:diagnostics') return <DiagnosticsPage key={t} />;
                      return null;
                    })}
                  </div>
                </div>
              </Panel>
              <Separator className="sep-h" />
              <Panel id="drawer" minSize={150} collapsible collapsedSize="0%" panelRef={drawerRef} defaultSize={`${centerDefault.drawer}%`}>
                <Drawer />
              </Panel>
            </Group>
          </Panel>
          <Separator className="sep-v" />
          <Panel id="inspector" minSize={280} maxSize="45%" collapsible collapsedSize="0%" panelRef={inspectorRef} defaultSize={`${mainDefault.inspector}%`}>
            <Inspector />
          </Panel>
        </Group>
      </div>
      <StatusBar />
    </div>
  );
}

