import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { downloadVerified, verifyFile } from '../src/core/http';
import { runProcess } from '../src/core/proc';
import { CancelledError } from '../src/core/operations';
import { parseLogLine, LogBuffer } from '../src/core/logs';
import { parseCrashReport, hypothesize } from '../src/core/crash';
import { applyOutcome, closure, type BisectState } from '../src/core/bisect';
import { tmpDir } from './helpers';

const body = crypto.randomBytes(256 * 1024);
const sha1 = crypto.createHash('sha1').update(body).digest('hex');
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/slow') {
      res.writeHead(200, { 'content-length': String(body.length) });
      res.write(body.subarray(0, 1000));
      return;
    }
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.closeAllConnections?.() ?? server.close());

describe('verified downloads', () => {
  it('downloads, verifies and reuses cached files', async () => {
    const dest = path.join(tmpDir(), 'a', 'mod.jar');
    expect((await downloadVerified({ url: `${base}/ok`, dest, sha1 })).cached).toBe(false);
    expect((await verifyFile(dest, { sha1 })).ok).toBe(true);
    expect((await downloadVerified({ url: `${base}/ok`, dest, sha1 })).cached).toBe(true);
  });

  it('rejects hash mismatches without leaving partial files', async () => {
    const dir = tmpDir();
    const dest = path.join(dir, 'bad.jar');
    await expect(downloadVerified({ url: `${base}/ok`, dest, sha1: '0'.repeat(40) })).rejects.toThrow(/Hash verification failed/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('refuses downloads without published hashes', async () => {
    await expect(downloadVerified({ url: `${base}/ok`, dest: path.join(tmpDir(), 'x.jar') })).rejects.toThrow(/without a published hash/);
  });

  it('cancels in-flight downloads and cleans up', async () => {
    const dir = tmpDir();
    const ac = new AbortController();
    const p = downloadVerified({ url: `${base}/slow`, dest: path.join(dir, 's.jar'), sha1, signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    expect(fs.readdirSync(dir).filter((f) => !f.endsWith('.part'))).toEqual([]);
  });
});

describe('process lifecycle', () => {
  it('streams output and returns the exit code', async () => {
    const lines: string[] = [];
    const r = await runProcess(process.execPath, ['-e', 'console.log("a");console.error("b");process.exit(3)'], { onLine: (l) => lines.push(l) });
    expect(r.code).toBe(3);
    expect(lines.sort()).toEqual(['a', 'b']);
  });

  it('kills the process tree on cancellation', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = runProcess(process.execPath, ['-e', 'require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});setInterval(()=>{},1000)'], { signal: ac.signal });
    setTimeout(() => ac.abort(), 400);
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    expect(Date.now() - t0).toBeLessThan(10000);
  });
});

describe('log and crash parsing', () => {
  it('parses Fabric development and vanilla log formats', () => {
    expect(parseLogLine('[16:37:41] [Render thread/INFO] (startertest) startertest initialized')).toMatchObject({ thread: 'Render thread', level: 'INFO', logger: 'startertest' });
    expect(parseLogLine('[12:00:01] [Server thread/WARN]: Can\'t keep up!')).toMatchObject({ level: 'WARN', thread: 'Server thread' });
    const b = new LogBuffer();
    b.push('stdout', '[16:00:00] [main/ERROR] (X) boom');
    const trace = b.push('stdout', '\tat a.b.C.d(C.java:1)');
    expect(trace.level).toBe('ERROR');
    expect(b.query({ levels: ['ERROR'] }).length).toBe(2);
  });

  it('separates crash report facts from hypotheses', () => {
    const report = `---- Minecraft Crash Report ----\nDescription: Initializing game\n\njava.lang.NoSuchMethodError: foo\n\tat a.b.C(C.java:1)\n\tat d.e.F(F.java:2)\n\nA detailed walkthrough\n-- System Details --\n\tMinecraft Version: 1.21.1\n\tJava Version: 21.0.2, Eclipse Adoptium\n`;
    const p = parseCrashReport(report);
    expect(p.description).toBe('Initializing game');
    expect(p.exception).toBe('java.lang.NoSuchMethodError: foo');
    expect(p.stackHead.length).toBe(2);
    expect(p.minecraftVersion).toBe('1.21.1');
    expect(hypothesize(report)[0].text).toMatch(/missing at runtime/);
  });
});

describe('dependency-aware bisection', () => {
  const units = [
    { key: 'a', title: 'A', requires: ['lib'] },
    { key: 'b', title: 'B', requires: [] },
    { key: 'c', title: 'C', requires: [] },
    { key: 'd', title: 'D', requires: [] },
    { key: 'lib', title: 'Lib', requires: [] }
  ];

  it('keeps required dependency groups together', () => {
    expect(closure(['a'], units).sort()).toEqual(['a', 'lib']);
  });

  it('narrows candidates to a single involved mod', () => {
    let s: BisectState = { profile: 'p', bisectProfile: 'p-bisect', predicate: 'user', units, candidates: ['a', 'b', 'c', 'd'], cleared: [], current: closure(['a', 'b'], units), attempts: [], skips: 0, done: false };
    s = applyOutcome(s, 'good');
    expect(s.candidates).toEqual(['c', 'd']);
    s = applyOutcome(s, 'bad');
    expect(s.done).toBe(true);
    expect(s.candidates).toEqual(['c']);
    expect(s.conclusion).toMatch(/evidence that it is involved, not proof/);
  });
});
