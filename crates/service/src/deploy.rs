use crate::js;
use crate::launch::find_profile;
use crate::manifest;
use crate::ops::OpCtx;
use crate::rt::Runtime;
use crate::secrets::SecretStore;
use crate::workspace;
use russh::keys::PublicKeyOrCertificate;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWriteExt;

pub const MANIFEST: &str = ".modsmith-deploy.json";
const CHUNK: usize = 256 * 1024;

#[derive(Clone)]
pub struct Target {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub remote_dir: String,
    pub mode: String,
    pub remove_stale: bool,
}

pub fn parse_target(v: &Value) -> Result<Target, String> {
    let host = js::string(&v["host"]).trim().to_string();
    if host.is_empty() || host.contains(char::is_whitespace) || host.contains('/') {
        return Err("Enter the server's host name, for example the one in your host's SFTP details".into());
    }
    let username = js::string(&v["username"]).trim().to_string();
    if username.is_empty() {
        return Err("Enter the SFTP user name".into());
    }
    let port = v["port"].as_u64().filter(|p| (1..=65535).contains(p)).ok_or_else(|| "The port must be between 1 and 65535".to_string())? as u16;
    Ok(Target {
        host,
        port,
        username,
        remote_dir: normalize_remote(&js::string(&v["remoteDir"])),
        mode: if v["mode"] == "full" { "full".into() } else { "mods".into() },
        remove_stale: v["removeStale"] != false,
    })
}

pub fn normalize_remote(dir: &str) -> String {
    let parts: Vec<&str> = dir.split(['/', '\\']).filter(|p| !p.is_empty() && *p != ".").collect();
    format!("/{}", parts.join("/"))
}

fn remote_path(dir: &str, rel: &str) -> String {
    if dir == "/" {
        format!("/{rel}")
    } else {
        format!("{dir}/{rel}")
    }
}

pub fn selected(rel: &str, mode: &str) -> bool {
    if rel == "server.properties" || rel == "eula.txt" || rel == MANIFEST {
        return false;
    }
    if mode == "full" {
        !rel.starts_with("world/") || rel.starts_with("world/datapacks/")
    } else {
        rel.starts_with("mods/") || rel.starts_with("config/")
    }
}

pub fn secret_name(t: &Target) -> String {
    format!("deploy:{}@{}:{}", t.username, t.host, t.port)
}

