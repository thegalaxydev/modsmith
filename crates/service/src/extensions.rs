use crate::http::{Expected, USER_AGENT};
use crate::js;
use crate::rt::Runtime;
use crate::themes::normalize_rel;
use crate::updates::compare_versions;
use base64::Engine;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::cell::Cell;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const MAX_PACKAGE: u64 = 50 * 1024 * 1024;
const MAX_ENTRIES: usize = 5000;
const MAX_UNPACKED: u64 = 200 * 1024 * 1024;
const MAX_READ: u64 = 10 * 1024 * 1024;
pub const DEFAULT_INDEX: &str = "https://thegalaxydev.github.io/modsmith/extensions/index.json";
const PERMISSIONS: [&str; 6] = ["project.read", "project.write", "game", "build", "network", "companion"];
const VERSION: &str = env!("CARGO_PKG_VERSION");

fn index_source() -> String {
    std::env::var("MODSMITH_EXTENSION_INDEX").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| DEFAULT_INDEX.to_string())
}

fn github_api() -> String {
    std::env::var("MODSMITH_GITHUB_API").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "https://api.github.com".to_string())
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("regex"))
}

fn extension_id() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^[a-z0-9][a-z0-9-]{0,38}\.[a-z0-9][a-z0-9-]{0,63}$")
}

fn semver() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")
}

fn release() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^\d+\.\d+\.\d+$")
}

fn part_id() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^[a-z0-9][a-z0-9-]{0,39}$")
}

fn sha256_hex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^[0-9a-fA-F]{64}$")
}

pub fn valid_id(id: &str) -> bool {
    extension_id().is_match(id)
}

fn fail(message: impl std::fmt::Display) -> String {
    format!("extension.json: {message}")
}

fn char_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn is_text(v: &Value, max: usize) -> bool {
    v.as_str().is_some_and(|s| !s.trim().is_empty() && char_len(s) <= max)
}

fn optional_text(m: &Map<String, Value>, key: &str, max: usize) -> Result<Option<String>, String> {
    match m.get(key) {
        None => Ok(None),
        Some(v) if is_text(v, max) => Ok(Some(js::string(v))),
        Some(_) => Err(fail(format!("{key} must be text of {max} characters at most"))),
    }
}

fn optional_link(m: &Map<String, Value>, key: &str) -> Result<Option<String>, String> {
    static R: OnceLock<Regex> = OnceLock::new();
    match m.get(key) {
        None => Ok(None),
        Some(Value::String(s)) if re(&R, r"^https://\S+$").is_match(s) => Ok(Some(s.clone())),
        Some(_) => Err(fail(format!("{key} must be an https:// link"))),
    }
}

fn package_file(m: &Map<String, Value>, key: &str, ext: &str, files: &BTreeSet<String>) -> Result<Option<String>, String> {
    let Some(v) = m.get(key) else { return Ok(None) };
    let Some(s) = v.as_str().filter(|s| s.to_lowercase().ends_with(ext)) else {
        return Err(fail(format!("{key} must be a {ext} file in the package")));
    };
    let rel = normalize_rel("", s, "", "package")?;
    if !files.contains(&rel) {
        return Err(fail(format!("{key} points to {s}, which is not in the package")));
    }
    Ok(Some(rel))
}

fn contributions(raw: Option<&Value>, key: &str) -> Result<Vec<Value>, String> {
    let Some(raw) = raw else { return Ok(vec![]) };
    let Some(list) = raw.as_array() else {
        return Err(fail(format!("contributes.{key} must be a list")));
    };
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for c in list {
        let Some(c) = c.as_object() else {
            return Err(fail(format!("contributes.{key} entries must be objects")));
        };
        let id = match c.get("id").and_then(Value::as_str) {
            Some(id) if part_id().is_match(id) => id.to_string(),
            _ => return Err(fail(format!("contributes.{key} ids must be lowercase letters, digits and dashes"))),
        };
        if !seen.insert(id.clone()) {
            return Err(fail(format!("contributes.{key} has {id} twice")));
        }
        let title = match c.get("title") {
            Some(t) if is_text(t, 60) => js::string(t).trim().to_string(),
            _ => return Err(fail(format!("contributes.{key}.{id} needs a title of 60 characters at most"))),
        };
        if key == "panels" {
            out.push(json!({ "id": id, "title": title }));
            continue;
        }
        let files = match c.get("files").and_then(Value::as_array) {
            Some(f) if !f.is_empty() && f.iter().all(|x| is_text(x, 200)) => f.clone(),
            _ => return Err(fail(format!("contributes.viewers.{id} needs a files list of glob patterns, like [\"*.nbt\"]"))),
        };
        out.push(json!({ "id": id, "title": title, "files": files }));
    }
    Ok(out)
}

