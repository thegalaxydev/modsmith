use crate::http::{download_verified, encode_uri_component, Expected, Http};
use crate::js;
use crate::ops::OpCtx;
use crate::proc::{run_process, RunOptions};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

const MANIFEST_URL: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

pub struct Platform {
    pub os: &'static str,
    pub arch: &'static str,
}

pub fn current_platform() -> Platform {
    let os = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "x86",
        "arm" => "arm",
        other => other,
    };
    Platform { os, arch }
}

pub fn rules_allow(rules: Option<&Value>, platform: &Platform, features: &Map<String, Value>) -> bool {
    let Some(rules) = rules.and_then(Value::as_array).filter(|r| !r.is_empty()) else { return true };
    let mut allowed = false;
    for r in rules {
        let mut matched = true;
        if let Some(name) = r["os"]["name"].as_str().filter(|n| !n.is_empty()) {
            if name != platform.os {
                matched = false;
            }
        }
        if let Some(arch) = r["os"]["arch"].as_str().filter(|n| !n.is_empty()) {
            if arch != platform.arch {
                matched = false;
            }
        }
        if let Some(f) = r["features"].as_object() {
            for (k, v) in f {
                if features.get(k).cloned().unwrap_or(json!(false)) != *v {
                    matched = false;
                }
            }
        }
        if matched {
            allowed = r["action"] == "allow";
        }
    }
    allowed
}

pub fn maven_path(name: &str) -> Result<String, String> {
    let mut split = name.splitn(2, '@');
    let coords = split.next().unwrap_or("");
    let ext = split.next().unwrap_or("jar");
    let parts: Vec<&str> = coords.split(':').collect();
    let (group, artifact, version) = (parts.first().copied().unwrap_or(""), parts.get(1).copied().unwrap_or(""), parts.get(2).copied().unwrap_or(""));
    if group.is_empty() || artifact.is_empty() || version.is_empty() {
        return Err(format!("Invalid library name {name}"));
    }
    let classifier = parts.get(3).filter(|c| !c.is_empty()).map(|c| format!("-{c}")).unwrap_or_default();
    Ok(format!("{}/{artifact}/{version}/{artifact}-{version}{classifier}.{ext}", group.replace('.', "/")))
}

fn library_key(name: &str) -> String {
    let parts: Vec<&str> = name.split('@').next().unwrap_or("").split(':').collect();
    format!("{}:{}:{}", parts.first().copied().unwrap_or(""), parts.get(1).copied().unwrap_or(""), parts.get(3).copied().unwrap_or(""))
}

fn arr(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}

fn or_value(a: &Value, b: &Value) -> Value {
    if a.is_null() {
        b.clone()
    } else {
        a.clone()
    }
}

pub fn merge_versions(child: &Value, parent: &Value) -> Value {
    let child_libs = arr(&child["libraries"]);
    let keys: HashSet<String> = child_libs.iter().map(|l| library_key(l["name"].as_str().unwrap_or(""))).collect();
    let mut libs = child_libs.clone();
    libs.extend(arr(&parent["libraries"]).into_iter().filter(|l| !keys.contains(&library_key(l["name"].as_str().unwrap_or("")))));
    let mut out = parent.as_object().cloned().unwrap_or_default();
    for (k, v) in child.as_object().cloned().unwrap_or_default() {
        out.insert(k, v);
    }
    out.shift_remove("inheritsFrom");
    out.insert("libraries".into(), Value::Array(libs));
    let mut game = arr(&parent["arguments"]["game"]);
    game.extend(arr(&child["arguments"]["game"]));
    let mut jvm = arr(&parent["arguments"]["jvm"]);
    jvm.extend(arr(&child["arguments"]["jvm"]));
    out.insert("arguments".into(), json!({ "game": game, "jvm": jvm }));
    for k in ["assetIndex", "assets", "downloads", "javaVersion"] {
        let v = or_value(&child[k], &parent[k]);
        if v.is_null() {
            out.shift_remove(k);
        } else {
            out.insert(k.into(), v);
        }
    }
    Value::Object(out)
}

pub struct ResolvedLibrary {
    pub name: String,
    pub file: PathBuf,
    pub url: Option<String>,
    pub sha1: Option<String>,
    pub size: Option<u64>,
}

