import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { zipSync, strToU8 } from 'fflate';
import { tmpDir } from './helpers';
import type { FakeTemurin } from './fakeapi';

const javaSource = `use std::io::Write;
fn main() {
    let exe = std::env::current_exe().unwrap();
    let home = exe.parent().unwrap().parent().unwrap();
    let release = std::fs::read_to_string(home.join("release")).unwrap_or_default();
    let version = release.lines().find_map(|l| l.strip_prefix("JAVA_VERSION=")).unwrap_or("0").trim_matches('"').to_string();
    let _ = writeln!(std::io::stderr(), "Property settings:\\n    java.home = {}\\n    java.vendor = Eclipse Adoptium\\n    java.version = {}\\n    os.arch = amd64\\nopenjdk version \\"{}\\"", home.display(), version, version);
}
`;

const javaScript = `#!/bin/sh
home="$(cd "$(dirname "$0")/.." && pwd)"
version="$(sed -n 's/^JAVA_VERSION="\\(.*\\)"$/\\1/p' "$home/release")"
printf 'Property settings:\\n    java.home = %s\\n    java.vendor = Eclipse Adoptium\\n    java.version = %s\\n    os.arch = amd64\\n' "$home" "$version" >&2
`;

let compiled: Uint8Array | null | undefined;

export function fakeJavaExecutable(): Uint8Array | null {
  if (process.platform !== 'win32') return strToU8(javaScript);
  if (compiled !== undefined) return compiled;
  const dir = tmpDir('mwb-fakejava-');
  fs.writeFileSync(path.join(dir, 'java.rs'), javaSource);
  const r = spawnSync('rustc', ['-O', '-C', 'debuginfo=0', '-o', path.join(dir, 'java.exe'), path.join(dir, 'java.rs')], { cwd: dir, windowsHide: true });
  compiled = r.status === 0 && fs.existsSync(path.join(dir, 'java.exe')) ? new Uint8Array(fs.readFileSync(path.join(dir, 'java.exe'))) : null;
  return compiled;
}

function tarHeader(name: string, size: number, mode: number, kind: string, link = ''): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100, 'latin1');
  h.write('0000000\0', 108, 'latin1');
  h.write('0000000\0', 116, 'latin1');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
  h.write('00000000000\0', 136, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write(kind, 156, 'latin1');
  h.write(link, 157, 'utf8');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return h;
}

const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return `${len}${body}`;
}

function tarGz(entries: { name: string; data?: Uint8Array; mode?: number; dir?: boolean; link?: string }[]): Uint8Array {
  const parts: Buffer[] = [];
  for (const e of entries) {
    if (e.name.length > 100) {
      const rec = Buffer.from(paxRecord('path', e.name));
      parts.push(tarHeader('PaxHeader', rec.length, 0o644, 'x'), pad(rec));
    }
    if (e.dir) parts.push(tarHeader(e.name, 0, 0o755, '5'));
    else if (e.link) parts.push(tarHeader(e.name, 0, 0o777, '2', e.link));
    else {
      const data = Buffer.from(e.data ?? new Uint8Array());
      parts.push(tarHeader(e.name, data.length, e.mode ?? 0o644, '0'), pad(data));
    }
  }
  parts.push(Buffer.alloc(1024));
  return new Uint8Array(zlib.gzipSync(Buffer.concat(parts)));
}

export function fakeTemurin(version: string, build: number, image: 'jdk' | 'jre', java: Uint8Array, format: 'zip' | 'tar.gz' = process.platform === 'win32' ? 'zip' : 'tar.gz'): FakeTemurin {
  const release = `jdk-${version}+${build}`;
  const top = image === 'jre' ? `${release}-jre` : release;
  const major = version.split('.')[0];
  const exe = process.platform === 'win32' ? '.exe' : '';
  const home = process.platform === 'darwin' ? `${top}/Contents/Home` : top;
  const files: Record<string, Uint8Array> = {
    [`${home}/release`]: strToU8(`IMPLEMENTOR="Eclipse Adoptium"\nJAVA_VERSION="${version}"\n`),
    [`${home}/bin/java${exe}`]: java,
    [`${home}/lib/${'nested/'.repeat(14)}modules`]: strToU8('modules')
  };
  if (image === 'jdk') files[`${home}/bin/javac${exe}`] = java;
  const kind = image === 'jre' ? 'jre' : 'jdk';
  if (format === 'zip') {
    const zip: Record<string, Uint8Array> = {};
    for (const [k, v] of Object.entries(files)) zip[k] = v;
    return { release, name: `OpenJDK${major}U-${kind}_x64_windows_hotspot_${version}_${build}.zip`, bytes: zipSync(zip) };
  }
  const entries: { name: string; data?: Uint8Array; mode?: number; dir?: boolean; link?: string }[] = [{ name: `${top}/`, dir: true }];
  for (const [k, v] of Object.entries(files)) entries.push({ name: k, data: v, mode: k.includes('/bin/') ? 0o755 : 0o644 });
  entries.push({ name: `${home}/legal/`, dir: true }, { name: `${home}/legal/RELEASE`, link: '../release' });
  const os = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux';
  return { release, name: `OpenJDK${major}U-${kind}_x64_${os}_hotspot_${version}_${build}.tar.gz`, bytes: tarGz(entries) };
}
