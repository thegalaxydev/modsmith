import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { InstanceInfo, OperationInfo } from '../shared/types';
import type { Services } from './context';
import type { OpContext } from './operations';
import type { ProjectService } from './projects';
import { stateDir } from './workspace';
import { debuggerAttached } from './debug';

type Cp =
  | { t: 'empty' }
  | { t: 'utf8'; v: string }
  | { t: 'int' | 'float'; v: number }
  | { t: 'long' | 'double'; v: bigint }
  | { t: 'class' | 'str' | 'mtype' | 'named'; i: number }
  | { t: 'ref' | 'nat' | 'dyn'; a: number; b: number }
  | { t: 'handle'; k: number; i: number };

export interface Member {
  access: number;
  name: string;
  desc: string;
  code: string | null;
  calls: [string, string][];
}

export interface ClassFile {
  name: string;
  access: number;
  superName: string | null;
  interfaces: string[];
  fields: Member[];
  methods: Member[];
  nest: string[];
  mixin: boolean;
}

export interface ClassChange {
  class: string;
  change: 'added' | 'removed' | 'modified';
  hotswap: boolean;
  methods: string[];
  reasons: string[];
  status?: 'redefined' | 'not-loaded' | 'added' | 'restart' | 'skipped' | 'rejected';
}

const BAD = 'is not a valid class file';
const MIXIN = 'Lorg/spongepowered/asm/mixin/Mixin;';

class Reader {
  p = 0;
  constructor(readonly b: Buffer) {}
  take(n: number) {
    if (this.p + n > this.b.length) throw new Error(BAD);
    const s = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return s;
  }
  u1() {
    return this.take(1)[0];
  }
  u2() {
    return this.take(2).readUInt16BE(0);
  }
  u4() {
    return this.take(4).readUInt32BE(0);
  }
}

const i32 = (b: Buffer, at: number) => {
  if (at < 0 || at + 4 > b.length) throw new Error(BAD);
  return b.readInt32BE(at);
};

class Pool {
  constructor(readonly e: Cp[]) {}
  get(i: number): Cp {
    const c = this.e[i];
    if (!c) throw new Error(BAD);
    return c;
  }
  utf8(i: number) {
    const c = this.get(i);
    if (c.t !== 'utf8') throw new Error(BAD);
    return c.v;
  }
  cls(i: number) {
    const c = this.get(i);
    if (c.t !== 'class') throw new Error(BAD);
    return this.utf8(c.i);
  }
  text(i: number): string {
    const c = this.get(i);
    switch (c.t) {
      case 'empty':
        return '';
      case 'utf8':
        return c.v;
      case 'int':
        return `i${c.v}`;
      case 'float':
        return `f${c.v}`;
      case 'long':
        return `l${c.v}`;
      case 'double':
        return `d${c.v}`;
      case 'class':
        return `C${this.utf8(c.i)}`;
      case 'str':
        return `S${JSON.stringify(this.utf8(c.i))}`;
      case 'ref':
        return `${this.cls(c.a)}.${this.text(c.b)}`;
      case 'nat':
        return `${this.utf8(c.a)}:${this.utf8(c.b)}`;
      case 'handle':
        return `H${c.k}:${this.text(c.i)}`;
      case 'mtype':
        return `T${this.utf8(c.i)}`;
      case 'dyn':
        return `Y${c.a}:${this.text(c.b)}`;
      case 'named':
        return this.utf8(c.i);
    }
  }
  call(i: number): [string, string] | null {
    try {
      const c = this.get(i);
      if (c.t !== 'ref') return null;
      const nat = this.get(c.b);
      if (nat.t !== 'nat') return null;
      return [this.cls(c.a), this.utf8(nat.a)];
    } catch {
      return null;
    }
  }
}

