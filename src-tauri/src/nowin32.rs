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
}

pub fn supported() -> bool {
    false
}

pub fn find_game_window(_pid: u32) -> Option<WindowInfo> {
    None
}

pub fn process_alive(_pid: u32) -> bool {
    true
}

pub fn is_window(_hwnd: isize) -> bool {
    false
}

pub fn bring_to_front(_hwnd: isize) -> bool {
    false
}

pub fn client_origin(_hwnd: isize) -> (f64, f64) {
    (0.0, 0.0)
}

pub fn dock(_child: isize, _owner: isize, _screen: Rect) -> Option<DockState> {
    None
}

pub fn move_docked(_state: &DockState, _screen: Rect) {}

pub fn set_visible(_state: &DockState, _visible: bool) {}

pub fn undock(_state: &DockState) {}

pub fn destroy_host(_state: &DockState) {}

pub fn focus_docked(_state: &DockState) {}