fn host_id(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

fn read_json(file: &Path) -> Map<String, Value> {
    fs::read_to_string(file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

fn write_json(file: &Path, m: &Map<String, Value>) -> Result<(), String> {
    if let Some(d) = file.parent() {
        let _ = fs::create_dir_all(d);
    }
    fs::write(file, js::pretty(&Value::Object(m.clone()))).map_err(|e| js::fs_error(&e, "open", file))
}

pub struct LocalFile {
    pub rel: String,
    pub path: PathBuf,
    pub size: u64,
    pub sha1: String,
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(root, &p, out);
        } else {
            out.push(p);
        }
    }
}

pub fn local_files(root: &Path, mode: &str) -> Result<Vec<LocalFile>, String> {
    let mut paths = Vec::new();
    walk(root, root, &mut paths);
    let mut out = Vec::new();
    for p in paths {
        let rel = p.strip_prefix(root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
        if !selected(&rel, mode) {
            continue;
        }
        let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        let sha1 = crate::http::hash_file(&p, "sha1")?;
        out.push(LocalFile { rel, path: p, size, sha1 });
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(out)
}

pub struct Plan {
    pub upload: Vec<(usize, &'static str)>,
    pub remove: Vec<String>,
    pub unchanged: usize,
}

pub fn plan(local: &[LocalFile], remote: &BTreeMap<String, Option<u64>>, previous: &Map<String, Value>, remove_stale: bool) -> Plan {
    let mut upload = Vec::new();
    let mut unchanged = 0;
    for (i, f) in local.iter().enumerate() {
        match remote.get(&f.rel).copied().flatten() {
            None => upload.push((i, "new")),
            Some(size) if size != f.size => upload.push((i, "changed")),
            Some(_) if previous.get(&f.rel).map(|p| js::string(&p["sha1"])) != Some(f.sha1.clone()) => upload.push((i, "changed")),
            Some(_) => unchanged += 1,
        }
    }
    let mut remove = Vec::new();
    if remove_stale {
        for (rel, p) in previous {
            if !rel.starts_with("mods/") || local.iter().any(|f| &f.rel == rel) {
                continue;
            }
            if matches!((remote.get(rel).copied().flatten(), p["size"].as_u64()), (Some(a), Some(b)) if a == b) {
                remove.push(rel.clone());
            }
        }
    }
    Plan { upload, remove, unchanged }
}

struct KeyCheck {
    expected: Option<String>,
    seen: Arc<Mutex<Option<(String, String)>>>,
}

impl russh::client::Handler for KeyCheck {
    type Error = russh::Error;
    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else { return Ok(false) };
        let fp = key.fingerprint(Default::default()).to_string();
        *self.seen.lock().unwrap_or_else(|e| e.into_inner()) = Some((fp.clone(), key.algorithm().to_string()));
        Ok(self.expected.as_ref().is_none_or(|e| *e == fp))
    }
}

fn runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())
}

fn on_thread<T: Send>(f: impl FnOnce() -> Result<T, String> + Send) -> Result<T, String> {
    std::thread::scope(|s| s.spawn(f).join().unwrap_or_else(|_| Err("The SFTP connection thread stopped unexpectedly".into())))
}

async fn connect(t: &Target, expected: Option<String>) -> Result<(russh::client::Handle<KeyCheck>, String, String), String> {
    let seen = Arc::new(Mutex::new(None));
    let cfg = Arc::new(russh::client::Config { inactivity_timeout: Some(std::time::Duration::from_secs(60)), ..Default::default() });
    let handler = KeyCheck { expected: expected.clone(), seen: seen.clone() };
    let addr = (t.host.as_str(), t.port);
    let connected = tokio::time::timeout(std::time::Duration::from_secs(20), russh::client::connect(cfg, addr, handler)).await;
    let result = match connected {
        Err(_) => return Err(format!("Could not reach {}:{} within 20 seconds", t.host, t.port)),
        Ok(r) => r,
    };
    let (fp, alg) = seen.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_default();
    match result {
        Ok(h) => Ok((h, fp, alg)),
        Err(_) if !fp.is_empty() && expected.as_ref().is_some_and(|e| *e != fp) => Err(format!(
            "The host key of {}:{} has changed: Modsmith trusted {} but the server now presents {fp}. If the host moved your server, check the new key with your host and trust it again; otherwise someone may be intercepting the connection.",
            t.host,
            t.port,
            expected.unwrap_or_default()
        )),
        Err(e) => Err(format!("Could not connect to {}:{}: {e}", t.host, t.port)),
    }
}

pub fn probe_host_key(t: &Target) -> Result<(String, String), String> {
    on_thread(|| {
        runtime()?.block_on(async {
            let (h, fp, alg) = connect(t, None).await?;
            let _ = h.disconnect(russh::Disconnect::ByApplication, "", "en").await;
            Ok((fp, alg))
        })
    })
}

async fn open_sftp(t: &Target, key: &str, password: &str) -> Result<(russh::client::Handle<KeyCheck>, russh_sftp::client::SftpSession), String> {
    let (mut h, _, _) = connect(t, Some(key.to_string())).await?;
    let auth = h.authenticate_password(t.username.clone(), password.to_string()).await.map_err(|e| format!("SFTP login failed: {e}"))?;
    if !auth.success() {
        return Err(format!("The server refused the user name or password for {}", t.username));
    }
    let channel = h.channel_open_session().await.map_err(|e| e.to_string())?;
    channel.request_subsystem(true, "sftp").await.map_err(|e| e.to_string())?;
    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream()).await.map_err(|e| format!("The server did not start SFTP: {e}"))?;
    Ok((h, sftp))
}

