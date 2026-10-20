use crate::{Area, Dock, GameWindow};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    Allow, AtomEnum, ButtonIndex, ChangeWindowAttributesAux, ClientMessageEvent, ConfigureWindowAux, ConnectionExt as _, CreateWindowAux, EventMask, GrabMode, InputFocus, MapState, ModMask, SetMode, StackMode, UnmapNotifyEvent, Window, WindowClass,
    UNMAP_NOTIFY_EVENT,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::{COPY_DEPTH_FROM_PARENT, COPY_FROM_PARENT, CURRENT_TIME, NONE};

struct Atoms {
    net_wm_pid: u32,
    net_wm_name: u32,
    utf8_string: u32,
    wm_protocols: u32,
    wm_delete_window: u32,
    net_active_window: u32,
    net_client_list: u32,
}

struct X {
    conn: RustConnection,
    root: Window,
    black: u32,
    atoms: Atoms,
}

static X11: OnceLock<Option<Arc<X>>> = OnceLock::new();
static GRAB_OWNER: AtomicU32 = AtomicU32::new(0);
static FOCUS_TARGET: Mutex<Option<(u32, u32)>> = Mutex::new(None);

fn intern(conn: &RustConnection, name: &[u8]) -> Option<u32> {
    Some(conn.intern_atom(false, name).ok()?.reply().ok()?.atom)
}

fn x() -> Option<Arc<X>> {
    X11.get_or_init(|| {
        if !crate::x11_available() {
            return None;
        }
        let (conn, screen) = x11rb::connect(None).ok()?;
        let s = conn.setup().roots.get(screen)?;
        let (root, black) = (s.root, s.black_pixel);
        let atoms = Atoms {
            net_wm_pid: intern(&conn, b"_NET_WM_PID")?,
            net_wm_name: intern(&conn, b"_NET_WM_NAME")?,
            utf8_string: intern(&conn, b"UTF8_STRING")?,
            wm_protocols: intern(&conn, b"WM_PROTOCOLS")?,
            wm_delete_window: intern(&conn, b"WM_DELETE_WINDOW")?,
            net_active_window: intern(&conn, b"_NET_ACTIVE_WINDOW")?,
            net_client_list: intern(&conn, b"_NET_CLIENT_LIST")?,
        };
        let x = Arc::new(X { conn, root, black, atoms });
        let reader = x.clone();
        std::thread::Builder::new().name("x11win-events".into()).spawn(move || events(reader)).ok()?;
        Some(x)
    })
    .clone()
}

pub fn available() -> bool {
    x().is_some()
}

fn prop32(x: &X, win: Window, atom: u32, kind: AtomEnum) -> Vec<u32> {
    x.conn
        .get_property(false, win, atom, kind, 0, 1024)
        .ok()
        .and_then(|c| c.reply().ok())
        .and_then(|r| r.value32().map(|v| v.collect()))
        .unwrap_or_default()
}

fn title(x: &X, win: Window) -> String {
    let get = |atom: u32, kind: u32| x.conn.get_property(false, win, atom, kind, 0, 1024).ok().and_then(|c| c.reply().ok()).map(|r| String::from_utf8_lossy(&r.value).into_owned());
    get(x.atoms.net_wm_name, x.atoms.utf8_string).filter(|t| !t.is_empty()).or_else(|| get(AtomEnum::WM_NAME.into(), AtomEnum::STRING.into())).unwrap_or_default()
}

fn viewable(x: &X, win: Window) -> Option<bool> {
    let a = x.conn.get_window_attributes(win).ok()?.reply().ok()?;
    if a.class != WindowClass::INPUT_OUTPUT {
        return None;
    }
    Some(a.map_state == MapState::VIEWABLE)
}

fn candidates(x: &X) -> Vec<Window> {
    let mut out = prop32(x, x.root, x.atoms.net_client_list, AtomEnum::WINDOW);
    let mut queue: VecDeque<(Window, u32)> = VecDeque::from([(x.root, 0)]);
    while let Some((w, depth)) = queue.pop_front() {
        let Some(tree) = x.conn.query_tree(w).ok().and_then(|c| c.reply().ok()) else { continue };
        for c in tree.children {
            if !out.contains(&c) {
                out.push(c);
            }
            if depth < 4 {
                queue.push_back((c, depth + 1));
            }
        }
    }
    out
}

