use crate::jarmeta;
use crate::js;
use crate::manifest::{self, schemas};
use crate::schema;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const CONFIG_DIRS: [&str; 3] = ["config", "defaultconfigs", "kubejs"];

#[derive(Clone, Debug)]
pub struct PackJar {
    pub file: String,
    pub name: String,
}

#[derive(Clone, Debug)]
pub struct PackFolder {
    pub path: String,
    pub kind: &'static str,
    pub name: String,
    pub minecraft: Option<String>,
    pub loader: Option<String>,
    pub loader_version: Option<String>,
    pub jars: Vec<PackJar>,
    pub disabled_jars: usize,
    pub config_dirs: Vec<String>,
    pub problems: Vec<String>,
}

fn read_json(file: &Path) -> Value {
    fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null)
}

fn s(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

fn basename(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

fn opt_str(v: Option<&Value>) -> Option<String> {
    v.filter(|x| !x.is_null()).map(js::string)
}

pub fn parse_loader(text: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(t) = text.filter(|t| !t.is_empty()) else { return (None, None) };
    let t = t.to_lowercase();
    static RE: OnceLock<Regex> = OnceLock::new();
    if let Some(c) = RE.get_or_init(|| Regex::new(r"^(neoforge|fabric|forge|quilt)[-_ ]?(.*)$").unwrap()).captures(&t) {
        let v = c.get(2).map(|m| m.as_str().to_string()).filter(|v| !v.is_empty());
        return (Some(c[1].to_string()), v);
    }
    for (needle, loader) in [("neoforged", "neoforge"), ("fabric", "fabric"), ("quilt", "quilt"), ("forge", "forge")] {
        if t.contains(needle) {
            return (Some(loader.into()), None);
        }
    }
    (None, None)
}

fn list_jars(mods_dir: &Path) -> (Vec<PackJar>, usize) {
    let Ok(entries) = fs::read_dir(mods_dir) else { return (vec![], 0) };
    let mut jars = Vec::new();
    let mut disabled = 0;
    for e in entries.flatten() {
        if !e.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if lower.ends_with(".jar") {
            jars.push(PackJar { file: s(&mods_dir.join(&name)), name });
        } else if lower.ends_with(".jar.disabled") {
            disabled += 1;
        }
    }
    jars.sort_by(|a, b| js::locale_compare(&a.name, &b.name));
    (jars, disabled)
}

fn modrinth_app_meta(profile_dir: &Path) -> (Option<String>, Option<String>, Option<String>, Option<String>) {
    let legacy = read_json(&profile_dir.join("profile.json"));
    if let Some(md) = legacy.get("metadata").filter(|m| js::truthy(Some(m))) {
        return (opt_str(md.get("name")), opt_str(md.get("game_version")), opt_str(md.get("loader")), md.get("loader_version").and_then(|l| opt_str(l.get("id"))));
    }
    let Some(app_dir) = profile_dir.parent().and_then(Path::parent) else { return (None, None, None, None) };
    let db = app_dir.join("app.db");
    if !db.exists() {
        return (None, None, None, None);
    }
    let Ok(conn) = rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else { return (None, None, None, None) };
    let row = conn.query_row("SELECT name, game_version, mod_loader, mod_loader_version FROM profiles WHERE path = ?", [basename(profile_dir)], |r| {
        Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?))
    });
    row.unwrap_or((None, None, None, None))
}

fn is_modrinth_app_profile(dir: &Path) -> bool {
    let parent = dir.parent().map(basename).unwrap_or_default().to_lowercase();
    let app = dir.parent().and_then(Path::parent).map(basename).unwrap_or_default().to_lowercase();
    parent == "profiles" && (app == "modrinthapp" || app == "com.modrinth.theseus" || dir.join("profile.json").exists())
}

fn modsmith_pack(root: &Path, side: &str) -> Option<PackFolder> {
    let (m, _) = manifest::read_manifest(root);
    let m = m?;
    let state = manifest::state_dir(root);
    let profiles = m["profiles"].as_array().cloned().unwrap_or_default();
    let profile = profiles.iter().find(|p| p["side"] == side).or(profiles.first()).cloned();
    let name = js::string(&m["name"]);
    let mut problems = Vec::new();
    let mut jars = Vec::new();
    if m["type"] == "mod" {
        problems.push(format!("{name} is a mod project, not a modpack"));
    }
    match &profile {
        None => problems.push(format!("{name} has no test profiles")),
        Some(p) => {
            let files_json = read_json(&state.join(format!("resolved-{}.files.json", js::string(&p["id"]))));
            match files_json.get("files").and_then(Value::as_object) {
                None => problems.push(format!("Open {name} in Modsmith and press Play once so its mods are downloaded")),
                Some(files) => {
                    for f in files.values() {
                        let f = js::string(f);
                        let path = Path::new(&f);
                        if path.exists() && !basename(path).starts_with("modsmith-bridge") {
                            jars.push(PackJar { name: basename(path), file: f });
                        }
                    }
                }
            }
        }
    }
    let config_dirs =
        profile.as_ref().and_then(|p| p.get("configDir")).and_then(Value::as_str).filter(|c| !c.is_empty()).map(|c| root.join(c)).filter(|d| d.exists()).map(|d| vec![s(&d)]).unwrap_or_default();
    Some(PackFolder {
        path: s(root),
        kind: "modsmith",
        name,
        minecraft: opt_str(m["platform"].get("minecraft")),
        loader: opt_str(m["platform"].get("loader")),
        loader_version: opt_str(m["platform"].get("loaderVersion")),
        jars,
        disabled_jars: 0,
        config_dirs,
        problems,
    })
}

