import { TopBar } from '../components/TopBar';
import { Rail } from '../components/Rail';
import { StatusBar } from '../components/StatusBar';
import { DockArea } from '../dock';
import { useEffect } from 'react';
import { useStore } from '../store';
import { startLanguageServer } from '../lsp';

export function WorkspaceView({ onNewProject, onSettings }: { onNewProject: () => void; onSettings: (tab?: string) => void }) {
  const path = useStore((s) => s.workspace?.path);
  const gradle = useStore((s) => s.workspace?.manifest?.source.kind === 'gradle');
  const trusted = useStore((s) => !!s.workspace?.trusted);
  useEffect(() => {
    if (path && gradle && trusted) void startLanguageServer(path).catch(() => undefined);
  }, [path, gradle, trusted]);
  return (
    <div className="shell">
      <TopBar onNewProject={onNewProject} />
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
