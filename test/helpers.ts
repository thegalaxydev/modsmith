import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';

export function tmpDir(prefix = 'mwb-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function fakeModJar(dir: string, name: string, fmj: Record<string, unknown>, nested: Record<string, Uint8Array> = {}): string {
  const file = path.join(dir, name);
  const entries: Record<string, Uint8Array> = { 'fabric.mod.json': strToU8(JSON.stringify({ schemaVersion: 1, version: '1.0.0', ...fmj })) };
  for (const [k, v] of Object.entries(nested)) entries[`META-INF/jars/${k}`] = v;
  if (Object.keys(nested).length) entries['fabric.mod.json'] = strToU8(JSON.stringify({ schemaVersion: 1, version: '1.0.0', jars: Object.keys(nested).map((k) => ({ file: `META-INF/jars/${k}` })), ...fmj }));
  fs.writeFileSync(file, zipSync(entries));
  return file;
}

export function jarBytes(fmj: Record<string, unknown>): Uint8Array {
  return zipSync({ 'fabric.mod.json': strToU8(JSON.stringify({ schemaVersion: 1, version: '1.0.0', ...fmj })) });
}