pub fn find_game_window(pid: u32) -> Option<GameWindow> {
    let x = x()?;
    let mut found: Vec<GameWindow> = Vec::new();
    for w in candidates(&x) {
        if prop32(&x, w, x.atoms.net_wm_pid, AtomEnum::CARDINAL).first() != Some(&pid) {
            continue;
        }
        let Some(visible) = viewable(&x, w) else { continue };
        let Some(geo) = x.conn.get_geometry(w).ok().and_then(|c| c.reply().ok()) else { continue };
        if geo.width < 32 || geo.height < 32 {
            continue;
        }
        found.push(GameWindow { id: w, title: title(&x, w), visible });
    }
    found.iter().find(|w| w.visible).cloned().or_else(|| found.into_iter().next())
}

pub fn is_window(id: u32) -> bool {
    x().is_some_and(|x| x.conn.get_window_attributes(id).ok().and_then(|c| c.reply().ok()).is_some())
}

pub fn close_window(id: u32) -> bool {
    let Some(x) = x() else { return false };
    let msg = ClientMessageEvent::new(32, id, x.atoms.wm_protocols, [x.atoms.wm_delete_window, CURRENT_TIME, 0, 0, 0]);
    x.conn.send_event(false, id, EventMask::NO_EVENT, msg).is_ok() && x.conn.flush().is_ok()
}

pub fn raise(id: u32) -> bool {
    let Some(x) = x() else { return false };
    let _ = x.conn.map_window(id);
    let _ = x.conn.configure_window(id, &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE));
    let msg = ClientMessageEvent::new(32, id, x.atoms.net_active_window, [2, CURRENT_TIME, 0, 0, 0]);
    let _ = x.conn.send_event(false, x.root, EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY, msg);
    x.conn.flush().is_ok()
}

pub fn origin(id: u32) -> (i32, i32) {
    let Some(x) = x() else { return (0, 0) };
    x.conn.translate_coordinates(id, x.root, 0, 0).ok().and_then(|c| c.reply().ok()).map(|r| (r.dst_x as i32, r.dst_y as i32)).unwrap_or((0, 0))
}

pub fn area_of(id: u32) -> Option<Area> {
    let x = x()?;
    let g = x.conn.get_geometry(id).ok()?.reply().ok()?;
    let (ox, oy) = origin(id);
    Some(Area { x: ox, y: oy, width: g.width as u32, height: g.height as u32 })
}

fn relative(owner: u32, area: Area) -> (i32, i32, u32, u32) {
    let (ox, oy) = origin(owner);
    (area.x - ox, area.y - oy, area.width.max(1), area.height.max(1))
}

fn parent_of(x: &X, w: Window) -> Option<Window> {
    Some(x.conn.query_tree(w).ok()?.reply().ok()?.parent)
}

fn withdraw(x: &X, game: Window) {
    let _ = x.conn.unmap_window(game);
    let ev = UnmapNotifyEvent { response_type: UNMAP_NOTIFY_EVENT, sequence: 0, event: x.root, window: game, from_configure: false };
    let _ = x.conn.send_event(false, x.root, EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY, ev);
    let _ = x.conn.flush();
}

pub fn dock(game: u32, owner: u32, area: Area) -> Option<Dock> {
    let x = x()?;
    let (rx, ry, w, h) = relative(owner, area);
    let host = x.conn.generate_id().ok()?;
    x.conn
        .create_window(
            COPY_DEPTH_FROM_PARENT,
            host,
            owner,
            rx as i16,
            ry as i16,
            w as u16,
            h as u16,
            0,
            WindowClass::INPUT_OUTPUT,
            COPY_FROM_PARENT,
            &CreateWindowAux::new().background_pixel(x.black).event_mask(EventMask::STRUCTURE_NOTIFY | EventMask::FOCUS_CHANGE),
        )
        .ok()?;
    let _ = x.conn.map_window(host);
    let _ = x.conn.configure_window(host, &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE));
    withdraw(&x, game);
    std::thread::sleep(Duration::from_millis(120));
    let _ = x.conn.change_save_set(SetMode::INSERT, game);
    for attempt in 0..3 {
        let _ = x.conn.reparent_window(game, host, 0, 0);
        let _ = x.conn.configure_window(game, &ConfigureWindowAux::new().x(0).y(0).width(w).height(h).border_width(0));
        let _ = x.conn.map_window(game);
        let _ = x.conn.flush();
        std::thread::sleep(Duration::from_millis(100 + attempt * 100));
        if parent_of(&x, game) == Some(host) {
            let d = Dock { game, host, owner };
            start_grab(&x, owner, host, game);
            focus(&d);
            return Some(d);
        }
    }
    let _ = x.conn.change_save_set(SetMode::DELETE, game);
    let _ = x.conn.destroy_window(host);
    let _ = x.conn.flush();
    None
}

