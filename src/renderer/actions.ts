import { store, waitForOperation } from './store';
import { derivePlayState } from './session';
import type { InstanceInfo, OperationInfo } from '../shared/types';

function ws() {
  const w = store.state.workspace;
  if (!w) throw new Error('No project is open');
  return w;
}

export function currentPlayState() {
  const s = store.state;
  return derivePlayState(s.operations, s.instances, s.workspace?.path ?? '', s.activeProfile);
}

export async function play(profileId = store.state.activeProfile) {
  const w = ws();
  const profile = w.manifest?.profiles.find((p) => p.id === profileId);
  if (!profile) {
    store.toast('error', 'Choose a test profile first');
    return;
  }
  if (currentPlayState().busy) return;
  if (!w.trusted) {
    if (!window.confirm('Playing builds and runs code from this project (Gradle scripts and mods). Trust this project?')) return;
    await store.call('workspace.trust', { path: w.path, trusted: true });
    await store.refreshWorkspace();
  }
  if (profile.side === 'server') {
    const eula = await store.call<{ accepted: boolean }>('instance.eula_status', { path: w.path, profile: profile.id, mode: profile.mode });
    if (!eula.accepted) {
      if (!window.confirm('Running a Minecraft server requires accepting the Minecraft End User License Agreement (https://aka.ms/MinecraftEULA).\n\nDo you accept the EULA for this test server?')) return;
      await store.call('instance.accept_eula', { path: w.path, profile: profile.id, mode: profile.mode, accept: true });
    }
  }
  await store.call<OperationInfo>('instance.launch', { path: w.path, profile: profile.id });
  if (profile.side === 'client') store.set({ activeTab: 'minecraft' });
  else store.setLayout({ drawer: true, drawerTab: 'console' });
}

export function activeInstance(): InstanceInfo | undefined {
  return currentPlayState().instance;
}

export async function stop(force = false) {
  const st = currentPlayState();
  if (st.op && st.op.status === 'running') {
    await store.call('operation.cancel', { id: st.op.id });
    return;
  }
  const inst = st.instance;
  if (inst) await store.call('instance.stop', { id: inst.id, force });
}

export async function restart() {
  const inst = activeInstance();
  const profileId = inst?.profileId ?? store.state.activeProfile;
  if (inst) {
    await store.call('instance.stop', { id: inst.id });
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && store.state.instances.some((i) => i.id === inst.id && ['starting', 'running', 'stopping'].includes(i.status))) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  await play(profileId);
}

export async function build(opts: { clean?: boolean; tasks?: string[] } = {}) {
  const w = ws();
  if (!w.trusted) {
    if (!window.confirm('Building runs this project\'s Gradle scripts. Trust this project?')) return null;
    await store.call('workspace.trust', { path: w.path, trusted: true });
  }
  const op = await store.call<OperationInfo>('project.build', { path: w.path, clean: opts.clean, tasks: opts.tasks });
  return waitForOperation(op.id);
}

export async function datagen() {
  const w = ws();
  const op = await store.call<OperationInfo>('project.datagen', { path: w.path });
  store.setLayout({ drawer: true, drawerTab: 'tasks' });
  return waitForOperation(op.id);
}

export async function exportPack(kind: 'mrpack' | 'curseforge') {
  const w = ws();
  const profile = store.state.activeProfile;
  if (!profile) return;
  if (!w.lockProfiles.includes(profile)) {
    const op = await store.call<OperationInfo>('profile.resolve', { path: w.path, id: profile });
    const done = await waitForOperation(op.id);
    if (done.status !== 'succeeded') return;
  }
  const ext = kind === 'mrpack' ? 'mrpack' : 'zip';
  const out = await window.workbench?.chooseSave(kind === 'mrpack' ? 'Export Modrinth pack' : 'Export CurseForge pack', `${w.name}-${profile}.${ext}`, [{ name: kind === 'mrpack' ? 'Modrinth pack' : 'CurseForge modpack', extensions: [ext] }]);
  if (!out) return;
  const r = await store.call<{ file: string; files: number; manualSteps: string[] }>(kind === 'mrpack' ? 'modpack.export_mrpack' : 'modpack.export_curseforge', { path: w.path, profile, output: out });
  store.toast('success', `Exported ${r.files} mod references to ${r.file}`);
  if (r.manualSteps.length) window.alert(`Some files could not be referenced and must be added manually:\n\n${r.manualSteps.join('\n\n')}`);
}

async function hasClientResources(): Promise<boolean> {
  try {
    const nodes = await store.call<unknown[]>('workspace.tree', { path: ws().path, dir: 'src/client/resources', depth: 0 }, { quiet: true });
    return nodes.length > 0;
  } catch {
    return false;
  }
}

export async function applyResources(kind: 'resources' | 'datapacks') {
  const inst = activeInstance();
  if (!inst) return;
  const w = ws();
  if (w.manifest?.source.kind === 'gradle') {
    const tasks = ['processResources'];
    if (kind === 'resources' && (await hasClientResources())) tasks.push('processClientResources');
    const done = await build({ tasks });
    if (!done || done.status !== 'succeeded') return;
  }
  await store.call('game.reload', { id: inst.id, kind });
  store.clearChanges(w.path);
  store.toast('success', kind === 'resources' ? 'Assets reloaded' : 'Game data reloaded');
}

export async function inspectTarget() {
  store.setLayout({ inspector: true });
  store.set((s) => ({ inspectRequest: (s.inspectRequest ?? 0) + 1 }));
}
