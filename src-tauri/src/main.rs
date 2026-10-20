#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod display;
mod service;
mod viewport;
#[cfg(windows)]
mod win32;
#[cfg(target_os = "linux")]
#[path = "x11.rs"]
mod win32;
#[cfg(not(any(windows, target_os = "linux")))]
#[path = "nowin32.rs"]
mod win32;

use serde::Deserialize;
use serde_json::{json, Value};
use service::{Runtime, Service};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};
use tauri_plugin_opener::OpenerExt;
use win32::Rect;

#[derive(Deserialize)]
struct Filter {
    name: String,
    extensions: Vec<String>,
}

type Svc<'a> = State<'a, Arc<Service>>;
type Vp<'a> = State<'a, viewport::Shared>;

async fn blocking<R: Send + 'static>(f: impl FnOnce() -> Result<R, String> + Send + 'static) -> Result<R, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn app_endpoint(service: Svc<'_>) -> Result<Value, String> {
    let service = service.inner().clone();
    let sf = blocking(move || service.ensure()).await?;
    Ok(json!({ "url": format!("ws://127.0.0.1:{}/rpc", sf.port), "token": sf.token }))
}

#[tauri::command]
fn app_info() -> Value {
    let platform = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let webview = tauri::webview_version().unwrap_or_default();
    json!({
        "platform": platform,
        "versions": { "modsmith": env!("CARGO_PKG_VERSION"), "tauri": tauri::VERSION, "webview": webview },
        "nativeViewport": win32::supported(),
        "display": display::current()
    })
}

#[tauri::command]
fn shell_report_error(kind: String, message: String, stack: String) {
    eprintln!("[renderer {kind}] {message}\n{stack}");
}

#[tauri::command]
fn shell_set_native_wayland(enabled: bool) -> Result<Value, String> {
    display::set_native_wayland(enabled)?;
    Ok(json!({ "ok": true, "restartRequired": true }))
}

fn file_dialog(app: &AppHandle, title: &str, filters: &[Filter]) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    let mut b = app.dialog().file().set_title(title);
    if let Some(w) = app.get_webview_window("main") {
        b = b.set_parent(&w);
    }
    for f in filters {
        let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
        b = b.add_filter(&f.name, &exts);
    }
    b
}

fn picked(p: Option<tauri_plugin_dialog::FilePath>) -> Option<String> {
    p.and_then(|p| p.into_path().ok()).map(|p| p.display().to_string())
}

#[tauri::command]
async fn dialog_directory(app: AppHandle, title: String) -> Result<Option<String>, String> {
    blocking(move || Ok(picked(file_dialog(&app, &title, &[]).blocking_pick_folder()))).await
}

#[tauri::command]
async fn dialog_file(app: AppHandle, title: String, filters: Vec<Filter>) -> Result<Option<String>, String> {
    blocking(move || Ok(picked(file_dialog(&app, &title, &filters).blocking_pick_file()))).await
}

#[tauri::command]
async fn dialog_save(app: AppHandle, title: String, default_path: String, filters: Vec<Filter>) -> Result<Option<String>, String> {
    blocking(move || {
        let mut b = file_dialog(&app, &title, &filters);
        let path = Path::new(&default_path);
        if let Some(dir) = path.parent().filter(|d| d.is_dir()) {
            b = b.set_directory(dir);
        }
        if let Some(name) = path.file_name() {
            b = b.set_file_name(name.to_string_lossy());
        }
        Ok(picked(b.blocking_save_file()))
    })
    .await
}

fn message(app: &AppHandle, text: String, buttons: MessageDialogButtons, kind: MessageDialogKind) -> tauri_plugin_dialog::MessageDialogBuilder<tauri::Wry> {
    let mut b = app.dialog().message(text).title("Modsmith").buttons(buttons).kind(kind);
    if let Some(w) = app.get_webview_window("main") {
        b = b.parent(&w);
    }
    b
}

#[tauri::command]
async fn dialog_confirm(app: AppHandle, text: String) -> Result<bool, String> {
    #[cfg(windows)]
    let owner = app.get_webview_window("main").and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize).unwrap_or(0);
    #[cfg(not(windows))]
    let owner = 0;
    blocking(move || match win32::confirm(owner, &text) {
        Some(answer) => Ok(answer),
        None => Ok(message(&app, text, MessageDialogButtons::YesNo, MessageDialogKind::Warning).blocking_show_with_result() == MessageDialogResult::Yes),
    })
    .await
}

#[tauri::command]
async fn dialog_alert(app: AppHandle, text: String) -> Result<(), String> {
    blocking(move || {
        message(&app, text, MessageDialogButtons::Ok, MessageDialogKind::Info).blocking_show();
        Ok(())
    })
    .await
}

#[tauri::command]
fn shell_open_path(app: AppHandle, path: String) -> Result<String, String> {
    if !Path::new(&path).exists() {
        return Err("Path does not exist".into());
    }
    Ok(app.opener().open_path(&path, None::<&str>).err().map(|e| e.to_string()).unwrap_or_default())
}

