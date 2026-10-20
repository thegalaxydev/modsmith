use serde_json::{json, Value};

pub struct WindowInfo {
    pub hwnd: isize,
    pub class_name: String,
    pub title: String,
    pub visible: bool,
}

#[cfg(windows)]
mod imp {
    use super::WindowInfo;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetClassNameW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, WM_CLOSE};

    struct Search {
        pids: Vec<u32>,
        found: Vec<WindowInfo>,
    }

    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let search = &mut *(lparam.0 as *mut Search);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if search.pids.contains(&pid) {
            let mut class = [0u16; 256];
            let n = GetClassNameW(hwnd, &mut class);
            let mut title = [0u16; 512];
            let t = GetWindowTextW(hwnd, &mut title);
            search.found.push(WindowInfo {
                hwnd: hwnd.0 as isize,
                class_name: String::from_utf16_lossy(&class[..n.max(0) as usize]),
                title: String::from_utf16_lossy(&title[..t.max(0) as usize]),
                visible: IsWindowVisible(hwnd).as_bool(),
            });
        }
        BOOL(1)
    }

    pub fn list_windows(pids: &[u32]) -> Vec<WindowInfo> {
        let mut search = Search { pids: pids.to_vec(), found: Vec::new() };
        unsafe {
            let _ = EnumWindows(Some(visit), LPARAM(&mut search as *mut Search as isize));
        }
        search.found
    }

    pub fn close_window(hwnd: isize) -> bool {
        unsafe { PostMessageW(Some(HWND(hwnd as *mut core::ffi::c_void)), WM_CLOSE, WPARAM(0), LPARAM(0)).is_ok() }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::WindowInfo;
    pub fn list_windows(pids: &[u32]) -> Vec<WindowInfo> {
        pids.iter()
            .filter_map(|p| x11win::find_game_window(*p))
            .map(|w| WindowInfo { hwnd: w.id as isize, class_name: "GLFW".into(), title: w.title, visible: w.visible })
            .collect()
    }
    pub fn close_window(hwnd: isize) -> bool {
        x11win::close_window(hwnd as u32)
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    use super::WindowInfo;
    pub fn list_windows(_: &[u32]) -> Vec<WindowInfo> {
        Vec::new()
    }
    pub fn close_window(_: isize) -> bool {
        false
    }
}

pub fn native_viewport() -> bool {
    cfg!(windows) || (cfg!(target_os = "linux") && x11win_available())
}

#[cfg(target_os = "linux")]
fn x11win_available() -> bool {
    !x11win::native_wayland_requested() && x11win::x11_available()
}

#[cfg(not(target_os = "linux"))]
fn x11win_available() -> bool {
    false
}

pub fn find_game_window(pid: u32) -> Option<WindowInfo> {
    let wins: Vec<WindowInfo> = imp::list_windows(&[pid]).into_iter().filter(|w| w.class_name.starts_with("GLFW") && !w.class_name.contains("Helper")).collect();
    let idx = wins.iter().position(|w| w.visible).unwrap_or(0);
    wins.into_iter().nth(idx)
}

pub fn close_window(hwnd: isize) -> bool {
    imp::close_window(hwnd)
}

pub fn viewport_window(pid: Option<u32>) -> Value {
    match pid {
        Some(pid) if native_viewport() => {
            let w = find_game_window(pid);
            json!({ "supported": true, "hwnd": w.as_ref().map(|w| w.hwnd), "title": w.as_ref().map(|w| w.title.clone()), "pid": pid })
        }
        _ => json!({ "supported": false, "hwnd": null, "reason": "Native docking is only available on Windows and Linux (X11)" }),
    }
}