async fn ensure_dir(sftp: &russh_sftp::client::SftpSession, dir: &str, made: &mut Vec<String>) -> Result<(), String> {
    let mut current = String::new();
    for part in dir.split('/').filter(|p| !p.is_empty()) {
        current = format!("{current}/{part}");
        if made.contains(&current) {
            continue;
        }
        match sftp.metadata(current.clone()).await {
            Ok(m) if m.is_dir() => {}
            Ok(_) => return Err(format!("{current} exists on the server and is not a folder")),
            Err(_) => sftp.create_dir(current.clone()).await.map_err(|e| format!("Could not create {current}: {e}"))?,
        }
        made.push(current.clone());
    }
    Ok(())
}

async fn upload(sftp: &russh_sftp::client::SftpSession, local: &Path, remote: &str, ctx: &OpCtx, done: &mut u64, total: u64) -> Result<(), String> {
    let tmp = format!("{remote}.modsmith-upload");
    let data = fs::read(local).map_err(|e| js::fs_error(&e, "open", local))?;
    let mut file = sftp.create(tmp.clone()).await.map_err(|e| format!("Could not write {tmp}: {e}"))?;
    for chunk in data.chunks(CHUNK) {
        if ctx.cancelled() {
            let _ = file.shutdown().await;
            let _ = sftp.remove_file(tmp.clone()).await;
            return Err("Cancelled".into());
        }
        file.write_all(chunk).await.map_err(|e| format!("Upload of {remote} failed: {e}"))?;
        *done += chunk.len() as u64;
        if total > 0 {
            ctx.progress(Some(0.4 + 0.55 * (*done as f64 / total as f64)), None);
        }
    }
    file.shutdown().await.map_err(|e| format!("Upload of {remote} failed: {e}"))?;
    if sftp.metadata(remote.to_string()).await.is_ok() {
        sftp.remove_file(remote.to_string()).await.map_err(|e| format!("Could not replace {remote}: {e}"))?;
    }
    sftp.rename(tmp.clone(), remote.to_string()).await.map_err(|e| format!("Could not move {tmp} into place: {e}"))
}

pub struct DeployInput<'a> {
    pub target: &'a Target,
    pub key: &'a str,
    pub password: &'a str,
    pub local: &'a [LocalFile],
    pub profile: &'a str,
    pub dry_run: bool,
}

pub fn run(input: DeployInput, ctx: &OpCtx) -> Result<Value, String> {
    on_thread(|| runtime()?.block_on(run_async(input, ctx)))
}