pub fn library_files(version: &Value, libraries_dir: &Path, platform: &Platform) -> Vec<ResolvedLibrary> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let none = Map::new();
    for lib in arr(&version["libraries"]) {
        if !rules_allow(lib.get("rules"), platform, &none) {
            continue;
        }
        let name = lib["name"].as_str().unwrap_or("").to_string();
        let mut add = |rel: &str, a: Option<&Value>, fallback: Option<String>| {
            let mut file = libraries_dir.to_path_buf();
            for part in rel.split('/') {
                file.push(part);
            }
            let key = file.to_string_lossy().to_string();
            if !seen.insert(key) {
                return;
            }
            let url = a.and_then(|a| a["url"].as_str()).filter(|u| !u.is_empty()).map(str::to_string).or(fallback);
            let sha1 = a.and_then(|a| a["sha1"].as_str()).or(lib["sha1"].as_str()).map(str::to_string);
            let size = a.and_then(|a| a["size"].as_u64()).or(lib["size"].as_u64());
            out.push(ResolvedLibrary { name: name.clone(), file, url, sha1, size });
        };
        let art = &lib["downloads"]["artifact"];
        if let Some(p) = art["path"].as_str().filter(|p| !p.is_empty()) {
            add(p, Some(art), None);
        } else if lib.get("downloads").is_none_or(Value::is_null) {
            if let Ok(mp) = maven_path(&name) {
                let base = lib["url"].as_str().unwrap_or("https://libraries.minecraft.net/");
                let base = if base.ends_with('/') { base.to_string() } else { format!("{base}/") };
                add(&mp, None, Some(format!("{base}{mp}")));
            }
        }
        let native_key = lib["natives"][platform.os].as_str().map(|k| k.replacen("${arch}", if platform.arch.ends_with("64") { "64" } else { "32" }, 1));
        if let Some(k) = native_key {
            let nat = &lib["downloads"]["classifiers"][k.as_str()];
            if let Some(p) = nat["path"].as_str().filter(|p| !p.is_empty()) {
                add(p, Some(nat), None);
            }
        }
    }
    out
}

pub fn offline_uuid(name: &str) -> String {
    let mut d = md5_digest(format!("OfflinePlayer:{name}").as_bytes());
    d[6] = (d[6] & 0x0f) | 0x30;
    d[8] = (d[8] & 0x3f) | 0x80;
    let h = hex::encode(d);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

fn md5_digest(input: &[u8]) -> [u8; 16] {
    let s: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    let k: Vec<u32> = (0..64).map(|i| ((i as f64 + 1.0).sin().abs() * 4294967296.0) as u32).collect();
    let (mut a0, mut b0, mut c0, mut d0) = (0x67452301u32, 0xefcdab89u32, 0x98badcfeu32, 0x10325476u32);
    let mut msg = input.to_vec();
    let bits = (input.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bits.to_le_bytes());
    for chunk in msg.chunks(64) {
        let m: Vec<u32> = chunk.chunks(4).map(|w| u32::from_le_bytes([w[0], w[1], w[2], w[3]])).collect();
        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for i in 0..64 {
            let (mut f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            f = f.wrapping_add(a).wrapping_add(k[i]).wrapping_add(m[g]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(f.rotate_left(s[i]));
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }
    let mut out = [0u8; 16];
    out[..4].copy_from_slice(&a0.to_le_bytes());
    out[4..8].copy_from_slice(&b0.to_le_bytes());
    out[8..12].copy_from_slice(&c0.to_le_bytes());
    out[12..].copy_from_slice(&d0.to_le_bytes());
    out
}

fn substitute(s: &str, vars: &Map<String, Value>) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"\$\{([a-zA-Z_]+)\}").expect("argument regex"));
    re.replace_all(s, |c: &regex::Captures| vars.get(&c[1]).and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| c[0].to_string())).to_string()
}

