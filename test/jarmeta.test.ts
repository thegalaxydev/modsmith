import { describe, expect, it } from 'vitest';
import { escapeControlCharsInStrings, parseFabricModJson } from '../src/core/jarmeta';

describe('fabric.mod.json parsing', () => {
  it('accepts raw line breaks inside strings like Fabric Loader does', () => {
    const text = '﻿{\n  "schemaVersion": 1,\n  "id": "bettergrass",\n  "version": "1.8.6",\n  "description": "Gamers can finally touch grass!\nOptiFine\'s better grass",\n  "depends": { "fabricloader": ">=0.15" }\n}';
    const meta = parseFabricModJson(text);
    expect(meta.id).toBe('bettergrass');
    expect(meta.description).toBe("Gamers can finally touch grass!\nOptiFine's better grass");
    expect(meta.depends).toEqual({ fabricloader: '>=0.15' });
  });

  it('only escapes control characters inside strings', () => {
    expect(escapeControlCharsInStrings('{\n"a": "x\ty",\n"b": "q\\"\nr"}')).toBe('{\n"a": "x\\ty",\n"b": "q\\"\\nr"}');
  });
});