async fn run_async(input: DeployInput<'_>, ctx: &OpCtx) -> Result<Value, String> {
    let t = input.target;
    ctx.progress(Some(0.3), Some(&format!("Connecting to {}:{}", t.host, t.port)));
    let (handle, sftp) = open_sftp(t, input.key, input.password).await?;
    ctx.log(&format!("Connected to {}:{} as {}", t.host, t.port, t.username));
    let manifest_path = remote_path(&t.remote_dir, MANIFEST);
    let previous: Map<String, Value> = match sftp.read(manifest_path.clone()).await {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| v["files"].as_object().cloned()).unwrap_or_default(),
        Err(_) => Map::new(),
    };
    ctx.progress(Some(0.35), Some("Comparing with the files on the server"));
    let mut remote: BTreeMap<String, Option<u64>> = BTreeMap::new();
    for rel in input.local.iter().map(|f| f.rel.clone()).chain(previous.keys().cloned()) {
        if remote.contains_key(&rel) {
            continue;
        }
        let size = sftp.metadata(remote_path(&t.remote_dir, &rel)).await.ok().filter(|m| !m.is_dir()).map(|m| m.len());
        remote.insert(rel, size);
    }
    let p = plan(input.local, &remote, &previous, t.remove_stale);
    let total: u64 = p.upload.iter().map(|(i, _)| input.local[*i].size).sum();
    let mut uploaded = Vec::new();
    for (i, reason) in &p.upload {
        uploaded.push(json!({ "path": input.local[*i].rel, "size": input.local[*i].size, "reason": reason }));
    }
    if !input.dry_run {
        let mut made = Vec::new();
        ensure_dir(&sftp, &t.remote_dir, &mut made).await?;
        let mut done = 0u64;
        for (i, _) in &p.upload {
            let f = &input.local[*i];
            let target = remote_path(&t.remote_dir, &f.rel);
            if let Some((parent, _)) = target.rsplit_once('/') {
                ensure_dir(&sftp, parent, &mut made).await?;
            }
            ctx.progress(None, Some(&format!("Uploading {}", f.rel)));
            upload(&sftp, &f.path, &target, ctx, &mut done, total).await?;
            ctx.log(&format!("Uploaded {} ({} bytes)", f.rel, f.size));
        }
        for rel in &p.remove {
            sftp.remove_file(remote_path(&t.remote_dir, rel)).await.map_err(|e| format!("Could not remove {rel}: {e}"))?;
            ctx.log(&format!("Removed {rel}"));
        }
        let mut files = Map::new();
        for (rel, v) in &previous {
            if !p.remove.contains(rel) && !input.local.iter().any(|f| &f.rel == rel) && remote.get(rel).copied().flatten().is_some() {
                files.insert(rel.clone(), v.clone());
            }
        }
        for f in input.local {
            files.insert(f.rel.clone(), json!({ "sha1": f.sha1, "size": f.size }));
        }
        let mut sorted: Vec<(String, Value)> = files.into_iter().collect();
        sorted.sort_by(|a, b| a.0.cmp(&b.0));
        let doc = json!({ "version": 1, "profile": input.profile, "deployedAt": js::iso_now(), "files": Value::Object(sorted.into_iter().collect()) });
        let tmp = format!("{manifest_path}.modsmith-upload");
        let mut file = sftp.create(tmp.clone()).await.map_err(|e| format!("Could not write {tmp}: {e}"))?;
        file.write_all(js::pretty(&doc).as_bytes()).await.map_err(|e| e.to_string())?;
        file.shutdown().await.map_err(|e| e.to_string())?;
        if sftp.metadata(manifest_path.clone()).await.is_ok() {
            let _ = sftp.remove_file(manifest_path.clone()).await;
        }
        sftp.rename(tmp, manifest_path).await.map_err(|e| e.to_string())?;
    }
    let _ = sftp.close().await;
    let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
    Ok(json!({ "upload": uploaded, "remove": p.remove, "unchanged": p.unchanged, "uploadBytes": total }))
}

fn targets_file(rt: &Runtime) -> PathBuf {
    rt.data.join("deploy-targets.json")
}

fn known_hosts_file(rt: &Runtime) -> PathBuf {
    rt.data.join("known-hosts.json")
}

fn target_key(dir: &Path, profile: &str) -> String {
    format!("{}#{profile}", dir.to_string_lossy())
}

fn secrets(rt: &Runtime) -> SecretStore {
    SecretStore::new(rt.data.join("secrets.json"))
}

fn target_json(t: &Target) -> Value {
    json!({ "host": t.host, "port": t.port, "username": t.username, "remoteDir": t.remote_dir, "mode": t.mode, "removeStale": t.remove_stale })
}

fn server_profile(dir: &Path, root: &str, profile_id: &str) -> Result<(Value, Value), String> {
    let m = manifest::require_manifest(dir, root)?;
    let profile = find_profile(&m, profile_id).ok_or_else(|| format!("Unknown profile {profile_id}"))?;
    if profile["side"] != "server" {
        return Err(format!("Profile {profile_id} is not a server profile"));
    }
    Ok((m, profile))
}

