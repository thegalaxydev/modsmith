use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use windows::core::{Interface, HSTRING, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, WPARAM};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, TerminateProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE};
use windows::Win32::UI::Shell::{FOLDERID_Desktop, FOLDERID_Programs, IShellLinkW, SHGetKnownFolderPath, ShellLink, KF_FLAG_DEFAULT};
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, WM_CLOSE};
use windows::core::BOOL;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn init_com() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
}

fn known_folder(id: &windows::core::GUID) -> Option<PathBuf> {
    unsafe {
        let p: PWSTR = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
        let path = p.to_string().ok().map(PathBuf::from);
        CoTaskMemFree(Some(p.0 as *const _));
        path
    }
}

pub fn desktop_dir() -> Option<PathBuf> {
    known_folder(&FOLDERID_Desktop)
}

pub fn programs_dir() -> Option<PathBuf> {
    known_folder(&FOLDERID_Programs)
}

pub fn create_shortcut(link: &Path, target: &Path, description: &str) -> Result<(), String> {
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    unsafe {
        let shell: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
        shell.SetPath(&HSTRING::from(target.as_os_str())).map_err(|e| e.to_string())?;
        if let Some(dir) = target.parent() {
            shell.SetWorkingDirectory(&HSTRING::from(dir.as_os_str())).map_err(|e| e.to_string())?;
        }
        shell.SetDescription(&HSTRING::from(description)).map_err(|e| e.to_string())?;
        shell.SetIconLocation(&HSTRING::from(target.as_os_str()), 0).map_err(|e| e.to_string())?;
        let file: IPersistFile = shell.cast().map_err(|e| e.to_string())?;
        file.Save(&HSTRING::from(link.as_os_str()), true).map_err(|e| format!("Could not save the shortcut {}: {e}", link.display()))
    }
}

fn image_path(pid: u32) -> Option<PathBuf> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        ok.then(|| PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase().trim_end_matches('\\') == b.to_string_lossy().to_lowercase().trim_end_matches('\\')
}

pub fn processes_in(dir: &Path) -> Vec<(u32, PathBuf)> {
    let mut out = Vec::new();
    let me = std::process::id();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let pid = entry.th32ProcessID;
                if pid != me {
                    if let Some(path) = image_path(pid) {
                        if path.parent().is_some_and(|p| same_dir(p, dir)) {
                            out.push((pid, path));
                        }
                    }
                }
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    out
}

unsafe extern "system" fn close_windows_of(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == lparam.0 as u32 && IsWindowVisible(hwnd).as_bool() {
        let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
    }
    BOOL(1)
}

pub fn ask_to_close(pid: u32) {
    unsafe {
        let _ = EnumWindows(Some(close_windows_of), LPARAM(pid as isize));
    }
}

pub fn terminate(pid: u32) {
    unsafe {
        if let Ok(h) = OpenProcess(PROCESS_TERMINATE, false, pid) {
            let _ = TerminateProcess(h, 1);
            let _ = CloseHandle(h);
        }
    }
}

pub fn wait_until_gone(dir: &Path, names: &[&str], timeout: Duration) -> bool {
    let start = Instant::now();
    loop {
        let left = processes_in(dir).into_iter().any(|(_, p)| names.iter().any(|n| p.file_name().is_some_and(|f| f.to_string_lossy().eq_ignore_ascii_case(n))));
        if !left {
            return true;
        }
        if start.elapsed() > timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

pub fn delete_later(files: &[PathBuf], dir: Option<&Path>) {
    let mut cmd = Command::new("cmd.exe");
    cmd.args(["/c", "ping", "-n", "4", "127.0.0.1", ">nul"]);
    for f in files {
        cmd.args(["&", "del", "/f", "/q"]).arg(f);
    }
    if let Some(d) = dir {
        cmd.args(["&", "rmdir"]).arg(d);
    }
    let _ = hidden(&mut cmd).spawn();
}

pub fn hidden(cmd: &mut Command) -> &mut Command {
    cmd.creation_flags(CREATE_NO_WINDOW)
}