#[tauri::command]
fn shell_show_item(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn shell_open_external(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Only https links can be opened".into());
    }
    app.opener().open_url(&url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
async fn viewport_attach(app: AppHandle, service: Svc<'_>, vp: Vp<'_>, instance_id: String, rect: Rect) -> Result<Value, String> {
    if !win32::supported() {
        return Ok(json!({ "ok": false, "error": display::docking_unavailable_reason() }));
    }
    let (service, vp) = (service.inner().clone(), vp.inner().clone());
    let r = blocking(move || vp.attach(&app, &service, instance_id, rect)).await;
    Ok(r.unwrap_or_else(|e| json!({ "ok": false, "error": e })))
}

#[tauri::command]
async fn viewport_update(app: AppHandle, vp: Vp<'_>, rect: Rect) -> Result<Value, String> {
    let vp = vp.inner().clone();
    let handle = app.clone();
    viewport::on_main(&app, move || vp.update(&handle, rect))
}

#[tauri::command]
async fn viewport_visible(app: AppHandle, vp: Vp<'_>, visible: bool) -> Result<Value, String> {
    let vp = vp.inner().clone();
    viewport::on_main(&app, move || vp.set_visible(visible))
}

#[tauri::command]
async fn viewport_focus(app: AppHandle, vp: Vp<'_>) -> Result<Value, String> {
    let vp = vp.inner().clone();
    viewport::on_main(&app, move || vp.focus())
}

#[tauri::command]
async fn viewport_detach(app: AppHandle, vp: Vp<'_>) -> Result<Value, String> {
    let vp = vp.inner().clone();
    let handle = app.clone();
    viewport::on_main(&app, move || vp.undock_current(&handle, "detached by user"))?;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
fn viewport_status(vp: Vp<'_>) -> Value {
    vp.status()
}

#[tauri::command]
async fn viewport_bring_to_front(service: Svc<'_>, vp: Vp<'_>, instance_id: String) -> Result<Value, String> {
    if !win32::supported() {
        return Ok(json!({ "ok": false, "error": display::docking_unavailable_reason() }));
    }
    let (service, vp) = (service.inner().clone(), vp.inner().clone());
    let r = blocking(move || vp.bring_to_front(&service, &instance_id)).await;
    Ok(r.unwrap_or_else(|e| json!({ "ok": false, "error": e })))
}

fn plain(p: PathBuf) -> PathBuf {
    match p.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p,
    }
}

fn locate_runtime() -> Runtime {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default();
    let bin = if cfg!(windows) { "modsmith-service.exe" } else { "modsmith-service" };
    let service = std::env::var_os("MODSMITH_SERVICE_BIN").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| exe_dir.join(bin));
    Runtime { service: plain(service) }
}

fn allowed_navigation(url: &tauri::Url, dev: Option<&str>) -> bool {
    matches!(url.host_str(), Some("tauri.localhost")) || url.scheme() == "tauri" || dev.is_some_and(|d| url.as_str().starts_with(d))
}

fn create_window(app: &AppHandle) -> tauri::Result<()> {
    let dev = std::env::var("MODSMITH_DEV_URL").ok().filter(|u| !u.is_empty());
    let url = match dev.as_deref().and_then(|u| u.parse().ok()) {
        Some(u) => WebviewUrl::External(u),
        None => WebviewUrl::App("index.html".into()),
    };
    let opener = app.clone();
    WebviewWindowBuilder::new(app, "main", url)
        .title("Modsmith")
        .inner_size(1600.0, 1000.0)
        .min_inner_size(960.0, 620.0)
        .background_color(tauri::window::Color(0x14, 0x16, 0x1a, 0xff))
        .visible(false)
        .initialization_script(include_str!("shim.js"))
        .on_navigation(move |url| {
            let ok = allowed_navigation(url, dev.as_deref());
            if !ok && url.scheme() == "https" {
                let _ = opener.opener().open_url(url.as_str(), None::<&str>);
            }
            ok
        })
        .on_page_load(|w, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = w.show();
            }
        })
        .build()?;
    #[cfg(debug_assertions)]
    if std::env::var("MODSMITH_DEVTOOLS").is_ok_and(|v| v == "1") {
        if let Some(w) = app.get_webview_window("main") {
            w.open_devtools();
        }
    }
    Ok(())
}

#[cfg(unix)]
fn exit_on_signals(app: AppHandle) {
    use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
    let Ok(mut signals) = signal_hook::iterator::Signals::new([SIGTERM, SIGINT, SIGHUP]) else { return };
    std::thread::spawn(move || {
        if signals.forever().next().is_some() {
            let handle = app.clone();
            let _ = viewport::on_main(&app, move || handle.state::<viewport::Shared>().undock_current(&handle, "workbench closing"));
            app.exit(0);
        }
    });
}

fn main() {
    display::prepare();
    let vp: viewport::Shared = Arc::default();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(vp)
        .setup(|app| {
            let runtime = locate_runtime();
            app.manage(Arc::new(Service::new(runtime)));
            create_window(app.handle())?;
            #[cfg(unix)]
            exit_on_signals(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            let vp = app.state::<viewport::Shared>();
            match event {
                WindowEvent::CloseRequested { .. } => vp.undock_current(app, "workbench closing"),
                WindowEvent::Resized(_) if window.is_minimized().unwrap_or(false) => vp.minimized(app),
                WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => vp.follow_window(app),
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_endpoint,
            app_info,
            dialog_directory,
            dialog_file,
            dialog_save,
            dialog_confirm,
            dialog_alert,
            shell_open_path,
            shell_show_item,
            shell_open_external,
            viewport_attach,
            viewport_update,
            viewport_visible,
            viewport_focus,
            viewport_detach,
            viewport_status,
            viewport_bring_to_front,
            shell_set_native_wayland,
            shell_report_error
        ])
        .run(tauri::generate_context!())
        .expect("error while running Modsmith");
}
