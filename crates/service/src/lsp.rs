use crate::http::{encode_uri_component, hash_file, stream_to};
use crate::js;
use crate::ops::OpCtx;
use crate::proc::{hide, kill_tree};
use crate::rt::{s, Runtime};
use crate::workspace;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

struct Session {
    workspace: String,
    language: String,
    pid: u32,
    stdin: Mutex<ChildStdin>,
    exited: Arc<AtomicBool>,
}

fn write_message(stdin: &Mutex<ChildStdin>, message: &str) -> std::io::Result<()> {
    let mut stdin = stdin.lock().unwrap_or_else(|e| e.into_inner());
    stdin.write_all(format!("Content-Length: {}\r\n\r\n", message.len()).as_bytes())?;
    stdin.write_all(message.as_bytes())?;
    stdin.flush()
}

fn shut_down(session: Arc<Session>, wait: Duration) {
    let _ = write_message(&session.stdin, r#"{"jsonrpc":"2.0","id":"modsmith-shutdown","method":"shutdown"}"#);
    let _ = write_message(&session.stdin, r#"{"jsonrpc":"2.0","method":"exit"}"#);
    let started = std::time::Instant::now();
    while started.elapsed() < wait && !session.exited.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(100));
    }
    if !session.exited.load(Ordering::SeqCst) {
        kill_tree(session.pid);
    }
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock() -> std::sync::MutexGuard<'static, HashMap<String, Arc<Session>>> {
    sessions().lock().unwrap_or_else(|e| e.into_inner())
}

fn config_dir_name() -> &'static str {
    if cfg!(windows) {
        "config_win"
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "config_mac_arm"
        } else {
            "config_mac"
        }
    } else if cfg!(target_arch = "aarch64") {
        "config_linux_arm"
    } else {
        "config_linux"
    }
}

fn launcher_jar(dir: &Path) -> Option<PathBuf> {
    let plugins = dir.join("plugins");
    let mut jars: Vec<PathBuf> = fs::read_dir(&plugins)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().map(|n| n.to_string_lossy().to_string()).is_some_and(|n| n.starts_with("org.eclipse.equinox.launcher_") && n.ends_with(".jar")))
        .collect();
    jars.sort();
    jars.pop()
}

pub fn file_uri(path: &Path) -> String {
    let text = s(path).replace('\\', "/");
    let segments: Vec<String> = text
        .split('/')
        .enumerate()
        .map(|(i, seg)| if i == 0 && seg.len() == 2 && seg.ends_with(':') { seg.to_string() } else { encode_uri_component(seg) })
        .collect();
    let joined = segments.join("/");
    if joined.starts_with('/') {
        format!("file://{joined}")
    } else {
        format!("file:///{joined}")
    }
}

fn tar_program() -> PathBuf {
    if cfg!(windows) {
        if let Some(root) = std::env::var_os("SystemRoot") {
            let p = PathBuf::from(root).join("System32").join("tar.exe");
            if p.exists() {
                return p;
            }
        }
    }
    PathBuf::from("tar")
}

pub fn stop_all_servers() {
    let all: Vec<Arc<Session>> = lock().drain().map(|(_, v)| v).collect();
    std::thread::scope(|scope| {
        for session in all {
            scope.spawn(move || shut_down(session, Duration::from_secs(3)));
        }
    });
}

impl Runtime {
    fn lsp_server(&self, language: &str) -> Result<Value, String> {
        let all: Value = serde_json::from_str(include_str!("../../../resources/lsp.json")).map_err(|e| e.to_string())?;
        all.get(language).filter(|v| v.is_object()).cloned().ok_or_else(|| format!("No language server is configured for {language}"))
    }

    fn lsp_install_dir(&self, server: &Value) -> PathBuf {
        self.data.join("lsp").join(format!("jdtls-{}", js::string(&server["version"])))
    }

    pub fn lsp_status(&self, root: &str, language: &str) -> Result<Value, String> {
        let server = self.lsp_server(language)?;
        let dir = workspace::normalize(root);
        let installed = launcher_jar(&self.lsp_install_dir(&server)).is_some();
        let min = server["javaMin"].as_i64().unwrap_or(21);
        let java = self.java.select(min, None, false, None);
        let ws = s(&dir);
        let session = lock().iter().find(|(_, v)| v.workspace == ws && v.language == language).map(|(k, _)| k.clone());
        Ok(json!({
            "language": language,
            "server": server["name"],
            "version": server["version"],
            "size": server["size"],
            "installed": installed,
            "javaMin": min,
            "java": java.map(|j| j["version"].clone()).unwrap_or(Value::Null),
            "trusted": workspace::require_trusted(&self.store, &ws).is_ok(),
            "session": session
        }))
    }

