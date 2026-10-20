import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { ActivityEntry, ActivitySource } from '../shared/types';

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS recent_workspaces (path TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, opened_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS trusted_workspaces (path TEXT PRIMARY KEY, trusted_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, action TEXT NOT NULL, params TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, workspace TEXT, status TEXT NOT NULL, message TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, error TEXT, result TEXT);
   CREATE TABLE IF NOT EXISTS launches (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, profile TEXT NOT NULL, side TEXT NOT NULL, mode TEXT NOT NULL, pid INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER, exit_code INTEGER, status TEXT NOT NULL, log_file TEXT NOT NULL, crash_report TEXT);
   CREATE TABLE IF NOT EXISTS http_cache (url TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, body TEXT NOT NULL);`
];

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
    let version = row?.version ?? 0;
    if (!row) this.db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
    while (version < MIGRATIONS.length) {
      this.db.exec(MIGRATIONS[version]);
      version++;
      this.db.prepare('UPDATE schema_version SET version = ?').run(version);
    }
  }

  getKv<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setKv(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, JSON.stringify(value), Date.now());
  }

  addRecent(p: string, name: string, type: string): void {
    this.db.prepare('INSERT INTO recent_workspaces (path, name, type, opened_at) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET name = excluded.name, type = excluded.type, opened_at = excluded.opened_at').run(p, name, type, Date.now());
  }

  removeRecent(p: string): void {
    this.db.prepare('DELETE FROM recent_workspaces WHERE path = ?').run(p);
  }

  listRecent(): { path: string; name: string; type: string; openedAt: number }[] {
    return (this.db.prepare('SELECT path, name, type, opened_at FROM recent_workspaces ORDER BY opened_at DESC LIMIT 30').all() as { path: string; name: string; type: string; opened_at: number }[]).map((r) => ({ path: r.path, name: r.name, type: r.type, openedAt: r.opened_at }));
  }

  isTrusted(p: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM trusted_workspaces WHERE path = ?').get(p);
  }

  setTrusted(p: string, trusted: boolean): void {
    if (trusted) this.db.prepare('INSERT OR REPLACE INTO trusted_workspaces (path, trusted_at) VALUES (?, ?)').run(p, Date.now());
    else this.db.prepare('DELETE FROM trusted_workspaces WHERE path = ?').run(p);
  }

  addActivity(source: ActivitySource, action: string, params: string, status: 'ok' | 'error', summary: string): ActivityEntry {
    const ts = Date.now();
    const res = this.db.prepare('INSERT INTO activity (ts, source, action, params, status, summary) VALUES (?, ?, ?, ?, ?, ?)').run(ts, source, action, params, status, summary);
    return { id: Number(res.lastInsertRowid), ts, source, action, params, status, summary };
  }

  listActivity(limit = 200, source?: string): ActivityEntry[] {
    const rows = source
      ? this.db.prepare('SELECT * FROM activity WHERE source = ? ORDER BY id DESC LIMIT ?').all(source, limit)
      : this.db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit);
    return rows as unknown as ActivityEntry[];
  }

  saveOperation(op: { id: string; kind: string; title: string; workspace?: string; status: string; message: string; startedAt: number; endedAt?: number; error?: string; result?: unknown }): void {
    this.db.prepare(`INSERT INTO operations (id, kind, title, workspace, status, message, started_at, ended_at, error, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, message = excluded.message, ended_at = excluded.ended_at, error = excluded.error, result = excluded.result`).run(
      op.id, op.kind, op.title, op.workspace ?? null, op.status, op.message, op.startedAt, op.endedAt ?? null, op.error ?? null, op.result === undefined ? null : JSON.stringify(op.result)
    );
  }

  listOperations(limit = 50): unknown[] {
    return this.db.prepare('SELECT * FROM operations ORDER BY started_at DESC LIMIT ?').all(limit);
  }

  saveLaunch(l: { id: string; workspace: string; profile: string; side: string; mode: string; pid?: number; startedAt: number; endedAt?: number; exitCode?: number | null; status: string; logFile: string; crashReport?: string }): void {
    this.db.prepare(`INSERT INTO launches (id, workspace, profile, side, mode, pid, started_at, ended_at, exit_code, status, log_file, crash_report) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, ended_at = excluded.ended_at, exit_code = excluded.exit_code, status = excluded.status, crash_report = excluded.crash_report`).run(
      l.id, l.workspace, l.profile, l.side, l.mode, l.pid ?? null, l.startedAt, l.endedAt ?? null, l.exitCode ?? null, l.status, l.logFile, l.crashReport ?? null
    );
  }

  listLaunches(workspace?: string, limit = 50): unknown[] {
    return workspace
      ? this.db.prepare('SELECT * FROM launches WHERE workspace = ? ORDER BY started_at DESC LIMIT ?').all(workspace, limit)
      : this.db.prepare('SELECT * FROM launches ORDER BY started_at DESC LIMIT ?').all(limit);
  }

  getHttpCache(url: string): { fetchedAt: number; body: string } | undefined {
    const row = this.db.prepare('SELECT fetched_at, body FROM http_cache WHERE url = ?').get(url) as { fetched_at: number; body: string } | undefined;
    return row ? { fetchedAt: row.fetched_at, body: row.body } : undefined;
  }

  setHttpCache(url: string, body: string): void {
    this.db.prepare('INSERT OR REPLACE INTO http_cache (url, fetched_at, body) VALUES (?, ?, ?)').run(url, Date.now(), body);
  }

  close(): void {
    this.db.close();
  }
}
