use crate::system;
use serde_json::{json, Value};
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

pub const MANIFEST: &str = ".modsmith-install.json";
const APP_EXE: &str = "modsmith.exe";
const SERVICE_EXE: &str = "modsmith-service.exe";
const UNINSTALL_EXE: &str = "uninstall.exe";
const PUBLISHER: &str = "Galaxy Development LLC";
const HOMEPAGE: &str = "https://thegalaxydev.github.io/modsmith/";

pub struct Env {
    pub key: String,
    pub default_dir: PathBuf,
    pub programs: Option<PathBuf>,
    pub desktop: Option<PathBuf>,
    pub data_dirs: Vec<PathBuf>,
    pub service_file: PathBuf,
    pub test_root: Option<PathBuf>,
    pub test: bool,
}

fn env_dir(name: &str) -> PathBuf {
    std::env::var_os(name).map(PathBuf::from).unwrap_or_default()
}

impl Env {
    pub fn real() -> Env {
        let local = env_dir("LOCALAPPDATA");
        Env {
            key: "Modsmith".into(),
            default_dir: local.join("Modsmith"),
            programs: system::programs_dir(),
            desktop: system::desktop_dir(),
            data_dirs: vec![env_dir("APPDATA").join("Modsmith"), local.join("dev.modsmith.workbench")],
            service_file: env_dir("APPDATA").join("Modsmith").join("service.json"),
            test_root: None,
            test: false,
        }
    }

    pub fn test(root: &Path) -> Env {
        Env {
            key: "ModsmithSetupTest".into(),
            default_dir: root.join("Modsmith"),
            programs: Some(root.join("Programs")),
            desktop: Some(root.join("Desktop")),
            data_dirs: vec![root.join("Data")],
            service_file: root.join("Data").join("service.json"),
            test_root: Some(root.to_path_buf()),
            test: true,
        }
    }

    fn uninstall_key(&self) -> String {
        format!(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{}", self.key)
    }

    pub fn desktop_link(&self) -> Option<PathBuf> {
        self.desktop.as_ref().map(|d| d.join("Modsmith.lnk"))
    }

    pub fn start_link(&self) -> Option<PathBuf> {
        self.programs.as_ref().map(|d| d.join("Modsmith.lnk"))
    }
}

pub struct Existing {
    pub dir: PathBuf,
    pub version: Option<String>,
}

fn unquote(s: &str) -> String {
    s.trim().trim_matches('"').to_string()
}

pub fn existing(env: &Env) -> Option<Existing> {
    let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey(env.uninstall_key()).ok();
    let from_registry = key.as_ref().and_then(|k| k.get_value::<String, _>("InstallLocation").ok()).map(|s| PathBuf::from(unquote(&s))).filter(|d| d.join(APP_EXE).exists());
    let dir = from_registry.or_else(|| Some(env.default_dir.clone()).filter(|d| d.join(APP_EXE).exists()))?;
    let version = read_manifest(&dir).and_then(|m| m["version"].as_str().map(str::to_string));
    Some(Existing { dir, version })
}

fn read_manifest(dir: &Path) -> Option<Value> {
    fs::read_to_string(dir.join(MANIFEST)).ok().and_then(|t| serde_json::from_str(&t).ok())
}

pub enum Stop {
    Stopped,
    StillRunning,
}

fn service_shutdown(env: &Env, dir: &Path, pids: &[u32]) {
    let listed = fs::read_to_string(&env.service_file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["pid"].as_u64());
    if !listed.is_some_and(|pid| pids.contains(&(pid as u32))) {
        return;
    }
    let mut cmd = Command::new(dir.join(SERVICE_EXE));
    cmd.args(["cli", "call", "service.shutdown", r#"{"stopInstances":false}"#]);
    if let Some(data) = env.service_file.parent().filter(|_| env.test) {
        cmd.env("MODSMITH_DATA_DIR", data);
    }
    let _ = system::hidden(&mut cmd).output();
}

fn is_named(path: &Path, name: &str) -> bool {
    path.file_name().is_some_and(|f| f.to_string_lossy().eq_ignore_ascii_case(name))
}

pub fn stop_running(env: &Env, dir: &Path, force: bool) -> Stop {
    let running = system::processes_in(dir);
    if running.is_empty() {
        return Stop::Stopped;
    }
    for (pid, path) in &running {
        if is_named(path, APP_EXE) {
            if force {
                system::terminate(*pid);
            } else {
                system::ask_to_close(*pid);
            }
        }
    }
    if !system::wait_until_gone(dir, &[APP_EXE], Duration::from_secs(if force { 5 } else { 10 })) {
        return Stop::StillRunning;
    }
    let services: Vec<u32> = system::processes_in(dir).into_iter().filter(|(_, p)| is_named(p, SERVICE_EXE)).map(|(pid, _)| pid).collect();
    if !services.is_empty() {
        service_shutdown(env, dir, &services);
        if !system::wait_until_gone(dir, &[SERVICE_EXE], Duration::from_secs(15)) {
            for (pid, path) in system::processes_in(dir) {
                if is_named(&path, SERVICE_EXE) {
                    system::terminate(pid);
                }
            }
            system::wait_until_gone(dir, &[SERVICE_EXE], Duration::from_secs(5));
        }
    }
    if !system::processes_in(dir).iter().any(|(_, p)| is_named(p, APP_EXE) || is_named(p, SERVICE_EXE)) {
        Stop::Stopped
    } else {
        Stop::StillRunning
    }
}

fn safe_relative(name: &str) -> Option<PathBuf> {
    let p = Path::new(name);
    if p.components().all(|c| matches!(c, Component::Normal(_))) {
        Some(p.to_path_buf())
    } else {
        None
    }
}

fn replace_file(target: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    let tmp = PathBuf::from(format!("{}.setup-new", target.display()));
    fs::write(&tmp, bytes).map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    if target.exists() {
        if let Err(e) = fs::remove_file(target) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("Could not replace {}: {e}. Close any program that is using it and try again.", target.display()));
        }
    }
    fs::rename(&tmp, target).map_err(|e| format!("Could not move {} into place: {e}", target.display()))
}

fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .map(|e| {
            let p = e.path();
            if e.file_name() == "cache" {
                0
            } else if p.is_dir() {
                dir_size(&p)
            } else {
                e.metadata().map(|m| m.len()).unwrap_or(0)
            }
        })
        .sum()
}

