use crate::activity::redact_text;
use crate::store::Store;
use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

const LOG_TAIL: usize = 200;
const FULL_LOG: usize = 20000;
pub const CANCELLED: &str = "Operation cancelled";

type Emit = Box<dyn Fn(&str, Value) + Send + Sync>;

struct Record {
    info: Mutex<Map<String, Value>>,
    full_log: Mutex<VecDeque<String>>,
    cancelled: AtomicBool,
    done: Mutex<bool>,
    done_cv: Condvar,
    last_emit: Mutex<Option<Instant>>,
}

pub struct Ops {
    records: Mutex<Vec<(String, Arc<Record>)>>,
    store: Arc<Store>,
    emit: OnceLock<Emit>,
}

pub struct OpCtx {
    ops: Arc<Ops>,
    record: Arc<Record>,
    pub id: String,
}

pub fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("system random source");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex::encode(b);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn now() -> i64 {
    crate::support::now_ms() as i64
}

impl OpCtx {
    pub fn cancelled(&self) -> bool {
        self.record.cancelled.load(Ordering::SeqCst)
    }

    pub fn check(&self) -> Result<(), String> {
        if self.cancelled() {
            Err(CANCELLED.into())
        } else {
            Ok(())
        }
    }

    pub fn progress(&self, fraction: Option<f64>, message: Option<&str>) {
        {
            let mut info = self.record.info.lock().unwrap_or_else(|e| e.into_inner());
            info.insert("progress".into(), fraction.map(Value::from).unwrap_or(Value::Null));
            if let Some(m) = message.filter(|m| !m.is_empty()) {
                info.insert("message".into(), json!(m));
            }
        }
        self.ops.emit_update(&self.record, false);
    }

    pub fn log(&self, line: &str) {
        let clean = redact_text(line);
        {
            let mut info = self.record.info.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(Value::Array(tail)) = info.get_mut("logTail") {
                tail.push(json!(clean));
                if tail.len() > LOG_TAIL {
                    let extra = tail.len() - LOG_TAIL;
                    tail.drain(0..extra);
                }
            }
        }
        {
            let mut full = self.record.full_log.lock().unwrap_or_else(|e| e.into_inner());
            full.push_back(clean.clone());
            while full.len() > FULL_LOG {
                full.pop_front();
            }
        }
        self.ops.emit("operation.log", json!({ "id": self.id, "line": clean }));
    }
}

impl Ops {
    pub fn new(store: Arc<Store>) -> Arc<Ops> {
        Arc::new(Ops { records: Mutex::new(Vec::new()), store, emit: OnceLock::new() })
    }

    pub fn set_emitter(&self, emit: Emit) {
        let _ = self.emit.set(emit);
    }

    pub fn emit_event(&self, event: &str, data: Value) {
        self.emit(event, data);
    }

    fn emit(&self, event: &str, data: Value) {
        if let Some(e) = self.emit.get() {
            e(event, data);
        }
    }

    fn snapshot(record: &Record) -> Value {
        Value::Object(record.info.lock().unwrap_or_else(|e| e.into_inner()).clone())
    }

    fn emit_update(&self, record: &Record, force: bool) {
        {
            let mut last = record.last_emit.lock().unwrap_or_else(|e| e.into_inner());
            if !force && last.is_some_and(|t| t.elapsed() < Duration::from_millis(150)) {
                return;
            }
            *last = Some(Instant::now());
        }
        self.emit("operation.updated", Self::snapshot(record));
    }

    fn save(&self, record: &Record) {
        let info = Self::snapshot(record);
        let _ = self.store.save_operation(&info);
    }

