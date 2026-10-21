import { describe, expect, it } from 'vitest';
import { playerNames, property, setOption, setProperties } from '../src/core/sessions';
import { identityArgs, joinArgs } from '../src/core/launch';
import { derivePlayState } from '../src/renderer/session';
import { mergeLogs } from '../src/renderer/panels/ConsolePanel';
import type { InstanceInfo, LogLine } from '../src/shared/types';

describe('multiplayer test sessions', () => {
  it('sets server properties in place and keeps line endings', () => {
    const text = '#Minecraft server properties\r\nonline-mode=true\r\nmotd=Hi\r\n';
    expect(setProperties(text, [['online-mode', 'false'], ['server-port', '25566']])).toBe('#Minecraft server properties\r\nonline-mode=false\r\nmotd=Hi\r\nserver-port=25566\r\n');
    expect(setProperties('', [['online-mode', 'false']])).toBe('online-mode=false\n');
    expect(property('# server-port=1\nserver-port = 25570\n', 'server-port')).toBe('25570');
    expect(setOption('', 'onboardAccessibility', 'false')).toBe('onboardAccessibility:false\n');
    expect(setOption('version:3955\r\nonboardAccessibility:true\r\n', 'onboardAccessibility', 'false')).toBe('version:3955\r\nonboardAccessibility:false\r\n');
  });

  it('checks player names', () => {
    expect(playerNames(2)).toEqual(['Player1', 'Player2']);
    expect(playerNames(2, ['Steve', ''])).toEqual(['Steve', 'Player2']);
    expect(() => playerNames(0)).toThrow('between 1 and 4');
    expect(() => playerNames(5)).toThrow('between 1 and 4');
    expect(() => playerNames(1, ['no spaces'])).toThrow('Player name "no spaces" must be 3 to 16 letters, digits or underscores');
    expect(() => playerNames(2, ['Alex', 'alex'])).toThrow('Player name "alex" is used twice');
  });

  it('gives each client an offline identity and joins by version', () => {
    expect(identityArgs('Player')).toEqual(['--username', 'Player', '--uuid', 'a01e3843e5213998958af459800e4d11', '--accessToken', '0']);
    expect(joinArgs('1.21.1', '127.0.0.1', 25566)).toEqual(['--quickPlayMultiplayer', '127.0.0.1:25566']);
    expect(joinArgs('1.20', '127.0.0.1', 25565)).toEqual(['--quickPlayMultiplayer', '127.0.0.1:25565']);
    expect(joinArgs('1.19.4', '127.0.0.1', 25565)).toEqual(['--server', '127.0.0.1', '--port', '25565']);
  });
});

describe('multiplayer sessions in the interface', () => {
  const base = { workspace: 'W', mode: 'development', instanceDir: 'd', startedAt: 1, bridge: { connected: false }, logFile: 'l' } as const;
  const inst = (id: string, extra: Partial<InstanceInfo>): InstanceInfo => ({ ...base, id, profileId: 'dev-client', side: 'client', status: 'running', ...extra }) as InstanceInfo;

  it('keeps the first client of a session as the play target', () => {
    const instances = [inst('b', { session: 's', slot: 2, player: 'Player2' }), inst('a', { session: 's', slot: 1, player: 'Player1' })];
    expect(derivePlayState([], instances, 'W', 'dev-client').instance?.id).toBe('a');
  });

  it('merges the logs of a session in time order and tags each line', () => {
    const line = (seq: number, ts: number, text: string) => ({ seq, ts, stream: 'stdout', text }) as LogLine;
    const merged = mergeLogs([
      { src: 'Server', lines: [line(1, 10, 'starting'), line(2, 30, 'Player1 joined the game')] },
      { src: 'Player1', lines: [line(1, 20, 'Connecting'), line(2, 30, 'joined')] }
    ]);
    expect(merged.map((l) => `${l.src}:${l.text}`)).toEqual(['Server:starting', 'Player1:Connecting', 'Server:Player1 joined the game', 'Player1:joined']);
  });
});
