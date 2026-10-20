#[cfg(target_os = "linux")]
mod imp;

#[derive(Clone, Debug)]
pub struct GameWindow {
    pub id: u32,
    pub title: String,
    pub visible: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Dock {
    pub game: u32,
    pub host: u32,
    pub owner: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub fn native_wayland_requested() -> bool {
    std::env::var("MODSMITH_NATIVE_WAYLAND").map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false)
}

pub fn wayland_session() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty())
}

pub fn x11_available() -> bool {
    cfg!(target_os = "linux") && std::env::var_os("DISPLAY").is_some_and(|v| !v.is_empty())
}

#[cfg(target_os = "linux")]
pub use imp::{area_of, available, close_window, destroy_host, dock, find_game_window, focus, is_window, move_dock, origin, raise, set_visible, undock};

#[cfg(not(target_os = "linux"))]
mod stub {
    use super::{Area, Dock, GameWindow};
    pub fn available() -> bool {
        false
    }
    pub fn find_game_window(_pid: u32) -> Option<GameWindow> {
        None
    }
    pub fn close_window(_id: u32) -> bool {
        false
    }
    pub fn is_window(_id: u32) -> bool {
        false
    }
    pub fn raise(_id: u32) -> bool {
        false
    }
    pub fn origin(_id: u32) -> (i32, i32) {
        (0, 0)
    }
    pub fn area_of(_id: u32) -> Option<Area> {
        None
    }
    pub fn dock(_game: u32, _owner: u32, _area: Area) -> Option<Dock> {
        None
    }
    pub fn move_dock(_d: &Dock, _area: Area) {}
    pub fn set_visible(_d: &Dock, _visible: bool) {}
    pub fn focus(_d: &Dock) {}
    pub fn undock(_d: &Dock) {}
    pub fn destroy_host(_d: &Dock) {}
}

#[cfg(not(target_os = "linux"))]
pub use stub::{area_of, available, close_window, destroy_host, dock, find_game_window, focus, is_window, move_dock, origin, raise, set_visible, undock};
