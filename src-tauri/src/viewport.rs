use crate::service::Service;
use crate::win32::{self, DockState, Rect};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

struct Docked {
    instance_id: String,
    state: DockState,
    rect: Rect,
}

#[derive(Default)]
pub struct Viewport {
    docked: Mutex<Option<Docked>>,
    generation: AtomicU64,
}

pub type Shared = Arc<Viewport>;

pub fn on_main<R: Send + 'static>(app: &AppHandle, f: impl FnOnce() -> R + Send + 'static) -> Result<R, String> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

#[cfg(windows)]
fn host_hwnd(win: &WebviewWindow) -> Option<isize> {
    win.hwnd().ok().map(|h| h.0 as isize)
}

#[cfg(not(windows))]
fn host_hwnd(_win: &WebviewWindow) -> Option<isize> {
    None
}

fn screen_rect(win: &WebviewWindow, rect: Rect) -> Option<Rect> {
    let (ox, oy) = win32::client_origin(host_hwnd(win)?);
    let s = win.scale_factor().unwrap_or(1.0);
    Some(Rect { x: ox + rect.x * s, y: oy + rect.y * s, width: rect.width * s, height: rect.height * s })
}

pub fn emit_state(app: &AppHandle, state: Value) {
    let _ = app.emit("viewport:state", state);
}

impl Viewport {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Docked>> {
        self.docked.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn undock_current(&self, app: &AppHandle, reason: &str) {
        let taken = self.lock().take();
        let Some(d) = taken else { return };
        self.generation.fetch_add(1, Ordering::SeqCst);
        win32::undock(&d.state);
        emit_state(app, json!({ "docked": false, "instanceId": d.instance_id, "reason": reason }));
    }

    pub fn minimized(&self, app: &AppHandle) {
        let id = self.lock().as_ref().map(|d| d.instance_id.clone());
        if let Some(id) = id {
            emit_state(app, json!({ "docked": true, "instanceId": id, "minimized": true }));
        }
    }

    pub fn follow_window(&self, app: &AppHandle) {
        let current = self.lock().as_ref().map(|d| (d.state, d.rect));
        let (Some((state, rect)), Some(win)) = (current, main_window(app)) else { return };
        if win.is_minimized().unwrap_or(false) {
            return;
        }
        if let Some(screen) = screen_rect(&win, rect) {
            win32::move_docked(&state, screen);
        }
    }

    fn watch(self: &Arc<Self>, app: AppHandle, state: DockState) {
        let generation = self.generation.load(Ordering::SeqCst);
        let me = self.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(1));
            if me.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            if win32::is_window(state.child) {
                continue;
            }
            let id = {
                let mut slot = me.lock();
                if me.generation.load(Ordering::SeqCst) != generation {
                    return;
                }
                me.generation.fetch_add(1, Ordering::SeqCst);
                slot.take().map(|d| d.instance_id)
            };
            let _ = app.run_on_main_thread(move || win32::destroy_host(&state));
            if let Some(id) = id {
                emit_state(&app, json!({ "docked": false, "instanceId": id, "reason": "game window closed" }));
            }
            return;
        });
    }

    fn dock_on_main(self: &Arc<Self>, app: &AppHandle, instance_id: &str, game: win32::WindowInfo, rect: Rect) -> Value {
        let Some(win) = main_window(app) else { return json!({ "ok": false, "error": "Workbench window is not available" }) };
        let (Some(owner), Some(screen)) = (host_hwnd(&win), screen_rect(&win, rect)) else {
            return json!({ "ok": false, "error": "Workbench window handle is not available" });
        };
        let current = self.lock().as_ref().map(|d| (d.instance_id == instance_id, d.state));
        match current {
            Some((true, state)) => {
                if let Some(d) = self.lock().as_mut() {
                    d.rect = rect;
                }
                win32::move_docked(&state, screen);
                return json!({ "ok": true, "hwnd": state.child });
            }
            Some((false, _)) => self.undock_current(app, "replaced"),
            None => {}
        }
        let Some(state) = win32::dock(game.hwnd, owner, screen) else {
            return json!({ "ok": false, "error": "Could not create the game host window" });
        };
        *self.lock() = Some(Docked { instance_id: instance_id.to_string(), state, rect });
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.watch(app.clone(), state);
        emit_state(app, json!({ "docked": true, "instanceId": instance_id, "hwnd": game.hwnd, "title": game.title }));
        json!({ "ok": true, "hwnd": game.hwnd })
    }

    pub fn attach(self: &Arc<Self>, app: &AppHandle, service: &Service, instance_id: String, rect: Rect) -> Result<Value, String> {
        let inst = service.call("instance.status", json!({ "id": instance_id }))?;
        let pid = inst["pid"].as_u64().unwrap_or(0) as u32;
        let status = inst["status"].as_str().unwrap_or("");
        if pid == 0 || !matches!(status, "running" | "starting") {
            return Ok(json!({ "ok": false, "error": "Instance is not running" }));
        }
        if inst["side"] != "client" {
            return Ok(json!({ "ok": false, "error": "Only client instances have a game window" }));
        }
        let Some(game) = win32::find_game_window(pid) else {
            return Ok(json!({ "ok": false, "error": "Game window not found yet (still loading?). Try again once the window is visible." }));
        };
        let me = self.clone();
        let handle = app.clone();
        on_main(app, move || me.dock_on_main(&handle, &instance_id, game, rect))
    }

    pub fn update(&self, app: &AppHandle, rect: Rect) -> Value {
        let state = {
            let mut slot = self.lock();
            let Some(d) = slot.as_mut() else { return json!({ "ok": false }) };
            d.rect = rect;
            d.state
        };
        if let Some(screen) = main_window(app).and_then(|w| screen_rect(&w, rect)) {
            win32::move_docked(&state, screen);
        }
        json!({ "ok": true })
    }

    pub fn set_visible(&self, visible: bool) -> Value {
        let state = self.lock().as_ref().map(|d| d.state);
        let Some(state) = state else { return json!({ "ok": false }) };
        win32::set_visible(&state, visible);
        json!({ "ok": true })
    }

    pub fn focus(&self) -> Value {
        let state = self.lock().as_ref().map(|d| d.state);
        let Some(state) = state else { return json!({ "ok": false }) };
        win32::focus_docked(&state);
        json!({ "ok": true })
    }

    pub fn status(&self) -> Value {
        match self.lock().as_ref() {
            Some(d) => json!({ "docked": true, "instanceId": d.instance_id, "hwnd": d.state.child }),
            None => json!({ "docked": false }),
        }
    }

    pub fn bring_to_front(&self, service: &Service, instance_id: &str) -> Result<Value, String> {
        let inst = service.call("instance.status", json!({ "id": instance_id }))?;
        let pid = inst["pid"].as_u64().unwrap_or(0) as u32;
        let game = if pid == 0 { None } else { win32::find_game_window(pid) };
        let Some(game) = game else { return Ok(json!({ "ok": false, "error": "Game window not found" })) };
        Ok(json!({ "ok": win32::bring_to_front(game.hwnd) }))
    }
}
