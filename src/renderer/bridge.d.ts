type Rect = { x: number; y: number; width: number; height: number };

interface WorkbenchShell {
  endpoint(): Promise<{ url: string; token: string }>;
  info(): Promise<{ platform: string; versions: Record<string, string>; nativeViewport: boolean }>;
  chooseDirectory(title: string): Promise<string | null>;
  chooseFile(title: string, filters: { name: string; extensions: string[] }[]): Promise<string | null>;
  chooseSave(title: string, defaultPath: string, filters: { name: string; extensions: string[] }[]): Promise<string | null>;
  openPath(p: string): Promise<string>;
  showItem(p: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  viewport: {
    attach(instanceId: string, rect: Rect): Promise<{ ok: boolean; error?: string; hwnd?: number }>;
    update(rect: Rect): Promise<{ ok: boolean }>;
    setVisible(visible: boolean): Promise<{ ok: boolean }>;
    focus(): Promise<{ ok: boolean }>;
    detach(): Promise<{ ok: boolean }>;
    status(): Promise<{ docked: boolean; instanceId?: string; hwnd?: number }>;
    bringToFront(instanceId: string): Promise<{ ok: boolean; error?: string }>;
    onState(cb: (state: Record<string, unknown>) => void): () => void;
  };
}

interface Window {
  workbench?: WorkbenchShell;
}