fn companion_mods(raw: Option<&Value>, files: &BTreeSet<String>, permissions: &[String]) -> Result<Vec<Value>, String> {
    static MC: OnceLock<Regex> = OnceLock::new();
    let Some(raw) = raw else { return Ok(vec![]) };
    let Some(list) = raw.as_array() else {
        return Err(fail("contributes.mods must be a list"));
    };
    if !list.is_empty() && !permissions.iter().any(|p| p == "companion") {
        return Err(fail("contributes.mods needs the companion permission"));
    }
    let mut out = Vec::new();
    for c in list {
        let Some(c) = c.as_object() else {
            return Err(fail("contributes.mods entries must be objects"));
        };
        let Some(file) = c.get("file").and_then(Value::as_str).filter(|f| f.to_lowercase().ends_with(".jar")) else {
            return Err(fail("contributes.mods entries need a .jar file in the package"));
        };
        let rel = normalize_rel("", file, "", "package")?;
        if !files.contains(&rel) {
            return Err(fail(format!("contributes.mods points to {file}, which is not in the package")));
        }
        let loader = match c.get("loader").and_then(Value::as_str) {
            Some(l) if l == "fabric" || l == "neoforge" => l.to_string(),
            _ => return Err(fail("contributes.mods loader must be fabric or neoforge")),
        };
        let minecraft = match c.get("minecraft").and_then(Value::as_str) {
            Some(v) if re(&MC, r"^\d+\.\d+(?:\.\d+)?$").is_match(v) => v.to_string(),
            _ => return Err(fail("contributes.mods minecraft must be a version like 1.21.1")),
        };
        out.push(json!({ "file": rel, "loader": loader, "minecraft": minecraft }));
    }
    Ok(out)
}

pub fn validate_manifest(raw: &Value, files: &BTreeSet<String>) -> Result<Value, String> {
    let Some(m) = raw.as_object() else {
        return Err(fail("the file is not a JSON object"));
    };
    let id = match m.get("id").and_then(Value::as_str) {
        Some(id) if valid_id(id) => id.to_string(),
        _ => return Err(fail("id must be publisher.name in lowercase letters, digits and dashes, like galaxy.nbt-viewer")),
    };
    if !m.get("name").is_some_and(|v| is_text(v, 60)) {
        return Err(fail("name is required (60 characters at most)"));
    }
    let version = match m.get("version").and_then(Value::as_str) {
        Some(v) if semver().is_match(v) => v.to_string(),
        _ => return Err(fail("version must look like 1.2.3")),
    };
    if !m.get("publisher").is_some_and(|v| is_text(v, 60)) {
        return Err(fail("publisher is required (60 characters at most)"));
    }
    let modsmith = match m.get("modsmith").and_then(Value::as_str) {
        Some(v) if release().is_match(v) => v.to_string(),
        _ => return Err(fail("modsmith must be the oldest Modsmith version the extension works with, like 0.1.12")),
    };
    let description = optional_text(m, "description", 300)?;
    let repository = optional_link(m, "repository")?;
    let homepage = optional_link(m, "homepage")?;
    let license = optional_text(m, "license", 60)?;
    let main = package_file(m, "main", ".js", files)?;
    let style = package_file(m, "style", ".css", files)?;
    let mut permissions: Vec<String> = Vec::new();
    match m.get("permissions") {
        None => {}
        Some(Value::Array(list)) => {
            for p in list {
                match p.as_str() {
                    Some(s) if PERMISSIONS.contains(&s) => {
                        if !permissions.iter().any(|x| x == s) {
                            permissions.push(s.to_string());
                        }
                    }
                    _ => return Err(fail(format!("permissions has an unknown permission {}", serde_json::to_string(p).unwrap_or_default()))),
                }
            }
        }
        Some(_) => return Err(fail("permissions must be a list")),
    }
    let empty = Map::new();
    let c = match m.get("contributes") {
        None => &empty,
        Some(Value::Object(c)) => c,
        Some(_) => return Err(fail("contributes must be an object")),
    };
    let viewers = contributions(c.get("viewers"), "viewers")?;
    let panels = contributions(c.get("panels"), "panels")?;
    let mods = companion_mods(c.get("mods"), files, &permissions)?;
    if (!viewers.is_empty() || !panels.is_empty()) && main.is_none() {
        return Err(fail("main is required when the extension contributes viewers or panels"));
    }
    let mut out = json!({
        "id": id,
        "name": js::string(&m["name"]).trim(),
        "version": version,
        "publisher": js::string(&m["publisher"]).trim(),
        "modsmith": modsmith,
        "permissions": permissions,
        "contributes": { "viewers": viewers, "panels": panels, "mods": mods }
    });
    let o = out.as_object_mut().expect("object");
    for (k, v) in [("description", description), ("repository", repository), ("homepage", homepage), ("license", license), ("main", main), ("style", style)] {
        if let Some(v) = v {
            o.insert(k.to_string(), json!(v));
        }
    }
    Ok(out)
}

