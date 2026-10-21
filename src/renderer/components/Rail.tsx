import { store, useStore } from '../store';
import { Ico, type IconName } from '../ui/icons';
import { runViewSide } from '../dock';

interface Item {
  id: string;
  label: string;
  title: string;
  icon: IconName;
}

export function Rail({ onSettings, onMcp }: { onSettings: () => void; onMcp: () => void }) {
  const activeTab = useStore((s) => s.activeTab);
  const filesOpen = useStore((s) => s.openPanels.includes('explorer'));
  const side = useStore(runViewSide);
  const hasManifest = useStore((s) => !!s.workspace?.manifest);
  const mcp = useStore((s) => s.clients.mcp ?? 0);
  const items: Item[] = [
    { id: 'home', label: 'Overview', title: 'Project overview', icon: 'home' },
    { id: 'explorer', label: 'Files', title: 'Project files (toggle sidebar)', icon: 'files' },
    { id: 'minecraft', label: side === 'server' ? 'Server' : 'Client', title: side === 'server' ? 'Dedicated server' : 'Minecraft client', icon: side === 'server' ? 'server' : 'minecraft' },
    { id: 'page:mods', label: 'Mods', title: 'Mods and dependencies', icon: 'mods' },
    { id: 'page:profiles', label: 'Configs', title: 'Run configurations', icon: 'profiles' },
    { id: 'page:tests', label: 'Tests', title: 'Test scenarios', icon: 'tests' }
  ];
  return (
    <nav className="rail" aria-label="Project views">
      {items.map((it) => {
        const active = it.id === 'explorer' ? filesOpen : activeTab === it.id;
        const disabled = !hasManifest && it.id.startsWith('page:');
        return (
          <button
            key={it.id}
            type="button"
            className={`rail-btn ${active ? 'active' : ''}`}
            aria-label={it.title}
            title={it.title}
            aria-current={active && it.id !== 'explorer' ? 'page' : undefined}
            aria-pressed={it.id === 'explorer' ? active : undefined}
            disabled={disabled}
            onClick={() => {
              if (it.id === 'explorer') store.toggleTool('explorer');
              else store.openTab(it.id);
            }}
          >
            <Ico name={it.icon} size={18} />
            <span className="rail-label">{it.label}</span>
          </button>
        );
      })}
      <div className="spacer" />
      <div className="rail-sep" role="separator" />
      <button type="button" className={`rail-btn rail-app ${mcp ? 'mcp-on' : ''}`} aria-label={mcp ? `MCP: ${mcp} assistant connection${mcp === 1 ? '' : 's'}` : 'MCP: no assistant connected'} title={mcp ? `MCP: ${mcp} assistant connection${mcp === 1 ? '' : 's'}` : 'MCP: no assistant connected. Click for setup.'} onClick={onMcp}>
        <Ico name="mcp" size={18} />
      </button>
      <button type="button" className="rail-btn rail-app" aria-label="Settings" title="Settings" onClick={onSettings}>
        <Ico name="settings" size={18} />
      </button>
    </nav>
  );
}
