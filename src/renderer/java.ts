import { store, waitForOperation } from './store';
import { ask } from './dialogs';
import type { JavaInstallation, OperationInfo } from '../shared/types';

export interface JavaNeeds {
  requirements: { purpose: 'gradle' | 'runtime'; major: number; jdk: boolean; java: JavaInstallation | null }[];
  install: { major: number; imageType: 'jdk' | 'jre' }[];
}

export type JavaTarget = { catalogEntryId: string } | { path: string; profile?: string; mode?: string };

const describe = (n: JavaNeeds['install'][number], needs: JavaNeeds) => {
  const uses = needs.requirements.filter((r) => r.major === n.major && !r.java).map((r) => (r.purpose === 'gradle' ? 'Gradle builds' : 'Minecraft'));
  return `• Java ${n.major} ${n.imageType.toUpperCase()} (for ${uses.join(' and ')})`;
};

export async function installJava(major: number, imageType: 'jdk' | 'jre' = 'jdk'): Promise<JavaInstallation | null> {
  const op = await store.call<OperationInfo>('java.install', { major, imageType });
  store.showTool('tasks');
  const done = await waitForOperation(op.id);
  if (done.status !== 'succeeded') return null;
  store.toast('success', `Installed Eclipse Temurin ${(done.result as JavaInstallation).version}`);
  return done.result as JavaInstallation;
}

export async function ensureJava(target: JavaTarget): Promise<boolean> {
  const needs = await store.call<JavaNeeds>('java.requirements', target);
  if (!needs.install.length) return true;
  const text = `This needs Java that is not installed yet:\n\n${needs.install.map((n) => describe(n, needs)).join('\n')}\n\nDownload Eclipse Temurin from Adoptium (adoptium.net) into the Modsmith data folder now? This is a one-time download of a few hundred MB.`;
  if (!(await ask(text))) return false;
  for (const n of needs.install) {
    if (!(await installJava(n.major, n.imageType))) return false;
  }
  return true;
}
