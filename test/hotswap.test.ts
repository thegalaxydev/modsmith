import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Workbench } from '../src/core/workbench';
import { accept, changedClasses, classDirs, classify, describeMember, parseClass, redefineAll, snapshot, type ClassChange } from '../src/core/hotswap';
import { createService, serviceBinary, type ServiceUnderTest } from './service';
import { tmpDir } from './helpers';
import type { JavaInstallation } from '../src/shared/types';

const FIXTURES = path.join(__dirname, 'fixtures', 'hotswap');
const bytes = (variant: string, cls: string) => {
  const f = path.join(FIXTURES, variant, 'demo', `${cls}.class`);
  return fs.existsSync(f) ? fs.readFileSync(f) : null;
};
const check = (variant: string, cls: string): ClassChange => {
  const o = bytes('base', cls);
  const n = bytes(variant, cls);
  return classify(o && parseClass(o), n && parseClass(n))!;
};

describe('hot-swap change classifier', () => {
  it('allows method body and lambda changes', () => {
    expect(check('body', 'Foo')).toMatchObject({ class: 'demo.Foo', change: 'modified', hotswap: true, methods: ['int value()'], reasons: [] });
    expect(check('lambda', 'Foo')).toMatchObject({ hotswap: true, methods: ['String lambda$run$0()'] });
    expect(check('safeitems', 'ModItems')).toMatchObject({ hotswap: true, methods: ['String name()'] });
    expect(check('base', 'Foo').methods).toEqual([]);
  });

  it('asks for a restart for schema, signature and hierarchy changes', () => {
    expect(check('field', 'Foo').reasons).toEqual(['Field added: int extra']);
    expect(check('method', 'Foo').reasons).toEqual(['Method added: int twice()']);
    expect(check('removed', 'Foo').reasons).toEqual(['Method removed: int helper()']);
    expect(check('signature', 'Foo').reasons).toEqual(['Method added: long value()', 'Method removed: int value()']);
    expect(check('modifiers', 'Foo').reasons).toEqual(['Method modifiers changed: int helper()']);
    expect(check('super', 'Foo').reasons).toEqual(['Superclass changed from demo.Base to demo.Other']);
    expect(check('iface', 'Foo').reasons).toEqual(['Implemented interfaces changed']);
    expect(check('clinit', 'Foo').reasons).toEqual(['Static initializer changed (it already ran when the class loaded)']);
    expect(check('nested', 'Foo').reasons).toEqual(['Nested, permitted or record classes changed']);
    expect(check('nested', 'Foo$Inner')).toMatchObject({ change: 'added', hotswap: true });
  });

  it('asks for a restart for mixins and game registration', () => {
    expect(check('mixin', 'FooMixin').reasons).toEqual(['Mixin class (mixins are applied when the game starts)']);
    expect(check('registry', 'ModItems').reasons).toEqual(['void register() registers game content (Registry.register); registration only runs at startup']);
  });

  it('treats new classes as loadable and removed classes as needing a restart', () => {
    expect(check('added', 'Extra')).toMatchObject({ change: 'added', hotswap: true });
    const removed = classify(parseClass(bytes('added', 'Extra')!), null)!;
    expect(removed).toMatchObject({ class: 'demo.Extra', change: 'removed', hotswap: false, reasons: ['Class removed (the running game still has it)'] });
  });

  it('rejects files that are not class files', () => {
    expect(() => parseClass(Buffer.from('not a class'))).toThrow('is not a valid class file');
    const b = bytes('base', 'Foo')!;
    expect(() => parseClass(b.subarray(0, b.length / 2))).toThrow('is not a valid class file');
  });

  it('describes members the way Java writes them', () => {
    expect(describeMember('go', '(I[Ljava/lang/String;Ljava/util/Map$Entry;)V')).toBe('void go(int, String[], Map.Entry)');
    expect(describeMember('<init>', '(J)V')).toBe('constructor(long)');
    expect(describeMember('x', '[[D')).toBe('double[][] x');
  });
});

