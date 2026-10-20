use crate::activity::redact_text;
use crate::bridge::Bridge;
use crate::js;
use crate::logs::{LogBuffer, Query};
use crate::proc::{hide, kill_tree, pump, spawn_error, Stream};
use crate::store::Store;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub struct LaunchSpec {
    pub workspace: String,
    pub profile_id: String,
    pub side: String,
    pub mode: String,
    pub instance_dir: PathBuf,
    pub java: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub bridge: bool,
    pub debug_port: Option<u16>,
    pub operation_id: Option<String>,
}

struct Inst {
    info: Mutex<Map<String, Value>>,
    logs: Mutex<LogBuffer>,
    stdin: Mutex<Option<ChildStdin>>,
    pid: Option<u32>,
    done: Mutex<bool>,
    done_cv: Condvar,
    session: Option<String>,
    log_file: Mutex<Option<File>>,
}

impl Inst {
    fn snapshot(&self) -> Value {
        Value::Object(self.info.lock().unwrap_or_else(|e| e.into_inner()).clone())
    }

    fn log(&self, stream: &str, text: &str) -> Value {
        self.logs.lock().unwrap_or_else(|e| e.into_inner()).push(stream, text)
    }

    fn set(&self, key: &str, v: Value) {
        self.info.lock().unwrap_or_else(|e| e.into_inner()).insert(key.into(), v);
    }

    fn status(&self) -> String {
        js::string(&self.info.lock().unwrap_or_else(|e| e.into_inner())["status"])
    }

    fn wait(&self, timeout: Duration) -> bool {
        let done = self.done.lock().unwrap_or_else(|e| e.into_inner());
        let (done, _) = self.done_cv.wait_timeout_while(done, timeout, |d| !*d).unwrap_or_else(|e| e.into_inner());
        *done
    }
}

type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

pub struct Instances {
    running: Mutex<Vec<(String, Arc<Inst>)>>,
    history: Mutex<Vec<(String, Arc<Inst>)>>,
    store: Arc<Store>,
    bridge: Arc<Bridge>,
    emit: OnceLock<Emit>,
}

pub fn find_crash_report(instance_dir: &Path, since: f64) -> Option<String> {
    let dir = instance_dir.join("crash-reports");
    let entries = fs::read_dir(&dir).ok()?;
    let mut files: Vec<(f64, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let p = dir.join(e.file_name());
            let m = fs::metadata(&p).ok()?;
            let t = js::mtime_ms(&m);
            (t >= since - 1000.0).then_some((t, p))
        })
        .collect();
    files.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    files.first().map(|(_, p)| p.to_string_lossy().to_string())
}

fn markers() -> &'static (Regex, Regex, Regex) {
    static M: OnceLock<(Regex, Regex, Regex)> = OnceLock::new();
    M.get_or_init(|| {
        (
            Regex::new(r"Sound engine started|Done \(\d").expect("ready regex"),
            Regex::new(r"Starting Minecraft server").expect("server regex"),
            Regex::new(r"\[EARLYDISPLAY/\]: ERROR DISPLAY|Failed to initialize the mod loading system and display").expect("early display regex"),
        )
    })
}

impl Instances {
    pub fn new(store: Arc<Store>, bridge: Arc<Bridge>) -> Arc<Instances> {
        Arc::new(Instances { running: Mutex::new(Vec::new()), history: Mutex::new(Vec::new()), store, bridge, emit: OnceLock::new() })
    }

    pub fn set_emitter(&self, emit: Emit) {
        let _ = self.emit.set(emit);
    }

    fn emit(&self, event: &str, data: Value) {
        if let Some(e) = self.emit.get() {
            e(event, data);
        }
    }

    fn updated(&self, inst: &Inst) {
        self.emit("instance.updated", inst.snapshot());
    }