function normalizeCode(code: Buffer, pool: Pool, calls: [string, string][]) {
  const out: string[] = [];
  let pc = 0;
  const at = (i: number) => {
    if (i >= code.length) throw new Error(BAD);
    return code[i];
  };
  const u2 = (i: number) => {
    if (i + 2 > code.length) throw new Error(BAD);
    return code.readUInt16BE(i);
  };
  while (pc < code.length) {
    const op = code[pc];
    let tok = `${op}`;
    let len = 1;
    if (op === 0x10 || (op >= 0x15 && op <= 0x19) || (op >= 0x36 && op <= 0x3a) || op === 0xa9 || op === 0xbc) {
      tok += ` ${at(pc + 1)}`;
      len = 2;
    } else if (op === 0x12) {
      tok += ` ${pool.text(at(pc + 1))}`;
      len = 2;
    } else if (op === 0x11 || op === 0x84 || (op >= 0x99 && op <= 0xa8) || op === 0xc6 || op === 0xc7) {
      tok += ` ${u2(pc + 1)}`;
      len = 3;
    } else if (op === 0x13 || op === 0x14 || (op >= 0xb2 && op <= 0xb8) || op === 0xbb || op === 0xbd || op === 0xc0 || op === 0xc1) {
      const i = u2(pc + 1);
      if (op >= 0xb6 && op <= 0xb8) {
        const c = pool.call(i);
        if (c) calls.push(c);
      }
      tok += ` ${pool.text(i)}`;
      len = 3;
    } else if (op === 0xc5) {
      tok += ` ${pool.text(u2(pc + 1))} ${at(pc + 3)}`;
      len = 4;
    } else if (op === 0xb9 || op === 0xba) {
      const i = u2(pc + 1);
      if (op === 0xb9) {
        const c = pool.call(i);
        if (c) calls.push(c);
      }
      tok += ` ${pool.text(i)}`;
      len = 5;
    } else if (op === 0xc8 || op === 0xc9) {
      tok += ` ${i32(code, pc + 1)}`;
      len = 5;
    } else if (op === 0xc4) {
      const inner = at(pc + 1);
      if (inner === 0x84) {
        tok += ` ${u2(pc + 2)} ${u2(pc + 4)}`;
        len = 6;
      } else {
        tok += ` ${inner} ${u2(pc + 2)}`;
        len = 4;
      }
    } else if (op === 0xaa || op === 0xab) {
      const start = (pc + 4) & ~3;
      const def = i32(code, start);
      if (op === 0xaa) {
        const low = i32(code, start + 4);
        const high = i32(code, start + 8);
        if (high < low) throw new Error(BAD);
        const n = high - low + 1;
        const targets: string[] = [];
        for (let k = 0; k < n; k++) targets.push(String(i32(code, start + 12 + 4 * k)));
        tok += ` ${def} ${low} ${high} ${targets.join(',')}`;
        len = start + 12 + 4 * n - pc;
      } else {
        const n = i32(code, start + 4);
        if (n < 0) throw new Error(BAD);
        const pairs: string[] = [];
        for (let k = 0; k < n; k++) pairs.push(`${i32(code, start + 8 + 8 * k)}=${i32(code, start + 12 + 8 * k)}`);
        tok += ` ${def} ${pairs.join(',')}`;
        len = start + 8 + 8 * n - pc;
      }
    }
    out.push(tok);
    pc += len;
  }
  return out.join(';');
}

function readMembers(r: Reader, pool: Pool, methods: boolean): Member[] {
  const out: Member[] = [];
  const n = r.u2();
  for (let k = 0; k < n; k++) {
    const access = r.u2();
    const name = pool.utf8(r.u2());
    const desc = pool.utf8(r.u2());
    let code: string | null = null;
    const calls: [string, string][] = [];
    const attrs = r.u2();
    for (let a = 0; a < attrs; a++) {
      const attr = pool.utf8(r.u2());
      const body = r.take(r.u4());
      if (methods && attr === 'Code') {
        const c = new Reader(body);
        c.p = 4;
        const bytes = c.take(c.u4());
        let text = normalizeCode(bytes, pool, calls);
        const ex = c.u2();
        for (let e = 0; e < ex; e++) {
          const [s, en, h, t] = [c.u2(), c.u2(), c.u2(), c.u2()];
          text += `|${s},${en},${h},${t === 0 ? '' : pool.cls(t)}`;
        }
        code = text;
      }
    }
    out.push({ access, name, desc, code, calls });
  }
  return out;
}