pub struct Options {
    pub dir: PathBuf,
    pub desktop: bool,
}

pub fn install(env: &Env, opts: &Options, payload: &[u8], version: &str, progress: &dyn Fn(f64, &str)) -> Result<(), String> {
    if payload.is_empty() {
        return Err("This setup was built without the Modsmith files. Download the installer from the Modsmith website.".into());
    }
    let dir = &opts.dir;
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let mut zip = zip::ZipArchive::new(Cursor::new(payload)).map_err(|e| format!("The setup's files are damaged: {e}"))?;
    let total: u64 = (0..zip.len()).filter_map(|i| zip.by_index(i).ok().map(|f| f.size())).sum::<u64>().max(1);
    let mut done = 0u64;
    let mut files: Vec<String> = Vec::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("The setup's files are damaged: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().map_err(|e| format!("The setup's files are damaged: {e}"))?.replace('\\', "/");
        let rel = safe_relative(&name).ok_or_else(|| format!("The setup contains an unsafe path: {name}"))?;
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut bytes).map_err(|e| format!("The setup's files are damaged: {e}"))?;
        progress(0.05 + 0.8 * (done as f64 / total as f64), &name);
        replace_file(&dir.join(&rel), &bytes)?;
        done += entry.size();
        files.push(name);
    }
    if let Some(old) = read_manifest(dir) {
        for stale in old["files"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            if !files.iter().any(|f| f == stale) {
                if let Some(rel) = safe_relative(stale) {
                    let _ = fs::remove_file(dir.join(rel));
                }
            }
        }
    }
    progress(0.88, "uninstall.exe");
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let uninstaller = dir.join(UNINSTALL_EXE);
    if !same_file(&me, &uninstaller) {
        let bytes = fs::read(&me).map_err(|e| format!("Could not read the setup program: {e}"))?;
        replace_file(&uninstaller, &bytes)?;
    }
    files.push(UNINSTALL_EXE.into());
    files.sort();
    let manifest = json!({ "version": version, "files": files });
    fs::write(dir.join(MANIFEST), serde_json::to_string_pretty(&manifest).unwrap_or_default()).map_err(|e| format!("Could not write {MANIFEST}: {e}"))?;
    progress(0.92, "registry");
    register(env, dir, version)?;
    progress(0.96, "shortcuts");
    let app = dir.join(APP_EXE);
    if let Some(link) = env.start_link() {
        system::create_shortcut(&link, &app, "Modsmith")?;
    }
    if let Some(link) = env.desktop_link() {
        if opts.desktop {
            system::create_shortcut(&link, &app, "Modsmith")?;
        } else if link.exists() {
            let _ = fs::remove_file(&link);
        }
    }
    progress(1.0, "");
    Ok(())
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

