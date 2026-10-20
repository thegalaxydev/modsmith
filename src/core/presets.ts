import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Services } from './context';
import { pickVersion } from './modrinth';
import { isGeneratable } from './catalog';

export const PresetSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  description: z.string().default(''),
  builtin: z.boolean().default(false),
  catalogEntryId: z.string(),
  environment: z.enum(['both', 'client', 'server']).default('both'),
  starters: z.array(z.string()).default(['empty', 'bridge', 'profiles']),
  dependencies: z.array(z.object({ source: z.literal('modrinth'), projectId: z.string(), title: z.string().optional(), usage: z.enum(['compile', 'runtime']).default('compile'), required: z.boolean().default(true), environment: z.enum(['client', 'server', 'both']).default('both') })).default([]),
  profiles: z.array(z.record(z.string(), z.unknown())).default([])
});
export type Preset = z.infer<typeof PresetSchema>;

const BUILTIN: Preset[] = [
  PresetSchema.parse({ id: 'fabric-minimal', name: 'Fabric minimal', description: 'Empty Fabric 1.21.1 mod with the bridge and client/server profiles.', builtin: true, catalogEntryId: 'fabric-1.21.1', starters: ['empty', 'bridge', 'profiles'] }),
  PresetSchema.parse({ id: 'fabric-content', name: 'Fabric content mod', description: 'Item, block, command, config and data generation starters.', builtin: true, catalogEntryId: 'fabric-1.21.1', starters: ['empty', 'item', 'block', 'command', 'config', 'datagen', 'bridge', 'profiles'] }),
  PresetSchema.parse({ id: 'fabric-modmenu', name: 'Fabric with Mod Menu', description: 'Adds Mod Menu as a compile dependency for config screens.', builtin: true, catalogEntryId: 'fabric-1.21.1', starters: ['empty', 'config', 'bridge', 'profiles'], dependencies: [{ source: 'modrinth', projectId: 'mOgUt4GM', title: 'Mod Menu', usage: 'compile', required: false, environment: 'client' }] }),
  PresetSchema.parse({ id: 'create-addon-fabric', name: 'Create addon (Fabric)', description: 'Create as a compile dependency. Availability is checked against Modrinth before use.', builtin: true, catalogEntryId: 'fabric-1.21.1', starters: ['empty', 'item', 'bridge', 'profiles'], dependencies: [{ source: 'modrinth', projectId: 'Xbc0uyRg', title: 'Create Fabric', usage: 'compile', required: true }] })
];

export class PresetService {
  constructor(private s: Services) {}

  private file(): string {
    return path.join(this.s.paths.data, 'presets.json');
  }

  list(): Preset[] {
    const user = fs.existsSync(this.file()) ? (JSON.parse(fs.readFileSync(this.file(), 'utf8')) as unknown[]).map((p) => PresetSchema.parse(p)) : [];
    return [...BUILTIN, ...user];
  }

  save(input: unknown): Preset {
    const p = PresetSchema.parse({ ...(input as object), builtin: false });
    if (BUILTIN.some((b) => b.id === p.id)) throw new Error('Cannot overwrite a built-in preset');
    const user = this.list().filter((x) => !x.builtin && x.id !== p.id);
    user.push(p);
    fs.writeFileSync(this.file(), JSON.stringify(user, null, 2));
    return p;
  }

  async check(id: string) {
    const p = this.list().find((x) => x.id === id);
    if (!p) throw new Error(`Unknown preset ${id}`);
    const entry = this.s.catalog.get(p.catalogEntryId);
    if (!entry) return { preset: p, usable: false, entry: null, dependencies: [], reason: `Unknown catalog entry ${p.catalogEntryId}` };
    const deps = [];
    for (const d of p.dependencies) {
      try {
        const versions = await this.s.modrinth.versions(d.projectId, { loader: entry.loader, minecraft: entry.minecraft });
        const v = pickVersion(versions, entry.loader, entry.minecraft);
        deps.push({ projectId: d.projectId, title: d.title, available: !!v, version: v?.version_number ?? null, detail: v ? `${v.version_number} (${v.version_type})` : `No ${entry.loader} build for Minecraft ${entry.minecraft} on Modrinth` });
      } catch (err) {
        deps.push({ projectId: d.projectId, title: d.title, available: false, version: null, detail: (err as Error).message });
      }
    }
    const blocking = deps.filter((d, i) => !d.available && p.dependencies[i].required);
    return { preset: p, usable: isGeneratable(entry) && blocking.length === 0, entry: entry.id, dependencies: deps, reason: !isGeneratable(entry) ? `${entry.id} is ${entry.status}` : blocking.length ? `Required dependencies unavailable: ${blocking.map((b) => b.title ?? b.projectId).join(', ')}` : null };
  }
}
