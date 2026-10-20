use crate::paths;
use crate::support::Log;
use serde::Deserialize;
use serde_json::value::RawValue;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

pub type Reply = Box<dyn FnOnce(WorkerResult) + Send>;

pub struct WorkerResult {
    pub ok: bool,
    pub result: Option<Box<RawValue>>,
    pub error: Option<String>,
}

pub enum WorkerEvent {
    Event(String),
    Shutdown(bool),
}

pub struct Ready {
    pub pid: u32,
    pub bridge_port: u16,
    pub runtime: String,
}

pub struct Worker {
    stdin: mpsc::UnboundedSender<String>,
    pending: Mutex<HashMap<u64, Reply>>,
    next: AtomicU64,
}

#[derive(Deserialize)]
struct Incoming<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    id: Option<u64>,
    ok: Option<bool>,
    #[serde(borrow)]
    result: Option<&'a RawValue>,
    error: Option<String>,
    #[serde(rename = "stopInstances")]
    stop_instances: Option<bool>,
    pid: Option<u32>,
    #[serde(rename = "bridgePort")]
    bridge_port: Option<u16>,
    runtime: Option<String>,
}

pub fn locate_node() -> PathBuf {
    if let Some(p) = std::env::var_os("MODSMITH_NODE").filter(|v| !v.is_empty()) {
        return PathBuf::from(p);
    }
    let exe = paths::exe_dir();
    let bundled = exe.join(if cfg!(windows) { "node.exe" } else { "node" });
    if bundled.exists() {
        return bundled;
    }
    if let Some(dev) = paths::find_upwards(&exe, &["src-tauri", "binaries", "node-x86_64-pc-windows-msvc.exe"], 6) {
        return dev;
    }
    PathBuf::from("node")
}

pub fn locate_script() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("MODSMITH_WORKER_SCRIPT").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(p));
    }
    let exe = paths::exe_dir();
    let bundled = exe.join("app").join("dist").join("worker").join("main.cjs");
    if bundled.exists() {
        return Some(bundled);
    }
    paths::find_upwards(&exe, &["dist", "worker", "main.cjs"], 6)
}

impl Worker {
    pub async fn spawn(log: Arc<Log>, node: PathBuf, script: PathBuf, events: mpsc::UnboundedSender<WorkerEvent>) -> Result<(Arc<Worker>, Child, Ready), String> {
        let mut cmd = Command::new(&node);
        cmd.arg(&script).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(false);
        #[cfg(windows)]
        {
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            cmd.creation_flags(DETACHED_PROCESS);
        }
        let mut child = cmd.spawn().map_err(|e| format!("could not start worker {} {}: {e}", node.display(), script.display()))?;
        let mut stdin = child.stdin.take().ok_or("worker stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("worker stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("worker stderr unavailable")?;
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(mut line) = rx.recv().await {
                line.push('\n');
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
            }
        });
        let err_log = log.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                err_log.write(&format!("worker stderr: {line}"));
            }
        });
        let worker = Arc::new(Worker { stdin: tx, pending: Mutex::new(HashMap::new()), next: AtomicU64::new(1) });
        let (ready_tx, ready_rx) = oneshot::channel::<Ready>();
        let reader = worker.clone();
        tokio::spawn(async move {
            let mut ready_tx = Some(ready_tx);
            let mut lines = BufReader::with_capacity(1 << 16, stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Incoming>(&line) else {
                    log.write(&format!("worker sent an unreadable line: {}", line.chars().take(200).collect::<String>()));
                    continue;
                };
                match msg.kind {
                    "result" => {
                        let reply = msg.id.and_then(|id| reader.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id));
                        if let Some(reply) = reply {
                            reply(WorkerResult { ok: msg.ok == Some(true), result: msg.result.map(RawValue::to_owned), error: msg.error });
                        }
                    }
                    "event" => {
                        let _ = events.send(WorkerEvent::Event(line));
                    }
                    "shutdown" => {
                        let _ = events.send(WorkerEvent::Shutdown(msg.stop_instances == Some(true)));
                    }
                    "ready" => {
                        if let Some(tx) = ready_tx.take() {
                            let _ = tx.send(Ready { pid: msg.pid.unwrap_or(0), bridge_port: msg.bridge_port.unwrap_or(0), runtime: msg.runtime.unwrap_or_default() });
                        }
                    }
                    _ => {}
                }
            }
            let pending: Vec<Reply> = reader.pending.lock().unwrap_or_else(|e| e.into_inner()).drain().map(|(_, r)| r).collect();
            for reply in pending {
                reply(WorkerResult { ok: false, result: None, error: Some("Service worker stopped".into()) });
            }
        });
        let ready = tokio::time::timeout(std::time::Duration::from_secs(120), ready_rx)
            .await
            .map_err(|_| "worker did not become ready".to_string())?
            .map_err(|_| "worker exited during start-up".to_string())?;
        Ok((worker, child, ready))
    }

    pub fn call(&self, method: &str, params: Option<&RawValue>, source: &str, record: bool, reply: Reply) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id, reply);
        let params = params.map(RawValue::get).unwrap_or("{}");
        let line = format!(
            "{{\"type\":\"call\",\"id\":{id},\"method\":{},\"params\":{params},\"source\":{},\"record\":{record}}}",
            serde_json::to_string(method).unwrap_or_default(),
            serde_json::to_string(source).unwrap_or_default()
        );
        if self.stdin.send(line).is_err() {
            if let Some(reply) = self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
                reply(WorkerResult { ok: false, result: None, error: Some("Service worker stopped".into()) });
            }
        }
    }

    pub fn send_clients(&self, counts: &str) {
        let _ = self.stdin.send(format!("{{\"type\":\"clients\",\"counts\":{counts}}}"));
    }

    pub fn invalidate(&self, what: &str) {
        let _ = self.stdin.send(format!("{{\"type\":\"invalidate\",\"what\":{}}}", serde_json::to_string(what).unwrap_or_default()));
    }

    pub fn stop(&self, stop_instances: bool) {
        let _ = self.stdin.send(format!("{{\"type\":\"stop\",\"stopInstances\":{stop_instances}}}"));
    }
}
