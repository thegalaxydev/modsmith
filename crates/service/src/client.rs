use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>;

pub struct RpcClient {
    writer: Arc<Mutex<WebSocket<MaybeTlsStream<TcpStream>>>>,
    pending: Pending,
    next: AtomicU64,
    closed: Arc<AtomicBool>,
    pub server_info: Value,
}

pub fn read_service_file() -> Option<Value> {
    let text = std::fs::read_to_string(crate::paths::resolve().service_file()).ok()?;
    serde_json::from_str(&text).ok()
}

fn connect_once(kind: &str, events: bool) -> Option<RpcClient> {
    let sf = read_service_file()?;
    let pid = sf["pid"].as_u64()? as u32;
    if !crate::support::pid_alive(pid) {
        return None;
    }
    let port = sf["port"].as_u64()?;
    let token = sf["token"].as_str()?.to_string();
    let stream = TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().ok()?, Duration::from_secs(4)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(4))).ok()?;
    let _ = stream.set_nodelay(true);
    let (mut ws, _) = tungstenite::client(format!("ws://127.0.0.1:{port}/rpc"), MaybeTlsStream::Plain(stream)).ok()?;
    ws.send(Message::text(json!({ "type": "auth", "token": token, "client": kind, "events": events, "protocol": 1 }).to_string())).ok()?;
    let ready = loop {
        match ws.read().ok()? {
            Message::Text(t) => {
                let v: Value = serde_json::from_str(&t).ok()?;
                if v["type"] == "ready" {
                    break v;
                }
            }
            Message::Close(_) => return None,
            _ => {}
        }
    };
    if let MaybeTlsStream::Plain(s) = ws.get_mut() {
        let _ = s.set_read_timeout(Some(Duration::from_millis(50)));
    }
    let writer = Arc::new(Mutex::new(ws));
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let closed = Arc::new(AtomicBool::new(false));
    let (w, p, c) = (writer.clone(), pending.clone(), closed.clone());
    std::thread::spawn(move || {
        loop {
            let msg = {
                let mut ws = w.lock().unwrap_or_else(|e| e.into_inner());
                ws.read()
            };
            match msg {
                Ok(Message::Text(t)) => {
                    let Ok(v) = serde_json::from_str::<Value>(&t) else { continue };
                    if v["type"] != "result" {
                        continue;
                    }
                    let Some(id) = v["id"].as_u64() else { continue };
                    if let Some(tx) = p.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
                        let r = if v["ok"] == true { Ok(v.get("result").cloned().unwrap_or(Value::Null)) } else { Err(v["error"].as_str().unwrap_or("Unknown error").to_string()) };
                        let _ = tx.send(r);
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => {}
                Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => break,
            }
            if c.load(Ordering::SeqCst) {
                break;
            }
        }
        c.store(true, Ordering::SeqCst);
        for (_, tx) in p.lock().unwrap_or_else(|e| e.into_inner()).drain() {
            let _ = tx.send(Err("Service connection closed".into()));
        }
    });
    Some(RpcClient { writer, pending, next: AtomicU64::new(1), closed, server_info: ready["server"].clone() })
}

pub fn spawn_service() {
    let Ok(exe) = std::env::current_exe() else { return };
    let mut cmd = std::process::Command::new(exe);
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    let _ = cmd.spawn();
}

pub fn connect(kind: &str, events: bool, auto_start: bool) -> Result<RpcClient, String> {
    if let Some(c) = connect_once(kind, events) {
        return Ok(c);
    }
    if !auto_start {
        return Err("The Modsmith service is not running".into());
    }
    spawn_service();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(300));
        if let Some(c) = connect_once(kind, events) {
            return Ok(c);
        }
    }
    Err(format!("The Modsmith service did not start; see {}", crate::paths::resolve().log_file().display()))
}

impl RpcClient {
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    pub fn call(&self, method: &str, params: &Value) -> Result<Value, String> {
        if self.is_closed() {
            return Err("Not connected to the Modsmith service".into());
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
        let msg = json!({ "type": "call", "id": id, "method": method, "params": params }).to_string();
        let sent = self.writer.lock().unwrap_or_else(|e| e.into_inner()).send(Message::text(msg));
        if sent.is_err() {
            self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            self.closed.store(true, Ordering::SeqCst);
            return Err("Service connection closed".into());
        }
        rx.recv().unwrap_or_else(|_| Err("Service connection closed".into()))
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let _ = self.writer.lock().unwrap_or_else(|e| e.into_inner()).close(None);
    }
}
