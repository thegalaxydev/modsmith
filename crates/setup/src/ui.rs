use crate::install::{self, Env, Existing, Options, Stop};
use crate::{PAYLOAD, VERSION};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::windows::WindowBuilderExtWindows;
use tao::window::WindowBuilder;
use wry::{WebContext, WebViewBuilder};

#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    Install,
    Uninstall,
}

enum UserEvent {
    Ipc(String),
    Eval(String),
}

const BRAND: &str = include_str!("../../../resources/brand/modsmith.svg");

fn logo_paths() -> &'static str {
    let start = BRAND.find("<svg").and_then(|i| BRAND[i..].find('>').map(|j| i + j + 1)).unwrap_or(0);
    let end = BRAND.rfind("</svg>").unwrap_or(BRAND.len());
    &BRAND[start..end]
}

pub fn message(text: &str) {
    let _ = rfd::MessageDialog::new().set_title("Modsmith Setup").set_description(text).set_level(rfd::MessageLevel::Error).show();
}

fn js_call(name: &str, args: &[Value]) -> String {
    let list = args.iter().map(|a| a.to_string()).collect::<Vec<_>>().join(",");
    format!("window.setup.{name}({list})")
}

fn send(proxy: &EventLoopProxy<UserEvent>, name: &str, args: &[Value]) {
    let _ = proxy.send_event(UserEvent::Eval(js_call(name, args)));
}

fn pick_folder(current: &str) -> Option<PathBuf> {
    let start = Path::new(current);
    let mut dialog = rfd::FileDialog::new().set_title("Choose where to install Modsmith");
    if let Some(parent) = start.parent().filter(|p| p.exists()) {
        dialog = dialog.set_directory(parent);
    }
    let picked = dialog.pick_folder()?;
    let named = picked.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("Modsmith"));
    Some(if named { picked } else { picked.join("Modsmith") })
}

fn open_url(url: &str) {
    if url.starts_with("https://") {
        let _ = std::process::Command::new("explorer.exe").arg(url).spawn();
    }
}

pub fn run(mode: Mode, dir: PathBuf, desktop: bool, existing: Option<Existing>, env: Env) -> i32 {
    let state = json!({
        "mode": if mode == Mode::Install { "install" } else { "uninstall" },
        "version": VERSION,
        "dir": dir.to_string_lossy(),
        "desktop": desktop,
        "existing": existing.as_ref().map(|e| json!({ "dir": e.dir.to_string_lossy(), "version": e.version })),
        "hasPayload": install::has_payload(PAYLOAD) || mode == Mode::Uninstall,
        "test": env.test,
    });
    let html = include_str!("ui.html").replace("@@LOGO_PATHS@@", logo_paths());
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let title = if mode == Mode::Install { "Modsmith Setup" } else { "Uninstall Modsmith" };
    let window = match WindowBuilder::new()
        .with_title(title)
        .with_inner_size(LogicalSize::new(620.0, 440.0))
        .with_resizable(false)
        .with_decorations(false)
        .with_undecorated_shadow(true)
        .build(&event_loop)
    {
        Ok(w) => w,
        Err(e) => {
            message(&format!("Could not open the setup window: {e}"));
            return 1;
        }
    };
    let data = std::env::temp_dir().join("modsmith-setup-webview");
    let mut context = WebContext::new(Some(data));
    let ipc_proxy = proxy.clone();
    let webview = match WebViewBuilder::new_with_web_context(&mut context)
        .with_initialization_script(format!("window.SETUP = {state};"))
        .with_html(html)
        .with_background_color((17, 19, 22, 255))
        .with_devtools(false)
        .with_ipc_handler(move |req| {
            let _ = ipc_proxy.send_event(UserEvent::Ipc(req.body().clone()));
        })
        .build(&window)
    {
        Ok(w) => w,
        Err(_) => {
            let go = rfd::MessageDialog::new()
                .set_title("Modsmith Setup")
                .set_description("Modsmith needs the Microsoft Edge WebView2 Runtime, which is not installed on this computer. Open the download page?")
                .set_buttons(rfd::MessageButtons::YesNo)
                .show();
            if go == rfd::MessageDialogResult::Yes {
                open_url("https://developer.microsoft.com/microsoft-edge/webview2/");
            }
            return 1;
        }
    };
    let env = Arc::new(env);
    let mut code = 0;
    let mut busy = false;
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } if !busy => *control_flow = ControlFlow::Exit,
            Event::UserEvent(UserEvent::Eval(js)) => {
                if js.starts_with("window.setup.done") || js.starts_with("window.setup.error") || js.starts_with("window.setup.running") {
                    busy = false;
                    code = if js.starts_with("window.setup.done") { 0 } else { 1 };
                }
                let _ = webview.evaluate_script(&js);
            }
            Event::UserEvent(UserEvent::Ipc(body)) => {
                let msg: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                match msg["cmd"].as_str().unwrap_or("") {
                    "drag" => {
                        let _ = window.drag_window();
                    }
                    "minimize" => window.set_minimized(true),
                    "close" if !busy => *control_flow = ControlFlow::Exit,
                    "open" => open_url(msg["url"].as_str().unwrap_or("")),
                    "browse" => {
                        if let Some(p) = pick_folder(msg["dir"].as_str().unwrap_or("")) {
                            let _ = webview.evaluate_script(&js_call("dir", &[json!(p.to_string_lossy())]));
                        }
                    }
                    "launch" => {
                        install::launch(Path::new(msg["dir"].as_str().unwrap_or("")));
                        *control_flow = ControlFlow::Exit;
                    }
                    "install" if !busy && mode == Mode::Install => {
                        busy = true;
                        let opts = Options { dir: PathBuf::from(msg["dir"].as_str().unwrap_or("")), desktop: msg["desktop"] == true };
                        let force = msg["force"] == true;
                        let p = proxy.clone();
                        let env = env.clone();
                        std::thread::spawn(move || {
                            crate::system::init_com();
                            send(&p, "progress", &[json!(0.02), json!("Closing Modsmith if it is open")]);
                            if matches!(install::stop_running(&env, &opts.dir, force), Stop::StillRunning) {
                                return send(&p, "running", &[]);
                            }
                            let report = |f: f64, name: &str| send(&p, "progress", &[json!(f), json!(name)]);
                            match install::install(&env, &opts, PAYLOAD, VERSION, &report) {
                                Ok(()) => send(&p, "done", &[]),
                                Err(e) => send(&p, "error", &[json!(e)]),
                            }
                        });
                    }
                    "uninstall" if !busy && mode == Mode::Uninstall => {
                        busy = true;
                        let delete_data = msg["deleteData"] == true;
                        let force = msg["force"] == true;
                        let p = proxy.clone();
                        let env = env.clone();
                        let dir = dir.clone();
                        std::thread::spawn(move || {
                            crate::system::init_com();
                            send(&p, "progress", &[json!(0.02), json!("Closing Modsmith if it is open")]);
                            if matches!(install::stop_running(&env, &dir, force), Stop::StillRunning) {
                                return send(&p, "running", &[]);
                            }
                            let report = |f: f64, name: &str| send(&p, "progress", &[json!(f), json!(name)]);
                            match install::uninstall(&env, &dir, delete_data, &report) {
                                Ok(()) => send(&p, "done", &[]),
                                Err(e) => send(&p, "error", &[json!(e)]),
                            }
                        });
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        if *control_flow == ControlFlow::Exit {
            if mode == Mode::Uninstall {
                crate::delete_self_later();
            }
            std::process::exit(code);
        }
    });
}