pub fn move_dock(d: &Dock, area: Area) {
    let Some(x) = x() else { return };
    let (rx, ry, w, h) = relative(d.owner, area);
    let _ = x.conn.configure_window(d.host, &ConfigureWindowAux::new().x(rx).y(ry).width(w).height(h).stack_mode(StackMode::ABOVE));
    let _ = x.conn.configure_window(d.game, &ConfigureWindowAux::new().x(0).y(0).width(w).height(h));
    let _ = x.conn.flush();
}

pub fn set_visible(d: &Dock, visible: bool) {
    let Some(x) = x() else { return };
    let _ = if visible { x.conn.map_window(d.host) } else { x.conn.unmap_window(d.host) };
    if visible {
        let _ = x.conn.configure_window(d.host, &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE));
    } else {
        let _ = x.conn.set_input_focus(InputFocus::PARENT, d.owner, CURRENT_TIME);
    }
    let _ = x.conn.flush();
}

pub fn focus(d: &Dock) {
    let Some(x) = x() else { return };
    let _ = x.conn.set_input_focus(InputFocus::PARENT, d.game, CURRENT_TIME);
    let _ = x.conn.flush();
}

pub fn undock(d: &Dock) {
    let Some(x) = x() else { return };
    stop_grab(&x, d.owner);
    if is_window(d.game) {
        let _ = x.conn.unmap_window(d.game);
        let _ = x.conn.reparent_window(d.game, x.root, 80, 80);
        let _ = x.conn.change_save_set(SetMode::DELETE, d.game);
        let _ = x.conn.configure_window(d.game, &ConfigureWindowAux::new().width(1280).height(720));
        let _ = x.conn.map_window(d.game);
        let _ = x.conn.flush();
        std::thread::sleep(Duration::from_millis(80));
        raise(d.game);
    }
    destroy_host(d);
}

pub fn destroy_host(d: &Dock) {
    let Some(x) = x() else { return };
    if GRAB_OWNER.load(Ordering::SeqCst) == d.owner {
        stop_grab(&x, d.owner);
    }
    let _ = x.conn.destroy_window(d.host);
    let _ = x.conn.set_input_focus(InputFocus::PARENT, d.owner, CURRENT_TIME);
    let _ = x.conn.flush();
}

fn start_grab(x: &X, owner: u32, host: u32, game: u32) {
    *FOCUS_TARGET.lock().unwrap_or_else(|e| e.into_inner()) = Some((host, game));
    if GRAB_OWNER.swap(owner, Ordering::SeqCst) == owner {
        return;
    }
    let _ = x.conn.grab_button(false, owner, EventMask::BUTTON_PRESS, GrabMode::SYNC, GrabMode::ASYNC, NONE, NONE, ButtonIndex::ANY, ModMask::ANY);
    let _ = x.conn.change_window_attributes(host, &ChangeWindowAttributesAux::new().event_mask(EventMask::STRUCTURE_NOTIFY | EventMask::FOCUS_CHANGE));
    let _ = x.conn.flush();
}

fn stop_grab(x: &X, owner: u32) {
    *FOCUS_TARGET.lock().unwrap_or_else(|e| e.into_inner()) = None;
    if GRAB_OWNER.compare_exchange(owner, 0, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
        let _ = x.conn.ungrab_button(ButtonIndex::ANY, owner, ModMask::ANY);
        let _ = x.conn.flush();
    }
}

fn events(x: Arc<X>) {
    loop {
        let Ok(event) = x.conn.wait_for_event() else { return };
        match event {
            Event::ButtonPress(e) => {
                let target = *FOCUS_TARGET.lock().unwrap_or_else(|e| e.into_inner());
                if let Some((host, game)) = target {
                    let focus = if e.child == host { game } else { e.event };
                    let _ = x.conn.set_input_focus(InputFocus::PARENT, focus, CURRENT_TIME);
                }
                let _ = x.conn.allow_events(Allow::REPLAY_POINTER, CURRENT_TIME);
                let _ = x.conn.flush();
            }
            Event::FocusIn(e) => {
                let target = *FOCUS_TARGET.lock().unwrap_or_else(|e| e.into_inner());
                if let Some((host, game)) = target {
                    if e.event == host {
                        let _ = x.conn.set_input_focus(InputFocus::PARENT, game, CURRENT_TIME);
                        let _ = x.conn.flush();
                    }
                }
            }
            _ => {}
        }
    }
}