    fn find_running(&self, id: &str) -> Option<Arc<Inst>> {
        self.running.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(i, _)| i == id).map(|(_, r)| r.clone())
    }

    fn find_any(&self, id: &str) -> Option<Arc<Inst>> {
        self.find_running(id).or_else(|| self.history.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(i, _)| i == id).map(|(_, r)| r.clone()))
    }

    pub fn on_bridge(&self, event: &str, data: &Value) {
        let Some(r) = data["instanceId"].as_str().and_then(|id| self.find_running(id)) else { return };
        let connected = event == "bridge.connected";
        {
            let mut info = r.info.lock().unwrap_or_else(|e| e.into_inner());
            let old = info.get("bridge").cloned().unwrap_or(Value::Null);
            let mut b = Map::new();
            b.insert("connected".into(), json!(connected));
            let protocol = if connected { Some(json!(1)) } else { old.get("protocol").cloned() };
            if let Some(p) = protocol {
                b.insert("protocol".into(), p);
            }
            if let Some(g) = data.get("game").cloned().or_else(|| old.get("game").cloned()) {
                b.insert("game".into(), g);
            }
            info.insert("bridge".into(), Value::Object(b));
        }
        r.log("system", if connected { "[Modsmith] Bridge connected" } else { "[Modsmith] Bridge disconnected" });
        self.updated(&r);
    }

    pub fn active_for_dir(&self, instance_dir: &Path) -> Option<Value> {
        let key = js::absolute(&instance_dir.to_string_lossy()).to_string_lossy().to_lowercase();
        self.running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(_, r)| r.snapshot())
            .find(|i| js::absolute(i["instanceDir"].as_str().unwrap_or("")).to_string_lossy().to_lowercase() == key && !["exited", "crashed", "failed"].contains(&i["status"].as_str().unwrap_or("")))
    }

    fn launch_record(info: &Value) -> Value {
        let mut o = Map::new();
        o.insert("id".into(), info["id"].clone());
        o.insert("workspace".into(), info["workspace"].clone());
        o.insert("profile".into(), info["profileId"].clone());
        o.insert("side".into(), info["side"].clone());
        o.insert("mode".into(), info["mode"].clone());
        for (k, src) in [("pid", "pid"), ("startedAt", "startedAt"), ("endedAt", "endedAt"), ("exitCode", "exitCode"), ("status", "status"), ("logFile", "logFile"), ("crashReport", "crashReport")] {
            if let Some(v) = info.get(src) {
                o.insert(k.into(), v.clone());
            }
        }
        Value::Object(o)
    }

    pub fn launch(self: &Arc<Self>, spec: LaunchSpec) -> Result<Value, String> {
        if let Some(c) = self.active_for_dir(&spec.instance_dir) {
            return Err(format!(
                "Instance directory {} is already in use by instance {} (pid {}). Stop it first or use another profile.",
                spec.instance_dir.display(),
                js::string(&c["id"]),
                c.get("pid").map(js::string).unwrap_or_else(|| "undefined".into())
            ));
        }
        fs::create_dir_all(&spec.instance_dir).map_err(|e| js::fs_error(&e, "mkdir", &spec.instance_dir))?;
        let id = crate::ops::uuid_v4();
        let log_dir = spec.instance_dir.join("logs").join("modsmith");
        fs::create_dir_all(&log_dir).map_err(|e| js::fs_error(&e, "mkdir", &log_dir))?;
        let log_file = log_dir.join(format!("session-{}.log", js::stamp(&js::iso_now())));
        let mut cmd = Command::new(&spec.java);
        cmd.args(&spec.args).current_dir(&spec.instance_dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        cmd.env_remove("JAVA_TOOL_OPTIONS").env_remove("_JAVA_OPTIONS");
        let mut session = None;
        if spec.bridge {
            let (sid, token) = self.bridge.create_session(&id);
            cmd.env("MODSMITH_BRIDGE_URL", self.bridge.url()).env("MODSMITH_BRIDGE_TOKEN", token).env("MODSMITH_BRIDGE_SESSION", &sid);
            session = Some(sid);
        } else {
            cmd.env_remove("MODSMITH_BRIDGE_URL").env_remove("MODSMITH_BRIDGE_TOKEN").env_remove("MODSMITH_BRIDGE_SESSION");
        }
        let started_at = crate::support::now_ms() as u64;
        let mut info = Map::new();
        info.insert("id".into(), json!(id));
        info.insert("workspace".into(), json!(spec.workspace));
        info.insert("profileId".into(), json!(spec.profile_id));
        info.insert("side".into(), json!(spec.side));
        info.insert("mode".into(), json!(spec.mode));
        info.insert("status".into(), json!("starting"));
        info.insert("instanceDir".into(), json!(spec.instance_dir.to_string_lossy()));
        info.insert("startedAt".into(), json!(started_at));
        info.insert("bridge".into(), json!({ "connected": false }));
        if let Some(p) = spec.debug_port {
            info.insert("debugPort".into(), json!(p));
        }
        info.insert("javaExecutable".into(), json!(spec.java));
        if let Some(o) = &spec.operation_id {
            info.insert("operationId".into(), json!(o));
        }
        info.insert("logFile".into(), json!(log_file.to_string_lossy()));
        let spawned = hide(&mut cmd).spawn();
        let (child, spawn_err) = match spawned {
            Ok(c) => (Some(c), None),
            Err(e) => (None, Some(spawn_error(&spec.java, &e))),
        };
        if let Some(c) = &child {
            info.insert("pid".into(), json!(c.id()));
        }
        let mut child = child;
        let stdin = child.as_mut().and_then(|c| c.stdin.take());
        let file = fs::OpenOptions::new().create(true).append(true).open(&log_file).ok();
        let inst = Arc::new(Inst {
            info: Mutex::new(info),
            logs: Mutex::new(LogBuffer::default()),
            stdin: Mutex::new(stdin),
            pid: child.as_ref().map(|c| c.id()),
            done: Mutex::new(false),
            done_cv: Condvar::new(),
            session,
            log_file: Mutex::new(file),
        });
        self.running.lock().unwrap_or_else(|e| e.into_inner()).push((id.clone(), inst.clone()));
        inst.log("system", &format!("[Modsmith] Launching {} ({}) profile {} in {}", spec.side, spec.mode, spec.profile_id, spec.instance_dir.display()));
        inst.log("system", &format!("[Modsmith] Java: {}", spec.java));
        if let Some(p) = spec.debug_port {
            inst.log("system", &format!("[Modsmith] JDWP debugger listening on 127.0.0.1:{p}"));
        }
        let snapshot = inst.snapshot();
        self.store.save_launch(&Self::launch_record(&snapshot)).map_err(|e| e.to_string())?;
        self.updated(&inst);
        match child {
            None => {
                inst.log("system", &format!("[Modsmith] Failed to start process: {}", spawn_err.unwrap_or_default()));
                inst.set("status", json!("failed"));
                inst.set("endedAt", json!(crate::support::now_ms() as u64));
                self.finish(&inst);
            }
            Some(mut c) => {
                let (tx, rx) = mpsc::channel();
                let a = pump(c.stdout.take(), Stream::Stdout, tx.clone());
                let b = pump(c.stderr.take(), Stream::Stderr, tx);
                let me = self.clone();
                let watcher = inst.clone();
                let instance_dir = spec.instance_dir.clone();
                std::thread::spawn(move || {
                    me.watch(&watcher, rx);
                    for h in [a, b].into_iter().flatten() {
                        let _ = h.join();
                    }
                    let code = c.wait().ok().and_then(|s| s.code());
                    me.exited(&watcher, code, &instance_dir, started_at as f64);
                });
            }
        }
        Ok(snapshot)
    }

    fn watch(&self, inst: &Arc<Inst>, rx: mpsc::Receiver<(Stream, String)>) {
        let (ready, server, early) = markers();
        let mut batch: Vec<Value> = Vec::new();
        let mut first: Option<Instant> = None;
        let mut early_failed = false;
        let id = js::string(&inst.info.lock().unwrap_or_else(|e| e.into_inner())["id"]);
        let flush = |batch: &mut Vec<Value>, first: &mut Option<Instant>| {
            *first = None;
            if !batch.is_empty() {
                self.emit("instance.log", json!({ "id": id, "lines": std::mem::take(batch) }));
            }
        };
        loop {
            let wait = first.map(|f| Duration::from_millis(100).saturating_sub(f.elapsed())).unwrap_or(Duration::from_secs(3600));
            match rx.recv_timeout(wait) {
                Ok((stream, text)) => {
                    let clean = redact_text(&text);
                    if let Some(f) = inst.log_file.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                        let _ = f.write_all(format!("{clean}\n").as_bytes());
                    }
                    let line = inst.log(stream.name(), &clean);
                    batch.push(line);
                    if first.is_none() {
                        first = Some(Instant::now());
                    }
                    if inst.status() == "starting" && (ready.is_match(&text) || server.is_match(&text)) {
                        inst.set("status", json!("running"));
                        self.updated(inst);
                    }
                    if inst.status() == "starting" && early.is_match(&text) && !early_failed {
                        early_failed = true;
                        inst.log("system", "[Modsmith] NeoForge could not start its early loading window and is waiting on an error dialog. Terminating the process; the next development launch disables the early window (config/fml.toml earlyWindowControl = false).");
                        if let Some(pid) = inst.pid {
                            std::thread::spawn(move || kill_tree(pid));
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => flush(&mut batch, &mut first),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if first.is_some_and(|f| f.elapsed() >= Duration::from_millis(100)) {
                flush(&mut batch, &mut first);
            }
        }
        flush(&mut batch, &mut first);
    }

    fn exited(&self, inst: &Arc<Inst>, code: Option<i32>, instance_dir: &Path, started_at: f64) {
        let crash = find_crash_report(instance_dir, started_at);
        {
            let mut info = inst.info.lock().unwrap_or_else(|e| e.into_inner());
            info.insert("exitCode".into(), code.map(|c| json!(c)).unwrap_or(Value::Null));
            info.insert("endedAt".into(), json!(crate::support::now_ms() as u64));
            if let Some(c) = &crash {
                info.insert("crashReport".into(), json!(c));
            }
            let stopping = info["status"] == "stopping";
            let status = if stopping && crash.is_none() {
                "exited"
            } else if crash.is_some() || code.is_some_and(|c| c != 0) {
                "crashed"
            } else {
                "exited"
            };
            info.insert("status".into(), json!(status));
        }
        let code_text = code.map(|c| c.to_string()).unwrap_or_else(|| "null".into());
        inst.log("system", &format!("[Modsmith] Process exited with code {code_text}{}", crash.map(|c| format!("; crash report {c}")).unwrap_or_default()));
        self.finish(inst);
    }

    fn finish(&self, inst: &Arc<Inst>) {
        inst.log_file.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(s) = &inst.session {
            self.bridge.close_session(s);
        }
        {
            let mut info = inst.info.lock().unwrap_or_else(|e| e.into_inner());
            let game = info.get("bridge").and_then(|b| b.get("game")).cloned();
            let mut b = Map::new();
            b.insert("connected".into(), json!(false));
            if let Some(g) = game {
                b.insert("game".into(), g);
            }
            info.insert("bridge".into(), Value::Object(b));
        }
        let snapshot = inst.snapshot();
        let _ = self.store.save_launch(&Self::launch_record(&snapshot));
        let id = js::string(&snapshot["id"]);
        self.running.lock().unwrap_or_else(|e| e.into_inner()).retain(|(i, _)| *i != id);
        {
            let mut history = self.history.lock().unwrap_or_else(|e| e.into_inner());
            history.retain(|(i, _)| *i != id);
            history.push((id, inst.clone()));
            if history.len() > 20 {
                history.remove(0);
            }
        }
        {
            let mut d = inst.done.lock().unwrap_or_else(|e| e.into_inner());
            *d = true;
            inst.done_cv.notify_all();
        }
        self.updated(inst);
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        self.find_any(id).map(|i| i.snapshot())
    }

    pub fn list(&self) -> Vec<Value> {
        let mut all: Vec<Value> = self.running.lock().unwrap_or_else(|e| e.into_inner()).iter().map(|(_, r)| r.snapshot()).collect();
        all.extend(self.history.lock().unwrap_or_else(|e| e.into_inner()).iter().map(|(_, r)| r.snapshot()));
        all.sort_by(|a, b| b["startedAt"].as_f64().unwrap_or(0.0).partial_cmp(&a["startedAt"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
        all
    }

    pub fn logs(&self, id: &str, q: &Query) -> Result<Value, String> {
        let inst = self.find_any(id).ok_or_else(|| format!("Unknown instance {id}"))?;
        let buf = inst.logs.lock().unwrap_or_else(|e| e.into_inner());
        Ok(json!({ "lines": buf.query(q), "lastSeq": buf.last_seq() }))
    }

    pub fn send_input(&self, id: &str, line: &str) -> Result<(), String> {
        let inst = self.find_running(id).ok_or_else(|| format!("Instance {id} is not running"))?;
        if inst.info.lock().unwrap_or_else(|e| e.into_inner())["side"] != "server" {
            return Err("Console input is only supported for dedicated servers".into());
        }
        let clean = Regex::new(r"[\r\n]+").expect("newline regex").replace_all(line, " ").to_string();
        if let Some(stdin) = inst.stdin.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            let _ = stdin.write_all(format!("{clean}\n").as_bytes());
            let _ = stdin.flush();
        }
        inst.log("system", &format!("> {line}"));
        Ok(())
    }

    pub fn stop(&self, id: &str, force: bool, timeout_ms: u64, graceful: Option<&dyn Fn() -> Result<bool, String>>) -> Result<Value, String> {
        let Some(r) = self.find_running(id) else {
            return self.get(id).ok_or_else(|| format!("Unknown instance {id}"));
        };
        if !force {
            r.set("status", json!("stopping"));
            self.updated(&r);
            let mut requested = false;
            if let Some(g) = graceful {
                match g() {
                    Ok(v) => requested = v,
                    Err(e) => {
                        r.log("system", &format!("[Modsmith] Graceful stop via bridge failed: {e}"));
                    }
                }
            }
            let side = js::string(&r.info.lock().unwrap_or_else(|e| e.into_inner())["side"]);
            if !requested && side == "server" {
                if let Some(stdin) = r.stdin.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                    let _ = stdin.write_all(b"stop\n");
                    let _ = stdin.flush();
                }
                requested = true;
            }
            if !requested && side == "client" && cfg!(windows) {
                if let Some(pid) = r.pid {
                    if let Some(w) = crate::win32::find_game_window(pid) {
                        requested = crate::win32::close_window(w.hwnd);
                    }
                }
            }
            r.log("system", if requested { "[Modsmith] Graceful stop requested" } else { "[Modsmith] No graceful stop mechanism available; terminating" });
            let done = r.wait(Duration::from_millis(if requested { timeout_ms } else { 0 }));
            if done {
                return Ok(r.snapshot());
            }
            r.log("system", &format!("[Modsmith] Process did not exit within {timeout_ms} ms; forcing termination"));
        }
        r.set("status", json!("stopping"));
        if let Some(pid) = r.pid {
            if crate::support::pid_alive(pid) {
                kill_tree(pid);
            }
        }
        r.wait(Duration::from_secs(10));
        Ok(r.snapshot())
    }

    pub fn running_ids(&self) -> Vec<String> {
        self.running.lock().unwrap_or_else(|e| e.into_inner()).iter().map(|(i, _)| i.clone()).collect()
    }
}