pub fn expand_arguments(args: &Value, vars: &Map<String, Value>, platform: &Platform) -> Vec<String> {
    let mut out = Vec::new();
    let none = Map::new();
    for a in arr(args) {
        match &a {
            Value::String(s) => out.push(s.clone()),
            _ => {
                if rules_allow(a.get("rules"), platform, &none) {
                    match &a["value"] {
                        Value::Array(v) => out.extend(v.iter().map(js::string)),
                        v => out.push(js::string(v)),
                    }
                }
            }
        }
    }
    out.into_iter().map(|s| substitute(&s, vars)).collect()
}

pub struct ClientLaunch {
    pub main_class: String,
    pub jvm_args: Vec<String>,
    pub game_args: Vec<String>,
}

pub struct LaunchPaths<'a> {
    pub libraries_dir: &'a Path,
    pub client_jar: &'a Path,
    pub game_dir: &'a Path,
    pub assets_dir: &'a Path,
    pub natives_dir: &'a Path,
    pub username: &'a str,
}

pub fn build_client_launch(version: &Value, o: &LaunchPaths, platform: &Platform) -> ClientLaunch {
    let sep = if cfg!(windows) { ";" } else { ":" };
    let mut cp: Vec<String> = library_files(version, o.libraries_dir, platform).into_iter().map(|l| l.file.to_string_lossy().to_string()).collect();
    cp.push(o.client_jar.to_string_lossy().to_string());
    let classpath = cp.join(sep);
    let s = |p: &Path| p.to_string_lossy().to_string();
    let index = version["assetIndex"]["id"].as_str().or(version["assets"].as_str()).unwrap_or("").to_string();
    let mut vars = Map::new();
    for (k, v) in [
        ("auth_player_name", o.username.to_string()),
        ("version_name", js::string(&version["id"])),
        ("game_directory", s(o.game_dir)),
        ("assets_root", s(o.assets_dir)),
        ("game_assets", s(o.assets_dir)),
        ("assets_index_name", index),
        ("auth_uuid", offline_uuid(o.username).replace('-', "")),
        ("auth_access_token", "0".into()),
        ("auth_session", "0".into()),
        ("clientid", "0".into()),
        ("auth_xuid", "0".into()),
        ("user_type", "legacy".into()),
        ("user_properties", "{}".into()),
        ("version_type", version["type"].as_str().unwrap_or("release").to_string()),
        ("natives_directory", s(o.natives_dir)),
        ("launcher_name", "modsmith".into()),
        ("launcher_version", crate::api::api().version.clone()),
        ("classpath", classpath.clone()),
        ("classpath_separator", sep.into()),
        ("library_directory", s(o.libraries_dir)),
    ] {
        vars.insert(k.into(), json!(v));
    }
    let mut jvm_args = if version["arguments"]["jvm"].is_array() {
        expand_arguments(&version["arguments"]["jvm"], &vars, platform)
    } else {
        vec![format!("-Djava.library.path={}", s(o.natives_dir)), "-cp".into(), classpath.clone()]
    };
    if !jvm_args.iter().any(|a| a == "-cp" || a == "-classpath") {
        jvm_args.push("-cp".into());
        jvm_args.push(classpath);
    }
    let game_args = if version["arguments"]["game"].is_array() {
        expand_arguments(&version["arguments"]["game"], &vars, platform)
    } else {
        version["minecraftArguments"].as_str().unwrap_or("").split(' ').filter(|s| !s.is_empty()).map(|a| substitute(a, &vars)).collect()
    };
    ClientLaunch { main_class: js::string(&version["mainClass"]), jvm_args, game_args }
}

pub struct InstalledClient {
    pub version: Value,
    pub libraries_dir: PathBuf,
    pub assets_dir: PathBuf,
    pub client_jar: PathBuf,
}

pub fn fetch_sha1(url: &str, what: &str) -> Result<String, String> {
    let res = crate::http::request("GET", &format!("{url}.sha1"), &[], None)?;
    if !res.ok() {
        return Err(format!("{what} ({})", res.status));
    }
    Ok(res.body.trim().chars().take(40).collect())
}

pub struct ClientInstaller<'a> {
    pub http: &'a Http,
    pub root: PathBuf,
}

fn verified(url: &str, dest: &Path, sha1: Option<&str>, size: Option<u64>, ctx: &OpCtx) -> Result<(PathBuf, bool), String> {
    let cancelled = || ctx.cancelled();
    download_verified(url, dest, &Expected { sha1, sha512: None, size }, &cancelled, &|_, _| {})
}

