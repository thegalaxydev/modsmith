use serde::{Deserialize, Serialize};
#[derive(Deserialize, Serialize, Clone, Copy, Debug)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug)]
pub struct WindowInfo {
    pub hwnd: isize,
    pub title: String,
}

#[derive(Clone, Copy, Debug)]
pub struct DockState {
    pub child: isize,
    dock: x11win::Dock,
}

fn area(r: Rect) -> x11win::Area {
    x11win::Area { x: r.x.round() as i32, y: r.y.round() as i32, width: (r.width.round() as u32).max(1), height: (r.height.round() as u32).max(1) }
}

pub fn supported() -> bool {
    x11win::available()
}

pub fn find_game_window(pid: u32) -> Option<WindowInfo> {
    x11win::find_game_window(pid).map(|w| WindowInfo { hwnd: w.id as isize, title: w.title })
}

pub fn process_alive(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).ok().and_then(|s| s.rsplit(')').next().map(|rest| !rest.trim_start().starts_with('Z'))).unwrap_or(false)
}

pub fn is_window(hwnd: isize) -> bool {
    x11win::is_window(hwnd as u32)
}

pub fn bring_to_front(hwnd: isize) -> bool {
    x11win::raise(hwnd as u32)
}

pub fn client_origin(hwnd: isize) -> (f64, f64) {
    let (x, y) = x11win::origin(hwnd as u32);
    (x as f64, y as f64)
}

pub fn dock(child: isize, owner: isize, screen: Rect) -> Option<DockState> {
    x11win::dock(child as u32, owner as u32, area(screen)).map(|dock| DockState { child, dock })
}

pub fn move_docked(state: &DockState, screen: Rect) {
    x11win::move_dock(&state.dock, area(screen));
}

pub fn set_visible(state: &DockState, visible: bool) {
    x11win::set_visible(&state.dock, visible);
}

pub fn undock(state: &DockState) {
    x11win::undock(&state.dock);
}

pub fn destroy_host(state: &DockState) {
    x11win::destroy_host(&state.dock);
}

pub fn focus_docked(state: &DockState) {
    x11win::focus(&state.dock);
}
