import fs from 'node:fs';
import path from 'node:path';

type Fn = (...args: unknown[]) => unknown;

let dpapi: { protect: Fn; unprotect: Fn; localFree: Fn; koffi: typeof import('koffi') } | null = null;

function load() {
  if (process.platform !== 'win32') throw new Error('Operating-system secret storage is only implemented on Windows (DPAPI). Set the value through an environment variable instead.');
  if (dpapi) return dpapi;
  const koffi = require('koffi') as typeof import('koffi');
  koffi.struct('MWB_DATA_BLOB', { cbData: 'uint32_t', pbData: 'void *' });
  const crypt32 = koffi.load('crypt32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  dpapi = {
    protect: crypt32.func('bool __stdcall CryptProtectData(MWB_DATA_BLOB *pDataIn, const char16_t *desc, void *entropy, void *reserved, void *prompt, uint32_t flags, _Out_ MWB_DATA_BLOB *pDataOut)'),
    unprotect: crypt32.func('bool __stdcall CryptUnprotectData(MWB_DATA_BLOB *pDataIn, void *desc, void *entropy, void *reserved, void *prompt, uint32_t flags, _Out_ MWB_DATA_BLOB *pDataOut)'),
    localFree: kernel32.func('void * __stdcall LocalFree(void *mem)'),
    koffi
  };
  return dpapi;
}

const CRYPTPROTECT_UI_FORBIDDEN = 0x1;

function run(fn: 'protect' | 'unprotect', input: Buffer): Buffer {
  const d = load();
  const out: { cbData: number; pbData: unknown } = { cbData: 0, pbData: null };
  const ok = fn === 'protect'
    ? d.protect({ cbData: input.length, pbData: input }, 'Modsmith secret', null, null, null, CRYPTPROTECT_UI_FORBIDDEN, out)
    : d.unprotect({ cbData: input.length, pbData: input }, null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, out);
  if (!ok) throw new Error(`DPAPI ${fn} failed`);
  try {
    return Buffer.from(d.koffi.decode(out.pbData, 'uint8_t', out.cbData) as number[]);
  } finally {
    d.localFree(out.pbData);
  }
}

export class SecretStore {
  constructor(private file: string) {}

  private read(): Record<string, string> {
    if (!fs.existsSync(this.file)) return {};
    return JSON.parse(fs.readFileSync(this.file, 'utf8'));
  }

  private write(data: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  set(name: string, value: string): void {
    const data = this.read();
    data[name] = run('protect', Buffer.from(value, 'utf8')).toString('base64');
    this.write(data);
  }

  get(name: string): string | null {
    const data = this.read();
    if (!data[name]) return null;
    return run('unprotect', Buffer.from(data[name], 'base64')).toString('utf8');
  }

  has(name: string): boolean {
    return !!this.read()[name];
  }

  delete(name: string): void {
    const data = this.read();
    delete data[name];
    this.write(data);
  }

  static supported(): boolean {
    return process.platform === 'win32';
  }
}