export function parseClass(bytes: Buffer): ClassFile {
  const r = new Reader(bytes);
  if (r.u4() !== 0xcafebabe) throw new Error(BAD);
  r.u2();
  r.u2();
  const count = r.u2();
  const e: Cp[] = [{ t: 'empty' }];
  for (let i = 1; i < count; i++) {
    const tag = r.u1();
    switch (tag) {
      case 1: {
        const len = r.u2();
        e.push({ t: 'utf8', v: r.take(len).toString('utf8') });
        break;
      }
      case 3:
        e.push({ t: 'int', v: r.take(4).readInt32BE(0) });
        break;
      case 4:
        e.push({ t: 'float', v: r.u4() });
        break;
      case 5:
        e.push({ t: 'long', v: r.take(8).readBigInt64BE(0) });
        break;
      case 6:
        e.push({ t: 'double', v: r.take(8).readBigUInt64BE(0) });
        break;
      case 7:
        e.push({ t: 'class', i: r.u2() });
        break;
      case 8:
        e.push({ t: 'str', i: r.u2() });
        break;
      case 9:
      case 10:
      case 11:
        e.push({ t: 'ref', a: r.u2(), b: r.u2() });
        break;
      case 12:
        e.push({ t: 'nat', a: r.u2(), b: r.u2() });
        break;
      case 15:
        e.push({ t: 'handle', k: r.u1(), i: r.u2() });
        break;
      case 16:
        e.push({ t: 'mtype', i: r.u2() });
        break;
      case 17:
      case 18:
        e.push({ t: 'dyn', a: r.u2(), b: r.u2() });
        break;
      case 19:
      case 20:
        e.push({ t: 'named', i: r.u2() });
        break;
      default:
        throw new Error(BAD);
    }
    if (tag === 5 || tag === 6) {
      e.push({ t: 'empty' });
      i++;
    }
  }
  const pool = new Pool(e);
  const access = r.u2();
  const name = pool.cls(r.u2());
  const sup = r.u2();
  const superName = sup === 0 ? null : pool.cls(sup);
  const interfaces: string[] = [];
  const ni = r.u2();
  for (let k = 0; k < ni; k++) interfaces.push(pool.cls(r.u2()));
  const fields = readMembers(r, pool, false);
  const methods = readMembers(r, pool, true);
  const nest: string[] = [];
  let mixin = false;
  const na = r.u2();
  for (let k = 0; k < na; k++) {
    const attr = pool.utf8(r.u2());
    const body = r.take(r.u4());
    const a = new Reader(body);
    if (attr === 'NestHost') nest.push(`host ${pool.cls(a.u2())}`);
    else if (attr === 'NestMembers' || attr === 'PermittedSubclasses') {
      const names: string[] = [];
      const n = a.u2();
      for (let j = 0; j < n; j++) names.push(pool.cls(a.u2()));
      names.sort();
      nest.push(`${attr} ${names.join(',')}`);
    } else if (attr === 'Record') {
      const comps: string[] = [];
      const n = a.u2();
      for (let j = 0; j < n; j++) {
        comps.push(`${pool.utf8(a.u2())}:${pool.utf8(a.u2())}`);
        const ca = a.u2();
        for (let x = 0; x < ca; x++) {
          a.u2();
          a.take(a.u4());
        }
      }
      nest.push(`record ${comps.join(',')}`);
    } else if (attr === 'RuntimeInvisibleAnnotations' || attr === 'RuntimeVisibleAnnotations') {
      if (e.some((c) => c.t === 'utf8' && c.v === MIXIN)) mixin = true;
    }
  }
  return { name, access, superName, interfaces, fields, methods, nest, mixin };
}

