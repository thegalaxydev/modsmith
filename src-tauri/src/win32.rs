use serde::{Deserialize, Serialize};
use std::sync::Once;
use windows::core::{w, BOOL, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::{ClientToScreen, GetStockObject, BLACK_BRUSH, HBRUSH};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId, GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows::Win32::UI::WindowsAndMessaging::*;

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
    pub visible: bool,
}

const HOST_CLASS: PCWSTR = w!("ModsmithViewportHost");

#[derive(Clone, Copy, Debug)]
pub struct DockState {
    pub child: isize,
    pub host: isize,
    pub original_style: isize,
    pub original_ex_style: isize,
}

fn h(v: isize) -> HWND {
    HWND(v as *mut core::ffi::c_void)
}

fn wide(buf: &[u16], n: i32) -> String {
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

pub fn supported() -> bool {
    true
}

pub fn window_pid(hwnd: isize) -> (u32, u32) {
    let mut pid = 0u32;
    let thread = unsafe { GetWindowThreadProcessId(h(hwnd), Some(&mut pid)) };
    (pid, thread)
}

struct Enum {
    pid: u32,
    found: Vec<WindowInfo>,
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam.0 as *mut Enum);
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == ctx.pid {
        let mut class = [0u16; 256];
        let n = GetClassNameW(hwnd, &mut class);
        let class = wide(&class, n);
        if class.starts_with("GLFW") && !class.contains("Helper") {
            let mut title = [0u16; 512];
            let t = GetWindowTextW(hwnd, &mut title);
            ctx.found.push(WindowInfo { hwnd: hwnd.0 as isize, title: wide(&title, t), visible: IsWindowVisible(hwnd).as_bool() });
        }
    }
    BOOL(1)
}

pub fn find_game_window(pid: u32) -> Option<WindowInfo> {
    let mut ctx = Enum { pid, found: Vec::new() };
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut ctx as *mut Enum as isize));
    }
    ctx.found.iter().find(|w| w.visible).cloned().or_else(|| ctx.found.first().cloned())
}

pub fn process_alive(pid: u32) -> bool {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code).is_ok();
        let _ = CloseHandle(handle);
        ok && code == 259
    }
}

pub fn is_window(hwnd: isize) -> bool {
    unsafe { IsWindow(Some(h(hwnd))).as_bool() }
}

pub fn bring_to_front(hwnd: isize) -> bool {
    unsafe {
        if IsIconic(h(hwnd)).as_bool() {
            let _ = ShowWindow(h(hwnd), SW_RESTORE);
        }
        SetForegroundWindow(h(hwnd)).as_bool()
    }
}

