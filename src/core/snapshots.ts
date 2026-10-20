import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Services } from './context';
import type { WorkspaceService } from './workspace';
import { instanceDirFor, stateDir } from './workspace';

export interface SnapshotMeta {
  id: string;
  name: string;
  profile: string;
  world: string;
  createdAt: string;
  sizeBytes: number;
  source: string;
}

function dirSize(d: string): number {
  let total = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, e.name);
    total += e.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

export class SnapshotService {
  constructor(private s: Services, private ws: WorkspaceService) {}

  private root(ws: string): string {
    return path.join(stateDir(ws), 'snapshots');
  }

  list(workspace: string): SnapshotMeta[] {
    const r = this.root(this.ws.normalize(workspace));
    if (!fs.existsSync(r)) return [];
    return fs.readdirSync(r).map((id) => path.join(r, id, 'snapshot.json')).filter((f) => fs.existsSync(f)).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as SnapshotMeta).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  worldDir(workspace: string, profileId: string, world?: string): { worldDir: string; world: string; instanceDir: string; side: string } {
    const dir = this.ws.normalize(workspace);
    const manifest = this.ws.requireManifest(dir);
    const profile = manifest.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`Unknown profile ${profileId}`);
    const instanceDir = instanceDirFor(dir, profile.id, profile.mode, profile.side);
    if (profile.side === 'server') {
      const props = path.join(instanceDir, 'server.properties');
      const levelName = world ?? (fs.existsSync(props) ? fs.readFileSync(props, 'utf8').match(/^level-name=(.*)$/m)?.[1]?.trim() : undefined) ?? 'world';
      return { worldDir: path.join(instanceDir, levelName), world: levelName, instanceDir, side: 'server' };
    }
    const saves = path.join(instanceDir, 'saves');
    let name = world ?? profile.world?.name;
    if (!name && fs.existsSync(saves)) {
      const worlds = fs.readdirSync(saves).filter((w) => fs.existsSync(path.join(saves, w, 'level.dat'))).sort((a, b) => fs.statSync(path.join(saves, b)).mtimeMs - fs.statSync(path.join(saves, a)).mtimeMs);
      name = worlds[0];
    }
    if (!name) throw new Error(`Profile ${profileId} has no world to snapshot yet`);
    return { worldDir: path.join(saves, name), world: name, instanceDir, side: 'client' };
  }

  async create(workspace: string, profileId: string, world: string | undefined, name: string | undefined, saveFirst: (() => Promise<void>) | null): Promise<SnapshotMeta> {
    const dir = this.ws.normalize(workspace);
    const w = this.worldDir(dir, profileId, world);
    if (!fs.existsSync(path.join(w.worldDir, 'level.dat'))) throw new Error(`World ${w.world} has no level.dat at ${w.worldDir}`);
    if (saveFirst) await saveFirst();
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
    const dest = path.join(this.root(dir), id);
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(w.worldDir, path.join(dest, 'world'), { recursive: true, filter: (src) => path.basename(src) !== 'session.lock' });
    const meta: SnapshotMeta = { id, name: name ?? `${w.world} ${new Date().toLocaleString()}`, profile: profileId, world: w.world, createdAt: new Date().toISOString(), sizeBytes: dirSize(path.join(dest, 'world')), source: w.worldDir };
    fs.writeFileSync(path.join(dest, 'snapshot.json'), JSON.stringify(meta, null, 2));
    return meta;
  }

  restore(workspace: string, profileId: string, snapshotId: string, confirm: boolean): { restoredTo: string } {
    if (!confirm) throw new Error('Restoring a snapshot replaces the current world; pass confirm: true');
    const dir = this.ws.normalize(workspace);
    const snap = this.list(dir).find((x) => x.id === snapshotId);
    if (!snap) throw new Error(`Unknown snapshot ${snapshotId}`);
    const w = this.worldDir(dir, profileId, snap.world);
    if (this.s.instances.activeForDir(w.instanceDir)) throw new Error('Stop the instance before restoring a world snapshot');
    const tmp = `${w.worldDir}.restore-${Date.now()}`;
    fs.cpSync(path.join(this.root(dir), snapshotId, 'world'), tmp, { recursive: true });
    if (fs.existsSync(w.worldDir)) fs.rmSync(w.worldDir, { recursive: true, force: true });
    fs.renameSync(tmp, w.worldDir);
    return { restoredTo: w.worldDir };
  }
}