function javaType(desc: string, pos: { i: number }): string {
  let dims = 0;
  while (desc[pos.i] === '[') {
    dims++;
    pos.i++;
  }
  let base: string;
  const c = desc[pos.i];
  if (c === 'L') {
    let end = desc.indexOf(';', pos.i);
    if (end < 0) end = desc.length;
    const full = desc.slice(pos.i + 1, end);
    pos.i = end + 1;
    base = (full.split('/').pop() ?? full).replace(/\$/g, '.');
  } else if (c === undefined) base = '?';
  else {
    pos.i++;
    base = ({ B: 'byte', C: 'char', D: 'double', F: 'float', I: 'int', J: 'long', S: 'short', Z: 'boolean', V: 'void' } as Record<string, string>)[c] ?? '?';
  }
  return base + '[]'.repeat(dims);
}

export function describeMember(name: string, desc: string): string {
  if (!desc.startsWith('(')) return `${javaType(desc, { i: 0 })} ${name}`;
  const pos = { i: 1 };
  const params: string[] = [];
  while (pos.i < desc.length && desc[pos.i] !== ')') params.push(javaType(desc, pos));
  pos.i++;
  const ret = javaType(desc, pos);
  if (name === '<init>') return `constructor(${params.join(', ')})`;
  if (name === '<clinit>') return 'static initializer';
  return `${ret} ${name}(${params.join(', ')})`;
}

function isRegistration(owner: string, name: string) {
  const simple = owner.split('/').pop() ?? owner;
  return name.startsWith('register') && (simple === 'Registry' || simple.startsWith('DeferredRegister') || simple === 'Registries' || simple.endsWith('RegistryHelper'));
}

export const dotted = (internal: string) => internal.replace(/\//g, '.');

const sameSet = (a: string[], b: string[]) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

export function classify(old: ClassFile | null, next: ClassFile | null): ClassChange | null {
  if (!old && !next) return null;
  const name = (old ?? next)!.name;
  const change = !old ? 'added' : !next ? 'removed' : 'modified';
  const reasons: string[] = [];
  const methods: string[] = [];
  if (old && !next) reasons.push(old.mixin ? 'Mixin class removed (mixins are applied when the game starts)' : 'Class removed (the running game still has it)');
  if (!old && next && next.mixin) reasons.push('New mixin class (mixins are applied when the game starts)');
  if (old && next) {
    if (old.superName !== next.superName) reasons.push(`Superclass changed from ${dotted(old.superName ?? '')} to ${dotted(next.superName ?? '')}`);
    if (!sameSet(old.interfaces, next.interfaces)) reasons.push('Implemented interfaces changed');
    if ((old.access & ~0x0020) !== (next.access & ~0x0020)) reasons.push('Class modifiers changed');
    if (!sameSet(old.nest, next.nest)) reasons.push('Nested, permitted or record classes changed');
    const key = (m: Member) => m.name + m.desc;
    for (const f of next.fields) {
      const x = old.fields.find((o) => o.name === f.name && o.desc === f.desc);
      if (!x) reasons.push(`Field added: ${describeMember(f.name, f.desc)}`);
      else if (x.access !== f.access) reasons.push(`Field modifiers changed: ${describeMember(f.name, f.desc)}`);
    }
    for (const f of old.fields) if (!next.fields.some((x) => x.name === f.name && x.desc === f.desc)) reasons.push(`Field removed: ${describeMember(f.name, f.desc)}`);
    for (const m of next.methods) {
      const x = old.methods.find((o) => key(o) === key(m));
      if (!x) {
        reasons.push(m.name === '<clinit>' ? 'Static initializer added (it would not run in the running game)' : `Method added: ${describeMember(m.name, m.desc)}`);
        continue;
      }
      if (x.access !== m.access) reasons.push(`Method modifiers changed: ${describeMember(m.name, m.desc)}`);
      if (x.code !== m.code) {
        if (m.name === '<clinit>') reasons.push('Static initializer changed (it already ran when the class loaded)');
        else {
          methods.push(describeMember(m.name, m.desc));
          const regs = [...new Set([...m.calls, ...x.calls].filter(([c, n]) => isRegistration(c, n)).map(([c, n]) => `${c.split('/').pop() ?? c}.${n}`))].sort();
          if (regs.length) reasons.push(`${describeMember(m.name, m.desc)} registers game content (${regs.join(', ')}); registration only runs at startup`);
        }
      }
    }
    for (const m of old.methods) if (!next.methods.some((x) => key(x) === key(m))) reasons.push(m.name === '<clinit>' ? 'Static initializer removed' : `Method removed: ${describeMember(m.name, m.desc)}`);
    if ((old.mixin || next.mixin) && reasons.every((r) => !r.startsWith('Mixin'))) reasons.unshift('Mixin class (mixins are applied when the game starts)');
  }
  return { class: dotted(name), change, hotswap: reasons.length === 0, methods, reasons };
}

function walkClasses(root: string, dir: string, out: Map<string, string>) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkClasses(root, p, out);
    else if (e.name.endsWith('.class')) out.set(path.relative(root, p).replace(/\\/g, '/'), p);
  }
}

