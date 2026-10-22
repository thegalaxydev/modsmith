use serde::Deserialize;
use serde_json::{json, Value};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tungstenite::{Message, WebSocket};

#[derive(Deserialize, Clone)]
pub struct ServiceFile {
    pub pid: u32,
    pub port: u16,
    pub token: String,
    #[serde(default)]
    pub version: String,
}

pub fn data_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("MODSMITH_DATA_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default();
    if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData").join("Roaming")).join("Modsmith")
    } else if cfg!(target_os = "macos") {
        home.join("Library").join("Application Support").join("Modsmith")
    } else {
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".config")).join("modsmith")
    }
}

pub fn read_service_file() -> Option<ServiceFile> {
    let text = std::fs::read_to_string(data_dir().join("service.json")).ok()?;
    serde_json::from_str(&text).ok()
}

pub struct Rpc {
    ws: WebSocket<TcpStream>,
    next: u64,
}

impl Rpc {
    pub fn open(sf: &ServiceFile, timeout: Duration) -> Result<Rpc, String> {
        let addr = SocketAddr::from(([127, 0, 0, 1], sf.port));
        let stream = TcpStream::connect_timeout(&addr, timeout).map_err(|e| e.to_string())?;
        stream.set_read_timeout(Some(timeout)).map_err(|e| e.to_string())?;
        stream.set_write_timeout(Some(timeout)).map_err(|e| e.to_string())?;
        let (mut ws, _) = tungstenite::client::client(format!("ws://127.0.0.1:{}/rpc", sf.port), stream).map_err(|e| e.to_string())?;
        let auth = json!({ "type": "auth", "token": sf.token, "client": "ui", "events": false, "protocol": 1 });
        ws.send(Message::text(auth.to_string())).map_err(|e| e.to_string())?;
        loop {
            let msg = ws.read().map_err(|e| e.to_string())?;
            if let Message::Text(t) = msg {
                let v: Value = serde_json::from_str(t.as_str()).unwrap_or(Value::Null);
                if v["type"] == "ready" {
                    return Ok(Rpc { ws, next: 1 });
                }
            }
        }
    }

    pub fn call(&mut self, method: &str, params: Value) -> Result<Result<Value, String>, String> {
        let id = self.next;
        self.next += 1;
        let req = json!({ "type": "call", "id": id, "method": method, "params": params });
        self.ws.send(Message::text(req.to_string())).map_err(|e| e.to_string())?;
        loop {
            let msg = self.ws.read().map_err(|e| e.to_string())?;
            let Message::Text(t) = msg else { continue };
            let v: Value = serde_json::from_str(t.as_str()).unwrap_or(Value::Null);
            if v["type"] != "result" || v["id"].as_u64() != Some(id) {
                continue;
            }
            if v["ok"] == true {
                return Ok(Ok(v["result"].clone()));
            }
            return Ok(Err(v["error"].as_str().unwrap_or("Unknown error").to_string()));
        }
    }
}

pub struct Runtime {
    pub service: PathBuf,
}

pub struct Service {
    pub runtime: Runtime,
    starting: Mutex<()>,
    rpc: Mutex<Option<Rpc>>,
}

fn reachable(sf: &ServiceFile) -> bool {
    crate::win32::process_alive(sf.pid) && Rpc::open(sf, Duration::from_secs(4)).is_ok()
}

fn current(sf: &ServiceFile) -> bool {
    sf.version == env!("CARGO_PKG_VERSION")
}

fn retire(sf: &ServiceFile) {
    if let Ok(mut rpc) = Rpc::open(sf, Duration::from_secs(4)) {
        let _ = rpc.call("service.shutdown", json!({ "stopInstances": false }));
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && reachable(sf) {
        std::thread::sleep(Duration::from_millis(200));
    }
}

impl Service {
    pub fn new(runtime: Runtime) -> Service {
        Service { runtime, starting: Mutex::new(()), rpc: Mutex::new(None) }
    }

    fn spawn(&self) -> Result<(), String> {
        let mut cmd = Command::new(&self.runtime.service);
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
        }
        cmd.spawn().map(|_| ()).map_err(|e| format!("Could not start the Modsmith service with {}: {e}", self.runtime.service.display()))
    }

    pub fn ensure(&self) -> Result<ServiceFile, String> {
        let _guard = self.starting.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(sf) = read_service_file() {
            if reachable(&sf) {
                if current(&sf) {
                    return Ok(sf);
                }
                retire(&sf);
            }
        }
        self.spawn()?;
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(300));
            if let Some(sf) = read_service_file() {
                if current(&sf) && reachable(&sf) {
                    return Ok(sf);
                }
            }
        }
        Err(format!("The Modsmith service did not start; see {}", data_dir().join("service.log").display()))
    }

    pub fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let mut slot = self.rpc.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(rpc) = slot.as_mut() {
            if let Ok(result) = rpc.call(method, params.clone()) {
                return result;
            }
            *slot = None;
        }
        let sf = self.ensure()?;
        let mut rpc = Rpc::open(&sf, Duration::from_secs(8))?;
        let result = rpc.call(method, params)?;
        *slot = Some(rpc);
        result
    }
}
