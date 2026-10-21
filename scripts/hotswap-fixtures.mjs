import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'test', 'fixtures', 'hotswap');
const base = path.join(fixtures, 'src', 'base');
const javac = process.argv[2] ?? 'javac';

const foo = 'demo/Foo.java';
const VARIANTS = {
  base: {},
  body: { [foo]: [['return value + 1;', 'return value + 2;']] },
  lambda: { [foo]: [['() -> "a"', '() -> "b"']] },
  field: { [foo]: [['private int value = 2;', 'private int value = 2;\n    private int extra;']] },
  method: { [foo]: [['    private int helper() {', '    public int twice() {\n        return value * 2;\n    }\n\n    private int helper() {']] },
  removed: { [foo]: [['    private int helper() {\n        return COUNT;\n    }\n', '']] },
  signature: { [foo]: [['public int value() {\n        return value + 1;', 'public long value() {\n        return value + 1L;']] },
  modifiers: { [foo]: [['private int helper()', 'private synchronized int helper()']] },
  super: { [foo]: [['extends Base', 'extends Other']] },
  iface: { [foo]: [['implements Runnable', 'implements Runnable, Cloneable']] },
  clinit: { [foo]: [['static int COUNT = 1;', 'static int COUNT = 5;']] },
  nested: { [foo]: [['    private int helper() {', '    static class Inner {\n    }\n\n    private int helper() {']] },
  mixin: { 'demo/FooMixin.java': [['return 1;', 'return 2;']] },
  registry: { 'demo/ModItems.java': [['Registry.register("first");', 'Registry.register("first");\n        Registry.register("second");']] },
  safeitems: { 'demo/ModItems.java': [['return "items";', 'return "things";']] },
  added: { 'demo/Extra.java': 'package demo;\n\npublic class Extra {\n    public int answer() {\n        return 42;\n    }\n}\n' }
};

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

function sources(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith('.java')) out.push(p);
  }
  return out;
}

for (const [name, edits] of Object.entries(VARIANTS)) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `hotswap-${name}-`));
  const src = path.join(tmp, 'src');
  const out = path.join(tmp, 'out');
  copyDir(base, src);
  for (const [file, change] of Object.entries(edits)) {
    const f = path.join(src, file);
    if (typeof change === 'string') {
      fs.writeFileSync(f, change);
      continue;
    }
    let text = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    for (const [a, b] of change) {
      if (!text.includes(a)) throw new Error(`${name}: ${file} does not contain ${a}`);
      text = text.replace(a, b);
    }
    fs.writeFileSync(f, text);
  }
  const r = spawnSync(javac, ['--release', '17', '-g', '-d', out, ...sources(src)], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`javac failed for ${name}`);
  const dest = path.join(fixtures, name, 'demo');
  fs.rmSync(path.join(fixtures, name), { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(path.join(out, 'demo'))) fs.copyFileSync(path.join(out, 'demo', f), path.join(dest, f));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${name}: ${fs.readdirSync(dest).join(', ')}`);
}