const sorted = (m: Map<string, string>) => new Map([...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export function classDirs(project: string, classpath: string[]): string[] {
  const root = path.resolve(project).replace(/\\/g, '/').toLowerCase();
  const out: string[] = [];
  for (const entry of classpath) {
    let dir = false;
    try {
      dir = fs.statSync(entry).isDirectory();
    } catch {
      dir = false;
    }
    if (!dir) continue;
    const norm = path.resolve(entry).replace(/\\/g, '/').toLowerCase();
    if (norm.startsWith(`${root}/`) && norm.split('/').includes('classes') && !out.includes(entry)) out.push(entry);
  }
  return out;
}

export function statePath(project: string, profile: string, side: string) {
  return path.join(stateDir(project), 'hotswap', `${profile}-${side}`);
}

export function snapshot(state: string, instance: string, dirs: string[]): number {
  fs.rmSync(state, { recursive: true, force: true });
  let count = 0;
  dirs.forEach((d, i) => {
    const files = new Map<string, string>();
    walkClasses(d, d, files);
    for (const [rel, src] of sorted(files)) {
      const dest = path.join(state, 'baseline', String(i), rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      count++;
    }
  });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'state.json'), JSON.stringify({ instance, dirs }));
  return count;
}

export interface Changed {
  dir: number;
  rel: string;
  old: Buffer | null;
  new: Buffer | null;
}

const readOrNull = (p: string | undefined) => {
  if (!p) return null;
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
};

export function changedClasses(state: string, dirs: string[]): Changed[] {
  const out: Changed[] = [];
  dirs.forEach((d, i) => {
    const base = path.join(state, 'baseline', String(i));
    const now = new Map<string, string>();
    const before = new Map<string, string>();
    walkClasses(d, d, now);
    walkClasses(base, base, before);
    const keys = [...new Set([...now.keys(), ...before.keys()])].sort();
    for (const rel of keys) {
      const nb = readOrNull(now.get(rel));
      const ob = readOrNull(before.get(rel));
      const same = nb && ob ? nb.equals(ob) : nb === ob;
      if (!same) out.push({ dir: i, rel, old: ob, new: nb });
    }
  });
  return out;
}

export function accept(state: string, changes: Changed[]) {
  for (const c of changes) {
    const dest = path.join(state, 'baseline', String(c.dir), c.rel);
    try {
      if (c.new) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, c.new);
      } else fs.rmSync(dest, { force: true });
    } catch {
      continue;
    }
  }
}

