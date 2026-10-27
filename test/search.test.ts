import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Workbench } from '../src/core/workbench';
import { createService, serviceBinary, type ServiceUnderTest } from './service';
import { tmpDir } from './helpers';

const put = (root: string, rel: string, text: string | Buffer) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

function project() {
  const dir = tmpDir('mwb-search-');
  put(dir, 'gradle.properties', 'mod_version=0.1.0\r\nmod_name=Demo Mod\r\n');
  put(dir, 'src/main/java/demo/Demo.java', 'package demo;\n\npublic class Demo {\n\tpublic static final String MOD_ID = "demo";\n\tString demoName = "Démo démo";\n}\n');
  put(dir, 'src/main/resources/assets/demo/lang/en_us.json', '{\n  "item.demo.gizmo": "Gizmo",\n  "block.demo.crate": "Crate of demo"\n}\n');
  put(dir, 'src/main/resources/fabric.mod.json', `{"id":"demo","description":"${'x'.repeat(400)}demo${'y'.repeat(400)}"}`);
  put(dir, 'build/libs/demo-0.1.0.jar', Buffer.from([0x50, 0x4b, 0, 0]));
  put(dir, 'build/libs/demo-0.1.0-sources.jar', Buffer.from([0x50, 0x4b, 0, 1]));
  put(dir, 'build/libs/notes.txt', 'demo');
  put(dir, '.gradle/cache.txt', 'demo');
  put(dir, 'run/logs/latest.log', 'demo');
  put(dir, 'textures/demo.png', Buffer.from([0x89, 0x50, 0, 0x64, 0x65, 0x6d, 0x6f]));
  put(dir, 'big.txt', 'demo\n'.repeat(300000));
  return dir;
}

type Match = { line: number; column: number; length: number; text: string; offset: number };
type Result = { files: { file: string; matches: Match[] }[]; fileCount: number; matchCount: number; searchedFiles: number; truncated: boolean };

describe('workspace search and replace', () => {
  let svc: ServiceUnderTest;
  beforeAll(() => {
    svc = createService();
  });
  afterAll(async () => {
    await svc.stop();
  });
  const call = <T>(m: string, p: Record<string, unknown>) => svc.call<T>(m, p, 'ui');

  it('finds text line by line and skips build outputs, binary and large files', async () => {
    const dir = project();
    const r = await call<Result>('workspace.search', { path: dir, query: 'demo' });
    expect(r.files.map((f) => [f.file, f.matches.length])).toEqual([
      ['gradle.properties', 1],
      ['src/main/java/demo/Demo.java', 4],
      ['src/main/resources/assets/demo/lang/en_us.json', 3],
      ['src/main/resources/fabric.mod.json', 2]
    ]);
    expect(r.matchCount).toBe(10);
    expect(r.truncated).toBe(false);
    const java = r.files[1].matches;
    expect(java[0]).toEqual({ line: 1, column: 8, length: 4, text: 'package demo;', offset: 0 });
    expect(java.map((m) => [m.line, m.column])).toEqual([[1, 8], [3, 13], [4, 38], [5, 8]]);
    const long = r.files[3].matches[1];
    expect(long).toMatchObject({ line: 1, column: 428, length: 4, offset: 328 });
    expect(long.text.slice(long.column - long.offset, long.column - long.offset + 4)).toBe('demo');
  });

  it('matches case, whole words, regular expressions and file globs', async () => {
    const dir = project();
    const count = async (p: Record<string, unknown>) => (await call<Result>('workspace.search', { path: dir, ...p })).matchCount;
    expect(await count({ query: 'Demo', caseSensitive: true })).toBe(2);
    expect(await count({ query: 'demo', wholeWord: true })).toBe(8);
    expect(await count({ query: 'd[eé]mo', regex: true, include: '*.java' })).toBe(6);
    expect(await count({ query: 'demo', include: 'src/main/resources', exclude: '**/lang/**' })).toBe(2);
    expect(await count({ query: 'mod_', include: 'gradle.properties' })).toBe(2);
    expect(await count({ query: 'demo', maxResults: 3 })).toBe(3);
    await expect(call('workspace.search', { path: dir, query: '(unclosed', regex: true })).rejects.toThrow(/^Invalid regular expression/);
    const unicode = await call<Result>('workspace.search', { path: dir, query: 'démo', include: '*.java' });
    expect(unicode.files[0].matches.map((m) => m.column)).toEqual([20, 25]);
  });

  it('replaces everywhere, in chosen files or one match, keeping line endings', async () => {
    const dir = project();
    const props = path.join(dir, 'gradle.properties');
    const one = await call<{ files: { file: string; replacements: number }[]; replacements: number }>('workspace.replace', { path: dir, query: '0.1.0', replacement: '1.0.0', include: '*.properties' });
    expect(one).toEqual({ files: [{ file: 'gradle.properties', replacements: 1 }], replacements: 1 });
    expect(fs.readFileSync(props, 'utf8')).toBe('mod_version=1.0.0\r\nmod_name=Demo Mod\r\n');
    const groups = await call<{ replacements: number }>('workspace.replace', { path: dir, query: 'mod_(?<key>\\w+)=(.*)', regex: true, replacement: '$<key>: $2 ($$1) [$&]\\t$9', files: ['gradle.properties'] });
    expect(groups.replacements).toBe(2);
    expect(fs.readFileSync(props, 'utf8')).toBe('version: 1.0.0 ($1) [mod_version=1.0.0]\t$9\r\nname: Demo Mod ($1) [mod_name=Demo Mod]\t$9\r\n');
    const java = 'src/main/java/demo/Demo.java';
    await call('workspace.replace', { path: dir, query: 'demo', replacement: 'gizmo', match: { file: java, line: 5, column: 8 } });
    expect(fs.readFileSync(path.join(dir, java), 'utf8')).toContain('String gizmoName = "Démo démo";');
    await expect(call('workspace.replace', { path: dir, query: 'demo', replacement: 'x', match: { file: java, line: 5, column: 8 } })).rejects.toThrow(/no longer there/);
    const all = await call<{ replacements: number; files: { file: string }[] }>('workspace.replace', { path: dir, query: 'Demo', caseSensitive: true, wholeWord: true, replacement: 'Example' });
    expect(all.files.map((f) => f.file)).toEqual(['gradle.properties', java]);
    expect(fs.readFileSync(path.join(dir, java), 'utf8')).toContain('public class Example {');
    await expect(call('workspace.replace', { path: dir, query: 'x', replacement: 'y', files: ['../outside.txt'] })).rejects.toThrow(/outside the workspace/);
  });

  it('lists and exports the built JARs', async () => {
    const dir = project();
    const sources = path.join(dir, 'build', 'libs', 'demo-0.1.0-sources.jar');
    fs.utimesSync(sources, new Date(), new Date(Date.now() + 60000));
    const r = await call<{ folder: string; exists: boolean; files: { name: string; kind: string; size: number }[] }>('project.artifacts', { path: dir });
    expect(r.exists).toBe(true);
    expect(r.folder).toBe(path.join(fs.realpathSync(dir), 'build', 'libs'));
    expect(r.files.map((f) => [f.name, f.kind, f.size])).toEqual([
      ['demo-0.1.0.jar', 'mod', 4],
      ['demo-0.1.0-sources.jar', 'sources', 4]
    ]);
    const out = path.join(tmpDir('mwb-export-'), 'nested', 'demo.jar');
    expect(await call('project.export_artifact', { path: dir, name: 'demo-0.1.0.jar', output: out })).toEqual({ output: out, size: 4 });
    expect(fs.readFileSync(out)).toEqual(Buffer.from([0x50, 0x4b, 0, 0]));
    await expect(call('project.export_artifact', { path: dir, name: '../../gradle.properties', output: out })).rejects.toThrow(/not a JAR/);
    await expect(call('project.export_artifact', { path: dir, name: 'other.jar', output: out })).rejects.toThrow(/build the project first/);
    expect(await call('project.artifacts', { path: tmpDir() })).toMatchObject({ exists: false, files: [] });
  });
});

