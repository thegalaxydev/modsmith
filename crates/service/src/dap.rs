use crate::rt::{s, Runtime};
use crate::workspace;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

struct Session {
    workspace: String,
    instance: Option<String>,
    stream: Mutex<TcpStream>,
}

fn sessions() -> std::sync::MutexGuard<'static, HashMap<String, std::sync::Arc<Session>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, std::sync::Arc<Session>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|e| e.into_inner())
}

pub fn debugger_attached(instance: &str) -> bool {
    sessions().values().any(|s| s.instance.as_deref() == Some(instance))
}

pub fn stop_all() {
    for (_, sess) in sessions().drain() {
        let _ = sess.stream.lock().unwrap_or_else(|e| e.into_inner()).shutdown(Shutdown::Both);
    }
}

impl Runtime {
    pub fn debug_connect(&self, root: &str, port: u16, instance: Option<&str>) -> Result<Value, String> {
        let ws = s(&workspace::normalize(root));
        if let Some(i) = instance {
            self.instance_or_err(i)?;
        }
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|_| format!("Could not connect to the debug adapter on port {port}"))?;
        let reader = stream.try_clone().map_err(|e| e.to_string())?;
        let mut rnd = [0u8; 8];
        getrandom::fill(&mut rnd).map_err(|e| e.to_string())?;
        let id = hex::encode(rnd);
        sessions().insert(id.clone(), std::sync::Arc::new(Session { workspace: ws, instance: instance.map(str::to_string), stream: Mutex::new(stream) }));
        let ops = self.ops.clone();
        let session = id.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(reader);
            loop {
                let mut length: Option<usize> = None;
                let mut line = String::new();
                let mut eof = false;
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => {
                            eof = true;
                            break;
                        }
                        Ok(_) => {}
                    }
                    let trimmed = line.trim_end();
                    if trimmed.is_empty() {
                        break;
                    }
                    if let Some(v) = trimmed.strip_prefix("Content-Length:") {
                        length = v.trim().parse().ok();
                    }
                }
                if eof {
                    break;
                }
                let Some(n) = length else { continue };
                let mut body = vec![0u8; n];
                if reader.read_exact(&mut body).is_err() {
                    break;
                }
                ops.emit_event("debug.message", json!({ "session": session, "message": String::from_utf8_lossy(&body) }));
            }
            sessions().remove(&session);
            ops.emit_event("debug.closed", json!({ "session": session }));
        });
        Ok(json!({ "session": id }))
    }

    pub fn debug_send(&self, session: &str, message: &str) -> Result<Value, String> {
        let sess = sessions().get(session).cloned().ok_or_else(|| format!("No debug session {session}"))?;
        let mut stream = sess.stream.lock().unwrap_or_else(|e| e.into_inner());
        stream.write_all(format!("Content-Length: {}\r\n\r\n", message.len()).as_bytes()).map_err(|e| e.to_string())?;
        stream.write_all(message.as_bytes()).map_err(|e| e.to_string())?;
        stream.flush().map_err(|e| e.to_string())?;
        Ok(json!({ "sent": true }))
    }

    pub fn debug_disconnect(&self, session: &str) -> Result<Value, String> {
        let sess = sessions().remove(session).ok_or_else(|| format!("No debug session {session}"))?;
        let _ = sess.stream.lock().unwrap_or_else(|e| e.into_inner()).shutdown(Shutdown::Both);
        Ok(json!({ "closed": true }))
    }

    pub fn debug_list(&self, root: Option<&str>) -> Value {
        let ws = root.map(|r| s(&workspace::normalize(r)));
        Value::Array(
            sessions()
                .iter()
                .filter(|(_, v)| ws.as_ref().is_none_or(|w| &v.workspace == w))
                .map(|(k, v)| json!({ "session": k, "workspace": v.workspace, "instance": v.instance }))
                .collect(),
        )
    }
}