export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

export function jdwpErrorText(code: number): string {
  const known: Record<number, string> = {
    21: 'the class is not loaded',
    60: 'the class file is invalid',
    61: 'the class hierarchy would become circular',
    62: 'the new bytecode does not pass verification',
    63: 'it adds a method',
    64: 'it adds, removes or changes fields',
    66: 'it changes the class hierarchy',
    67: 'it removes a method',
    68: 'the class was compiled for a newer Java version than the game runs on',
    69: 'the class name does not match',
    70: 'it changes class modifiers',
    71: 'it changes method modifiers',
    72: 'it changes nested classes or other class attributes',
    99: 'this Java runtime cannot redefine classes',
    112: 'the debugger connection is not available'
  };
  return known[code] ?? `the JVM reported error ${code}`;
}

export class JdwpCodeError extends Error {
  constructor(readonly code: number) {
    super(jdwpErrorText(code));
  }
}

export class Jdwp {
  private buf = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  private closed: Error | null = null;
  private id = 0;
  private refSize = 8;

  private constructor(private sock: net.Socket) {
    sock.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.wake();
    });
    sock.on('error', (e) => {
      this.closed = e;
      this.wake();
    });
    sock.on('close', () => {
      this.closed ??= new Error('connection closed');
      this.wake();
    });
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  private async read(n: number, ms = 60000): Promise<Buffer> {
    const deadline = Date.now() + ms;
    while (this.buf.length < n) {
      if (this.closed) throw this.closed;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out');
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  static async connect(port: number): Promise<Jdwp> {
    const busy = `The debug port ${port} did not answer. Another debugger may be attached; only one can connect at a time.`;
    const sock = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port });
      const t = setTimeout(() => {
        s.destroy();
        reject(new Error(`Could not connect to the debug port ${port}: timed out`));
      }, 3000);
      s.once('connect', () => {
        clearTimeout(t);
        resolve(s);
      });
      s.once('error', (e) => {
        clearTimeout(t);
        reject(new Error(`Could not connect to the debug port ${port}: ${e.message}`));
      });
    });
    sock.setNoDelay(true);
    const j = new Jdwp(sock);
    try {
      sock.write('JDWP-Handshake');
      const hs = await j.read(14, 10000);
      if (hs.toString('latin1') !== 'JDWP-Handshake') throw new Error(busy);
    } catch {
      sock.destroy();
      throw new Error(busy);
    }
    const sizes = await j.command(1, 7, Buffer.alloc(0));
    j.refSize = i32(sizes, 12);
    return j;
  }

  async command(set: number, cmd: number, data: Buffer): Promise<Buffer> {
    const id = ++this.id;
    const head = Buffer.alloc(11);
    head.writeUInt32BE(11 + data.length, 0);
    head.writeUInt32BE(id, 4);
    head[8] = 0;
    head[9] = set;
    head[10] = cmd;
    this.sock.write(Buffer.concat([head, data]));
    for (;;) {
      let h: Buffer;
      let body: Buffer;
      try {
        h = await this.read(11);
        const len = h.readUInt32BE(0);
        if (len < 11) throw new Error('invalid packet');
        body = await this.read(len - 11);
      } catch (e) {
        throw new Error(`The debugger connection failed: ${(e as Error).message}`);
      }
      if ((h[8] & 0x80) === 0 || h.readUInt32BE(4) !== id) continue;
      const code = h.readUInt16BE(9);
      if (code !== 0) throw new JdwpCodeError(code);
      return body;
    }
  }

  async canRedefine() {
    const caps = await this.command(1, 17, Buffer.alloc(0));
    return (caps[7] ?? 0) !== 0;
  }

  async classesBySignature(sig: string): Promise<Buffer[]> {
    const s = Buffer.from(sig, 'utf8');
    const data = Buffer.alloc(4 + s.length);
    data.writeUInt32BE(s.length, 0);
    s.copy(data, 4);
    const body = await this.command(1, 2, data);
    const n = i32(body, 0);
    const step = 1 + this.refSize + 4;
    const out: Buffer[] = [];
    for (let k = 0; k < n; k++) {
      const at = 4 + k * step;
      if (at + 1 + this.refSize > body.length) throw new Error('The debugger sent an invalid reply');
      out.push(Buffer.from(body.subarray(at + 1, at + 1 + this.refSize)));
    }
    return out;
  }

  async redefine(classes: [Buffer, Buffer][]): Promise<number | null> {
    const parts: Buffer[] = [];
    const count = Buffer.alloc(4);
    count.writeUInt32BE(classes.length, 0);
    parts.push(count);
    for (const [ref, bytes] of classes) {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(bytes.length, 0);
      parts.push(ref, len, bytes);
    }
    try {
      await this.command(1, 18, Buffer.concat(parts));
      return null;
    } catch (e) {
      return e instanceof JdwpCodeError ? e.code : 112;
    }
  }

  async dispose() {
    try {
      await this.command(1, 6, Buffer.alloc(0));
    } catch {
      void 0;
    }
    this.sock.destroy();
  }
}

