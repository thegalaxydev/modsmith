use crate::activity;
use crate::api;
use crate::handlers::{self, Native};
use crate::store::Store;
use crate::support::constant_time_eq;
use crate::worker::{Worker, WorkerResult};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;

const MAX_MESSAGE: usize = 64 * 1024 * 1024;

struct Client {
    tx: mpsc::UnboundedSender<Message>,
    events: bool,
    source: String,
}

pub struct Hub {
    token: String,
    worker: Arc<Worker>,
    store: Arc<Store>,
    native: Arc<Native>,
    clients: Mutex<HashMap<u64, Client>>,
    next: AtomicU64,
}

#[derive(Deserialize)]
struct Incoming<'a> {
    #[serde(rename = "type")]
    kind: Option<&'a str>,
    #[serde(borrow)]
    id: Option<&'a RawValue>,
    method: Option<serde_json::Value>,
    #[serde(borrow)]
    params: Option<&'a RawValue>,
    token: Option<serde_json::Value>,
    client: Option<serde_json::Value>,
    events: Option<serde_json::Value>,
}

fn close(code: u16, reason: &str) -> Message {
    Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.to_string().into() }))
}

fn truthy(v: &Option<serde_json::Value>) -> bool {
    match v {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::Number(n)) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        Some(serde_json::Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

pub fn origin_allowed(origin: Option<&str>) -> bool {
    let Some(origin) = origin else { return true };
    let local = regex::Regex::new(r"^http://(localhost|127\.0\.0\.1):\d+$").map(|r| r.is_match(origin)).unwrap_or(false);
    local || origin == "http://tauri.localhost" || origin == "https://tauri.localhost"
}

pub fn result_message(id: &str, r: WorkerResult) -> String {
    if r.ok {
        match r.result {
            Some(raw) => format!("{{\"type\":\"result\",\"id\":{id},\"ok\":true,\"result\":{}}}", raw.get()),
            None => format!("{{\"type\":\"result\",\"id\":{id},\"ok\":true}}"),
        }
    } else {
        let err = serde_json::to_string(r.error.as_deref().unwrap_or("Unknown error")).unwrap_or_default();
        format!("{{\"type\":\"result\",\"id\":{id},\"ok\":false,\"error\":{err}}}")
    }
}

impl Hub {
    pub fn new(token: String, worker: Arc<Worker>, store: Arc<Store>, catalog: Arc<crate::manifest::Catalog>, data_dir: std::path::PathBuf, cache_dir: std::path::PathBuf) -> Arc<Hub> {
        let providers = Arc::new(crate::providers::Providers::new(crate::http::Http::new(store.clone()), data_dir, catalog.clone()));
        let ops = crate::ops::Ops::new(store.clone());
        let profiles = Arc::new(crate::profiles::Profiles { providers: providers.clone(), store: store.clone(), ops: ops.clone(), cache: cache_dir });
        let native = Arc::new(Native { store: store.clone(), catalog, providers, profiles, ops: ops.clone() });
        let hub = Arc::new(Hub { token, worker, store, native, clients: Mutex::new(HashMap::new()), next: AtomicU64::new(1) });
        let weak = Arc::downgrade(&hub);
        ops.set_emitter(Box::new(move |event, data| {
            if let Some(h) = weak.upgrade() {
                h.broadcast(format!("{{\"type\":\"event\",\"event\":\"{event}\",\"data\":{data}}}"));
            }
        }));
        hub
    }

    fn finish(&self, source: &str, method: &str, params: &Value, r: WorkerResult, reply: Box<dyn FnOnce(WorkerResult) + Send>) {
        let mutating = api::api().methods.get(method).is_some_and(|d| d.mutating);
        if activity::should_record(method, source, r.ok, mutating) {
            let summary = if r.ok {
                let parsed: Option<Value> = r.result.as_ref().and_then(|raw| serde_json::from_str(raw.get()).ok());
                activity::summarize(parsed.as_ref())
            } else {
                r.error.clone().unwrap_or_default()
            };
            self.record(source, method, params, r.ok, &summary);
        }
        reply(r);
    }

    fn record(&self, source: &str, method: &str, params: &Value, ok: bool, summary: &str) {
        let mutating = api::api().methods.get(method).is_some_and(|m| m.mutating);
        if !activity::should_record(method, source, ok, mutating) {
            return;
        }
        let text = activity::params_text(params);
        if let Ok(entry) = self.store.add_activity(source, method, &text, if ok { "ok" } else { "error" }, &activity::js_slice(summary, 500)) {
            self.broadcast(format!("{{\"type\":\"event\",\"event\":\"activity.added\",\"data\":{entry}}}"))
        }
    }

    fn dispatch(self: &Arc<Self>, method: String, raw: Option<&RawValue>, source: String, reply: Box<dyn FnOnce(WorkerResult) + Send>) {
        let raw_params: Value = raw.and_then(|r| serde_json::from_str(r.get()).ok()).unwrap_or(Value::Null);
        let params = match api::validate(&method, &raw_params) {
            Ok(p) => p,
            Err(msg) => {
                self.record(&source, &method, &raw_params, false, &msg);
                return reply(WorkerResult { ok: false, result: None, error: Some(msg) });
            }
        };
        let hub = self.clone();
        if method == "operation.list" {
            let rust_ops = self.native.ops.list();
            let (m, s) = (method.clone(), source.clone());
            let forwarded = RawValue::from_string(params.to_string()).ok();
            self.worker.call(
                &m,
                forwarded.as_deref(),
                &s,
                false,
                Box::new(move |r: WorkerResult| {
                    if !r.ok {
                        return hub.finish(&source, &method, &params, r, reply);
                    }
                    let mut all = rust_ops;
                    if let Some(Value::Array(list)) = r.result.as_ref().and_then(|raw| serde_json::from_str::<Value>(raw.get()).ok()) {
                        all.extend(list);
                    }
                    all.sort_by(|a, b| b["startedAt"].as_f64().unwrap_or(0.0).partial_cmp(&a["startedAt"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
                    let merged = WorkerResult { ok: true, result: RawValue::from_string(Value::Array(all).to_string()).ok(), error: None };
                    hub.finish(&source, &method, &params, merged, reply);
                }),
            );
            return;
        }
        let routed_native = if method.starts_with("operation.") { params["id"].as_str().is_some_and(|id| self.native.ops.has(id)) } else { handlers::is_native(&method) };
        if routed_native {
            tokio::task::spawn_blocking(move || {
                let r = hub.native.call(&method, &params);
                match r {
                    Ok(outcome) => {
                        for what in &outcome.invalidate {
                            hub.worker.invalidate(what);
                        }
                        for (event, data) in &outcome.events {
                            hub.broadcast(format!("{{\"type\":\"event\",\"event\":\"{event}\",\"data\":{data}}}"));
                        }
                        hub.record(&source, &method, &params, true, &activity::summarize(outcome.value.as_ref()));
                        reply(WorkerResult { ok: true, result: outcome.value.and_then(|v| RawValue::from_string(v.to_string()).ok()), error: None });
                    }
                    Err(e) => {
                        hub.record(&source, &method, &params, false, &e);
                        reply(WorkerResult { ok: false, result: None, error: Some(e) });
                    }
                }
            });
            return;
        }
        let text = params.to_string();
        let forwarded = RawValue::from_string(text).ok();
        let worker = self.worker.clone();
        let (m, s) = (method.clone(), source.clone());
        worker.call(
            &m,
            forwarded.as_deref(),
            &s,
            false,
            Box::new(move |r: WorkerResult| {
                let mutating = api::api().methods.get(&method).is_some_and(|d| d.mutating);
                if activity::should_record(&method, &source, r.ok, mutating) {
                    let summary = if r.ok {
                        let parsed: Option<Value> = r.result.as_ref().and_then(|raw| serde_json::from_str(raw.get()).ok());
                        activity::summarize(parsed.as_ref())
                    } else {
                        r.error.clone().unwrap_or_default()
                    };
                    hub.record(&source, &method, &params, r.ok, &summary);
                }
                reply(r);
            }),
        );
    }

    fn counts_json(&self) -> String {
        let clients = self.clients.lock().unwrap_or_else(|e| e.into_inner());
        let mut counts: Vec<(String, u64)> = vec![("ui".into(), 0), ("mcp".into(), 0), ("cli".into(), 0)];
        for c in clients.values() {
            match counts.iter_mut().find(|(k, _)| *k == c.source) {
                Some(entry) => entry.1 += 1,
                None => counts.push((c.source.clone(), 1)),
            }
        }
        let body = counts.iter().map(|(k, v)| format!("{}:{v}", serde_json::to_string(k).unwrap_or_default())).collect::<Vec<_>>().join(",");
        format!("{{{body}}}")
    }

    fn clients_changed(&self) {
        let counts = self.counts_json();
        self.worker.send_clients(&counts);
        self.broadcast(format!("{{\"type\":\"event\",\"event\":\"clients.changed\",\"data\":{counts}}}"));
    }

    pub fn broadcast(&self, line: String) {
        let msg = Message::text(line);
        for c in self.clients.lock().unwrap_or_else(|e| e.into_inner()).values() {
            if c.events {
                let _ = c.tx.send(msg.clone());
            }
        }
    }

    pub fn close_all(&self) {
        for c in self.clients.lock().unwrap_or_else(|e| e.into_inner()).values() {
            let _ = c.tx.send(close(1001, "service stopping"));
        }
    }

    pub async fn serve(self: Arc<Self>, listener: TcpListener) {
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let hub = self.clone();
            tokio::spawn(async move { hub.connection(stream).await });
        }
    }

    async fn connection(self: Arc<Self>, stream: TcpStream) {
        let _ = stream.set_nodelay(true);
        let check = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
            let origin = req.headers().get("origin").and_then(|v| v.to_str().ok());
            let path_ok = req.uri().path_and_query().map(|p| p.as_str() == "/rpc").unwrap_or(false);
            if !path_ok || !origin_allowed(origin) {
                let mut err = ErrorResponse::new(None);
                *err.status_mut() = StatusCode::FORBIDDEN;
                return Err(err);
            }
            Ok(resp)
        };
        let config = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE)).max_frame_size(Some(MAX_MESSAGE));
        let Ok(ws) = tokio_tungstenite::accept_hdr_async_with_config(stream, check, Some(config)).await else { return };
        let (mut sink, mut stream) = ws.split();
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
        let conn = self.next.fetch_add(1, Ordering::Relaxed);
        let mut authed = false;
        let deadline = tokio::time::sleep(Duration::from_secs(5));
        tokio::pin!(deadline);
        loop {
            let next = if authed {
                stream.next().await
            } else {
                tokio::select! {
                    m = stream.next() => m,
                    _ = &mut deadline => {
                        let _ = tx.send(close(4001, "auth timeout"));
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
            let parsed = serde_json::from_str::<Incoming>(&text);
            let msg = match parsed {
                Ok(m) => Some(m),
                Err(_) if serde_json::from_str::<serde::de::IgnoredAny>(&text).is_ok() => None,
                Err(_) => {
                    let _ = tx.send(close(4002, "invalid json"));
                    break;
                }
            };
            if !authed {
                let ok = msg.as_ref().is_some_and(|m| m.kind == Some("auth") && m.token.as_ref().and_then(|t| t.as_str()).is_some_and(|t| constant_time_eq(t, &self.token)));
                let Some(m) = msg.filter(|_| ok) else {
                    let _ = tx.send(close(4004, "authentication failed"));
                    break;
                };
                let source = match m.client.as_ref().and_then(|c| c.as_str()) {
                    Some(s @ ("ui" | "mcp" | "cli")) => s.to_string(),
                    _ => "system".to_string(),
                };
                self.clients.lock().unwrap_or_else(|e| e.into_inner()).insert(conn, Client { tx: tx.clone(), events: truthy(&m.events), source });
                authed = true;
                self.clients_changed();
                let a = api::api();
                let ready = format!(
                    "{{\"type\":\"ready\",\"server\":{{\"product\":{},\"version\":{},\"pid\":{}}}}}",
                    serde_json::to_string(&a.product).unwrap_or_default(),
                    serde_json::to_string(&a.version).unwrap_or_default(),
                    std::process::id()
                );
                let _ = tx.send(Message::text(ready));
                continue;
            }
            let Some(m) = msg else { continue };
            let (Some("call"), Some(id), Some(serde_json::Value::String(method))) = (m.kind, m.id, m.method.as_ref()) else { continue };
            if !id.get().starts_with(|c: char| c.is_ascii_digit() || c == '-') {
                continue;
            }
            let id = id.get().to_string();
            if !api::api().methods.contains_key(method.as_str()) {
                let r = WorkerResult { ok: false, result: None, error: Some(format!("Unknown method {method}")) };
                let _ = tx.send(Message::text(result_message(&id, r)));
                continue;
            }
            let source = self.clients.lock().unwrap_or_else(|e| e.into_inner()).get(&conn).map(|c| c.source.clone()).unwrap_or_else(|| "system".into());
            let reply_tx = tx.clone();
            self.dispatch(
                method.clone(),
                m.params,
                source,
                Box::new(move |r| {
                    let _ = reply_tx.send(Message::text(result_message(&id, r)));
                }),
            );
        }
        drop(tx);
        if authed {
            self.clients.lock().unwrap_or_else(|e| e.into_inner()).remove(&conn);
            self.clients_changed();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins() {
        assert!(origin_allowed(None));
        assert!(origin_allowed(Some("http://tauri.localhost")));
        assert!(origin_allowed(Some("http://localhost:5173")));
        assert!(!origin_allowed(Some("https://example.com")));
        assert!(!origin_allowed(Some("http://localhost")));
        assert!(!origin_allowed(Some("file://")));
    }
}
