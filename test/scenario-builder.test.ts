import { describe, expect, it } from 'vitest';
import { ACTIONS, newDraft, parseProperties, propertiesText, slugify, stepSummary } from '../src/renderer/components/ScenarioBuilder';
import { ScenarioSchema } from '../src/core/scenarios';

describe('scenario builder', () => {
  it('makes file names and block properties', () => {
    expect(slugify('Crate drops its contents!')).toBe('crate-drops-its-contents');
    expect(slugify('***')).toBe('scenario');
    expect(parseProperties('facing=north, lit = true, bad')).toEqual({ facing: 'north', lit: 'true' });
    expect(parseProperties('')).toBeUndefined();
    expect(propertiesText({ facing: 'north', lit: 'true' })).toBe('facing=north, lit=true');
  });

  it('creates steps the scenario schema accepts', () => {
    const steps = ACTIONS.map((a) => a.make()).map((s) => ({ ...s, command: 'say hi', item: 'minecraft:stone', block: 'minecraft:stone', id: 'minecraft:stone', pattern: 'x' }));
    const res = ScenarioSchema.safeParse({ ...newDraft('dev-client'), name: 'All', steps: steps.map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => k === 'action' || Object.keys(ACTIONS.find((a) => a.action === s.action)!.make()).includes(k)))) });
    expect(res.success).toBe(true);
    expect(ACTIONS.map((a) => stepSummary({ ...a.make(), command: 'time set day', item: 'minecraft:stone', block: 'minecraft:stone', id: 'x', pattern: 'p' }))).toEqual(['/time set day', '1 × minecraft:stone', '20 ticks', 'minecraft:stone at 0 64 0', 'at least 1 × minecraft:stone', 'item x', 'a line matches /p/', '']);
  });
});