unsafe extern "system" fn host_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_SETFOCUS {
        if let Ok(child) = GetWindow(hwnd, GW_CHILD) {
            focus_child(child.0 as isize);
        }
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn create_host(owner: isize, screen: Rect) -> Option<isize> {
    static REGISTER: Once = Once::new();
    unsafe {
        let instance: HINSTANCE = GetModuleHandleW(None).ok()?.into();
        REGISTER.call_once(|| {
            let wc = WNDCLASSW {
                lpfnWndProc: Some(host_proc),
                hInstance: instance,
                lpszClassName: HOST_CLASS,
                hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                hbrBackground: HBRUSH(GetStockObject(BLACK_BRUSH).0),
                ..Default::default()
            };
            RegisterClassW(&wc);
        });
        let host = CreateWindowExW(
            WS_EX_TOOLWINDOW,
            HOST_CLASS,
            w!("Minecraft"),
            WS_POPUP | WS_CLIPCHILDREN,
            screen.x.round() as i32,
            screen.y.round() as i32,
            (screen.width.round() as i32).max(1),
            (screen.height.round() as i32).max(1),
            Some(h(owner)),
            None,
            Some(instance),
            None,
        )
        .ok()?;
        Some(host.0 as isize)
    }
}

pub fn client_origin(hwnd: isize) -> (f64, f64) {
    let mut p = POINT { x: 0, y: 0 };
    unsafe {
        let _ = ClientToScreen(h(hwnd), &mut p);
    }
    (p.x as f64, p.y as f64)
}

fn size_of(rect: Rect) -> (i32, i32) {
    ((rect.width.round() as i32).max(1), (rect.height.round() as i32).max(1))
}

pub fn dock(child: isize, owner: isize, screen: Rect) -> Option<DockState> {
    let host = create_host(owner, screen)?;
    unsafe {
        let original_style = GetWindowLongPtrW(h(child), GWL_STYLE);
        let original_ex_style = GetWindowLongPtrW(h(child), GWL_EXSTYLE);
        let strip = (WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU).0 as isize;
        let style = (original_style & !strip & !(WS_CHILD.0 as isize)) | (WS_POPUP | WS_VISIBLE).0 as isize;
        if IsIconic(h(child)).as_bool() {
            let _ = ShowWindow(h(child), SW_RESTORE);
        }
        SetWindowLongPtrW(h(child), GWL_STYLE, style);
        SetWindowLongPtrW(h(child), GWL_EXSTYLE, original_ex_style & !(WS_EX_APPWINDOW.0 as isize));
        SetWindowLongPtrW(h(child), GWLP_HWNDPARENT, host);
        let _ = ShowWindow(h(host), SW_SHOWNOACTIVATE);
        place(child, screen, Some(HWND_TOP), SWP_FRAMECHANGED | SWP_SHOWWINDOW);
        Some(DockState { child, host, original_style, original_ex_style })
    }
}

fn place(hwnd: isize, screen: Rect, after: Option<HWND>, flags: SET_WINDOW_POS_FLAGS) {
    let (w, hh) = size_of(screen);
    let flags = flags | SWP_NOACTIVATE | if after.is_none() { SWP_NOZORDER } else { SET_WINDOW_POS_FLAGS(0) };
    unsafe {
        let _ = SetWindowPos(h(hwnd), after, screen.x.round() as i32, screen.y.round() as i32, w, hh, flags);
    }
}

pub fn move_docked(state: &DockState, screen: Rect) {
    place(state.host, screen, None, SET_WINDOW_POS_FLAGS(0));
    place(state.child, screen, None, SWP_ASYNCWINDOWPOS);
}

pub fn set_visible(state: &DockState, visible: bool) {
    let cmd = if visible { SW_SHOWNOACTIVATE } else { SW_HIDE };
    unsafe {
        let _ = ShowWindow(h(state.host), cmd);
        let _ = ShowWindow(h(state.child), cmd);
    }
}

pub fn undock(state: &DockState) {
    unsafe {
        if is_window(state.child) {
            SetWindowLongPtrW(h(state.child), GWLP_HWNDPARENT, 0);
            SetWindowLongPtrW(h(state.child), GWL_STYLE, state.original_style);
            SetWindowLongPtrW(h(state.child), GWL_EXSTYLE, state.original_ex_style);
            let _ = SetWindowPos(h(state.child), Some(HWND_TOP), 80, 80, 1280, 720, SWP_FRAMECHANGED | SWP_SHOWWINDOW);
            let _ = SetForegroundWindow(h(state.child));
        }
        destroy_host(state);
    }
}

pub fn destroy_host(state: &DockState) {
    unsafe {
        if is_window(state.host) {
            let _ = DestroyWindow(h(state.host));
        }
    }
}

fn focus_child(child: isize) {
    unsafe {
        let ours = GetCurrentThreadId();
        let (_, theirs) = window_pid(child);
        if theirs != 0 && theirs != ours {
            let _ = AttachThreadInput(ours, theirs, true);
            let _ = SetFocus(Some(h(child)));
            let _ = AttachThreadInput(ours, theirs, false);
        } else {
            let _ = SetFocus(Some(h(child)));
        }
    }
}

pub fn focus_docked(state: &DockState) {
    unsafe {
        let _ = SetForegroundWindow(h(state.child));
    }
    focus_child(state.child);
}

pub fn confirm(owner: isize, text: &str) -> Option<bool> {
    let text: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let owner = if owner == 0 { None } else { Some(HWND(owner as *mut core::ffi::c_void)) };
    let r = unsafe { MessageBoxW(owner, PCWSTR(text.as_ptr()), w!("Modsmith"), MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2 | MB_SETFOREGROUND) };
    Some(r == IDYES)
}