pub struct Package {
    pub manifest: Value,
    pub files: BTreeMap<String, Vec<u8>>,
}

pub fn read_package(file: &Path) -> Result<Package, String> {
    let meta = fs::metadata(file).map_err(|e| js::fs_error(&e, "stat", file))?;
    if meta.len() > MAX_PACKAGE {
        return Err("The package is larger than 50 MB".into());
    }
    let invalid = || "The package is not a valid .zip file".to_string();
    let handle = fs::File::open(file).map_err(|e| js::fs_error(&e, "open", file))?;
    let mut zip = zip::ZipArchive::new(handle).map_err(|_| invalid())?;
    if zip.len() > MAX_ENTRIES {
        return Err("The package has more than 5000 files".into());
    }
    let mut total = 0u64;
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|_| invalid())?;
        let name = String::from_utf8_lossy(entry.name_raw()).to_string();
        if name.starts_with('/') || name.contains('\\') || name.contains(':') || name.split('/').any(|p| p == "..") {
            return Err(format!("The package has an unsafe file path: {name}"));
        }
        total += entry.size();
        if total > MAX_UNPACKED {
            return Err("The package unpacks to more than 200 MB".into());
        }
        if name.ends_with('/') {
            continue;
        }
        let mut buf = Vec::new();
        (&mut entry).take(MAX_UNPACKED + 1).read_to_end(&mut buf).map_err(|_| invalid())?;
        entries.push((name, buf));
    }
    let names: Vec<&String> = entries.iter().map(|(n, _)| n).collect();
    let mut prefix = String::new();
    if !names.iter().any(|n| *n == "extension.json") {
        let tops: BTreeSet<String> = names.iter().map(|n| n.find('/').map(|i| n[..=i].to_string()).unwrap_or_default()).collect();
        let only = if tops.len() == 1 { tops.into_iter().next().unwrap_or_default() } else { String::new() };
        if only.is_empty() || !names.iter().any(|n| **n == format!("{only}extension.json")) {
            return Err("The package has no extension.json at its top level".into());
        }
        prefix = only;
    }
    let mut files = BTreeMap::new();
    for (n, b) in entries {
        if let Some(rel) = n.strip_prefix(&prefix) {
            files.insert(rel.to_string(), b);
        }
    }
    let text = String::from_utf8_lossy(&files["extension.json"]).trim_start_matches('\u{feff}').to_string();
    let raw: Value = serde_json::from_str(&text).map_err(|e| format!("extension.json: {e}"))?;
    let keys: BTreeSet<String> = files.keys().cloned().collect();
    Ok(Package { manifest: validate_manifest(&raw, &keys)?, files })
}

fn allowed_url(url: &str) -> Result<(), String> {
    let u = url::Url::parse(url).map_err(|_| format!("{url} is not a valid link"))?;
    let local = u.scheme() == "http" && matches!(u.host_str(), Some("127.0.0.1") | Some("localhost") | Some("[::1]"));
    if u.scheme() != "https" && !local {
        return Err("Only https:// links can be installed".into());
    }
    Ok(())
}

