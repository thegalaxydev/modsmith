import { store, waitForOperation } from './store';
import { derivePlayState, isSourceChange } from './session';
import type { HotswapResult, InstanceInfo, OperationInfo } from '../shared/types';
import { ask, tell } from './dialogs';
import { ensureJava } from './java';

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
    store.toast('error', 'Choose a run configuration first');
    return;
  }
  if (currentPlayState().busy) return;
  if (!w.trusted) {
    if (!(await ask('Playing builds and runs code from this project (Gradle scripts and mods). Trust this project?'))) return;
    await store.call('workspace.trust', { path: w.path, trusted: true });
    await store.refreshWorkspace();
  }
  if (profile.side === 'server') {
    const eula = await store.call<{ accepted: boolean }>('instance.eula_status', { path: w.path, profile: profile.id, mode: profile.mode });
    if (!eula.accepted) {
      if (!(await ask('Running a Minecraft server requires accepting the Minecraft End User License Agreement (https://aka.ms/MinecraftEULA).\n\nDo you accept the EULA for this test server?'))) return;
      await store.call('instance.accept_eula', { path: w.path, profile: profile.id, mode: profile.mode, accept: true });
    }
  }
  if (!(await ensureJava({ path: w.path, profile: profile.id, mode: profile.mode }))) return;
  await store.call<OperationInfo>('instance.launch', { path: w.path, profile: profile.id });
  store.openTab('minecraft');
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

export function restartReasons(r: HotswapResult) {
  const lines: string[] = [];
  for (const c of r.classes) for (const why of c.reasons) lines.push(`• ${c.class}: ${why}`);
  if (r.error && !lines.length) lines.push(`• ${r.error}`);
  return lines.slice(0, 8).join('\n') + (lines.length > 8 ? `\n• and ${lines.length - 8} more` : '');
}

export async function hotReload(): Promise<HotswapResult | null> {
  const inst = activeInstance();
  if (!inst) return null;
  const op = await store.call<OperationInfo>('instance.hotswap', { id: inst.id });
  const done = await waitForOperation(op.id);
  if (done.status !== 'succeeded' || !done.result) return null;
  const r = done.result as HotswapResult;
  const w = ws();
  if (r.restartRequired) {
    store.showTool('tasks');
    if (await ask(`These code changes cannot be applied while the game runs. Nothing was changed in the game.\n\n${restartReasons(r)}\n\nRestart the game now?`)) await restart();
    return r;
  }
  store.clearChanges(w.path, isSourceChange);
  const other = r.classes.length - r.redefined;
  store.toast('success', r.classes.length ? `Hot reload: ${r.redefined} class${r.redefined === 1 ? '' : 'es'} updated${other ? `, ${other} load${other === 1 ? 's' : ''} when first used` : ''}` : 'Hot reload: no compiled classes changed');
  return r;
}

export async function enableHotReload() {
  const w = ws();
  const inst = activeInstance();
  const id = inst?.profileId ?? store.state.activeProfile;
  const profile = w.manifest?.profiles.find((p) => p.id === id);
  if (!profile) return;
  let port = profile.debug?.port ?? 5005;
  const st = await store.call<{ free: boolean; suggested: number | null }>('instance.debug_port_check', { port });
  if (!st.free) {
    if (!st.suggested) {
      store.toast('error', `Debug port ${port} and the ports after it are in use`);
      return;
    }
    if (!(await ask(`Hot reload needs a debug port, and port ${port} is already in use by another program. Use port ${st.suggested} instead?`))) return;
    port = st.suggested;
  }
  await store.call('profile.update', { path: w.path, id: profile.id, patch: { debug: { ...profile.debug, enabled: true, port } } });
  await store.refreshWorkspace();
  if (inst) await restart();
  else store.toast('success', 'Hot reload is on for this profile');
}

export async function build(opts: { clean?: boolean; tasks?: string[] } = {}) {
  const w = ws();
  if (!w.trusted) {
    if (!(await ask('Building runs this project\'s Gradle scripts. Trust this project?'))) return null;
    await store.call('workspace.trust', { path: w.path, trusted: true });
  }
  if (!(await ensureJava({ path: w.path }))) return null;
  const op = await store.call<OperationInfo>('project.build', { path: w.path, clean: opts.clean, tasks: opts.tasks });
  return waitForOperation(op.id);
}

export async function datagen() {
  const w = ws();
  if (!(await ensureJava({ path: w.path }))) return null;
  const op = await store.call<OperationInfo>('project.datagen', { path: w.path });
  store.showTool('tasks');
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
  if (r.manualSteps.length) await tell(`Some files could not be referenced and must be added manually:\n\n${r.manualSteps.join('\n\n')}`);
}

export function exportServerProfile() {
  const m = store.state.workspace?.manifest;
  const active = m?.profiles.find((p) => p.id === store.state.activeProfile);
  return active?.side === 'server' ? active : m?.profiles.find((p) => p.side === 'server');
}

export async function exportServerPack() {
  const w = ws();
  const profile = exportServerProfile();
  if (!profile) {
    store.toast('error', 'Add a server profile first');
    return;
  }
  if (w.manifest?.source.kind === 'gradle' && !w.trusted) {
    if (!(await ask('Exporting builds this project\'s Gradle scripts. Trust this project?'))) return;
    await store.call('workspace.trust', { path: w.path, trusted: true });
    await store.refreshWorkspace();
  }
  const parent = await window.workbench?.chooseDirectory(`Choose where to save the ${profile.name} server pack`);
  if (!parent) return;
  const sep = parent.includes('\\') ? '\\' : '/';
  const out = `${parent.replace(/[\\/]+$/, '')}${sep}${w.name}-${profile.id}-server`.replace(/\s+/g, '-');
  const zip = await ask(`The server pack will be saved to\n${out}\n\nAlso create a .zip of it for uploading to a host?`);
  const op = await store.call<OperationInfo>('server.export_pack', { path: w.path, profile: profile.id, output: out, zip });
  store.showTool('tasks');
  const done = await waitForOperation(op.id);
  if (done.status !== 'succeeded') return;
  const r = done.result as { output: string; zip: string | null; mods: string[] };
  store.toast('success', `Server pack exported with ${r.mods.length} mods`);
  void window.workbench?.openPath(r.output);
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
  store.showTool('inspector');
  store.set((s) => ({ inspectRequest: (s.inspectRequest ?? 0) + 1 }));
}
