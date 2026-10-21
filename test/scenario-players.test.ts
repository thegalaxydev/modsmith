import { describe, expect, it } from 'vitest';
import { asPlayer, checkPlayers, playersOf, ScenarioSchema } from '../src/core/scenarios';

const base = { schemaVersion: 1, name: 'Duo', profile: 'dev-client', steps: [{ action: 'command', command: 'say hi' }] };
const parse = (x: Record<string, unknown>) => ScenarioSchema.parse({ ...base, ...x });

describe('multiplayer scenarios', () => {
  it('runs commands as a player', () => {
    expect(asPlayer('/give @s minecraft:stone', 'Alex')).toBe('execute as Alex at Alex run give @s minecraft:stone');
    expect(asPlayer('setblock ~ ~-1 ~ minecraft:stone', '@p')).toBe('execute as @p at @p run setblock ~ ~-1 ~ minecraft:stone');
    expect(asPlayer('/time set day', null)).toBe('time set day');
  });

  it('defaults players only when there is a server', () => {
    expect(playersOf(parse({}))).toEqual([]);
    expect(playersOf(parse({ server: 'dev-server' }))).toEqual(['Player1', 'Player2']);
    expect(playersOf(parse({ server: 'dev-server', players: ['Alex'] }))).toEqual(['Alex']);
  });

  it('checks players and the players steps name', () => {
    expect(() => checkPlayers(parse({ server: 'dev-server', players: ['Alex', 'Steve'], steps: [{ action: 'give', item: 'minecraft:stone', player: 'Steve' }] }))).not.toThrow();
    expect(() => checkPlayers(parse({ players: ['Alex'] }))).toThrow('A scenario with players needs a server run configuration ("server")');
    expect(() => checkPlayers(parse({ server: 'dev-server', players: ['Alex', 'alex'] }))).toThrow('Each player in a scenario needs a different name');
    expect(() => checkPlayers(parse({ server: 'dev-server', players: ['Alex'], cleanup: [{ action: 'screenshot', player: 'Bob' }] }))).toThrow("cleanup[0] names player Bob, who is not one of the scenario's players (Alex)");
    expect(() => checkPlayers(parse({ steps: [{ action: 'assert_log', pattern: 'x', player: 'Alex' }] }))).toThrow('steps[0] names player Alex, but only multiplayer scenarios (with "server" and "players") can name players');
    expect(() => parse({ server: 'dev-server', players: ['no spaces'] })).toThrow();
    expect(() => parse({ server: 'dev-server', players: ['A1', 'B2', 'C3', 'D4', 'E5'] })).toThrow();
  });
});
