import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { serviceBinary } from './service';
import { tmpDir } from './helpers';

class Session {
  private buf = '';
  private seen = new Map<number, unknown>();
  private next = 1;
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        const m = JSON.parse(line) as { id?: number };
        if (m.id !== undefined) this.seen.set(m.id, m);
      }
    });
  }
  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.next++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    for (let i = 0; i < 600 && !this.seen.has(id); i++) await new Promise((r) => setTimeout(r, 50));
    return this.seen.get(id) ?? null;
  }
  notify(method: string) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  }
}

describe.runIf(!!serviceBinary)('the Rust MCP server matches the Node MCP server', () => {
  const root = path.resolve(__dirname, '..');
  const env = { ...process.env, MODSMITH_DATA_DIR: path.join(tmpDir('mwb-mcp-'), 'data'), MODSMITH_SERVICE_BIN: serviceBinary! };
  let node: Session;
  let rust: Session;

  beforeAll(() => {
    node = new Session(spawn(process.execPath, [path.join(root, 'dist', 'mcp', 'main.cjs')], { env }));
    rust = new Session(spawn(serviceBinary!, ['mcp'], { env }));
  });
  afterAll(() => {
    node.child.kill();
    rust.child.kill();
    spawnSync(serviceBinary!, ['cli', 'service', 'stop'], { env });
  });

  const probes: [string, unknown][] = [
    ['initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } }],
    ['initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'probe', version: '1' } }],
    ['tools/list', {}],
    ['resources/list', {}],
    ['resources/templates/list', {}],
    ['prompts/list', {}],
    ['ping', {}],
    ['nonsense/method', {}],
    ['tools/call', { name: 'registry_search', arguments: { limit: 'many' } }],
    ['tools/call', { name: 'no_such_tool', arguments: {} }],
    ['tools/call', { name: 'workspace_inspect' }],
    ['tools/call', { name: 'catalog_list', arguments: {} }],
    ['tools/call', { name: 'workspace_inspect', arguments: { path: path.join(root, 'no-such-folder') } }],
    ['tools/call', { name: 'instance_status', arguments: { id: 'nope' } }],
    ['tools/call', { name: 'operation_wait', arguments: { id: 'nope', timeoutMs: 10 } }],
    ['tools/call', { name: 'project_validate_create', arguments: { input: { projectName: '', destination: 'x', modId: 'A', packageName: 'a', license: 'MIT', git: false, catalogEntryId: 'fabric-1.21.1', environment: 'both', starters: [], dependencies: [] } } }],
    ['resources/read', { uri: 'modsmith://capabilities' }],
    ['resources/read', { uri: `modsmith://workspace/${encodeURIComponent(root)}/manifest` }],
    ['resources/read', { uri: 'modsmith://bogus' }]
  ];

  it('answers every probe identically', async () => {
    for (const [method, params] of probes) {
      const n = await node.request(method, params);
      const r = await rust.request(method, params);
      expect(r, `${method} ${JSON.stringify(params)}`).toEqual(n);
      expect(JSON.stringify(r)).toBe(JSON.stringify(n));
      if (method === 'initialize') {
        node.notify('notifications/initialized');
        rust.notify('notifications/initialized');
      }
    }
  }, 120000);

  it('runs CLI commands with the same output and exit codes as the Node CLI', () => {
    const ws = tmpDir('mwb-cli-');
    fs.writeFileSync(path.join(ws, 'settings.gradle'), '');
    const commands = [
      [],
      ['help'],
      ['methods'],
      ['nonsense'],
      ['java'],
      ['open', ws],
      ['trust', ws],
      ['trust', ws, '--revoke'],
      ['instances'],
      ['logs', 'nope'],
      ['stop', 'nope', '--force'],
      ['call', 'catalog.list'],
      ['call', 'bogus.method'],
      ['call', 'workspace.inspect', JSON.stringify({ path: ws })],
      ['call', 'instance.status', '{}'],
      ['mcp', 'config'],
      ['service', 'start']
    ];
    const norm = (t: string) => t.replace(/"pid": \d+/g, '"pid": 0');
    for (const args of commands) {
      const n = spawnSync(process.execPath, [path.join(root, 'dist', 'cli', 'main.cjs'), ...args], { env, encoding: 'utf8' });
      const r = spawnSync(serviceBinary!, ['cli', ...args], { env, encoding: 'utf8' });
      expect({ code: r.status, out: norm(r.stdout), err: r.stderr }, args.join(' ')).toEqual({ code: n.status, out: norm(n.stdout), err: n.stderr });
    }
    const status = spawnSync(serviceBinary!, ['cli', 'service', 'status'], { env, encoding: 'utf8' });
    expect(JSON.parse(status.stdout)).toMatchObject({ running: true, token: '[redacted]' });
    const cfg = spawnSync(serviceBinary!, ['cli', 'mcp', 'config'], { env, encoding: 'utf8' }).stdout;
    expect(cfg).toContain('"mcp"');
  }, 120000);
});