describe.runIf(!!serviceBinary)('Rust and Node search the same way', () => {
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

  it('returns the same matches and replacements', async () => {
    const dir = project();
    put(dir, 'src/emoji.txt', 'a😀demo b😀 DEMO\r\nx\n\nαβγ demo_demo');
    for (const q of [{ query: 'demo' }, { query: 'DEMO', caseSensitive: true }, { query: 'demo', wholeWord: true }, { query: '\\bd\\w+', regex: true }, { query: 'a*', regex: true }, { query: '"(.+?)"', regex: true, include: '*.json, *.java', exclude: 'fabric.mod.json' }, { query: 'demo', include: 'src/**/lang/*' }, { query: '.' , maxResults: 7 }]) {
      const params = { path: dir, ...q };
      const n = JSON.parse(JSON.stringify(await node.call('workspace.search', params, 'ui')));
      expect(await rust.call('workspace.search', params, 'ui'), JSON.stringify(q)).toEqual(n);
    }
    for (const r of [{ query: 'demo', replacement: 'x$1' }, { query: '(d)(e)(m)(o)', regex: true, replacement: '$4$3$2$1 $10 ${2} $<n> \\n\\\\' }, { query: 'b😀', replacement: '!' }]) {
      const a = tmpDir('mwb-sa-');
      const b = tmpDir('mwb-sb-');
      fs.cpSync(dir, a, { recursive: true });
      fs.cpSync(dir, b, { recursive: true });
      const rn = JSON.parse(JSON.stringify(await node.call('workspace.replace', { path: a, ...r }, 'ui')));
      expect(await rust.call('workspace.replace', { path: b, ...r }, 'ui')).toEqual(rn);
      for (const f of ['src/emoji.txt', 'src/main/java/demo/Demo.java', 'gradle.properties']) expect(fs.readFileSync(path.join(b, f), 'utf8'), f).toBe(fs.readFileSync(path.join(a, f), 'utf8'));
    }
    const art = JSON.parse(JSON.stringify(await node.call('project.artifacts', { path: dir }, 'ui')));
    expect(await rust.call('project.artifacts', { path: dir }, 'ui')).toEqual(art);
  });
});