fn resolve_link(url: &str) -> Result<String, String> {
    static LATEST: OnceLock<Regex> = OnceLock::new();
    static TAGGED: OnceLock<Regex> = OnceLock::new();
    allowed_url(url)?;
    let latest = re(&LATEST, r"^https://github\.com/([\w.-]+)/([\w.-]+?)(?:\.git)?(?:/releases(?:/latest)?)?/?$").captures(url);
    let tagged = re(&TAGGED, r"^https://github\.com/([\w.-]+)/([\w.-]+)/releases/tag/([^/?#]+)/?$").captures(url);
    let (owner, repo, tag) = match (&latest, &tagged) {
        (Some(c), _) => (c[1].to_string(), c[2].to_string(), None),
        (None, Some(c)) => (c[1].to_string(), c[2].to_string(), Some(c[3].to_string())),
        _ => return Ok(url.to_string()),
    };
    let api = match &tag {
        None => format!("{}/repos/{owner}/{repo}/releases/latest", github_api()),
        Some(t) => format!("{}/repos/{owner}/{repo}/releases/tags/{t}", github_api()),
    };
    let res = crate::http::fetch_with_retry("GET", &api, &[("User-Agent", USER_AGENT), ("Accept", "application/vnd.github+json")], None)?;
    if res.status == 404 {
        return Err(match &tag {
            None => format!("{owner}/{repo} has no published release"),
            Some(t) => format!("{owner}/{repo} has no release {t}"),
        });
    }
    if !res.ok() {
        return Err(format!("HTTP {} for {api}", res.status));
    }
    let rel: Value = serde_json::from_str(&res.body).map_err(|e| e.to_string())?;
    let zips: Vec<&Value> = rel["assets"].as_array().map(|a| a.iter().filter(|x| x["name"].as_str().unwrap_or("").to_lowercase().ends_with(".zip") && x["browser_download_url"].as_str().is_some_and(|u| !u.is_empty())).collect()).unwrap_or_default();
    let pick = zips.iter().find(|x| x["name"].as_str().unwrap_or("").to_lowercase().contains("modsmith")).or(zips.first());
    match pick {
        Some(a) => Ok(js::string(&a["browser_download_url"])),
        None => Err(format!("The release {} has no .zip asset; attach the extension package to the release", rel["tag_name"].as_str().unwrap_or(""))),
    }
}

fn download_limited(url: &str, dest: &Path) -> Result<(), String> {
    allowed_url(url)?;
    let too_big = Cell::new(false);
    let r = crate::http::stream_to(url, dest, &|| too_big.get(), &|received, _| {
        if received > MAX_PACKAGE {
            too_big.set(true);
        }
    });
    if too_big.get() {
        return Err("The package is larger than 50 MB".into());
    }
    r
}

struct IndexVersion {
    version: String,
    url: String,
    sha256: String,
    size: Option<u64>,
    modsmith: String,
    permissions: Vec<String>,
}

struct IndexEntry {
    id: String,
    name: String,
    publisher: String,
    description: Option<String>,
    repository: Option<String>,
    license: Option<String>,
    versions: Vec<IndexVersion>,
}

fn read_index(data: &Value) -> Result<Vec<IndexEntry>, String> {
    let Some(list) = data.get("extensions").and_then(Value::as_array).filter(|_| data.is_object()) else {
        return Err("The extension index is not valid".into());
    };
    let mut out = Vec::new();
    for e in list {
        let (Some(id), Some(name), Some(versions)) = (e["id"].as_str(), e["name"].as_str(), e["versions"].as_array()) else { continue };
        if !valid_id(id) {
            continue;
        }
        let mut vs: Vec<IndexVersion> = versions
            .iter()
            .filter(|v| v["version"].as_str().is_some_and(|x| semver().is_match(x)) && v["url"].is_string() && v["sha256"].as_str().is_some_and(|x| sha256_hex().is_match(x)) && v["modsmith"].is_string())
            .map(|v| IndexVersion {
                version: js::string(&v["version"]),
                url: js::string(&v["url"]),
                sha256: js::string(&v["sha256"]).to_lowercase(),
                size: v["size"].as_f64().map(|n| n as u64),
                modsmith: js::string(&v["modsmith"]),
                permissions: v["permissions"].as_array().map(|a| a.iter().filter_map(Value::as_str).filter(|p| PERMISSIONS.contains(p)).map(String::from).collect()).unwrap_or_default(),
            })
            .collect();
        if vs.is_empty() {
            continue;
        }
        vs.sort_by(|a, b| compare_versions(&b.version, &a.version));
        let opt = |k: &str| e[k].as_str().map(String::from);
        out.push(IndexEntry { id: id.to_string(), name: name.to_string(), publisher: e["publisher"].as_str().unwrap_or("").to_string(), description: opt("description"), repository: opt("repository"), license: opt("license"), versions: vs });
    }
    Ok(out)
}

