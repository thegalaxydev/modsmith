import { store, useAsync, useStore } from './store';

export function useProjectImage(): string | null {
  const path = useStore((s) => s.workspace?.path);
  const icon = useStore((s) => s.workspace?.manifest?.icon);
  const res = useAsync(() => (path && icon ? store.call<string | null>('workspace.image', { path }, { quiet: true }) : Promise.resolve(null)), [path, icon]);
  return icon ? res.data ?? null : null;
}

export async function chooseProjectImage(path: string): Promise<void> {
  const file = await window.workbench?.chooseFile('Choose a project image', [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]);
  if (!file) return;
  await store.call('workspace.set_image', { path, file });
  await store.refreshWorkspace();
}

export async function clearProjectImage(path: string): Promise<void> {
  await store.call('workspace.set_image', { path, file: null });
  await store.refreshWorkspace();
}