impl Runtime {
    pub fn deploy_target_get(&self, root: &str, profile_id: &str) -> Result<Value, String> {
        let dir = workspace::normalize(root);
        server_profile(&dir, root, profile_id)?;
        let saved = read_json(&targets_file(self)).get(&target_key(&dir, profile_id)).cloned();
        let Some(saved) = saved else { return Ok(json!({ "target": null, "hasPassword": false, "hostKey": null })) };
        let t = parse_target(&saved)?;
        let known = read_json(&known_hosts_file(self)).get(&host_id(&t.host, t.port)).cloned().unwrap_or(Value::Null);
        Ok(json!({ "target": target_json(&t), "hasPassword": secrets(self).has(&secret_name(&t)), "hostKey": known }))
    }

    pub fn deploy_target_set(&self, root: &str, profile_id: &str, target: &Value, password: Option<&Value>) -> Result<Value, String> {
        let dir = workspace::normalize(root);
        server_profile(&dir, root, profile_id)?;
        let t = parse_target(target)?;
        let file = targets_file(self);
        let mut all = read_json(&file);
        all.insert(target_key(&dir, profile_id), target_json(&t));
        write_json(&file, &all)?;
        match password {
            Some(Value::String(p)) if !p.is_empty() => secrets(self).set(&secret_name(&t), p)?,
            Some(Value::Null) => secrets(self).delete(&secret_name(&t))?,
            _ => {}
        }
        self.deploy_target_get(root, profile_id)
    }

    pub fn deploy_host_key(&self, target: &Value) -> Result<Value, String> {
        let t = parse_target(target)?;
        let (fp, alg) = probe_host_key(&t)?;
        let trusted = read_json(&known_hosts_file(self)).get(&host_id(&t.host, t.port)).map(js::string);
        Ok(json!({ "host": t.host, "port": t.port, "hostKey": fp, "algorithm": alg, "trusted": trusted.as_deref() == Some(fp.as_str()), "changed": trusted.is_some_and(|k| k != fp) }))
    }

    pub fn deploy_trust_host(&self, host: &str, port: u64, host_key: &str) -> Result<Value, String> {
        if !host_key.starts_with("SHA256:") {
            return Err("hostKey must be a SHA256 fingerprint from deploy.host_key".into());
        }
        let file = known_hosts_file(self);
        let mut all = read_json(&file);
        all.insert(host_id(host.trim(), port as u16), json!(host_key));
        write_json(&file, &all)?;
        Ok(json!({ "host": host.trim(), "port": port, "hostKey": host_key, "trusted": true }))
    }

