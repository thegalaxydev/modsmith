use crate::bridge::Bridge;
use crate::instances::Instances;
use crate::java::Java;
use crate::manifest::Catalog;
use crate::ops::Ops;
use crate::profiles::Profiles;
use crate::providers::Providers;
use crate::store::Store;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

pub struct Runtime {
    pub store: Arc<Store>,
    pub catalog: Arc<Catalog>,
    pub providers: Arc<Providers>,
    pub profiles: Arc<Profiles>,
    pub ops: Arc<Ops>,
    pub java: Java,
    pub bridge: Arc<Bridge>,
    pub instances: Arc<Instances>,
    pub resources: PathBuf,
    pub data: PathBuf,
    pub cache: PathBuf,
    pub clients: Mutex<Value>,
    pub shutdown: OnceLock<Box<dyn Fn(bool) + Send + Sync>>,
}

pub fn s(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

pub fn basename(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| s(p))
}

pub fn undef(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "undefined".into(),
        Some(v) => crate::js::string(v),
    }
}

impl Runtime {
    pub fn emit(&self, event: &str, data: Value) {
        self.ops.emit_event(event, data);
    }

    pub fn downloads(&self) -> PathBuf {
        self.cache.join("downloads")
    }

    pub fn catalog_entry(&self, manifest: &Value) -> Option<Value> {
        manifest["platform"]["catalogEntry"].as_str().filter(|c| !c.is_empty()).and_then(|id| self.catalog.get(id)).cloned()
    }

    pub fn instance_or_err(&self, id: &str) -> Result<Value, String> {
        self.instances.get(id).ok_or_else(|| format!("Unknown instance {id}"))
    }

    pub fn bridge_call(&self, id: &str, method: &str, params: Value, timeout_ms: u64) -> Result<Value, String> {
        self.instance_or_err(id)?;
        self.bridge.call(id, method, params, timeout_ms)
    }

    pub fn system_info(&self) -> Value {
        let bridge_dir = self.resources.join("bridge");
        let mut jars: Vec<String> =
            std::fs::read_dir(&bridge_dir).map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|f| f.ends_with(".jar")).collect()).unwrap_or_default();
        jars.sort();
        json!({
            "product": crate::api::api().product,
            "version": crate::api::api().version,
            "platform": platform_text(),
            "node": null,
            "runtime": format!("rust {}", env!("CARGO_PKG_VERSION")),
            "dataDir": s(&self.data),
            "cacheDir": s(&self.cache),
            "resources": s(&self.resources),
            "bridgePort": self.bridge.port(),
            "bridgeJars": jars,
            "nativeViewport": if cfg!(windows) { "win32-reparent" } else if crate::win32::native_viewport() { "x11-reparent" } else { "unsupported" },
            "clients": self.clients.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            "demoMode": std::env::var("MODSMITH_DEMO").map(|v| v == "1").unwrap_or(false)
        })
    }

    pub fn capabilities(&self) -> Value {
        let adapters = [("fabric", "Fabric"), ("neoforge", "NeoForge")];
        Value::Array(
            adapters
                .iter()
                .map(|(id, name)| {
                    let catalog: Vec<Value> =
                        self.catalog.entries.iter().filter(|e| e["loader"] == *id).map(|e| json!({ "id": e["id"], "minecraft": e["minecraft"], "status": e["status"] })).collect();
                    json!({ "id": id, "name": name, "implemented": crate::scaffold::implemented(id), "capabilities": crate::scaffold::capabilities(id), "catalog": catalog })
                })
                .collect(),
        )
    }
}

fn platform_text() -> String {
    let os = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = crate::clientinstall::current_platform().arch;
    format!("{os} {arch} ({})", os_release())
}

#[cfg(windows)]
fn os_release() -> String {
    #[repr(C)]
    struct Info {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        csd: [u16; 128],
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(info: *mut Info) -> i32;
    }
    let mut info = Info { size: std::mem::size_of::<Info>() as u32, major: 0, minor: 0, build: 0, platform: 0, csd: [0; 128] };
    unsafe {
        RtlGetVersion(&mut info);
    }
    format!("{}.{}.{}", info.major, info.minor, info.build)
}

#[cfg(not(windows))]
fn os_release() -> String {
    std::fs::read_to_string("/proc/sys/kernel/osrelease").map(|s| s.trim().to_string()).unwrap_or_default()
}

pub fn mcp_launch() -> Option<(String, Vec<String>)> {
    let exe = std::env::current_exe().ok()?;
    let exe = crate::js::realpath(&exe).unwrap_or(exe);
    Some((s(&exe), vec!["mcp".into()]))
}

pub fn mcp_config() -> Value {
    let Some((command, args)) = mcp_launch() else { return json!({ "available": false, "reason": "MCP launch command unknown" }) };
    let quoted = args.iter().map(|a| format!("\"{a}\"")).collect::<Vec<_>>().join(" ");
    let cmd = format!("claude mcp add modsmith  -- \"{command}\" {quoted}");
    let cmd = cmd.split_whitespace().collect::<Vec<_>>().join(" ");
    json!({
        "available": true,
        "config": { "mcpServers": { "modsmith": { "command": command, "args": args, "env": {} } } },
        "claudeCodeCommand": cmd,
        "note": "The MCP server is a stdio process that connects to the running Modsmith service (starting it if needed), so the UI, CLI and assistants share the same instances and history."
    })
}
