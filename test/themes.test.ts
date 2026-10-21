import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { createService, type ServiceUnderTest } from './service';

type Installed = { id: string; name: string; author: string | null; type: string | null; theme: { colors: Record<string, string>; tokenColors: { scope?: string; settings: Record<string, string> }[]; semanticTokenColors: Record<string, unknown>; semanticHighlighting: boolean | null }; warnings: string[] };

let svc: ServiceUnderTest;
let dir: string;

const write = (rel: string, text: string) => {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
};

const vsix = (name: string, files: Record<string, string>) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
  return f;
};

const fails = async (method: string, params: Record<string, unknown>) => {
  try {
    await svc.call(method, params, 'ui');
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error(`${method} did not fail`);
};

const list = () => svc.call<Installed[]>('theme.list', {}, 'ui');

beforeAll(async () => {
  svc = createService();
});
afterAll(async () => {
  await svc.stop();
});
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwb-themes-'));
  for (const t of await list()) await svc.call('theme.remove', { id: t.id }, 'ui');
});

describe('VS Code theme import', () => {
  it('parses JSONC, follows local includes and merges them in VS Code order', async () => {
    write('base.jsonc', `{
      // base theme
      "name": "Base",
      "type": "light",
      "colors": { "editor.background": "#ffffff", "editor.foreground": "#111111", },
      "tokenColors": [ { "scope": "comment", "settings": { "foreground": "#999999" } }, ],
      "semanticTokenColors": { "class": "#ff0000" },
    }`);
    write('rules/extra.json', '[{ "scope": ["string"], "settings": { "foreground": "#00aa00" } }]');
    const main = write('main.json', `{
      /* comments and trailing commas */
      "name": "Child Theme",
      "type": "dark",
      "include": "./base.jsonc",
      "semanticHighlighting": true,
      "colors": { "editor.background": "#202020", "statusBar.background": "#123456", },
      "tokenColors": "./rules/extra.json",
      "semanticTokenColors": { "variable.readonly": { "foreground": "#00ffff", "fontStyle": "italic" } }
    }`);
    const inspected = await svc.call<{ kind: string; variants: { key: string; label: string; type: string }[] }>('theme.inspect', { file: main }, 'ui');
    expect(inspected).toEqual({ kind: 'json', extension: null, variants: [{ key: 'theme', label: 'Child Theme', type: 'dark' }] });
    const r = await svc.call<{ installed: Installed[]; updated: string[] }>('theme.install', { file: main }, 'ui');
    const t = r.installed[0];
    expect(t.id).toBe('file.child-theme');
    expect(t.type).toBe('dark');
    expect(t.theme.colors).toEqual({ 'editor.background': '#202020', 'editor.foreground': '#111111', 'statusBar.background': '#123456' });
    expect(t.theme.tokenColors.map((x) => x.settings.foreground)).toEqual(['#999999', '#00aa00']);
    expect(Object.keys(t.theme.semanticTokenColors).sort()).toEqual(['class', 'variable.readonly']);
    expect(t.theme.semanticHighlighting).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
    const stored = await list();
    expect(stored.map((x) => x.id)).toEqual(['file.child-theme']);
    expect(stored[0].theme.colors['statusBar.background']).toBe('#123456');
  });

  it('reports malformed files, missing references, cycles and paths outside the theme folder', async () => {
    expect(await fails('theme.install', { file: write('bad.json', '{ "colors": { "a": ') })).toBe('bad.json is not valid JSON or JSONC');
    expect(await fails('theme.install', { file: write('arr.json', '[1, 2]') })).toBe('arr.json is not a VS Code color theme (expected an object with colors or tokenColors)');
    expect(await fails('theme.install', { file: write('missing.json', '{ "include": "./nope.json" }') })).toBe('nope.json is missing');
    write('a.json', '{ "include": "b.json" }');
    write('b.json', '{ "include": "./a.json" }');
    expect(await fails('theme.install', { file: path.join(dir, 'a.json') })).toBe('Include cycle: a.json -> b.json -> a.json');
    expect(await fails('theme.install', { file: write('sub/escape.json', '{ "include": "../a.json" }') })).toBe('../a.json points outside the theme folder');
    expect(await fails('theme.install', { file: write('notes.txt', '{}') })).toBe('Choose a VS Code color theme (.json or .jsonc) or a theme extension (.vsix)');
    expect(await list()).toEqual([]);
  });

  it('lists and installs the themes of a .vsix without duplicating re-imports', async () => {
    const pkg = {
      name: 'night-owl-ish',
      publisher: 'Example',
      displayName: 'Night Owl-ish',
      version: '1.2.3',
      contributes: {
        themes: [
          { label: 'Owl Dark', uiTheme: 'vs-dark', path: './themes/dark.json' },
          { label: 'Owl Light', uiTheme: 'vs', path: './themes/light.jsonc' }
        ]
      },
      main: './out/extension.js'
    };
    const file = vsix('owl.vsix', {
      'extension/package.json': JSON.stringify(pkg),
      'extension/themes/common.json': '{ "colors": { "focusBorder": "#ff00ff" } }',
      'extension/themes/dark.json': '{ "include": "./common.json", "colors": { "editor.background": "#011627" } }',
      'extension/themes/light.jsonc': '{ // light\n "colors": { "editor.background": "#fbfbfb", }, }',
      'extension/out/extension.js': 'throw new Error("never run")',
      '[Content_Types].xml': '<Types/>'
    });
    const inspected = await svc.call<{ kind: string; extension: Record<string, string>; variants: { key: string; label: string; type: string }[] }>('theme.inspect', { file }, 'ui');
    expect(inspected.kind).toBe('vsix');
    expect(inspected.extension).toEqual({ publisher: 'Example', name: 'night-owl-ish', displayName: 'Night Owl-ish', version: '1.2.3' });
    expect(inspected.variants).toEqual([
      { key: 'extension/themes/dark.json', label: 'Owl Dark', type: 'dark' },
      { key: 'extension/themes/light.jsonc', label: 'Owl Light', type: 'light' }
    ]);
    const one = await svc.call<{ installed: Installed[]; updated: string[] }>('theme.install', { file, variants: ['extension/themes/dark.json'] }, 'ui');
    expect(one.installed.map((t) => [t.id, t.author, t.theme.colors['focusBorder']])).toEqual([['example.night-owl-ish.owl-dark', 'Example', '#ff00ff']]);
    expect(one.updated).toEqual([]);
    const both = await svc.call<{ installed: Installed[]; updated: string[] }>('theme.install', { file }, 'ui');
    expect(both.installed.map((t) => t.id)).toEqual(['example.night-owl-ish.owl-dark', 'example.night-owl-ish.owl-light']);
    expect(both.updated).toEqual(['example.night-owl-ish.owl-dark']);
    expect((await list()).map((t) => t.id)).toEqual(['example.night-owl-ish.owl-dark', 'example.night-owl-ish.owl-light']);
    expect(await fails('theme.install', { file, variants: ['extension/themes/nope.json'] })).toBe('extension/themes/nope.json is not a theme in this package');
  });

  it('refuses unsafe or oversized packages and leaves installed themes alone', async () => {
    const good = write('keep.json', '{ "name": "Keep", "colors": {} }');
    await svc.call('theme.install', { file: good }, 'ui');
    const manifest = (themes: unknown[]) => JSON.stringify({ name: 'x', publisher: 'p', contributes: { themes } });
    expect(await fails('theme.inspect', { file: vsix('trav.vsix', { 'extension/package.json': manifest([{ label: 'T', path: './t.json' }]), 'extension/../evil.json': '{}' }) })).toBe('The package has an unsafe file path: extension/../evil.json');
    expect(await fails('theme.install', { file: vsix('outside.vsix', { 'extension/package.json': manifest([{ label: 'T', path: '../../t.json' }]) }) })).toBe('../../t.json points outside the extension');
    expect(await fails('theme.install', { file: vsix('none.vsix', { 'extension/package.json': manifest([]) }) })).toBe('This extension does not contribute any color themes');
    expect(await fails('theme.install', { file: vsix('nomanifest.vsix', { 'readme.md': 'hi' }) })).toBe('The package has no extension/package.json');
    expect(await fails('theme.install', { file: vsix('missing.vsix', { 'extension/package.json': manifest([{ label: 'T', path: './themes/t.json' }]) }) })).toBe('extension/themes/t.json is missing');
    const many: Record<string, string> = { 'extension/package.json': manifest([{ label: 'T', path: './t.json' }]), 'extension/t.json': '{}' };
    for (let i = 0; i < 20001; i++) many[`extension/f/${i}.txt`] = '';
    expect(await fails('theme.inspect', { file: vsix('many.vsix', many) })).toBe('The package has too many files');
    fs.writeFileSync(path.join(dir, 'broken.vsix'), 'not a zip at all');
    expect(await fails('theme.inspect', { file: path.join(dir, 'broken.vsix') })).toBe('The package is not a valid .vsix archive');
    expect((await list()).map((t) => t.id)).toEqual(['file.keep']);
  });

  it('removes imported themes and refuses unknown or unsafe ids', async () => {
    const t = await svc.call<{ installed: Installed[] }>('theme.install', { file: write('gone.json', '{ "name": "Gone" }') }, 'ui');
    expect(await svc.call('theme.remove', { id: t.installed[0].id }, 'ui')).toEqual({ removed: 'file.gone' });
    expect(await list()).toEqual([]);
    expect(await fails('theme.remove', { id: 'file.gone' })).toBe('No imported theme file.gone');
    expect(await fails('theme.remove', { id: '../themes' })).toBe('No imported theme ../themes');
  });
});
