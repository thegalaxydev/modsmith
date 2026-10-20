import fs from 'node:fs';
import path from 'node:path';

const JAVA_KEYWORDS = new Set(
  'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record yield sealed permits'.split(' ')
);

export interface FieldIssue {
  field: string;
  message: string;
}

export function validateModId(id: string): string | null {
  if (!id) return 'Mod ID is required';
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(id)) return 'Mod ID must be 2-64 characters: lowercase letters, digits and underscores, starting with a letter';
  if (['minecraft', 'java', 'fabric', 'fabricloader', 'forge', 'neoforge', 'mixinextras'].includes(id)) return `Mod ID "${id}" is reserved`;
  return null;
}

export function validatePackage(pkg: string): string | null {
  if (!pkg) return 'Package is required';
  const parts = pkg.split('.');
  if (parts.length < 2) return 'Package should have at least two segments, for example com.example.mymod';
  for (const p of parts) {
    if (!/^[a-z_][a-z0-9_]*$/.test(p)) return `Invalid package segment "${p}": use lowercase letters, digits and underscores`;
    if (JAVA_KEYWORDS.has(p)) return `Package segment "${p}" is a Java keyword`;
  }
  if (pkg.startsWith('net.minecraft') || pkg.startsWith('com.mojang') || pkg.startsWith('net.fabricmc')) return 'Package must not use a Minecraft, Mojang or Fabric namespace';
  return null;
}

export function validateDestination(dest: string): string | null {
  if (!dest) return 'Destination is required';
  if (!path.isAbsolute(dest)) return 'Destination must be an absolute path';
  if (/[<>"|?*]/.test(dest.slice(2))) return 'Destination contains characters that are not allowed in Windows paths';
  if (fs.existsSync(dest)) {
    if (!fs.statSync(dest).isDirectory()) return 'Destination exists and is a file';
    const contents = fs.readdirSync(dest);
    if (contents.length > 0) return `Destination is not empty (${contents.length} entries). Choose an empty or new directory; existing projects are never overwritten.`;
  } else {
    let parent = path.dirname(dest);
    while (!fs.existsSync(parent)) {
      const next = path.dirname(parent);
      if (next === parent) return 'Destination drive does not exist';
      parent = next;
    }
    try {
      fs.accessSync(parent, fs.constants.W_OK);
    } catch {
      return `Cannot write to ${parent}`;
    }
  }
  return null;
}

export function suggestModId(name: string): string {
  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[0-9_]+/, '');
  if (id.length < 2) id = 'mymod';
  return id.slice(0, 64);
}

export function toClassName(name: string): string {
  const words = name.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  let cls = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  if (!cls || /^[0-9]/.test(cls)) cls = 'Mod' + cls;
  if (JAVA_KEYWORDS.has(cls.toLowerCase())) cls += 'Mod';
  return cls;
}

export function validateScaffold(opts: { projectName: string; destination: string; modId: string; packageName: string; license: string }): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (!opts.projectName.trim()) issues.push({ field: 'projectName', message: 'Project name is required' });
  const m = validateModId(opts.modId);
  if (m) issues.push({ field: 'modId', message: m });
  const p = validatePackage(opts.packageName);
  if (p) issues.push({ field: 'packageName', message: p });
  const d = validateDestination(opts.destination);
  if (d) issues.push({ field: 'destination', message: d });
  if (!opts.license.trim()) issues.push({ field: 'license', message: 'License is required (for example MIT, CC0-1.0 or All-Rights-Reserved)' });
  return issues;
}