describe('class snapshots', () => {
  const copy = (variant: string, to: string) => {
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(path.join(to, 'demo'), { recursive: true });
    for (const f of fs.readdirSync(path.join(FIXTURES, variant, 'demo'))) fs.copyFileSync(path.join(FIXTURES, variant, 'demo', f), path.join(to, 'demo', f));
  };

  it('finds class output folders inside the project only', () => {
    const project = tmpDir();
    const main = path.join(project, 'build', 'classes', 'java', 'main');
    const res = path.join(project, 'build', 'resources', 'main');
    const outside = path.join(tmpDir(), 'classes');
    for (const d of [main, res, outside]) fs.mkdirSync(d, { recursive: true });
    expect(classDirs(project, [main, res, outside, path.join(project, 'lib.jar'), main])).toEqual([main]);
  });

  it('reports changed, added and removed classes against the snapshot and accepts them', () => {
    const project = tmpDir();
    const classes = path.join(project, 'build', 'classes', 'java', 'main');
    const state = path.join(project, '.modsmith', 'hotswap', 'dev-client');
    copy('base', classes);
    expect(snapshot(state, 'inst-1', [classes])).toBe(6);
    expect(JSON.parse(fs.readFileSync(path.join(state, 'state.json'), 'utf8'))).toEqual({ instance: 'inst-1', dirs: [classes] });
    expect(changedClasses(state, [classes])).toEqual([]);
    copy('added', classes);
    fs.copyFileSync(path.join(FIXTURES, 'body', 'demo', 'Foo.class'), path.join(classes, 'demo', 'Foo.class'));
    fs.rmSync(path.join(classes, 'demo', 'Other.class'));
    const changes = changedClasses(state, [classes]);
    expect(changes.map((c) => [c.rel, !!c.old, !!c.new])).toEqual([
      ['demo/Extra.class', false, true],
      ['demo/Foo.class', true, true],
      ['demo/Other.class', true, false]
    ]);
    accept(state, changes);
    expect(changedClasses(state, [classes])).toEqual([]);
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function jvmOutput(child: ChildProcess) {
  const lines: string[] = [];
  child.stdout!.on('data', (d: Buffer) => lines.push(...d.toString().split(/\r?\n/).filter(Boolean)));
  return {
    lines,
    async waitFor(text: string, after = 0, ms = 20000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (lines.slice(after).some((l) => l === text)) return lines.length;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`Timed out waiting for "${text}"; last output: ${lines.slice(-3).join(' | ')}`);
    }
  };
}

describe('JDWP class redefinition', () => {
  let svc: ServiceUnderTest;
  let javas: JavaInstallation[] = [];
  beforeAll(async () => {
    svc = createService();
    const all = await svc.call<JavaInstallation[]>('java.list', { refresh: true }, 'ui');
    for (const major of [17, 21, 25]) {
      const j = all.find((x) => x.major === major && fs.existsSync(x.executable));
      if (j) javas.push(j);
    }
  });
  afterAll(async () => {
    await svc.stop();
  });

  it('redefines method bodies atomically on every installed Java 17, 21 and 25', async () => {
    if (!javas.length) return;
    expect(javas.map((j) => j.major).length).toBeGreaterThan(0);
    for (const java of javas) {
      const dir = tmpDir();
      fs.mkdirSync(path.join(dir, 'demo'));
      for (const f of fs.readdirSync(path.join(FIXTURES, 'base', 'demo'))) fs.copyFileSync(path.join(FIXTURES, 'base', 'demo', f), path.join(dir, 'demo', f));
      const port = await freePort();
      const child = spawn(java.executable, [`-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:${port}`, '-cp', dir, 'demo.Loop'], { stdio: ['ignore', 'pipe', 'pipe'] });
      try {
        const out = jvmOutput(child);
        let mark = await out.waitFor('value 3');
        const ok = await redefineAll(port, [{ sig: 'Ldemo/Foo;', bytes: bytes('body', 'Foo')! }]);
        expect(ok, `Java ${java.major}`).toEqual({ loaded: [true], error: null });
        mark = await out.waitFor('value 4', mark);
        const rejected = await redefineAll(port, [
          { sig: 'Ldemo/ModItems;', bytes: bytes('safeitems', 'ModItems')! },
          { sig: 'Ldemo/Foo;', bytes: bytes('field', 'Foo')! }
        ]);
        expect(rejected, `Java ${java.major}`).toEqual({ loaded: [false, true], error: 'it adds, removes or changes fields' });
        mark = await out.waitFor('value 4', mark);
        const again = await redefineAll(port, [{ sig: 'Ldemo/Foo;', bytes: bytes('base', 'Foo')! }]);
        expect(again.error).toBeNull();
        await out.waitFor('value 3', mark);
      } finally {
        child.kill();
      }
    }
  }, 120000);

  it('explains a closed or busy debug port', async () => {
    const port = await freePort();
    await expect(redefineAll(port, [])).rejects.toThrow(`Could not connect to the debug port ${port}`);
    const srv = net.createServer((s) => s.end('nope'));
    await new Promise<void>((r) => srv.listen(port, '127.0.0.1', () => r()));
    try {
      await expect(redefineAll(port, [])).rejects.toThrow(`The debug port ${port} did not answer. Another debugger may be attached; only one can connect at a time.`);
    } finally {
      srv.close();
    }
  });
});

describe.runIf(!!serviceBinary)('Rust service matches the Node service for hot reload', () => {
  let node: Workbench;
  let rust: ServiceUnderTest;
  beforeAll(() => {
    node = new Workbench();
    rust = createService();
  });
  afterAll(async () => {
    await node.stop(false);
    await rust.stop();
  });
  const outcome = (p: Promise<unknown>) =>
    p.then(
      (ok) => ({ ok: JSON.parse(JSON.stringify(ok ?? null)) }),
      (e: Error) => ({ err: e.message })
    );
  const same = async (method: string, params: Record<string, unknown>) => {
    const r = await outcome(rust.call(method, params, 'ui'));
    const n = await outcome(node.call(method, params, 'ui'));
    expect(r, method).toEqual(n);
    return n;
  };

  it('reports unknown instances and checks debug ports the same way', async () => {
    expect(await same('instance.hotswap', { id: 'no-such-instance' })).toEqual({ err: 'Unknown instance no-such-instance' });
    const port = await freePort();
    expect(await same('instance.debug_port_check', { port })).toEqual({ ok: { port, free: true, suggested: port } });
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(port, '127.0.0.1', () => r()));
    try {
      const busy = (await same('instance.debug_port_check', { port })) as { ok: { free: boolean; suggested: number | null } };
      expect(busy.ok.free).toBe(false);
      expect(busy.ok.suggested).not.toBe(port);
    } finally {
      srv.close();
    }
  });
});
