import { readFileSync } from 'node:fs';
import path from 'node:path';

const RUNTIME = /^(vcruntime|msvcp|concrt)\d/i;

function imports(file) {
  const d = readFileSync(file);
  const pe = d.readUInt32LE(0x3c);
  if (d.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error(`${file} is not a PE file`);
  const sections = d.readUInt16LE(pe + 6);
  const optional = pe + 24;
  const table = optional + d.readUInt16LE(pe + 20);
  const dirs = d.readUInt16LE(optional) === 0x20b ? optional + 112 : optional + 96;
  const importRva = d.readUInt32LE(dirs + 8);
  const offset = (rva) => {
    for (let i = 0; i < sections; i++) {
      const s = table + 40 * i;
      const va = d.readUInt32LE(s + 12);
      const size = Math.max(d.readUInt32LE(s + 8), d.readUInt32LE(s + 16));
      if (rva >= va && rva < va + size) return rva - va + d.readUInt32LE(s + 20);
    }
    throw new Error(`${file}: RVA ${rva} is outside every section`);
  };
  const names = [];
  for (let o = offset(importRva); d.readUInt32LE(o + 12); o += 20) {
    const n = offset(d.readUInt32LE(o + 12));
    names.push(d.toString('latin1', n, d.indexOf(0, n)));
  }
  return names;
}

const files = process.argv.slice(2);
if (!files.length) throw new Error('Usage: node scripts/check-runtime.mjs <file.exe>...');
let failed = false;
for (const file of files) {
  const needs = imports(file).filter((n) => RUNTIME.test(n));
  if (needs.length) {
    failed = true;
    console.error(`${path.basename(file)} needs ${needs.join(', ')}, which a Windows PC without the Visual C++ Redistributable does not have`);
  } else {
    console.log(`${path.basename(file)}: no Visual C++ runtime DLLs`);
  }
}
if (failed) process.exit(1);