fn register(env: &Env, dir: &Path, version: &str) -> Result<(), String> {
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(env.uninstall_key()).map_err(|e| format!("Could not register Modsmith with Windows: {e}"))?;
    let quoted = |p: &Path| format!("\"{}\"", p.display());
    let uninstaller = dir.join(UNINSTALL_EXE);
    let size_kb = (dir_size(dir) / 1024) as u32;
    let set = |name: &str, value: &str| key.set_value(name, &value.to_string()).map_err(|e| format!("Could not register Modsmith with Windows: {e}"));
    set("DisplayName", "Modsmith")?;
    set("DisplayVersion", version)?;
    set("DisplayIcon", &quoted(&dir.join(APP_EXE)))?;
    set("Publisher", PUBLISHER)?;
    set("InstallLocation", &quoted(dir))?;
    let test = env.test_root.as_ref().map(|r| format!(" --test-root {}", quoted(r))).unwrap_or_default();
    set("UninstallString", &format!("{} --uninstall{test}", quoted(&uninstaller)))?;
    set("QuietUninstallString", &format!("{} --uninstall --silent{test}", quoted(&uninstaller)))?;
    set("URLInfoAbout", HOMEPAGE)?;
    set("HelpLink", HOMEPAGE)?;
    set("MainBinaryName", APP_EXE)?;
    for (name, value) in [("NoModify", 1u32), ("NoRepair", 1u32), ("EstimatedSize", size_kb)] {
        key.set_value(name, &value).map_err(|e| format!("Could not register Modsmith with Windows: {e}"))?;
    }
    Ok(())
}

pub fn uninstall(env: &Env, dir: &Path, delete_data: bool, progress: &dyn Fn(f64, &str)) -> Result<(), String> {
    progress(0.1, "files");
    let listed: Vec<String> = read_manifest(dir).and_then(|m| m["files"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())).unwrap_or_default();
    let mut locked = Vec::new();
    for name in listed.iter().map(String::as_str).chain([APP_EXE, SERVICE_EXE, UNINSTALL_EXE, MANIFEST]) {
        if let Some(rel) = safe_relative(name) {
            let p = dir.join(rel);
            if !p.exists() {
                continue;
            }
            if let Err(e) = fs::remove_file(&p) {
                if name == UNINSTALL_EXE {
                    locked.push(p);
                } else {
                    return Err(format!("Could not remove {}: {e}", p.display()));
                }
            }
        }
    }
    let _ = fs::remove_dir_all(dir.join("resources"));
    progress(0.5, "shortcuts");
    for link in [env.start_link(), env.desktop_link()].into_iter().flatten() {
        let _ = fs::remove_file(link);
    }
    progress(0.6, "registry");
    let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(env.uninstall_key());
    if delete_data {
        progress(0.7, "data");
        let _ = fs::remove_dir_all(dir.join("cache"));
        for d in &env.data_dirs {
            let _ = fs::remove_dir_all(d);
        }
    }
    let _ = remove_empty_dirs(dir);
    if !locked.is_empty() {
        system::delete_later(&locked, Some(dir));
    }
    progress(1.0, "");
    Ok(())
}

fn remove_empty_dirs(dir: &Path) -> std::io::Result<()> {
    for e in fs::read_dir(dir)?.flatten() {
        if e.path().is_dir() {
            let _ = remove_empty_dirs(&e.path());
        }
    }
    fs::remove_dir(dir)
}

pub fn launch(dir: &Path) {
    let _ = Command::new(dir.join(APP_EXE)).current_dir(dir).spawn();
}

pub fn has_payload(payload: &[u8]) -> bool {
    !payload.is_empty()
}
