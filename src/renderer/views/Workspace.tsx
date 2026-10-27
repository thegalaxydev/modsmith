import { TopBar } from '../components/TopBar';
import { Rail } from '../components/Rail';
import { StatusBar } from '../components/StatusBar';
import { DockArea } from '../dock';
import { useEffect } from 'react';
import { store, useStore } from '../store';
import { startLanguageServer } from '../lsp';
import { debugKeys } from '../panels/DebugPanel';
import { debuggerController } from '../debugger';
import { openSearch } from '../panels/SearchPanel';
import { selectedText } from '../javaNav';

function searchKeys(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key !== 'f' && key !== 'h') return;
  e.preventDefault();
  const tab = store.state.activeTab;
  const text = tab.startsWith('file:') ? selectedText(tab) : '';
  openSearch(key === 'h', text && !/[\r\n]/.test(text) ? text : undefined);
}

export function WorkspaceView({ onNewProject, onSettings }: { onNewProject: () => void; onSettings: (tab?: string) => void }) {
  const path = useStore((s) => s.workspace?.path);
  const gradle = useStore((s) => s.workspace?.manifest?.source.kind === 'gradle');
  const trusted = useStore((s) => !!s.workspace?.trusted);
  useEffect(() => {
    if (path && gradle && trusted) void startLanguageServer(path).catch(() => undefined);
  }, [path, gradle, trusted]);
  useEffect(() => {
    window.addEventListener('keydown', debugKeys);
    window.addEventListener('keydown', searchKeys);
    return () => {
      window.removeEventListener('keydown', debugKeys);
      window.removeEventListener('keydown', searchKeys);
      void debuggerController.stop();
    };
  }, [path]);
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