    pub fn lsp_install(self: &Arc<Self>, language: &str) -> Result<Value, String> {
        let server = self.lsp_server(language)?;
        let me = self.clone();
        let title = format!("Install {} {}", js::string(&server["name"]), js::string(&server["version"]));
        Ok(self.ops.start("lsp.install", &title, None, move |ctx| me.lsp_install_into(&server, ctx).map(Some)))
    }

    fn lsp_install_into(&self, server: &Value, ctx: &OpCtx) -> Result<Value, String> {
        let dir = self.lsp_install_dir(server);
        if launcher_jar(&dir).is_some() {
            ctx.log(&format!("Already installed in {}", dir.display()));
            return Ok(json!({ "installed": true, "dir": s(&dir) }));
        }
        let url = js::string(&server["url"]);
        let sha256 = js::string(&server["sha256"]).to_lowercase();
        let name = url.rsplit('/').next().unwrap_or("jdtls.tar.gz").to_string();
        let archive = self.downloads().join("lsp").join(&name);
        let cached = archive.exists() && hash_file(&archive, "sha256").map(|h| h == sha256).unwrap_or(false);
        if cached {
            ctx.log(&format!("Using the downloaded {name}"));
        } else {
            if let Some(parent) = archive.parent() {
                fs::create_dir_all(parent).map_err(|e| js::fs_error(&e, "mkdir", parent))?;
            }
            let tmp = PathBuf::from(format!("{}.part", archive.display()));
            ctx.log(&format!("Downloading {url}"));
            let cancelled = || ctx.cancelled();
            let progress = |got: u64, total: Option<u64>| {
                if let Some(t) = total.filter(|t| *t > 0) {
                    ctx.progress(Some(got as f64 / t as f64 * 0.85), Some(&format!("Downloading {} of {} MB", got / 1_000_000, t / 1_000_000)));
                }
            };
            stream_to(&url, &tmp, &cancelled, &progress)?;
            let got = hash_file(&tmp, "sha256")?;
            if got != sha256 {
                let _ = fs::remove_file(&tmp);
                return Err(format!("Hash verification failed for {url}: sha256 mismatch"));
            }
            fs::rename(&tmp, &archive).map_err(|e| js::fs_error(&e, "rename", &tmp))?;
            ctx.log("Download verified (SHA-256)");
        }
        ctx.progress(Some(0.9), Some("Unpacking"));
        let part = PathBuf::from(format!("{}.part", dir.display()));
        let _ = fs::remove_dir_all(&part);
        fs::create_dir_all(&part).map_err(|e| js::fs_error(&e, "mkdir", &part))?;
        let status = hide(Command::new(tar_program()).arg("-xzf").arg(&archive).arg("-C").arg(&part).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()))
            .status()
            .map_err(|e| crate::proc::spawn_error("tar", &e))?;
        if !status.success() || launcher_jar(&part).is_none() {
            let _ = fs::remove_dir_all(&part);
            return Err(format!("Could not unpack {name} (tar exit {})", status.code().map(|c| c.to_string()).unwrap_or_else(|| "null".into())));
        }
        let _ = fs::remove_dir_all(&dir);
        fs::rename(&part, &dir).map_err(|e| js::fs_error(&e, "rename", &part))?;
        ctx.log(&format!("Installed in {}", dir.display()));
        Ok(json!({ "installed": true, "dir": s(&dir) }))
    }

    pub fn lsp_start(&self, root: &str, language: &str) -> Result<Value, String> {
        let dir = workspace::normalize(root);
        let ws = s(&dir);
        if !dir.is_dir() {
            return Err(format!("{ws} is not a folder"));
        }
        workspace::require_trusted(&self.store, &ws)?;
        let server = self.lsp_server(language)?;
        let install = self.lsp_install_dir(&server);
        let jar = launcher_jar(&install).ok_or_else(|| format!("{} is not installed yet", js::string(&server["name"])))?;
        let min = server["javaMin"].as_i64().unwrap_or(21);
        let java = self.java.select(min, None, false, None).ok_or_else(|| format!("{} needs Java {min} or newer", js::string(&server["name"])))?;
        let stale: Vec<String> = lock().iter().filter(|(_, v)| v.workspace == ws && v.language == language).map(|(k, _)| k.clone()).collect();
        for id in stale {
            if let Some(s) = lock().remove(&id) {
                shut_down(s, Duration::from_secs(5));
            }
        }
        let key = hex::encode(Sha1::digest(ws.to_lowercase().as_bytes()));
        let data = self.data.join("lsp").join("workspaces").join(&key[..16]);
        fs::create_dir_all(&data).map_err(|e| js::fs_error(&e, "mkdir", &data))?;
        let mut cmd = Command::new(js::string(&java["executable"]));
        cmd.args([
            "-Declipse.application=org.eclipse.jdt.ls.core.id1",
            "-Dosgi.bundles.defaultStartLevel=4",
            "-Declipse.product=org.eclipse.jdt.ls.core.product",
            "-Dlog.level=WARNING",
            "-Djava.import.generatesMetadataFilesAtProjectRoot=false",
            "-Xms256m",
            "-Xmx2G",
            "--add-modules=ALL-SYSTEM",
            "--add-opens",
            "java.base/java.util=ALL-UNNAMED",
            "--add-opens",
            "java.base/java.lang=ALL-UNNAMED",
            "-jar",
        ])
        .arg(&jar)
        .arg("-configuration")
        .arg(install.join(config_dir_name()))
        .arg("-data")
        .arg(&data)
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
        let mut child = hide(&mut cmd).spawn().map_err(|e| crate::proc::spawn_error("java", &e))?;
        let pid = child.id();
        let stdin = child.stdin.take().ok_or("The language server has no input stream")?;
        let stdout = child.stdout.take().ok_or("The language server has no output stream")?;
        let mut rnd = [0u8; 8];
        getrandom::fill(&mut rnd).map_err(|e| e.to_string())?;
        let id = hex::encode(rnd);
        let exited = Arc::new(AtomicBool::new(false));
        lock().insert(id.clone(), Arc::new(Session { workspace: ws.clone(), language: language.to_string(), pid, stdin: Mutex::new(stdin), exited: exited.clone() }));
        let ops = self.ops.clone();
        let session = id.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut length: Option<usize> = None;
                let mut line = String::new();
                let mut eof = false;
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => {
                            eof = true;
                            break;
                        }
                        Ok(_) => {}
                    }
                    let trimmed = line.trim_end();
                    if trimmed.is_empty() {
                        break;
                    }
                    if let Some(v) = trimmed.strip_prefix("Content-Length:") {
                        length = v.trim().parse().ok();
                    }
                }
                if eof {
                    break;
                }
                let Some(n) = length else { continue };
                let mut body = vec![0u8; n];
                if reader.read_exact(&mut body).is_err() {
                    break;
                }
                ops.emit_event("lsp.message", json!({ "session": session, "message": String::from_utf8_lossy(&body) }));
            }
            let code = child.wait().ok().and_then(|s| s.code());
            exited.store(true, Ordering::SeqCst);
            lock().remove(&session);
            ops.emit_event("lsp.exited", json!({ "session": session, "code": code }));
        });
        let gradle_home = self.resolve_gradle_java(&dir).ok().map(|(j, _)| j["home"].clone()).unwrap_or(Value::Null);
        Ok(json!({
            "session": id,
            "rootUri": file_uri(&dir),
            "server": server["name"],
            "version": server["version"],
            "initializationOptions": {
                "bundles": [],
                "settings": {
                    "java": {
                        "import": { "generatesMetadataFilesAtProjectRoot": false, "gradle": { "enabled": true, "wrapper": { "enabled": true }, "java": { "home": gradle_home } }, "maven": { "enabled": false } },
                        "configuration": { "updateBuildConfiguration": "automatic" },
                        "completion": { "enabled": true },
                        "signatureHelp": { "enabled": true },
                        "format": { "enabled": true }
                    }
                },
                "extendedClientCapabilities": { "classFileContentsSupport": false, "progressReportProvider": false }
            }
        }))
    }

    pub fn lsp_send(&self, session: &str, message: &str) -> Result<Value, String> {
        let target = lock().get(session).cloned().ok_or_else(|| format!("No language server session {session}"))?;
        write_message(&target.stdin, message).map_err(|e| format!("The language server stopped accepting input: {e}"))?;
        Ok(json!({ "sent": true }))
    }

    pub fn lsp_stop(&self, session: &str) -> Value {
        let removed = lock().remove(session);
        let stopped = removed.is_some();
        if let Some(s) = removed {
            std::thread::spawn(move || shut_down(s, Duration::from_secs(5)));
        }
        json!({ "stopped": stopped })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_uris() {
        assert_eq!(file_uri(Path::new("D:\\Minecraft\\My Mod")), "file:///D:/Minecraft/My%20Mod");
        assert_eq!(file_uri(Path::new("/home/galaxy/mod")), "file:///home/galaxy/mod");
    }
}