fn compatible(v: &IndexVersion) -> bool {
    compare_versions(&v.modsmith, VERSION) != Ordering::Greater
}

fn newest(e: &IndexEntry) -> &IndexVersion {
    e.versions.iter().find(|v| compatible(v)).unwrap_or(&e.versions[0])
}

struct Index {
    source: String,
    fetched_at: i64,
    stale: bool,
    error: Option<String>,
    entries: Vec<IndexEntry>,
}

fn random_hex() -> Result<String, String> {
    let mut rnd = [0u8; 4];
    getrandom::fill(&mut rnd).map_err(|e| e.to_string())?;
    Ok(hex::encode(rnd))
}

pub fn companion_mods_for(data: &Path, loader: &str, minecraft: &str) -> Vec<(PathBuf, Value)> {
    let dir = data.join("extensions");
    let mut names: Vec<String> = fs::read_dir(&dir).map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect()).unwrap_or_default();
    names.sort();
    let mut out = Vec::new();
    for name in names {
        if name.starts_with('.') || name.ends_with(".part") || !valid_id(&name) {
            continue;
        }
        let Some(rec) = fs::read_to_string(dir.join(&name).join("install.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { continue };
        if rec["id"].as_str() != Some(name.as_str()) || rec["enabled"] == false || !rec["manifest"]["permissions"].as_array().is_some_and(|p| p.iter().any(|x| x == "companion")) {
            continue;
        }
        let title = js::string(&rec["name"]);
        for m in rec["manifest"]["contributes"]["mods"].as_array().cloned().unwrap_or_default() {
            if m["loader"].as_str() != Some(loader) || m["minecraft"].as_str() != Some(minecraft) {
                continue;
            }
            let rel = js::string(&m["file"]);
            let file = dir.join(&name).join("files").join(&rel);
            if !file.is_file() {
                continue;
            }
            let base = rel.rsplit('/').next().unwrap_or(&rel).to_string();
            let mod_ids = crate::jarmeta::read_jar_metadata(&crate::rt::s(&file)).ok().and_then(|v| v.as_array().cloned()).map(|a| crate::resolver::all_mod_ids(&a)).unwrap_or_default();
            out.push((file, json!({ "key": format!("extension:{name}:{rel}"), "provider": "local", "title": format!("{title} (extension)"), "fileName": format!("{name}-{base}"), "modIds": mod_ids, "reason": format!("companion mod of the {title} extension"), "required": false })));
        }
    }
    out
}

impl Runtime {
    fn extensions_dir(&self) -> PathBuf {
        self.data.join("extensions")
    }

    fn extension_downloads(&self) -> PathBuf {
        self.extensions_dir().join(".downloads")
    }

    fn extension_record(&self, id: &str) -> Option<Value> {
        if !valid_id(id) {
            return None;
        }
        let text = fs::read_to_string(self.extensions_dir().join(id).join("install.json")).ok()?;
        let v: Value = serde_json::from_str(&text).ok()?;
        (v["id"].as_str() == Some(id)).then_some(v)
    }

    fn extension_index(&self, max_age_ms: i64) -> Result<Index, String> {
        let src = index_source();
        if !src.starts_with("http://") && !src.starts_with("https://") {
            let path = PathBuf::from(&src);
            let text = fs::read_to_string(&path).map_err(|e| js::fs_error(&e, "open", &path))?;
            let data: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            return Ok(Index { source: src, fetched_at: crate::support::now_ms() as i64, stale: false, error: None, entries: read_index(&data)? });
        }
        let r = self.providers.http.get_json(&src, max_age_ms, &[])?;
        Ok(Index { source: src, fetched_at: r.fetched_at, stale: r.stale, error: r.error, entries: read_index(&r.data)? })
    }

    pub fn extension_list(&self) -> Value {
        let mut out: Vec<Value> = fs::read_dir(self.extensions_dir())
            .map(|d| {
                d.flatten()
                    .filter_map(|e| {
                        let name = e.file_name().to_string_lossy().to_string();
                        if name.starts_with('.') || name.ends_with(".part") {
                            return None;
                        }
                        self.extension_record(&name)
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.sort_by(|a, b| js::locale_compare(&js::string(&a["name"]), &js::string(&b["name"])).then_with(|| js::string(&a["id"]).cmp(&js::string(&b["id"]))));
        Value::Array(out)
    }

    pub fn extension_catalog(&self, force: bool) -> Value {
        let installed: BTreeMap<String, String> = self.extension_list().as_array().map(|a| a.iter().map(|r| (js::string(&r["id"]), js::string(&r["version"]))).collect()).unwrap_or_default();
        let idx = match self.extension_index(if force { 0 } else { 6 * 3600 * 1000 }) {
            Ok(i) => i,
            Err(e) => return json!({ "source": index_source(), "fetchedAt": crate::support::now_ms() as i64, "stale": false, "error": e, "extensions": [] }),
        };
        let mut extensions: Vec<Value> = idx
            .entries
            .iter()
            .map(|e| {
                let v = newest(e);
                let have = installed.get(&e.id).cloned();
                let update = have.as_ref().is_some_and(|h| compatible(v) && compare_versions(&v.version, h) == Ordering::Greater);
                json!({
                    "id": e.id,
                    "name": e.name,
                    "publisher": e.publisher,
                    "description": e.description,
                    "repository": e.repository,
                    "license": e.license,
                    "latest": { "version": v.version, "modsmith": v.modsmith, "permissions": v.permissions, "size": v.size },
                    "compatible": compatible(v),
                    "installed": have,
                    "update": update
                })
            })
            .collect();
        extensions.sort_by(|a, b| js::locale_compare(&js::string(&a["name"]), &js::string(&b["name"])).then_with(|| js::string(&a["id"]).cmp(&js::string(&b["id"]))));
        json!({ "source": idx.source, "fetchedAt": idx.fetched_at, "stale": idx.stale, "error": idx.error, "extensions": extensions })
    }

    pub fn extension_inspect(&self, file: Option<&str>, url: Option<&str>) -> Result<Value, String> {
        let file = file.filter(|f| !f.is_empty());
        let url = url.filter(|u| !u.is_empty());
        if file.is_some() == url.is_some() {
            return Err("Pass either file or url".into());
        }
        let (path, source) = if let Some(link) = url {
            let direct = resolve_link(link)?;
            let dl = self.extension_downloads();
            fs::create_dir_all(&dl).map_err(|e| js::fs_error(&e, "mkdir", &dl))?;
            let tmp = dl.join(format!("{}.{}.part", std::process::id(), random_hex()?));
            let result = download_limited(&direct, &tmp).and_then(|_| {
                let sha = crate::http::hash_file(&tmp, "sha256")?;
                let dest = dl.join(format!("{sha}.zip"));
                fs::rename(&tmp, &dest).map_err(|e| js::fs_error(&e, "rename", &tmp))?;
                Ok(dest)
            });
            let _ = fs::remove_file(&tmp);
            (result?, json!({ "kind": "url", "location": link }))
        } else {
            let p = js::absolute(file.unwrap_or_default());
            if !p.is_file() {
                return Err(format!("{} does not exist", p.display()));
            }
            let loc = crate::rt::s(&p);
            (p, json!({ "kind": "file", "location": loc }))
        };
        let pkg = read_package(&path)?;
        let sha256 = crate::http::hash_file(&path, "sha256")?;
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let compatible = compare_versions(&js::string(&pkg.manifest["modsmith"]), VERSION) != Ordering::Greater;
        let installed = self.extension_record(&js::string(&pkg.manifest["id"])).map(|r| r["version"].clone()).unwrap_or(Value::Null);
        Ok(json!({ "manifest": pkg.manifest, "file": crate::rt::s(&path), "sha256": sha256, "size": size, "compatible": compatible, "source": source, "installed": installed }))
    }

    pub fn extension_install(&self, p: &Value) -> Result<Value, String> {
        let get = |k: &str| p[k].as_str().filter(|s| !s.is_empty());
        if let Some(id) = get("registry") {
            return self.extension_install_verified(id, get("version"));
        }
        let Some(file) = get("file") else {
            return Err("Pass registry or file".into());
        };
        let path = js::absolute(file);
        if !path.is_file() {
            return Err(format!("{} does not exist", path.display()));
        }
        let sha256 = crate::http::hash_file(&path, "sha256")?;
        if let Some(expected) = get("sha256") {
            if expected.to_lowercase() != sha256 {
                return Err("The package changed since it was inspected (SHA-256 mismatch)".into());
            }
        }
        let pkg = read_package(&path)?;
        let source = match get("url") {
            Some(u) => json!({ "kind": "url", "location": u }),
            None => json!({ "kind": "file", "location": crate::rt::s(&path) }),
        };
        self.extension_place(pkg, &sha256, false, source)
    }

    fn extension_install_verified(&self, id: &str, version: Option<&str>) -> Result<Value, String> {
        let idx = self.extension_index(0)?;
        let entry = idx.entries.iter().find(|e| e.id == id).ok_or_else(|| format!("No Verified extension {id}"))?;
        let v = match version {
            Some(want) => Some(entry.versions.iter().find(|x| x.version == want).ok_or_else(|| format!("{id} has no Verified version {want}"))?),
            None => entry.versions.iter().find(|x| compatible(x)),
        };
        let v = match v {
            Some(v) if compatible(v) => v,
            other => {
                let need = other.unwrap_or(&entry.versions[0]);
                return Err(format!("{} {} needs Modsmith {} or newer; this is {VERSION}", entry.name, need.version, need.modsmith));
            }
        };
        allowed_url(&v.url)?;
        let dest = self.extension_downloads().join(format!("{}.zip", v.sha256));
        crate::http::download_verified(&v.url, &dest, &Expected { sha1: None, sha256: Some(&v.sha256), sha512: None, size: None }, &|| false, &|_, _| {})?;
        let pkg = read_package(&dest)?;
        let (mid, mver) = (js::string(&pkg.manifest["id"]), js::string(&pkg.manifest["version"]));
        if mid != id || mver != v.version {
            return Err(format!("The downloaded package is {mid} {mver}, not {id} {}", v.version));
        }
        for perm in pkg.manifest["permissions"].as_array().cloned().unwrap_or_default() {
            let perm = js::string(&perm);
            if !v.permissions.contains(&perm) {
                return Err(format!("The package asks for {perm}, which was not approved for this version"));
            }
        }
        self.extension_place(pkg, &v.sha256, true, json!({ "kind": "registry", "location": v.url }))
    }

    fn extension_place(&self, pkg: Package, sha256: &str, verified: bool, source: Value) -> Result<Value, String> {
        let m = &pkg.manifest;
        let (id, name, version, modsmith) = (js::string(&m["id"]), js::string(&m["name"]), js::string(&m["version"]), js::string(&m["modsmith"]));
        if compare_versions(&modsmith, VERSION) == Ordering::Greater {
            return Err(format!("{name} {version} needs Modsmith {modsmith} or newer; this is {VERSION}"));
        }
        let dir = self.extensions_dir();
        let previous = self.extension_record(&id);
        let target = dir.join(&id);
        let part = dir.join(format!("{id}.part"));
        let _ = fs::remove_dir_all(&part);
        let files_dir = part.join("files");
        fs::create_dir_all(&files_dir).map_err(|e| js::fs_error(&e, "mkdir", &files_dir))?;
        for (rel, bytes) in &pkg.files {
            let dest = files_dir.join(rel);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| js::fs_error(&e, "mkdir", parent))?;
            }
            fs::write(&dest, bytes).map_err(|e| js::fs_error(&e, "open", &dest))?;
        }
        let enabled = previous.as_ref().map(|p| p["enabled"] != false).unwrap_or(true);
        let description = m.get("description").cloned().unwrap_or(Value::Null);
        let rec = json!({
            "id": id,
            "name": name,
            "version": version,
            "publisher": m["publisher"],
            "description": description,
            "manifest": m,
            "enabled": enabled,
            "verified": verified,
            "source": source,
            "sha256": sha256,
            "installedAt": js::iso_now()
        });
        let install = part.join("install.json");
        fs::write(&install, js::pretty(&rec)).map_err(|e| js::fs_error(&e, "open", &install))?;
        if target.exists() {
            fs::remove_dir_all(&target).map_err(|e| js::fs_error(&e, "rmdir", &target))?;
        }
        fs::rename(&part, &target).map_err(|e| js::fs_error(&e, "rename", &part))?;
        Ok(json!({ "installed": rec, "previous": previous.map(|p| p["version"].clone()).unwrap_or(Value::Null) }))
    }

    pub fn extension_remove(&self, id: &str) -> Result<Value, String> {
        if self.extension_record(id).is_none() {
            return Err(format!("No installed extension {id}"));
        }
        let target = self.extensions_dir().join(id);
        fs::remove_dir_all(&target).map_err(|e| js::fs_error(&e, "rmdir", &target))?;
        Ok(json!({ "removed": id }))
    }

    pub fn extension_set_enabled(&self, id: &str, enabled: bool) -> Result<Value, String> {
        let Some(mut rec) = self.extension_record(id) else {
            return Err(format!("No installed extension {id}"));
        };
        rec["enabled"] = json!(enabled);
        let file = self.extensions_dir().join(id).join("install.json");
        fs::write(&file, js::pretty(&rec)).map_err(|e| js::fs_error(&e, "open", &file))?;
        Ok(rec)
    }

    pub fn extension_read(&self, id: &str, file: &str) -> Result<Value, String> {
        if self.extension_record(id).is_none() {
            return Err(format!("No installed extension {id}"));
        }
        let rel = normalize_rel("", file, "", "extension")?;
        let full = self.extensions_dir().join(id).join("files").join(&rel);
        let st = match fs::metadata(&full) {
            Ok(st) if st.is_file() => st,
            _ => return Err(format!("{rel} is not in {id}")),
        };
        if st.len() > MAX_READ {
            return Err(format!("{rel} is larger than 10 MB"));
        }
        let buf = fs::read(&full).map_err(|e| js::fs_error(&e, "open", &full))?;
        let binary = buf.iter().take(8000).any(|b| *b == 0);
        let content = if binary { base64::engine::general_purpose::STANDARD.encode(&buf) } else { String::from_utf8_lossy(&buf).into_owned() };
        Ok(json!({ "file": rel, "content": content, "binary": binary, "size": st.len() }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn validates_manifests() {
        let ok = json!({ "id": "galaxy.nbt-viewer", "name": "NBT viewer", "version": "1.0.0", "publisher": "Galaxy", "modsmith": "0.1.11", "main": "main.js", "permissions": ["project.read", "project.read"], "contributes": { "viewers": [{ "id": "nbt", "title": "NBT", "files": ["*.nbt"] }] } });
        let m = validate_manifest(&ok, &files(&["main.js", "extension.json"])).unwrap();
        assert_eq!(m["permissions"], json!(["project.read"]));
        assert!(validate_manifest(&ok, &files(&["extension.json"])).unwrap_err().contains("not in the package"));
        let mut bad = ok.clone();
        bad["id"] = json!("NoDot");
        assert!(validate_manifest(&bad, &files(&["main.js"])).unwrap_err().contains("publisher.name"));
        let mut bad = ok.clone();
        bad["permissions"] = json!(["everything"]);
        assert!(validate_manifest(&bad, &files(&["main.js"])).unwrap_err().contains("unknown permission \"everything\""));
    }

    #[test]
    fn lists_companion_mods_for_the_launch_target() {
        let data = std::env::temp_dir().join(format!("modsmith-companions-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        let install = |id: &str, permissions: Value, enabled: bool| {
            let dir = data.join("extensions").join(id);
            fs::create_dir_all(dir.join("files").join("mods")).unwrap();
            fs::write(dir.join("files").join("mods").join("companion.jar"), b"jar").unwrap();
            let mods = json!([{ "file": "mods/companion.jar", "loader": "neoforge", "minecraft": "1.21.1" }, { "file": "mods/missing.jar", "loader": "neoforge", "minecraft": "1.21.1" }]);
            let rec = json!({ "id": id, "name": "Ponder Studio", "enabled": enabled, "manifest": { "permissions": permissions, "contributes": { "mods": mods } } });
            fs::write(dir.join("install.json"), rec.to_string()).unwrap();
        };
        install("galaxy.ponder-studio", json!(["game", "companion"]), true);
        install("galaxy.no-permission", json!(["game"]), true);
        install("galaxy.disabled", json!(["companion"]), false);
        let found = companion_mods_for(&data, "neoforge", "1.21.1");
        assert_eq!(found.len(), 1);
        assert!(found[0].0.ends_with("galaxy.ponder-studio/files/mods/companion.jar"));
        assert_eq!(found[0].1["fileName"], "galaxy.ponder-studio-companion.jar");
        assert_eq!(found[0].1["required"], false);
        assert!(companion_mods_for(&data, "fabric", "1.21.1").is_empty());
        assert!(companion_mods_for(&data, "neoforge", "1.20.1").is_empty());
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn checks_links() {
        assert!(allowed_url("https://example.com/x.zip").is_ok());
        assert!(allowed_url("http://127.0.0.1:9/x.zip").is_ok());
        assert!(allowed_url("http://example.com/x.zip").is_err());
        assert!(allowed_url("file:///c:/x.zip").is_err());
    }
}
