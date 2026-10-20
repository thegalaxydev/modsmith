use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

pub struct Log {
    file: Mutex<Option<File>>,
}

impl Log {
    pub fn open(path: &Path) -> Log {
        Log { file: Mutex::new(OpenOptions::new().create(true).append(true).open(path).ok()) }
    }

    pub fn write(&self, msg: &str) {
        let stamp = humantime::format_rfc3339_millis(SystemTime::now());
        if let Some(f) = self.file.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            let _ = writeln!(f, "[{stamp}] {msg}");
        }
    }
}

pub fn now_ms() -> u128 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

#[cfg(windows)]
pub fn pid_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    if pid == 0 {
        return false;
    }
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code).is_ok();
        let _ = CloseHandle(handle);
        ok && code == 259
    }
}

#[cfg(not(windows))]
pub fn pid_alive(pid: u32) -> bool {
    pid != 0 && Path::new(&format!("/proc/{pid}")).exists()
}

pub struct Lock {
    path: PathBuf,
}

impl Lock {
    pub fn acquire(path: &Path) -> Option<Lock> {
        let me = std::process::id();
        for _ in 0..2 {
            match OpenOptions::new().write(true).create_new(true).open(path) {
                Ok(mut f) => {
                    let _ = f.write_all(me.to_string().as_bytes());
                    return Some(Lock { path: path.to_path_buf() });
                }
                Err(_) => {
                    let owner: u32 = fs::read_to_string(path).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
                    if owner != 0 && owner != me && pid_alive(owner) {
                        return None;
                    }
                    let _ = fs::remove_file(path);
                }
            }
        }
        None
    }

    pub fn release(&self) {
        let me = std::process::id().to_string();
        if fs::read_to_string(&self.path).map(|s| s.trim() == me).unwrap_or(false) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

pub fn random_token() -> String {
    use base64::Engine;
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("system random source");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    let tmp = PathBuf::from(format!("{}.tmp", path.display()));
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path)
}