    fn find(&self, id: &str) -> Option<Arc<Record>> {
        self.records.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(k, _)| k == id).map(|(_, r)| r.clone())
    }

    pub fn has(&self, id: &str) -> bool {
        self.find(id).is_some()
    }

    pub fn start<F>(self: &Arc<Self>, kind: &str, title: &str, workspace: Option<String>, f: F) -> Value
    where
        F: FnOnce(&OpCtx) -> Result<Option<Value>, String> + Send + 'static,
    {
        let id = uuid_v4();
        let mut info = Map::new();
        info.insert("id".into(), json!(id));
        info.insert("kind".into(), json!(kind));
        info.insert("title".into(), json!(title));
        if let Some(w) = workspace {
            info.insert("workspace".into(), json!(w));
        }
        info.insert("status".into(), json!("running"));
        info.insert("progress".into(), Value::Null);
        info.insert("message".into(), json!("Starting"));
        info.insert("startedAt".into(), json!(now()));
        info.insert("logTail".into(), json!([]));
        let record = Arc::new(Record {
            info: Mutex::new(info),
            full_log: Mutex::new(VecDeque::new()),
            cancelled: AtomicBool::new(false),
            done: Mutex::new(false),
            done_cv: Condvar::new(),
            last_emit: Mutex::new(None),
        });
        self.records.lock().unwrap_or_else(|e| e.into_inner()).push((id.clone(), record.clone()));
        self.save(&record);
        self.emit_update(&record, true);
        let snapshot = Self::snapshot(&record);
        let ops = self.clone();
        std::thread::spawn(move || {
            let ctx = OpCtx { ops: ops.clone(), record: record.clone(), id };
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&ctx))).unwrap_or_else(|_| Err("Internal error".into()));
            {
                let aborted = record.cancelled.load(Ordering::SeqCst);
                let mut info = record.info.lock().unwrap_or_else(|e| e.into_inner());
                match outcome {
                    Ok(result) => {
                        info.insert("status".into(), json!(if aborted { "cancelled" } else { "succeeded" }));
                        match result {
                            Some(r) => {
                                info.insert("result".into(), r);
                            }
                            None => {
                                info.shift_remove("result");
                            }
                        }
                        info.insert("message".into(), json!(if aborted { "Cancelled" } else { "Completed" }));
                        info.insert("progress".into(), json!(1));
                    }
                    Err(e) if aborted || e == CANCELLED => {
                        info.insert("status".into(), json!("cancelled"));
                        info.insert("message".into(), json!("Cancelled"));
                    }
                    Err(e) => {
                        info.insert("status".into(), json!("failed"));
                        info.insert("error".into(), json!(e));
                        info.insert("message".into(), json!("Failed"));
                        drop(info);
                        ctx.log(&format!("ERROR: {e}"));
                        info = record.info.lock().unwrap_or_else(|e| e.into_inner());
                    }
                }
                info.insert("endedAt".into(), json!(now()));
            }
            ops.save(&record);
            ops.emit_update(&record, true);
            *record.done.lock().unwrap_or_else(|e| e.into_inner()) = true;
            record.done_cv.notify_all();
        });
        snapshot
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        self.find(id).map(|r| Self::snapshot(&r))
    }

    pub fn full_log(&self, id: &str) -> Vec<String> {
        self.find(id).map(|r| r.full_log.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()).unwrap_or_default()
    }

    pub fn list(&self) -> Vec<Value> {
        let mut out: Vec<Value> = self.records.lock().unwrap_or_else(|e| e.into_inner()).iter().map(|(_, r)| Self::snapshot(r)).collect();
        out.sort_by(|a, b| b["startedAt"].as_i64().unwrap_or(0).cmp(&a["startedAt"].as_i64().unwrap_or(0)));
        out
    }

    pub fn cancel(&self, id: &str) -> bool {
        let Some(r) = self.find(id) else { return false };
        {
            let mut info = r.info.lock().unwrap_or_else(|e| e.into_inner());
            if info.get("status") != Some(&json!("running")) {
                return false;
            }
            r.cancelled.store(true, Ordering::SeqCst);
            info.insert("message".into(), json!("Cancelling"));
        }
        self.emit("operation.updated", Self::snapshot(&r));
        true
    }

    pub fn wait(&self, id: &str, timeout_ms: u64) -> Option<Value> {
        let r = self.find(id)?;
        let done = r.done.lock().unwrap_or_else(|e| e.into_inner());
        let _ = r.done_cv.wait_timeout_while(done, Duration::from_millis(timeout_ms), |d| !*d);
        Some(Self::snapshot(&r))
    }
}