export async function redefineAll(port: number, classes: { sig: string; bytes: Buffer }[]): Promise<{ loaded: boolean[]; error: string | null }> {
  const j = await Jdwp.connect(port);
  try {
    if (!(await j.canRedefine())) throw new Error('This Java runtime cannot redefine classes');
    const loaded: boolean[] = [];
    const batch: [Buffer, Buffer][] = [];
    for (const c of classes) {
      const refs = await j.classesBySignature(c.sig);
      loaded.push(refs.length > 0);
      for (const r of refs) batch.push([r, c.bytes]);
    }
    const code = batch.length ? await j.redefine(batch) : null;
    return { loaded, error: code === null ? null : jdwpErrorText(code) };
  } finally {
    await j.dispose();
  }
}

export class HotswapService {
  constructor(
    private s: Services,
    private projects: ProjectService
  ) {}

  async portCheck(port: number) {
    const free = await portFree(port);
    let suggested: number | null = free ? port : null;
    if (!free) {
      for (let p = port + 1; p < Math.min(port + 50, 65536); p++) {
        if (await portFree(p)) {
          suggested = p;
          break;
        }
      }
    }
    return { port, free, suggested };
  }

  start(id: string): OperationInfo {
    const info = this.s.instances.get(id);
    if (!info) throw new Error(`Unknown instance ${id}`);
    if (!['running', 'starting'].includes(info.status)) throw new Error(`Instance ${id} is not running`);
    if (info.mode !== 'development') throw new Error('Hot reload works on development runs. This run uses the built JAR, so rebuild and restart instead');
    if (!info.debugPort) throw new Error('Hot reload needs the debug port. Turn on hot reload for this profile and restart the game');
    if (debuggerAttached(id)) throw new Error('The debugger is attached to this game, and the debug port takes one connection at a time. Stop debugging, then apply the changes');
    const port = info.debugPort;
    const dir = info.workspace;
    const state = statePath(dir, info.profileId, `${info.side}${info.slot && info.slot > 1 ? `-${info.slot}` : ''}`);
    let saved: { instance?: string; dirs?: string[] } = {};
    try {
      saved = JSON.parse(fs.readFileSync(path.join(state, 'state.json'), 'utf8'));
    } catch {
      saved = {};
    }
    if (saved.instance !== id) throw new Error('This run has no class snapshot for hot reload. Restart it to use hot reload');
    const dirs = (saved.dirs ?? []).filter((d): d is string => typeof d === 'string');
    return this.s.ops.start({ kind: 'instance.hotswap', title: `Hot reload ${info.profileId}`, workspace: dir }, (ctx) => this.run(info, dir, state, dirs, port, ctx));
  }

