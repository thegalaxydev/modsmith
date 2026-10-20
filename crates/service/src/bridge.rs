use crate::support::constant_time_eq;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc as smpsc, Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;

pub const PROTOCOL: i64 = 1;
const MAX_PAYLOAD: usize = 48 * 1024 * 1024;

type Pending = HashMap<i64, (smpsc::Sender<Result<Value, String>>, String)>;
type Emit = Box<dyn Fn(&str, Value) + Send + Sync>;

struct Session {
    token: String,
    instance_id: String,
    socket: Option<(u64, mpsc::UnboundedSender<Message>)>,
    hello: Option<Value>,
    pending: Pending,
    next_id: i64,
    connected_at: Option<u64>,
}

pub struct Bridge {
    pub port: AtomicU64,
    sessions: Mutex<Vec<(String, Session)>>,
    orphaned: Mutex<HashMap<u64, String>>,
    emit: OnceLock<Emit>,
    next_conn: AtomicU64,
}

fn close(code: u16, reason: &str) -> Message {
    Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.to_string().into() }))
}

fn string_len(v: &Value, min: usize, max: usize) -> Option<String> {
    let s = v.as_str()?;
    let n = s.encode_utf16().count();
    (n >= min && n <= max).then(|| s.to_string())
}

pub fn parse_hello(msg: &Value) -> Option<Value> {
    if msg["type"] != "hello" {
        return None;
    }
    let protocol = msg["protocol"].as_f64().filter(|f| f.fract() == 0.0 && f.abs() <= 9007199254740991.0)?;
    let session = string_len(&msg["session"], 8, 128)?;
    let token = string_len(&msg["token"], 16, 256)?;
    let game = msg["game"].as_object()?;
    let mut g = Map::new();
    for k in ["minecraft", "loader", "loaderVersion"] {
        g.insert(k.into(), json!(game.get(k)?.as_str()?));
    }
    let side = game.get("side")?.as_str()?;
    if side != "client" && side != "server" {
        return None;
    }
    g.insert("side".into(), json!(side));
    g.insert("bridgeVersion".into(), json!(game.get("bridgeVersion")?.as_str()?));
    let caps = match game.get("capabilities") {
        None => json!([]),
        Some(Value::Array(a)) if a.iter().all(Value::is_string) => Value::Array(a.clone()),
        Some(_) => return None,
    };
    g.insert("capabilities".into(), caps);
    for (k, v) in game {
        if !g.contains_key(k) {
            g.insert(k.clone(), v.clone());
        }
    }
    Some(json!({ "type": "hello", "protocol": protocol as i64, "session": session, "token": token, "game": g }))
}

impl Bridge {
    pub fn new() -> Arc<Bridge> {
        Arc::new(Bridge { port: AtomicU64::new(0), sessions: Mutex::new(Vec::new()), orphaned: Mutex::new(HashMap::new()), emit: OnceLock::new(), next_conn: AtomicU64::new(1) })
    }

    pub fn set_emitter(&self, emit: Emit) {
        let _ = self.emit.set(emit);
    }

    fn emit(&self, event: &str, data: Value) {
        if let Some(e) = self.emit.get() {
            e(event, data);
        }
    }

    pub fn port(&self) -> u16 {
        self.port.load(Ordering::SeqCst) as u16
    }

    pub fn url(&self) -> String {
        format!("ws://127.0.0.1:{}/bridge", self.port())
    }

