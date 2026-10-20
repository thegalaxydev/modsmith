mod activity;
mod api;
mod detect;
mod handlers;
mod http;
mod jarmeta;
mod js;
mod manifest;
mod mrpack;
mod ops;
mod packimport;
mod packlink;
mod paths;
mod profiles;
mod providers;
mod resolver;
mod schema;
mod secrets;
mod server;
mod store;
mod support;
mod versionrange;
mod worker;
mod workspace;

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use support::{Lock, Log};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use worker::{Worker, WorkerEvent};

fn validate_batch() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines().map_while(Result::ok) {
        let req: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
        let reply = match req["schema"].as_str() {
            Some("manifest") => match manifest::validate_manifest(&req["value"]) {
                (Some(m), _) => json!({ "ok": true, "value": m }),
                (None, errors) => json!({ "ok": false, "errors": errors }),
            },
            Some(name) => match schema::parse(&manifest::schemas()[name], &req["value"]) {
                Ok(v) => json!({ "ok": true, "value": v }),
                Err(issues) => json!({ "ok": false, "errors": issues.iter().map(schema::Issue::text).collect::<Vec<_>>() }),
            },
            None => match api::validate(req["method"].as_str().unwrap_or_default(), &req["params"]) {
                Ok(params) => json!({ "ok": true, "params": params }),
                Err(error) => json!({ "ok": false, "error": error }),
            },
        };
        let _ = writeln!(out, "{reply}");
    }
}

struct Service {
    paths: paths::Paths,
    lock: Lock,
    stopping: AtomicBool,
}

impl Service {
    fn remove_service_file(&self) {
        let file = self.paths.service_file();
        let ours = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).map(|v| v["pid"] == std::process::id()).unwrap_or(false);
        if ours {
            let _ = std::fs::remove_file(&file);
        }
    }

    fn finish(&self, code: i32) -> ! {
        self.remove_service_file();
        self.lock.release();
        std::process::exit(code)
    }
}

async fn run() -> i32 {
    let paths = paths::resolve();
    let log = Arc::new(Log::open(&paths.log_file()));
    let Some(lock) = Lock::acquire(&paths.lock_file()) else {
        log.write("another service owns the lock; exiting");
        return 0;
    };
    let svc = Arc::new(Service { paths, lock, stopping: AtomicBool::new(false) });
    let store = match store::Store::open(&svc.paths.data.join("workbench.sqlite")) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            log.write(&format!("fatal: could not open the database: {e}"));
            svc.finish(1);
        }
    };
    let catalog = match manifest::find_resources_dir().ok_or_else(|| "resources directory not found".to_string()).and_then(|dir| manifest::load_catalog(&dir)) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            log.write(&format!("fatal: could not load the compatibility catalog: {e}"));
            svc.finish(1);
        }
    };
    let node = worker::locate_node();
    let Some(script) = worker::locate_script() else {
        log.write("fatal: worker script dist/worker/main.cjs not found");
        svc.finish(1);
    };
    let (events_tx, mut events_rx) = mpsc::unbounded_channel::<WorkerEvent>();
    let (worker, mut child, ready) = match Worker::spawn(log.clone(), node.clone(), script.clone(), events_tx).await {
        Ok(w) => w,
        Err(e) => {
            log.write(&format!("fatal: {e}"));
            svc.finish(1);
        }
    };
    let listener = match TcpListener::bind(("127.0.0.1", 0)).await {
        Ok(l) => l,
        Err(e) => {
            log.write(&format!("fatal: could not listen: {e}"));
            worker.stop(false);
            svc.finish(1);
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let token = support::random_token();
    let hub = server::Hub::new(token.clone(), worker.clone(), store, catalog, svc.paths.data.clone(), svc.paths.cache.clone());
    let info = json!({ "pid": std::process::id(), "port": port, "token": token, "version": api::api().version, "startedAt": support::now_ms() as u64 });
    if let Err(e) = support::write_atomic(&svc.paths.service_file(), &info.to_string()) {
        log.write(&format!("fatal: could not write service.json: {e}"));
        worker.stop(false);
        svc.finish(1);
    }
    let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
    log.write(&format!("service started pid {} port {port} bridge {} runtime {exe} worker {} pid {} ({})", std::process::id(), ready.bridge_port, ready.runtime, ready.pid, script.display()));
    tokio::spawn(hub.clone().serve(listener));

    let (stop_tx, mut stop_rx) = mpsc::unbounded_channel::<bool>();
    let fan = hub.clone();
    let stop_from_worker = stop_tx.clone();
    tokio::spawn(async move {
        while let Some(ev) = events_rx.recv().await {
            match ev {
                WorkerEvent::Event(line) => fan.broadcast(line),
                WorkerEvent::Shutdown(stop_instances) => {
                    let _ = stop_from_worker.send(stop_instances);
                }
            }
        }
    });
    let stop_signal = stop_tx.clone();
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            let _ = stop_signal.send(true);
        }
    });

    tokio::select! {
        status = child.wait() => {
            log.write(&format!("worker exited unexpectedly ({})", status.map(|s| s.to_string()).unwrap_or_else(|e| e.to_string())));
            hub.close_all();
            tokio::time::sleep(Duration::from_millis(200)).await;
            svc.finish(1);
        }
        Some(stop_instances) = stop_rx.recv() => {
            if svc.stopping.swap(true, Ordering::SeqCst) {
                return 0;
            }
            log.write(&format!("shutting down (stopInstances={stop_instances})"));
            svc.remove_service_file();
            hub.close_all();
            worker.stop(stop_instances);
            match tokio::time::timeout(Duration::from_secs(120), child.wait()).await {
                Ok(_) => {}
                Err(_) => {
                    log.write("worker did not stop in time; killing it");
                    let _ = child.kill().await;
                }
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
            svc.finish(0);
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("validate") => validate_batch(),
        Some("--version") => println!("{} {}", paths::PRODUCT_NAME, api::api().version),
        _ => {
            let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio runtime");
            let code = rt.block_on(run());
            std::process::exit(code);
        }
    }
}