pub fn detect_pack_folder(input: &str, side: &str) -> Result<PackFolder, String> {
    let mut dir = js::absolute(input);
    if !dir.is_dir() {
        return Err(format!("Folder not found: {input}"));
    }
    if basename(&dir).to_lowercase() == "mods" {
        dir = dir.parent().map(Path::to_path_buf).unwrap_or(dir);
    }
    if dir.join(manifest::MANIFEST_FILE).exists() {
        if let Some(pack) = modsmith_pack(&dir, side) {
            return Ok(pack);
        }
    }
    let mut kind = "folder";
    let mut name = basename(&dir);
    let mut game_dir = dir.clone();
    let mut minecraft: Option<String> = None;
    let mut loader_text: Option<String> = None;
    let mut loader_version: Option<String> = None;
    let cf = read_json(&dir.join("minecraftinstance.json"));
    let mmc = read_json(&dir.join("mmc-pack.json"));
    if js::truthy(Some(&cf)) {
        kind = "curseforge";
        name = opt_str(cf.get("name")).unwrap_or(name);
        minecraft = opt_str(cf.get("gameVersion")).or_else(|| cf.get("baseModLoader").and_then(|b| opt_str(b.get("minecraftVersion"))));
        loader_text = cf.get("baseModLoader").and_then(|b| opt_str(b.get("name")));
    } else if js::truthy(Some(&mmc)) {
        kind = "prism";
        let cfg = fs::read_to_string(dir.join("instance.cfg")).unwrap_or_default();
        static NAME: OnceLock<Regex> = OnceLock::new();
        if let Some(n) = NAME.get_or_init(|| Regex::new(r"(?m)^name=(.*)$").unwrap()).captures(&cfg).map(|c| c[1].trim().to_string()).filter(|n| !n.is_empty()) {
            name = n;
        }
        game_dir = [".minecraft", "minecraft"].iter().map(|d| dir.join(d)).find(|d| d.exists()).unwrap_or_else(|| dir.join(".minecraft"));
        for c in mmc.get("components").and_then(Value::as_array).into_iter().flatten() {
            let version = opt_str(c.get("version"));
            match c.get("uid").and_then(Value::as_str) {
                Some("net.minecraft") => minecraft = version,
                Some("net.fabricmc.fabric-loader") => (loader_text, loader_version) = (Some("fabric".into()), version),
                Some("net.neoforged") => (loader_text, loader_version) = (Some("neoforge".into()), version),
                Some("net.minecraftforge") => (loader_text, loader_version) = (Some("forge".into()), version),
                Some("org.quiltmc.quilt-loader") => (loader_text, loader_version) = (Some("quilt".into()), version),
                _ => {}
            }
        }
    } else if is_modrinth_app_profile(&dir) {
        kind = "modrinth";
        let (n, mc, l, lv) = modrinth_app_meta(&dir);
        name = n.unwrap_or(name);
        minecraft = mc;
        loader_text = l;
        loader_version = lv;
    }
    let (loader, parsed_version) = parse_loader(loader_text.as_deref());
    let mods_dir = if game_dir.join("mods").exists() { game_dir.join("mods") } else { game_dir.clone() };
    let (jars, disabled) = list_jars(&mods_dir);
    let mut problems = Vec::new();
    if jars.is_empty() {
        problems.push(if mods_dir == game_dir { "No mods folder or mod JARs found in this folder" } else { "The mods folder has no enabled mod JARs" }.to_string());
    }
    let config_dirs = CONFIG_DIRS.iter().map(|d| game_dir.join(d)).filter(|d| d.exists()).map(|d| s(&d)).collect();
    Ok(PackFolder { path: s(&dir), kind, name, minecraft, loader, loader_version: loader_version.or(parsed_version), jars, disabled_jars: disabled, config_dirs, problems })
}