    pub async fn start(self: &Arc<Self>) -> std::io::Result<()> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        self.port.store(listener.local_addr()?.port() as u64, Ordering::SeqCst);
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { continue };
                let b = me.clone();
                tokio::spawn(async move { b.connection(stream).await });
            }
        });
        Ok(())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<(String, Session)>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn create_session(&self, instance_id: &str) -> (String, String) {
        let id = crate::ops::uuid_v4();
        let token = crate::support::random_token();
        self.lock().push((id.clone(), Session { token: token.clone(), instance_id: instance_id.into(), socket: None, hello: None, pending: HashMap::new(), next_id: 1, connected_at: None }));
        (id, token)
    }

    pub fn close_session(&self, id: &str) {
        let removed = {
            let mut sessions = self.lock();
            let Some(i) = sessions.iter().position(|(sid, _)| sid == id) else { return };
            sessions.remove(i).1
        };
        for (_, (tx, _)) in removed.pending {
            let _ = tx.send(Err("Bridge session closed".into()));
        }
        if let Some((conn, tx)) = removed.socket {
            self.orphaned.lock().unwrap_or_else(|e| e.into_inner()).insert(conn, removed.instance_id.clone());
            let _ = tx.send(Message::Close(None));
        }
    }

    pub fn status(&self, instance_id: &str) -> Value {
        let sessions = self.lock();
        let Some((_, s)) = sessions.iter().find(|(_, s)| s.instance_id == instance_id) else { return json!({ "connected": false }) };
        let mut o = Map::new();
        o.insert("connected".into(), json!(s.socket.is_some()));
        if let Some(h) = &s.hello {
            o.insert("protocol".into(), h["protocol"].clone());
            o.insert("game".into(), h["game"].clone());
        }
        if let Some(t) = s.connected_at {
            o.insert("connectedAt".into(), json!(t));
        }
        Value::Object(o)
    }

    pub fn call(&self, instance_id: &str, method: &str, params: Value, timeout_ms: u64) -> Result<Value, String> {
        let (id, rx) = {
            let mut sessions = self.lock();
            let Some((_, s)) = sessions.iter_mut().find(|(_, s)| s.instance_id == instance_id) else { return Err("Bridge is not connected for this instance".into()) };
            let Some((_, tx)) = s.socket.clone().filter(|(_, tx)| !tx.is_closed()) else { return Err("Bridge is not connected for this instance".into()) };
            let caps: Vec<String> = s.hello.as_ref().and_then(|h| h["game"]["capabilities"].as_array()).map(|a| a.iter().filter_map(|c| c.as_str().map(str::to_string)).collect()).unwrap_or_default();
            if !caps.is_empty() && !caps.iter().any(|c| c == method) {
                return Err(format!("Bridge method {method} is not supported by this game instance (supported: {})", caps.join(", ")));
            }
            let id = s.next_id;
            s.next_id += 1;
            let (rtx, rrx) = smpsc::channel();
            s.pending.insert(id, (rtx, method.to_string()));
            let _ = tx.send(Message::text(json!({ "type": "request", "id": id, "method": method, "params": params }).to_string()));
            (id, rrx)
        };
        match rx.recv_timeout(Duration::from_millis(timeout_ms)) {
            Ok(r) => r,
            Err(smpsc::RecvTimeoutError::Timeout) => {
                for (_, s) in self.lock().iter_mut() {
                    if s.instance_id == instance_id {
                        s.pending.remove(&id);
                    }
                }
                Err(format!("Bridge call {method} timed out after {timeout_ms} ms"))
            }
            Err(smpsc::RecvTimeoutError::Disconnected) => Err("Bridge disconnected".into()),
        }
    }

    pub fn stop(&self) {
        let ids: Vec<String> = self.lock().iter().map(|(id, _)| id.clone()).collect();
        for id in ids {
            self.close_session(&id);
        }
    }

    async fn connection(self: Arc<Self>, stream: TcpStream) {
        let _ = stream.set_nodelay(true);
        let check = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
            let path_ok = req.uri().path_and_query().map(|p| p.as_str() == "/bridge").unwrap_or(false);
            if !path_ok || req.headers().contains_key("origin") {
                let mut err = ErrorResponse::new(None);
                *err.status_mut() = StatusCode::FORBIDDEN;
                return Err(err);
            }
            Ok(resp)
        };
        let config = WebSocketConfig::default().max_message_size(Some(MAX_PAYLOAD)).max_frame_size(Some(MAX_PAYLOAD));
        let Ok(ws) = tokio_tungstenite::accept_hdr_async_with_config(stream, check, Some(config)).await else { return };
        let (mut sink, mut source) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                let closing = matches!(msg, Message::Close(_));
                if sink.send(msg).await.is_err() || closing {
                    break;
                }
            }
            let _ = sink.close().await;
        });
        let conn = self.next_conn.fetch_add(1, Ordering::SeqCst);
        let mut session: Option<String> = None;
        let hello_deadline = tokio::time::sleep(Duration::from_secs(10));
        tokio::pin!(hello_deadline);
        loop {
            let next = if session.is_some() {
                source.next().await
            } else {
                tokio::select! {
                    m = source.next() => m,
                    _ = &mut hello_deadline => {
                        let _ = tx.send(close(4001, "hello timeout"));
                        break;
                    }
                }
            };
            let Some(Ok(msg)) = next else { break };
            let text = match msg {
                Message::Text(t) => t.to_string(),
                Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
                Message::Close(_) => break,
                _ => continue,
            };
            let Ok(msg) = serde_json::from_str::<Value>(&text) else {
                let _ = tx.send(close(4002, "invalid json"));
                break;
            };
            let Some(sid) = session.clone() else {
                let Some(hello) = parse_hello(&msg) else {
                    let _ = tx.send(close(4003, "invalid hello"));
                    break;
                };
                let hello_session = hello["session"].as_str().unwrap_or_default().to_string();
                let hello_token = hello["token"].as_str().unwrap_or_default().to_string();
                let mut sessions = self.lock();
                let Some((_, s)) = sessions.iter_mut().find(|(id, s)| *id == hello_session && constant_time_eq(&s.token, &hello_token)) else {
                    drop(sessions);
                    let _ = tx.send(close(4004, "authentication failed"));
                    break;
                };
                if hello["protocol"] != json!(PROTOCOL) {
                    drop(sessions);
                    let _ = tx.send(Message::text(json!({ "type": "welcome", "ok": false, "error": format!("Unsupported protocol {}; expected {PROTOCOL}", hello["protocol"]) }).to_string()));
                    let _ = tx.send(close(4005, "protocol mismatch"));
                    break;
                }
                if let Some((old, old_tx)) = s.socket.take() {
                    if old != conn {
                        let _ = old_tx.send(close(4006, "replaced"));
                    }
                }
                s.socket = Some((conn, tx.clone()));
                s.connected_at = Some(crate::support::now_ms() as u64);
                let game = hello["game"].clone();
                s.hello = Some(hello);
                let instance_id = s.instance_id.clone();
                drop(sessions);
                session = Some(hello_session);
                let _ = tx.send(Message::text(json!({ "type": "welcome", "ok": true, "protocol": PROTOCOL }).to_string()));
                self.emit("bridge.connected", json!({ "instanceId": instance_id, "game": game }));
                continue;
            };
            match msg["type"].as_str() {
                Some("response") => {
                    let Some(id) = msg["id"].as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64) else { continue };
                    let Some(ok) = msg["ok"].as_bool() else { continue };
                    if msg.get("error").is_some_and(|e| !e.is_string()) {
                        continue;
                    }
                    let entry = {
                        let mut sessions = self.lock();
                        sessions.iter_mut().find(|(i, _)| *i == sid).and_then(|(_, s)| s.pending.remove(&id))
                    };
                    if let Some((rtx, method)) = entry {
                        let r = if ok {
                            Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                        } else {
                            Err(msg["error"].as_str().map(str::to_string).unwrap_or_else(|| format!("Bridge call {method} failed")))
                        };
                        let _ = rtx.send(r);
                    }
                }
                Some("event") => {
                    let Some(event) = msg["event"].as_str().filter(|e| e.encode_utf16().count() <= 128) else { continue };
                    let instance_id = self.lock().iter().find(|(i, _)| *i == sid).map(|(_, s)| s.instance_id.clone());
                    let instance_id = match instance_id {
                        Some(i) => i,
                        None => continue,
                    };
                    let mut data = Map::new();
                    data.insert("instanceId".into(), json!(instance_id));
                    data.insert("event".into(), json!(event));
                    if let Some(d) = msg.get("data") {
                        data.insert("data".into(), d.clone());
                    }
                    self.emit("bridge.event", Value::Object(data));
                }
                _ => {}
            }
        }
        drop(tx);
        if let Some(sid) = session {
            let lost = {
                let mut sessions = self.lock();
                match sessions.iter_mut().find(|(i, _)| *i == sid) {
                    Some((_, s)) if s.socket.as_ref().is_some_and(|(c, _)| *c == conn) => {
                        s.socket = None;
                        let pending: Vec<_> = s.pending.drain().collect();
                        Some((s.instance_id.clone(), pending))
                    }
                    _ => None,
                }
            };
            if let Some((instance_id, pending)) = lost {
                for (_, (rtx, _)) in pending {
                    let _ = rtx.send(Err("Bridge disconnected".into()));
                }
                self.emit("bridge.disconnected", json!({ "instanceId": instance_id }));
            } else if let Some(instance_id) = self.orphaned.lock().unwrap_or_else(|e| e.into_inner()).remove(&conn) {
                self.emit("bridge.disconnected", json!({ "instanceId": instance_id }));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_validation() {
        let ok = json!({ "type": "hello", "protocol": 1, "session": "12345678", "token": "0123456789abcdef", "game": { "extra": 1, "minecraft": "1.21.1", "loader": "fabric", "loaderVersion": "0.16", "side": "client", "bridgeVersion": "1" } });
        let h = parse_hello(&ok).unwrap();
        assert_eq!(h["game"]["capabilities"], json!([]));
        assert_eq!(h["game"].as_object().unwrap().keys().last().unwrap(), "extra");
        assert!(parse_hello(&json!({ "type": "hello", "protocol": 1, "session": "short", "token": "0123456789abcdef", "game": {} })).is_none());
    }
}
