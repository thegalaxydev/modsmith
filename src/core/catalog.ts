import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CatalogEntry } from '../shared/types';

const EntrySchema = z.object({
  id: z.string(),
  schema: z.literal(1),
  loader: z.enum(['fabric', 'neoforge', 'forge']),
  minecraft: z.string(),
  loaderVersion: z.string(),
  status: z.enum(['verified', 'unverified']),
  verifiedOn: z.string().optional(),
  verificationNote: z.string(),
  gradleVersion: z.string().regex(/^\d+\.\d+(\.\d+)?$/),
  plugin: z.object({ id: z.string(), version: z.string() }),
  mappings: z.enum(['mojang', 'parchment', 'none']),
  parchment: z.object({ minecraft: z.string(), version: z.string() }).optional(),
  remap: z.boolean(),
  javaRelease: z.number().int().min(8),
  gradleJavaMin: z.number().int().min(8),
  runtimeJavaMin: z.number().int().min(8),
  fabricApiVersion: z.string().optional(),
  templateSource: z.string().url(),
  starters: z.array(z.string()),
  bridge: z.object({ available: z.boolean(), jar: z.string().optional() })
});

export const CatalogSchema = z.object({ schemaVersion: z.literal(1), updated: z.string(), entries: z.array(EntrySchema) });

export class CompatibilityCatalog {
  readonly entries: CatalogEntry[];
  readonly updated: string;

  constructor(resourcesDir: string) {
    const raw = JSON.parse(fs.readFileSync(path.join(resourcesDir, 'catalog', 'compatibility.json'), 'utf8'));
    const parsed = CatalogSchema.parse(raw);
    const ids = new Set<string>();
    for (const e of parsed.entries) {
      if (ids.has(e.id)) throw new Error(`Duplicate catalog entry ${e.id}`);
      ids.add(e.id);
    }
    this.entries = parsed.entries as CatalogEntry[];
    this.updated = parsed.updated;
  }

  get(id: string): CatalogEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  forLoader(loader: string): CatalogEntry[] {
    return this.entries.filter((e) => e.loader === loader);
  }

  select(loader: string, minecraft: string, opts: { allowUnverified?: boolean } = {}): CatalogEntry | null {
    const matches = this.entries.filter((e) => e.loader === loader && e.minecraft === minecraft && (opts.allowUnverified || e.status === 'verified'));
    return matches[0] ?? null;
  }

  minecraftVersions(loader: string): { minecraft: string; status: string; entryId: string }[] {
    return this.forLoader(loader).map((e) => ({ minecraft: e.minecraft, status: e.status, entryId: e.id }));
  }
}

export function assertGeneratable(entry: CatalogEntry): void {
  if (entry.status !== 'verified') {
    throw new Error(`Catalog entry ${entry.id} is ${entry.status}: ${entry.verificationNote}`);
  }
}