impl ClientInstaller<'_> {
    pub fn libraries_dir(&self) -> PathBuf {
        self.root.join("libraries")
    }

    pub fn assets_dir(&self) -> PathBuf {
        self.root.join("assets")
    }

    fn version_dir(&self, id: &str) -> PathBuf {
        self.root.join("versions").join(id)
    }

    fn read_json(file: &Path) -> Result<Value, String> {
        let text = std::fs::read_to_string(file).map_err(|e| js::fs_error(&e, "open", file))?;
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }

    pub fn vanilla(&self, minecraft: &str, ctx: &OpCtx) -> Result<Value, String> {
        let file = self.version_dir(minecraft).join(format!("{minecraft}.json"));
        let manifest = self.http.get_json(MANIFEST_URL, 6 * 3600 * 1000, &[])?;
        let entry = arr(&manifest.data["versions"]).into_iter().find(|v| v["id"] == minecraft).ok_or_else(|| format!("Minecraft {minecraft} is not in the Mojang version manifest"))?;
        verified(&js::string(&entry["url"]), &file, entry["sha1"].as_str(), None, ctx)?;
        Self::read_json(&file)
    }

    pub fn fabric(&self, minecraft: &str, loader: &str) -> Result<Value, String> {
        let url = format!("https://meta.fabricmc.net/v2/versions/loader/{}/{}/profile/json", encode_uri_component(minecraft), encode_uri_component(loader));
        let v = self.http.get_json(&url, 24 * 3600 * 1000, &[])?.data;
        let id = js::string(&v["id"]);
        let dir = self.version_dir(&id);
        std::fs::create_dir_all(&dir).map_err(|e| js::fs_error(&e, "mkdir", &dir))?;
        let file = dir.join(format!("{id}.json"));
        std::fs::write(&file, js::pretty(&v)).map_err(|e| js::fs_error(&e, "open", &file))?;
        Ok(v)
    }

    pub fn neoforge(&self, minecraft: &str, loader: &str, java: &str, ctx: &OpCtx) -> Result<Value, String> {
        let id = format!("neoforge-{loader}");
        let file = self.version_dir(&id).join(format!("{id}.json"));
        if !file.exists() {
            let url = format!("https://maven.neoforged.net/releases/net/neoforged/neoforge/{loader}/neoforge-{loader}-installer.jar");
            let sha1 = fetch_sha1(&url, "Could not fetch the NeoForge installer checksum")?;
            let (jar, _) = verified(&url, &self.root.join("installers").join(format!("neoforge-{loader}-installer.jar")), Some(&sha1), None, ctx)?;
            let profiles = self.root.join("launcher_profiles.json");
            if !profiles.exists() {
                std::fs::write(&profiles, "{\"profiles\":{}}").map_err(|e| js::fs_error(&e, "open", &profiles))?;
            }
            ctx.log(&format!("Installing NeoForge {loader} client"));
            let cancelled = || ctx.cancelled();
            let mut on_line = |l: &str, _: crate::proc::Stream| ctx.log(l);
            let args = vec!["-jar".to_string(), jar.to_string_lossy().to_string(), "--install-client".into(), self.root.to_string_lossy().to_string()];
            let code = run_process(Path::new(java), &args, RunOptions { cwd: Some(&self.root), env: vec![], env_remove: vec![], cancelled: &cancelled, on_line: &mut on_line })?;
            if code != Some(0) || !file.exists() {
                return Err(format!("The NeoForge client installer failed (exit {})", code.map(|c| c.to_string()).unwrap_or_else(|| "null".into())));
            }
        }
        let v = Self::read_json(&file)?;
        if let Some(parent) = v["inheritsFrom"].as_str().filter(|p| !p.is_empty()) {
            if parent != minecraft {
                return Err(format!("NeoForge {loader} is for Minecraft {parent}, not {minecraft}"));
            }
        }
        Ok(v)
    }

    fn pool<T: Sync>(items: &[T], size: usize, f: &(dyn Fn(&T) -> Result<(), String> + Sync)) -> Result<(), String> {
        let next = AtomicUsize::new(0);
        let error: Mutex<Option<String>> = Mutex::new(None);
        std::thread::scope(|scope| {
            for _ in 0..size.min(items.len()) {
                scope.spawn(|| loop {
                    if error.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
                        return;
                    }
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    let Some(item) = items.get(i) else { return };
                    if let Err(e) = f(item) {
                        let mut slot = error.lock().unwrap_or_else(|e| e.into_inner());
                        if slot.is_none() {
                            *slot = Some(e);
                        }
                        return;
                    }
                });
            }
        });
        match error.into_inner().unwrap_or_else(|e| e.into_inner()) {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    fn launch_jar(&self, client_jar: &Path, id: &str, minecraft: &str, sha1: &str) -> Result<PathBuf, String> {
        if id.is_empty() || id == minecraft {
            return Ok(client_jar.to_path_buf());
        }
        let target = self.version_dir(id).join(format!("{id}.jar"));
        let expected = crate::http::Expected { sha1: Some(sha1), sha512: None, size: None };
        if crate::http::verify_file(&target, &expected)?.is_none() {
            return Ok(target);
        }
        let dir = self.version_dir(id);
        std::fs::create_dir_all(&dir).map_err(|e| js::fs_error(&e, "mkdir", &dir))?;
        let tmp = PathBuf::from(format!("{}.tmp", target.display()));
        std::fs::copy(client_jar, &tmp).map_err(|e| js::fs_error(&e, "copyfile", client_jar))?;
        std::fs::rename(&tmp, &target).map_err(|e| js::fs_error(&e, "rename", &tmp))?;
        Ok(target)
    }

    pub fn install(&self, loader: &str, minecraft: &str, loader_version: &str, java: &str, ctx: &OpCtx) -> Result<InstalledClient, String> {
        ctx.progress(Some(0.1), Some(&format!("Preparing Minecraft {minecraft}")));
        let vanilla = self.vanilla(minecraft, ctx)?;
        let child = if loader == "fabric" { self.fabric(minecraft, loader_version)? } else { self.neoforge(minecraft, loader_version, java, ctx)? };
        let version = merge_versions(&child, &vanilla);
        let platform = current_platform();
        let client_jar = self.version_dir(minecraft).join(format!("{minecraft}.jar"));
        let client = &vanilla["downloads"]["client"];
        let (Some(url), Some(sha1)) = (client["url"].as_str().filter(|u| !u.is_empty()), client["sha1"].as_str().filter(|s| !s.is_empty())) else {
            return Err(format!("Minecraft {minecraft} has no client download"));
        };
        ctx.progress(Some(0.15), Some(&format!("Downloading Minecraft {minecraft}")));
        verified(url, &client_jar, Some(sha1), client["size"].as_u64(), ctx)?;
        let client_jar = self.launch_jar(&client_jar, &js::string(&version["id"]), minecraft, sha1)?;
        let libs = library_files(&version, &self.libraries_dir(), &platform);
        let done = AtomicUsize::new(0);
        let total = libs.len();
        Self::pool(&libs, 8, &|l: &ResolvedLibrary| {
            ctx.check()?;
            if !l.file.exists() || l.sha1.is_some() {
                match &l.url {
                    None => {
                        if !l.file.exists() {
                            return Err(format!("Library {} has no download URL", l.name));
                        }
                    }
                    Some(url) => {
                        let sha1 = match &l.sha1 {
                            Some(s) => s.clone(),
                            None => fetch_sha1(url, &format!("No published checksum for {url}"))?,
                        };
                        verified(url, &l.file, Some(&sha1), l.size, ctx)?;
                    }
                }
            }
            let n = done.fetch_add(1, Ordering::SeqCst) + 1;
            if n.is_multiple_of(10) {
                ctx.progress(Some(0.2 + (0.3 * n as f64) / total as f64), Some(&format!("Libraries {n}/{total}")));
            }
            Ok(())
        })?;
        let idx = &version["assetIndex"];
        let Some(idx_id) = idx["id"].as_str() else { return Err(format!("Minecraft {minecraft} has no asset index")) };
        let index_file = self.assets_dir().join("indexes").join(format!("{idx_id}.json"));
        verified(&js::string(&idx["url"]), &index_file, idx["sha1"].as_str(), idx["size"].as_u64(), ctx)?;
        let index = Self::read_json(&index_file)?;
        let objects: Vec<(String, Option<u64>)> = index["objects"].as_object().map(|o| o.values().map(|v| (js::string(&v["hash"]), v["size"].as_u64())).collect()).unwrap_or_default();
        let objects_dir = self.assets_dir().join("objects");
        let missing: Vec<(String, Option<u64>)> = objects.iter().filter(|(h, _)| !objects_dir.join(&h[..2.min(h.len())]).join(h).exists()).cloned().collect();
        if !missing.is_empty() {
            ctx.log(&format!("Downloading {} of {} game assets", missing.len(), objects.len()));
        }
        let got = AtomicUsize::new(0);
        let total = missing.len();
        Self::pool(&missing, 16, &|(hash, size): &(String, Option<u64>)| {
            ctx.check()?;
            let prefix = &hash[..2.min(hash.len())];
            verified(&format!("https://resources.download.minecraft.net/{prefix}/{hash}"), &objects_dir.join(prefix).join(hash), Some(hash), *size, ctx)?;
            let n = got.fetch_add(1, Ordering::SeqCst) + 1;
            if n.is_multiple_of(100) {
                ctx.progress(Some(0.5 + (0.35 * n as f64) / total as f64), Some(&format!("Assets {n}/{total}")));
            }
            Ok(())
        })?;
        Ok(InstalledClient { version, libraries_dir: self.libraries_dir(), assets_dir: self.assets_dir(), client_jar })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_uuid_matches_vanilla() {
        assert_eq!(offline_uuid("Player"), "a01e3843-e521-3998-958a-f459800e4d11");
        assert_eq!(hex::encode(md5_digest(b"")), "d41d8cd98f00b204e9800998ecf8427e");
    }

    #[test]
    fn maven_paths() {
        assert_eq!(maven_path("net.fabricmc:fabric-loader:0.16.5").unwrap(), "net/fabricmc/fabric-loader/0.16.5/fabric-loader-0.16.5.jar");
        assert_eq!(maven_path("a.b:c:1:natives@zip").unwrap(), "a/b/c/1/c-1-natives.zip");
    }

    #[test]
    fn loader_versions_launch_with_a_jar_named_after_the_version() {
        let root = std::env::temp_dir().join(format!("modsmith-launchjar-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let store = std::sync::Arc::new(crate::store::Store::open(&root.join("db.sqlite")).unwrap());
        let http = Http::new(store);
        let installer = ClientInstaller { http: &http, root: root.clone() };
        let vanilla = root.join("versions").join("1.21.1").join("1.21.1.jar");
        std::fs::create_dir_all(vanilla.parent().unwrap()).unwrap();
        std::fs::write(&vanilla, b"client").unwrap();
        let sha1 = crate::http::hash_file(&vanilla, "sha1").unwrap();
        assert_eq!(installer.launch_jar(&vanilla, "1.21.1", "1.21.1", &sha1).unwrap(), vanilla);
        let neo = installer.launch_jar(&vanilla, "neoforge-21.1.262", "1.21.1", &sha1).unwrap();
        assert_eq!(neo, root.join("versions").join("neoforge-21.1.262").join("neoforge-21.1.262.jar"));
        assert_eq!(std::fs::read(&neo).unwrap(), b"client");
        std::fs::write(&neo, b"stale").unwrap();
        installer.launch_jar(&vanilla, "neoforge-21.1.262", "1.21.1", &sha1).unwrap();
        assert_eq!(std::fs::read(&neo).unwrap(), b"client");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rules() {
        let p = Platform { os: "windows", arch: "x64" };
        assert!(rules_allow(Some(&json!([{ "action": "allow", "os": { "name": "windows" } }])), &p, &Map::new()));
        assert!(!rules_allow(Some(&json!([{ "action": "allow", "os": { "name": "osx" } }])), &p, &Map::new()));
        assert!(!rules_allow(Some(&json!([{ "action": "allow", "features": { "is_demo_user": true } }])), &p, &Map::new()));
    }
}