  private async run(info: InstanceInfo, dir: string, state: string, dirs: string[], port: number, ctx: OpContext) {
    const id = info.id;
    const tasks: string[] = [];
    for (const d of dirs) {
      const set = path.basename(d);
      const task = set === 'main' ? 'classes' : `${set}Classes`;
      if (!tasks.includes(task)) tasks.push(task);
    }
    if (!tasks.length) tasks.push('classes');
    ctx.progress(0.05, 'Compiling changed sources');
    try {
      await this.projects.runBuild(dir, { tasks }, ctx);
    } catch (e) {
      throw new Error(`${(e as Error).message}. Nothing was applied to the running game`);
    }
    ctx.throwIfCancelled();
    ctx.progress(0.7, 'Comparing classes with the running game');
    const changes = changedClasses(state, dirs);
    const classes: ClassChange[] = [];
    const names: (string | null)[] = [];
    for (const c of changes) {
      const parse = (b: Buffer | null) => {
        if (!b) return null;
        try {
          return parseClass(b);
        } catch (e) {
          throw new Error(`${c.rel} ${(e as Error).message}`);
        }
      };
      const old = parse(c.old);
      const next = parse(c.new);
      classes.push(classify(old, next)!);
      names.push(next?.name ?? null);
    }
    if (!classes.length) {
      ctx.log('No compiled classes changed since the game started or since the last hot reload');
      return { instance: id, applied: false, restartRequired: false, redefined: 0, classes: [] };
    }
    const blocked = classes.filter((c) => !c.hotswap);
    if (blocked.length) {
      for (const c of blocked) for (const r of c.reasons) ctx.log(`${c.class}: ${r}`);
      ctx.log('Nothing was applied. Restart the game to use these changes');
      ctx.progress(1, 'Restart needed');
      return { instance: id, applied: false, restartRequired: true, redefined: 0, classes: classes.map((c) => ({ ...c, status: c.hotswap ? 'skipped' : 'restart' })) };
    }
    ctx.progress(0.8, 'Redefining classes in the running game');
    const targets: { sig: string; bytes: Buffer }[] = [];
    const index: number[] = [];
    changes.forEach((c, k) => {
      const n = names[k];
      if (classes[k].change === 'modified' && n && c.new) {
        targets.push({ sig: `L${n};`, bytes: c.new });
        index.push(k);
      }
    });
    const { loaded, error } = targets.length ? await redefineAll(port, targets) : { loaded: [] as boolean[], error: null };
    if (error) {
      ctx.log(`The game rejected the new classes: ${error}. Nothing was applied`);
      return {
        instance: id,
        applied: false,
        restartRequired: true,
        redefined: 0,
        error: `The game rejected the new classes because ${error}. Nothing was applied; restart to use these changes`,
        classes: classes.map((c) => ({ ...c, status: 'rejected' }))
      };
    }
    let redefined = 0;
    for (const c of classes) if (c.change === 'added') c.status = 'added';
    index.forEach((k, n) => {
      if (loaded[n]) {
        classes[k].status = 'redefined';
        redefined++;
      } else classes[k].status = 'not-loaded';
    });
    accept(state, changes);
    for (const c of classes) {
      const what = c.status === 'redefined' ? (c.methods.length ? `redefined (${c.methods.join(', ')})` : 'redefined') : c.status === 'not-loaded' ? 'not loaded yet; the new version loads when first used' : c.status === 'added' ? 'new class; loads when first used' : String(c.status);
      ctx.log(`${c.class}: ${what}`);
    }
    ctx.progress(1, `Redefined ${redefined} class${redefined === 1 ? '' : 'es'}`);
    return { instance: id, applied: true, restartRequired: false, redefined, classes };
  }
}
