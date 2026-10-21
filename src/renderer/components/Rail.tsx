import { store, useStore } from '../store';
import { Ico, type IconName } from '../ui/icons';

const ITEMS: { id: string; label: string; icon: IconName }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'project', label: 'Project', icon: 'code' },
  { id: 'page:mods', label: 'Mods', icon: 'mods' },
  { id: 'page:profiles', label: 'Test Profiles', icon: 'profiles' },
  { id: 'page:tests', label: 'Tests', icon: 'tests' }
];

export function Rail({ onSettings, onMcp }: { onSettings: () => void; onMcp: () => void }) {
  const activeTab = useStore((s) => s.activeTab);
  const side = useStore((s) => (s.openPanels.includes('explorer') ? 'project' : null));
  const clients = useStore((s) => s.clients);
  const mcp = clients.mcp ?? 0;
  return (
    <nav className="rail" aria-label="Main navigation">
      {ITEMS.map((it) => {
        const active = it.id === 'project' ? side === 'project' : activeTab === it.id;
        return (
          <button
            key={it.id}
            type="button"
            className={`rail-btn ${active ? 'active' : ''}`}
            aria-label={it.label}
            title={it.label}
            aria-current={active ? 'page' : undefined}
            onClick={() => {
              if (it.id === 'project') store.toggleTool('explorer');
              else store.openTab(it.id);
            }}
          >
            <Ico name={it.icon} size={20} />
            <span className="rail-label">{it.label === 'Test Profiles' ? 'Profiles' : it.label}</span>
          </button>
        );
      })}
      <div className="spacer" />
      <button type="button" className={`rail-btn ${mcp ? 'mcp-on' : ''}`} aria-label={mcp ? `MCP: ${mcp} assistant connection${mcp === 1 ? '' : 's'}` : 'MCP: no assistant connected'} title={mcp ? `MCP: ${mcp} assistant connection${mcp === 1 ? '' : 's'}` : 'MCP: no assistant connected. Click for setup.'} onClick={onMcp}>
        <Ico name="mcp" size={20} />
      </button>
      <button type="button" className="rail-btn" aria-label="Settings" title="Settings" onClick={onSettings}>
        <Ico name="settings" size={20} />
      </button>
    </nav>
  );
}
