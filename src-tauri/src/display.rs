use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicBool, Ordering};

static NATIVE_WAYLAND: AtomicBool = AtomicBool::new(false);

fn config_file() -> std::path::PathBuf {
    crate::service::data_dir().join("shell.json")
}

fn read_config() -> Map<String, Value> {
    std::fs::read_to_string(config_file()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

fn env_set(key: &str) -> bool {
    std::env::var_os(key).is_some_and(|v| !v.is_empty())
}

pub fn prepare() {
    if !cfg!(target_os = "linux") {
        return;
    }
    let configured = read_config().get("nativeWayland").and_then(Value::as_bool).unwrap_or(false);
    let from_env = std::env::var("MODSMITH_NATIVE_WAYLAND").ok().map(|v| v == "1" || v.eq_ignore_ascii_case("true"));
    let wayland = env_set("WAYLAND_DISPLAY");
    let native = wayland && (from_env.unwrap_or(configured) || !env_set("DISPLAY"));
    NATIVE_WAYLAND.store(native, Ordering::SeqCst);
    if wayland && !native && !env_set("GDK_BACKEND") {
        std::env::set_var("GDK_BACKEND", "x11");
    }
    std::env::set_var("MODSMITH_NATIVE_WAYLAND", if native { "1" } else { "0" });
}

pub fn current() -> Value {
    let kind = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if NATIVE_WAYLAND.load(Ordering::SeqCst) {
        "wayland"
    } else if env_set("WAYLAND_DISPLAY") {
        "xwayland"
    } else if env_set("DISPLAY") {
        "x11"
    } else {
        "none"
    };
    json!({ "server": kind, "waylandSession": env_set("WAYLAND_DISPLAY"), "nativeWayland": NATIVE_WAYLAND.load(Ordering::SeqCst) })
}

pub fn set_native_wayland(enabled: bool) -> Result<(), String> {
    let mut cfg = read_config();
    cfg.insert("nativeWayland".into(), Value::Bool(enabled));
    let file = config_file();
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, serde_json::to_string_pretty(&Value::Object(cfg)).unwrap_or_default()).map_err(|e| e.to_string())
}

pub fn docking_unavailable_reason() -> String {
    if cfg!(target_os = "linux") {
        if NATIVE_WAYLAND.load(Ordering::SeqCst) {
            "Embedding needs X11, and Modsmith is running on native Wayland (Settings, Interface). The game opens in its own window.".into()
        } else {
            "No X11 display was found, so the game opens in its own window.".into()
        }
    } else {
        "Embedding the game window is available on Windows and Linux (X11). The game opens in its own window.".into()
    }
}