pub fn config_target(dir: &str) -> String {
    let base = basename(Path::new(dir));
    if CONFIG_DIRS.contains(&base.as_str()) {
        base
    } else {
        "config".into()
    }
}

pub fn compatibility_problems(pack: &PackFolder, minecraft: &str, loader: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(mc) = pack.minecraft.as_deref().filter(|m| !m.is_empty() && *m != minecraft) {
        out.push(format!("{} is for Minecraft {mc}; this project uses {minecraft}", pack.name));
    }
    if let Some(l) = pack.loader.as_deref().filter(|l| !l.is_empty() && *l != loader) {
        out.push(format!("{} uses {l}; this project uses {loader}", pack.name));
    }
    out
}

pub fn discover_pack_folders(extra: &[String]) -> Vec<String> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default();
    let app_data = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData").join("Roaming"));
    let roots = [
        home.join("curseforge").join("minecraft").join("Instances"),
        home.join("Documents").join("Curse").join("Minecraft").join("Instances"),
        app_data.join("ModrinthApp").join("profiles"),
        app_data.join("com.modrinth.theseus").join("profiles"),
        app_data.join("PrismLauncher").join("instances"),
        home.join(".local").join("share").join("PrismLauncher").join("instances"),
        home.join("Library").join("Application Support").join("PrismLauncher").join("instances"),
        home.join("Library").join("Application Support").join("ModrinthApp").join("profiles"),
        home.join(".local").join("share").join("ModrinthApp").join("profiles"),
        home.join(".var").join("app").join("org.prismlauncher.PrismLauncher").join("data").join("PrismLauncher").join("instances"),
    ];
    let mut out: Vec<String> = Vec::new();
    for r in roots {
        let Ok(entries) = fs::read_dir(&r) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) && !name.starts_with('.') && !name.starts_with('_') {
                let p = s(&r.join(&name));
                if !out.contains(&p) {
                    out.push(p);
                }
            }
        }
    }
    for p in extra {
        if Path::new(p).exists() && !out.contains(p) {
            out.push(p.clone());
        }
    }
    out
}

fn links_file(root: &Path) -> PathBuf {
    manifest::state_dir(root).join("linked-packs.json")
}

pub fn read_links(root: &Path) -> Map<String, Value> {
    let raw = read_json(&links_file(root));
    let raw = if raw.is_null() { json!({}) } else { raw };
    schema::parse(&schemas()["links"], &raw).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

pub fn write_links(root: &Path, links: &Map<String, Value>) -> Result<(), String> {
    let file = links_file(root);
    if let Some(d) = file.parent() {
        let _ = fs::create_dir_all(d);
    }
    let clean: Map<String, Value> = links.iter().filter(|(_, v)| v.as_array().is_some_and(|a| !a.is_empty())).map(|(k, v)| (k.clone(), v.clone())).collect();
    fs::write(&file, format!("{}\n", js::pretty(&Value::Object(clean)))).map_err(|e| js::fs_error(&e, "open", &file))
}

pub fn same_path(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        let r = s(&js::absolute(p));
        if cfg!(windows) {
            r.to_lowercase()
        } else {
            r
        }
    };
    norm(a) == norm(b)
}

pub fn jar_metadata(file: &str) -> Vec<Value> {
    static CACHE: OnceLock<Mutex<HashMap<String, (f64, Vec<Value>)>>> = OnceLock::new();
    let Ok(st) = fs::metadata(file) else { return vec![] };
    let mtime = js::mtime_ms(&st);
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((m, meta)) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(file) {
        if *m == mtime {
            return meta.clone();
        }
    }
    let meta = jarmeta::read_jar_metadata(file).ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(file.to_string(), (mtime, meta.clone()));
    meta
}

pub struct Selection {
    pub used: Vec<PackJar>,
    pub skipped: Vec<(String, String)>,
}

pub fn select_pack_jars(pack: &PackFolder, side: &str, replaced_ids: &[String]) -> Selection {
    let replaced: Vec<&String> = replaced_ids.iter().filter(|s| !s.is_empty()).collect();
    let mut used = Vec::new();
    let mut skipped = Vec::new();
    for j in &pack.jars {
        let meta = jar_metadata(&j.file);
        let ids: Vec<String> = meta.iter().flat_map(|m| std::iter::once(js::string(&m["id"])).chain(m["provides"].as_array().into_iter().flatten().map(js::string))).collect();
        if let Some(clash) = ids.iter().find(|id| replaced.contains(id)) {
            skipped.push((j.name.clone(), format!("\"{clash}\" comes from this project's development build instead")));
            continue;
        }
        if side == "server" && meta.first().is_some_and(|m| m["environment"] == "client") {
            skipped.push((j.name.clone(), "client-only mod".into()));
            continue;
        }
        used.push(j.clone());
    }
    Selection { used, skipped }
}
