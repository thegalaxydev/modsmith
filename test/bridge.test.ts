import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { BridgeHost, constantTimeEqual } from '../src/core/bridge';
import { EventBus } from '../src/core/events';

const hosts: BridgeHost[] = [];

async function host() {
  const bus = new EventBus();
  const h = new BridgeHost(bus);
  await h.start();
  hosts.push(h);
  return { h, bus };
}

afterEach(async () => {
  while (hosts.length) await hosts.pop()!.stop();
});

function connect(url: string, headers: Record<string, string> = {}) {
  return new WebSocket(url, { headers });
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise((r) => ws.on('close', (code) => r(code)));
}

const game = { minecraft: '1.21.1', loader: 'fabric', loaderVersion: '0.19.5', side: 'client', bridgeVersion: '0.1.0', capabilities: ['registry.search'] };

describe('bridge authentication', () => {
  it('compares tokens in constant time', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });

  it('binds to loopback only', async () => {
    const { h } = await host();
    expect(h.url()).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/bridge$/);
  });

  it('rejects a wrong token', async () => {
    const { h } = await host();
    const s = h.createSession('inst');
    const ws = connect(h.url());
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: 1, session: s.id, token: 'x'.repeat(43), game })));
    expect(await closed(ws)).toBe(4004);
    expect(h.status('inst').connected).toBe(false);
  });

  it('rejects malformed hello messages and browser origins', async () => {
    const { h } = await host();
    const ws = connect(h.url());
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: 1 })));
    expect(await closed(ws)).toBe(4003);
    const browser = connect(h.url(), { Origin: 'https://evil.example' });
    const err = await new Promise((r) => browser.on('error', r));
    expect(err).toBeTruthy();
  });

  it('rejects protocol mismatches', async () => {
    const { h } = await host();
    const s = h.createSession('inst');
    const ws = connect(h.url());
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: 99, session: s.id, token: s.token, game })));
    expect(await closed(ws)).toBe(4005);
  });

  it('authenticates, round-trips calls and enforces advertised capabilities', async () => {
    const { h, bus } = await host();
    const s = h.createSession('inst');
    const events: string[] = [];
    bus.on((e) => events.push(e));
    const ws = connect(h.url());
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'request') ws.send(JSON.stringify({ type: 'response', id: m.id, ok: true, result: { echo: m.params.query } }));
    });
    await new Promise<void>((r) => ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', protocol: 1, session: s.id, token: s.token, game }));
      r();
    }));
    await new Promise((r) => setTimeout(r, 100));
    expect(h.status('inst').connected).toBe(true);
    expect(events).toContain('bridge.connected');
    expect(await h.call('inst', 'registry.search', { query: 'diamond' })).toEqual({ echo: 'diamond' });
    await expect(h.call('inst', 'world.give_item', {})).rejects.toThrow(/not supported/);
    expect(await h.call('inst', 'ext.galaxy.sample.ping', { query: 'late' })).toEqual({ echo: 'late' });
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(h.status('inst').connected).toBe(false);
  });

  it('times out unanswered calls', async () => {
    const { h } = await host();
    const s = h.createSession('inst');
    const ws = connect(h.url());
    await new Promise<void>((r) => ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', protocol: 1, session: s.id, token: s.token, game: { ...game, capabilities: [] } }));
      r();
    }));
    await new Promise((r) => setTimeout(r, 100));
    await expect(h.call('inst', 'anything', {}, 200)).rejects.toThrow(/timed out/);
    ws.close();
  });
});
