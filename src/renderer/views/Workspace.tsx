import { TopBar } from '../components/TopBar';
import { Rail } from '../components/Rail';
import { StatusBar } from '../components/StatusBar';
import { DockArea } from '../dock';

export function WorkspaceView({ onNewProject, onSettings }: { onNewProject: () => void; onSettings: (tab?: string) => void }) {
  return (
    <div className="shell">
      <TopBar onNewProject={onNewProject} onSettings={() => onSettings()} />
      <div className="shell-body">
        <Rail onSettings={() => onSettings()} onMcp={() => onSettings('mcp')} />
        <div className="grow dock-host">
          <DockArea />
        </div>
      </div>
      <StatusBar />
    </div>
  );
}