    pub fn server_deploy(self: &Arc<Self>, root: &str, profile_id: &str, dry_run: bool, confirm: bool, password: Option<String>) -> Result<Value, String> {
        let dir = workspace::normalize(root);
        let (m, profile) = server_profile(&dir, root, profile_id)?;
        if !dry_run && !confirm {
            return Err("A deploy changes files on the server; preview it with dryRun, then pass confirm: true".into());
        }
        let loader = js::string(&m["platform"]["loader"]);
        if !crate::scaffold::implemented(&loader) {
            return Err(format!("Server deploys are not implemented for {loader}"));
        }
        if m["source"]["kind"] == "gradle" {
            workspace::require_trusted(&self.store, &dir.to_string_lossy())?;
        }
        let saved = read_json(&targets_file(self)).get(&target_key(&dir, profile_id)).cloned().ok_or_else(|| format!("Set up where to deploy {profile_id} first (deploy.target_set)"))?;
        let t = parse_target(&saved)?;
        let key = read_json(&known_hosts_file(self))
            .get(&host_id(&t.host, t.port))
            .map(js::string)
            .ok_or_else(|| format!("Modsmith has not seen the host key of {}:{} yet; check it with deploy.host_key and trust it first", t.host, t.port))?;
        let password = match password.filter(|p| !p.is_empty()) {
            Some(p) => p,
            None => secrets(self).get(&secret_name(&t))?.ok_or_else(|| format!("No password is saved for {}; enter it to deploy", t.username))?,
        };
        let me = self.clone();
        let title = format!("{} {} to {}", if dry_run { "Preview deploy of" } else { "Deploy" }, js::string(&profile["name"]), t.host);
        Ok(self.ops.start("server.deploy", &title, Some(dir.to_string_lossy().to_string()), move |ctx| {
            let staging = manifest::state_dir(&dir).join("deploy").join(js::string(&profile["id"]));
            let _ = fs::remove_dir_all(&staging);
            ctx.progress(Some(0.02), Some("Preparing the server pack"));
            me.export_server_pack_into(&dir, &m, &profile, &staging, false, t.mode == "full", ctx)?;
            let local = local_files(&staging, &t.mode)?;
            ctx.log(&format!("{} files to compare ({} mode)", local.len(), t.mode));
            let mut out = run(DeployInput { target: &t, key: &key, password: &password, local: &local, profile: &js::string(&profile["id"]), dry_run }, ctx)?;
            let _ = fs::remove_dir_all(&staging);
            if let Value::Object(o) = &mut out {
                o.insert("host".into(), json!(t.host));
                o.insert("port".into(), json!(t.port));
                o.insert("remoteDir".into(), json!(t.remote_dir));
                o.insert("mode".into(), json!(t.mode));
                o.insert("dryRun".into(), json!(dry_run));
                o.insert("minecraft".into(), m["platform"]["minecraft"].clone());
                o.insert("loader".into(), m["platform"]["loader"].clone());
                o.insert("loaderVersion".into(), m["platform"]["loaderVersion"].clone());
            }
            ctx.progress(Some(1.0), Some(if dry_run { "Preview ready" } else { "Deployed" }));
            Ok(Some(out))
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lf(rel: &str, size: u64, sha1: &str) -> LocalFile {
        LocalFile { rel: rel.into(), path: PathBuf::new(), size, sha1: sha1.into() }
    }

    #[test]
    fn selection() {
        assert!(selected("mods/a.jar", "mods"));
        assert!(selected("config/a.toml", "mods"));
        assert!(!selected("libraries/x.jar", "mods"));
        assert!(!selected("server.properties", "full"));
        assert!(!selected("world/level.dat", "full"));
        assert!(selected("world/datapacks/p.zip", "full"));
        assert!(selected("libraries/x.jar", "full"));
        assert_eq!(normalize_remote(""), "/");
        assert_eq!(normalize_remote("server/./files/"), "/server/files");
    }

    #[test]
    fn plans() {
        let local = vec![lf("mods/a.jar", 10, "a"), lf("mods/b.jar", 5, "b"), lf("mods/c.jar", 7, "c"), lf("config/x.toml", 3, "x")];
        let mut remote = BTreeMap::new();
        remote.insert("mods/a.jar".to_string(), Some(10));
        remote.insert("mods/b.jar".to_string(), Some(6));
        remote.insert("mods/c.jar".to_string(), Some(7));
        remote.insert("config/x.toml".to_string(), None);
        remote.insert("mods/old.jar".to_string(), Some(4));
        remote.insert("mods/userswap.jar".to_string(), Some(9));
        let previous: Map<String, Value> = serde_json::from_value(json!({
            "mods/a.jar": { "sha1": "a", "size": 10 },
            "mods/c.jar": { "sha1": "old", "size": 7 },
            "mods/old.jar": { "sha1": "o", "size": 4 },
            "mods/userswap.jar": { "sha1": "u", "size": 2 },
            "config/gone.toml": { "sha1": "g", "size": 1 }
        }))
        .unwrap();
        let p = plan(&local, &remote, &previous, true);
        let up: Vec<(&str, &str)> = p.upload.iter().map(|(i, r)| (local[*i].rel.as_str(), *r)).collect();
        assert_eq!(up, vec![("mods/b.jar", "changed"), ("mods/c.jar", "changed"), ("config/x.toml", "new")]);
        assert_eq!(p.unchanged, 1);
        assert_eq!(p.remove, vec!["mods/old.jar".to_string()]);
        assert!(plan(&local, &remote, &previous, false).remove.is_empty());
    }
}
