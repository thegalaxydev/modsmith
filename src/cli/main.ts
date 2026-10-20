import fs from 'node:fs';
import path from 'node:path';
import { PRODUCT } from '../shared/product';
import { API } from '../shared/api';
import { connectService, readServiceFile } from '../client/connect';
import type { RpcClient } from '../shared/rpc-client';
import type { OperationInfo } from '../shared/types';

const HELP = `${PRODUCT.name} CLI

Usage:
  ${PRODUCT.id} service start|stop|status
  ${PRODUCT.id} call <method> [json-params]        Call any service method (see "methods")
  ${PRODUCT.id} methods                           List service methods
  ${PRODUCT.id} java                              List Java installations
  ${PRODUCT.id} create <dir> --name <n> [--modid <id>] [--package <pkg>] [--starters a,b] [--no-build] [--git]
  ${PRODUCT.id} open <dir>                        Inspect a workspace (no Gradle execution)
  ${PRODUCT.id} trust <dir>                       Trust a workspace so Gradle may run
  ${PRODUCT.id} build <dir> [--clean]
  ${PRODUCT.id} launch <dir> [--profile dev-client] [--mode development|production]
  ${PRODUCT.id} stop <instance-id> [--force]
  ${PRODUCT.id} instances
  ${PRODUCT.id} logs <instance-id> [--tail 100]
  ${PRODUCT.id} search <query> [--mc 1.21.1] [--loader fabric]
  ${PRODUCT.id} add-mod <dir> <modrinth-slug> [--profile dev-client] [--compile]
  ${PRODUCT.id} mcp config                        Print MCP client configuration
`;

function flags(argv: string[]): { pos: string[]; f: Record<string, string | boolean> } {
  const pos: string[] = [];
  const f: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key.startsWith('no-')) f[key.slice(3)] = false;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) f[key] = argv[++i];
      else f[key] = true;
    } else pos.push(a);
  }
  return { pos, f };
}

async function waitOp(c: RpcClient, op: OperationInfo): Promise<OperationInfo> {
  let shown = 0;
  for (;;) {
    const cur = await c.call<OperationInfo>('operation.wait', { id: op.id, timeoutMs: 1000 });
    const log = await c.call<{ lines: string[] }>('operation.log', { id: op.id });
    for (const l of log.lines.slice(shown)) console.log(l);
    shown = log.lines.length;
    if (cur.status !== 'running') {
      if (cur.status === 'failed') console.error(`FAILED: ${cur.error}`);
      return cur;
    }
  }
}

function out(v: unknown) {
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
}

async function main() {
  const argv = process.argv.slice(2);
  const { pos, f } = flags(argv);
  const cmd = pos[0];
  if (!cmd || cmd === 'help' || f.help) {
    console.log(HELP);
    return;
  }
  if (cmd === 'service' && pos[1] === 'status') {
    out(readServiceFile() ? { running: true, ...readServiceFile(), token: '[redacted]' } : { running: false });
    return;
  }
  if (cmd === 'methods') {
    for (const [k, d] of Object.entries(API)) console.log(`${k.padEnd(28)} ${d.description}`);
    return;
  }
  const c = await connectService('cli', { autoStart: !(cmd === 'service' && pos[1] === 'stop') });
  try {
    switch (cmd) {
      case 'service':
        if (pos[1] === 'stop') out(await c.call('service.shutdown', { stopInstances: !!f['stop-instances'] }));
        else out(c.serverInfo);
        break;
      case 'call': {
        const params = pos[2] ? JSON.parse(pos[2]) : {};
        const r = await c.call<OperationInfo>(pos[1], params);
        if (r && typeof r === 'object' && 'kind' in r && 'status' in r && r.status === 'running' && f.wait !== false) out(await waitOp(c, r));
        else out(r);
        break;
      }
      case 'java':
        for (const j of await c.call<{ version: string; vendor: string; home: string; isJdk: boolean }[]>('java.list', { refresh: !!f.refresh })) console.log(`${j.isJdk ? 'JDK' : 'JRE'} ${j.version.padEnd(12)} ${j.vendor.padEnd(24)} ${j.home}`);
        break;
      case 'create': {
        const dest = path.resolve(pos[1]);
        const name = String(f.name ?? path.basename(dest));
        const modId = String(f.modid ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''));
        const op = await c.call<OperationInfo>('project.create', {
          projectName: name,
          destination: dest,
          modId,
          packageName: String(f.package ?? `com.example.${modId}`),
          author: String(f.author ?? ''),
          description: String(f.description ?? ''),
          license: String(f.license ?? 'MIT'),
          git: !!f.git,
          catalogEntryId: String(f.entry ?? 'fabric-1.21.1'),
          starters: String(f.starters ?? 'empty,bridge,profiles').split(','),
          runInitialBuild: f.build !== false
        });
        const done = await waitOp(c, op);
        process.exitCode = done.status === 'succeeded' ? 0 : 1;
        break;
      }
      case 'open':
        out(await c.call('workspace.open', { path: path.resolve(pos[1]) }));
        break;
      case 'trust':
        out(await c.call('workspace.trust', { path: path.resolve(pos[1]), trusted: f.revoke ? false : true }));
        break;
      case 'build': {
        const done = await waitOp(c, await c.call<OperationInfo>('project.build', { path: path.resolve(pos[1]), clean: !!f.clean }));
        process.exitCode = done.status === 'succeeded' ? 0 : 1;
        break;
      }
      case 'launch': {
        const done = await waitOp(c, await c.call<OperationInfo>('instance.launch', { path: path.resolve(pos[1]), profile: String(f.profile ?? 'dev-client'), mode: f.mode }));
        out(done.result ?? done.error);
        process.exitCode = done.status === 'succeeded' ? 0 : 1;
        break;
      }
      case 'stop':
        out(await c.call('instance.stop', { id: pos[1], force: !!f.force }));
        break;
      case 'instances':
        out(await c.call('instance.list', {}));
        break;
      case 'logs': {
        const r = await c.call<{ lines: { text: string }[] }>('logs.read', { id: pos[1], limit: Number(f.tail ?? 100) });
        r.lines.forEach((l) => console.log(l.text));
        break;
      }
      case 'search': {
        const r = await c.call<{ hits: { slug: string; title: string; downloads: number; id: string }[] }>('dependency.search', { query: pos.slice(1).join(' '), minecraft: f.mc, loader: f.loader ?? 'fabric', limit: 15 });
        r.hits.forEach((h) => console.log(`${h.id}  ${h.slug.padEnd(28)} ${h.title} (${h.downloads} downloads)`));
        break;
      }
      case 'add-mod':
        out(await c.call('dependency.add', { path: path.resolve(pos[1]), profile: f.project ? undefined : String(f.profile ?? 'dev-client'), ref: { source: 'modrinth', projectId: pos[2], usage: f.compile ? 'compile' : 'runtime' } }));
        break;
      case 'mcp':
        if (pos[1] === 'config') {
          const cfg = await c.call<{ config: unknown; claudeCodeCommand: string }>('mcp.config', {});
          out(cfg.config);
          console.log('\nClaude Code:\n' + cfg.claudeCodeCommand);
          if (f.write) {
            fs.writeFileSync(String(f.write), JSON.stringify(cfg.config, null, 2));
            console.log(`\nWritten to ${f.write}`);
          }
        }
        break;
      default:
        console.error(`Unknown command ${cmd}\n`);
        console.log(HELP);
        process.exitCode = 2;
    }
  } finally {
    c.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
