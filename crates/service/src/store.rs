use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Mutex;

const MIGRATIONS: [&str; 1] = ["CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS recent_workspaces (path TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, opened_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS trusted_workspaces (path TEXT PRIMARY KEY, trusted_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, action TEXT NOT NULL, params TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, workspace TEXT, status TEXT NOT NULL, message TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, error TEXT, result TEXT);
   CREATE TABLE IF NOT EXISTS launches (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, profile TEXT NOT NULL, side TEXT NOT NULL, mode TEXT NOT NULL, pid INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER, exit_code INTEGER, status TEXT NOT NULL, log_file TEXT NOT NULL, crash_report TEXT);
   CREATE TABLE IF NOT EXISTS http_cache (url TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, body TEXT NOT NULL);"];

pub struct Store {
    db: Mutex<Connection>,
}

fn now() -> i64 {
    crate::support::now_ms() as i64
}

impl Store {
    pub fn open(file: &Path) -> rusqlite::Result<Store> {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let db = Connection::open(file)?;
        db.execute_batch("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")?;
        let row: Option<i64> = db.query_row("SELECT version FROM schema_version", [], |r| r.get(0)).optional()?;
        let mut version = row.unwrap_or(0) as usize;
        if row.is_none() {
            db.execute("INSERT INTO schema_version (version) VALUES (0)", [])?;
        }
        while version < MIGRATIONS.len() {
            db.execute_batch(MIGRATIONS[version])?;
            version += 1;
            db.execute("UPDATE schema_version SET version = ?", [version as i64])?;
        }
        Ok(Store { db: Mutex::new(db) })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn add_activity(&self, source: &str, action: &str, params: &str, status: &str, summary: &str) -> rusqlite::Result<Value> {
        let ts = now();
        let db = self.conn();
        db.execute("INSERT INTO activity (ts, source, action, params, status, summary) VALUES (?, ?, ?, ?, ?, ?)", params![ts, source, action, params, status, summary])?;
        let id = db.last_insert_rowid();
        Ok(json!({ "id": id, "ts": ts, "source": source, "action": action, "params": params, "status": status, "summary": summary }))
    }

    pub fn list_activity(&self, limit: i64, source: Option<&str>) -> rusqlite::Result<Value> {
        let db = self.conn();
        let map = |r: &rusqlite::Row| -> rusqlite::Result<Value> {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "ts": r.get::<_, i64>(1)?,
                "source": r.get::<_, String>(2)?,
                "action": r.get::<_, String>(3)?,
                "params": r.get::<_, String>(4)?,
                "status": r.get::<_, String>(5)?,
                "summary": r.get::<_, String>(6)?
            }))
        };
        let cols = "SELECT id, ts, source, action, params, status, summary FROM activity";
        let rows: Vec<Value> = match source {
            Some(s) => db.prepare(&format!("{cols} WHERE source = ? ORDER BY id DESC LIMIT ?"))?.query_map(params![s, limit], map)?.collect::<Result<_, _>>()?,
            None => db.prepare(&format!("{cols} ORDER BY id DESC LIMIT ?"))?.query_map(params![limit], map)?.collect::<Result<_, _>>()?,
        };
        Ok(Value::Array(rows))
    }

    pub fn is_trusted(&self, path: &str) -> rusqlite::Result<bool> {
        self.conn().query_row("SELECT 1 FROM trusted_workspaces WHERE path = ?", [path], |_| Ok(())).optional().map(|r| r.is_some())
    }

    pub fn add_recent(&self, path: &str, name: &str, kind: &str) -> rusqlite::Result<()> {
        self.conn()
            .execute("INSERT INTO recent_workspaces (path, name, type, opened_at) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET name = excluded.name, type = excluded.type, opened_at = excluded.opened_at", params![path, name, kind, now()])
            .map(|_| ())
    }

    pub fn save_operation(&self, op: &Value) -> rusqlite::Result<()> {
        let text = |k: &str| op.get(k).filter(|v| !v.is_null()).map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()));
        let result = op.get("result").map(|v| v.to_string());
        self.conn()
            .execute(
                "INSERT INTO operations (id, kind, title, workspace, status, message, started_at, ended_at, error, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, message = excluded.message, ended_at = excluded.ended_at, error = excluded.error, result = excluded.result",
                params![
                    text("id"),
                    text("kind"),
                    text("title"),
                    text("workspace"),
                    text("status"),
                    text("message"),
                    op["startedAt"].as_i64(),
                    op.get("endedAt").and_then(Value::as_i64),
                    text("error"),
                    result
                ],
            )
            .map(|_| ())
    }

    pub fn get_http_cache(&self, url: &str) -> rusqlite::Result<Option<(i64, String)>> {
        self.conn().query_row("SELECT fetched_at, body FROM http_cache WHERE url = ?", [url], |r| Ok((r.get(0)?, r.get(1)?))).optional()
    }

    pub fn set_http_cache(&self, url: &str, body: &str) -> rusqlite::Result<()> {
        self.conn().execute("INSERT OR REPLACE INTO http_cache (url, fetched_at, body) VALUES (?, ?, ?)", params![url, now(), body]).map(|_| ())
    }

    pub fn list_recent(&self) -> rusqlite::Result<Vec<(String, String, String, i64)>> {
        let db = self.conn();
        let mut stmt = db.prepare("SELECT path, name, type, opened_at FROM recent_workspaces ORDER BY opened_at DESC LIMIT 30")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect();
        rows
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_schema_and_round_trips_activity() {
        let dir = std::env::temp_dir().join(format!("modsmith-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::open(&dir.join("workbench.sqlite")).unwrap();
        let a = store.add_activity("mcp", "workspace.trust", "{}", "ok", "{path}").unwrap();
        store.add_activity("ui", "java.add", "{}", "error", "bad").unwrap();
        let all = store.list_activity(10, None).unwrap();
        assert_eq!(all.as_array().unwrap().len(), 2);
        assert_eq!(all[0]["action"], "java.add");
        let mcp = store.list_activity(10, Some("mcp")).unwrap();
        assert_eq!(mcp[0]["id"], a["id"]);
        drop(store);
        let again = Store::open(&dir.join("workbench.sqlite")).unwrap();
        assert_eq!(again.list_activity(10, None).unwrap().as_array().unwrap().len(), 2);
    }
}
