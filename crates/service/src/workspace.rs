use crate::detect::detect_gradle_project;
use crate::js;
use crate::manifest::{self, Catalog};
use crate::store::Store;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

const IGNORED: [&str; 10] = [".git", ".gradle", "build", "node_modules", "out", "bin", ".idea", ".vscode", "run", ".modsmith"];
const MAX_IMAGE: u64 = 2 * 1024 * 1024;

fn image_type(ext: &str) -> Option<&'static str> {
    match ext.to_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

fn ext_of(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default()
}

pub fn normalize(p: &str) -> PathBuf {
    let abs = js::absolute(p);
    if !abs.exists() {
        return abs;
    }
    let root = js::realpath(&abs).unwrap_or(abs);
    if root.is_dir() {
        manifest::migrate_project(&root);
    }
    root
}

fn str_path(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

fn basename(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| str_path(p))
}

pub fn inspect(store: &Store, catalog: &Catalog, p: &str) -> Value {
    let root = normalize(p);
    let exists = root.is_dir();
    let state = str_path(&manifest::state_dir(&root));
    if !exists {
        return json!({ "path": str_path(&root), "name": basename(&root), "exists": exists, "trusted": false, "manifest": null, "manifestErrors": [], "detected": null, "type": "unmanaged", "lockProfiles": [], "stateDir": state, "gitRepo": false, "warnings": ["Directory does not exist"] });
    }
    let mut warnings: Vec<String> = Vec::new();
    let (manifest, errors) = manifest::read_manifest(&root);
    let detected = detect_gradle_project(&root);
    let lock_profiles: Vec<String> = match manifest::read_lock(&root) {
        Ok(lock) => lock["profiles"].as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default(),
        Err(e) => {
            warnings.push(e);
            vec![]
        }
    };
    let catalog_entry_id = manifest.as_ref().and_then(|m| m["platform"]["catalogEntry"].as_str()).filter(|s| !s.is_empty());
    let entry = catalog_entry_id.and_then(|id| catalog.get(id));
    if let (Some(id), None) = (catalog_entry_id, entry) {
        warnings.push(format!("Catalog entry {id} is not known to this version of Modsmith"));
    }
    if let Some(m) = &manifest {
        let loader = m["platform"]["loader"].as_str().unwrap_or_default();
        if loader != "fabric" && loader != "neoforge" {
            warnings.push(format!("{loader} adapter is not implemented; build and launch are disabled"));
        }
    }
    if detected.get("ambiguous") == Some(&Value::Bool(true)) {
        warnings.push("Project structure is ambiguous; see detection notes".into());
    }
    let mut out = Map::new();
    out.insert("path".into(), json!(str_path(&root)));
    out.insert("name".into(), manifest.as_ref().map(|m| m["name"].clone()).unwrap_or_else(|| json!(basename(&root))));
    out.insert("exists".into(), json!(exists));
    out.insert("trusted".into(), json!(store.is_trusted(&str_path(&root)).unwrap_or(false)));
    out.insert("manifest".into(), manifest.clone().unwrap_or(Value::Null));
    out.insert("manifestErrors".into(), json!(errors));
    out.insert("detected".into(), detected);
    out.insert("type".into(), manifest.as_ref().map(|m| m["type"].clone()).unwrap_or_else(|| json!("unmanaged")));
    if let Some(e) = entry {
        out.insert("catalogEntry".into(), e["id"].clone());
        out.insert("catalogStatus".into(), e["status"].clone());
    }
    out.insert("lockProfiles".into(), json!(lock_profiles));
    out.insert("stateDir".into(), json!(state));
    out.insert("gitRepo".into(), json!(root.join(".git").exists()));
    out.insert("warnings".into(), json!(warnings));
    Value::Object(out)
}

fn tree_walk(root: &Path, d: &Path, level: usize, depth: usize) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(d) else { return vec![] };
    let mut items: Vec<(String, bool, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir && IGNORED.contains(&name.as_str()) {
                return None;
            }
            Some((name, is_dir, e.path()))
        })
        .collect();
    items.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| js::locale_compare(&a.0, &b.0)));
    items
        .into_iter()
        .map(|(name, is_dir, full)| {
            let rel = full.strip_prefix(root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
            let mut node = Map::new();
            node.insert("name".into(), json!(name));
            node.insert("path".into(), json!(rel));
            node.insert("dir".into(), json!(is_dir));
            if is_dir && level < depth {
                node.insert("children".into(), Value::Array(tree_walk(root, &full, level + 1, depth)));
            }
            Value::Object(node)
        })
        .collect()
}

pub fn tree(p: &str, rel: &str, depth: usize) -> Result<Value, String> {
    let root = normalize(p);
    let dir = js::resolve_within(&root, if rel.is_empty() { "." } else { rel })?;
    Ok(Value::Array(tree_walk(&root, &dir, 0, depth)))
}

fn stat(file: &Path) -> Result<fs::Metadata, String> {
    fs::metadata(file).map_err(|e| js::fs_error(&e, "stat", file))
}

pub fn read_file(p: &str, rel: &str) -> Result<Value, String> {
    let root = normalize(p);
    let file = js::resolve_within(&root, rel)?;
    let st = stat(&file)?;
    if st.is_dir() {
        return Err(format!("{rel} is a directory"));
    }
    if st.len() > 4 * 1024 * 1024 {
        return Err(format!("{rel} is larger than 4 MB; open it in an external editor"));
    }
    let buf = fs::read(&file).map_err(|e| js::fs_error(&e, "open", &file))?;
    let binary = buf.iter().take(8000).any(|b| *b == 0);
    let content = if binary { base64::engine::general_purpose::STANDARD.encode(&buf) } else { String::from_utf8_lossy(&buf).into_owned() };
    Ok(json!({ "path": rel, "content": content, "size": st.len(), "binary": binary, "mtime": js::mtime_ms(&st) }))
}

pub fn write_file(p: &str, rel: &str, content: &str, expected_mtime: Option<f64>, create: bool, binary: bool) -> Result<Value, String> {
    let root = normalize(p);
    let file = js::resolve_within(&root, rel)?;
    let exists = file.exists();
    if !exists && !create {
        return Err(format!("{rel} does not exist; pass create to create it"));
    }
    if let (true, Some(expected)) = (exists, expected_mtime) {
        if (js::mtime_ms(&stat(&file)?) - expected).abs() > 1.0 {
            return Err(format!("{rel} changed on disk since it was opened; reload before saving"));
        }
    }
    let bytes = if binary {
        let compact: String = content.chars().filter(|c| !c.is_whitespace()).collect();
        base64::engine::general_purpose::STANDARD.decode(compact).map_err(|_| "content is not valid base64".to_string())?
    } else {
        content.as_bytes().to_vec()
    };
    js::write_file_atomic(&file, &bytes)?;
    Ok(json!({ "path": rel, "mtime": js::mtime_ms(&stat(&file)?) }))
}

pub fn image(p: &str) -> Value {
    let root = normalize(p);
    let Some(rel) = manifest::read_manifest(&root).0.and_then(|m| m["icon"].as_str().map(str::to_string)) else { return Value::Null };
    let Some(mime) = image_type(&ext_of(Path::new(&rel))) else { return Value::Null };
    let Ok(file) = js::resolve_within(&root, &rel) else { return Value::Null };
    let Ok(st) = fs::metadata(&file) else { return Value::Null };
    if !st.is_file() || st.len() > MAX_IMAGE {
        return Value::Null;
    }
    match fs::read(&file) {
        Ok(bytes) => json!(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))),
        Err(_) => Value::Null,
    }
}

pub fn set_image(p: &str, file: Option<&str>) -> Result<Value, String> {
    let root = normalize(p);
    let mut manifest = manifest::require_manifest(&root, p)?;
    let Some(file) = file else {
        if let Some(o) = manifest.as_object_mut() {
            o.shift_remove("icon");
        }
        manifest::write_manifest(&root, &manifest)?;
        return Ok(json!({ "icon": null }));
    };
    let full = js::resolve_within(&root, file)?;
    if image_type(&ext_of(&full)).is_none() {
        return Err("Choose a PNG, JPEG, WebP or GIF image".into());
    }
    let st = stat(&full)?;
    if !st.is_file() {
        return Err(format!("{file} is not a file"));
    }
    if st.len() > MAX_IMAGE {
        return Err("Choose an image smaller than 2 MB".into());
    }
    let icon = full.strip_prefix(&root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
    if let Some(o) = manifest.as_object_mut() {
        o.insert("icon".into(), json!(icon));
    }
    manifest::write_manifest(&root, &manifest)?;
    Ok(json!({ "icon": icon }))
}

pub fn delete_file(p: &str, rel: &str, confirm: bool) -> Result<Value, String> {
    if !confirm {
        return Err("Deleting a file is destructive; pass confirm: true to proceed".into());
    }
    let root = normalize(p);
    let file = js::resolve_within(&root, rel)?;
    if js::absolute(&str_path(&file)) == js::absolute(&str_path(&root)) {
        return Err("Refusing to delete the workspace root".into());
    }
    if stat(&file)?.is_dir() {
        return Err("Deleting directories is not supported".into());
    }
    fs::remove_file(&file).map_err(|e| js::fs_error(&e, "rm", &file))?;
    Ok(Value::Null)
}

pub fn open(store: &Store, catalog: &Catalog, p: &str) -> Result<Value, String> {
    let info = inspect(store, catalog, p);
    if info["exists"] != true {
        return Err(format!("Workspace not found: {}", js::string(&info["path"])));
    }
    store.add_recent(info["path"].as_str().unwrap_or_default(), &js::string(&info["name"]), &js::string(&info["type"])).map_err(|e| e.to_string())?;
    Ok(info)
}

pub fn trust(store: &Store, catalog: &Catalog, p: &str, trusted: bool) -> Result<Value, String> {
    let root = normalize(p);
    store.set_trusted(&str_path(&root), trusted).map_err(|e| e.to_string())?;
    Ok(inspect(store, catalog, &str_path(&root)))
}

pub fn require_trusted(store: &Store, root: &str) -> Result<(), String> {
    if !store.is_trusted(&str_path(&normalize(root))).unwrap_or(false) {
        return Err(format!("Workspace {root} is not trusted. Building or launching runs the project's Gradle scripts as code; trust the workspace first (workspace_trust)."));
    }
    Ok(())
}

pub fn instance_dir_for(root: &Path, profile: &str, mode: &str, side: &str) -> PathBuf {
    manifest::state_dir(root).join("instances").join(format!("{profile}{}-{side}", if mode == "production" { "-prod" } else { "" }))
}

pub fn default_profiles(side: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let parse = |v: Value| crate::schema::parse(&manifest::schemas()["profile"], &v).unwrap_or(v);
    if side != "server" {
        out.push(parse(json!({ "id": "dev-client", "name": "Test Client", "side": "client" })));
    }
    if side != "client" {
        out.push(parse(json!({ "id": "dev-server", "name": "Dedicated Server", "side": "server", "jvm": { "memoryMb": 2048, "args": [] } })));
    }
    out
}

pub fn ensure_gitignore(root: &Path) {
    let gi = root.join(".gitignore");
    let line = format!("{}/", manifest::STATE_DIR);
    let text = fs::read_to_string(&gi).unwrap_or_default();
    if !text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).any(|l| l == line) {
        let sep = if !text.is_empty() && !text.ends_with('\n') { "\n" } else { "" };
        let _ = fs::write(&gi, format!("{text}{sep}{line}\n"));
    }
}

pub fn init_manifest(catalog: &Catalog, p: &str, opts: &Value) -> Result<Value, String> {
    let root = normalize(p);
    if manifest::manifest_path(&root).exists() {
        return Err(format!("{} already exists", manifest::MANIFEST_FILE));
    }
    let detected = detect_gradle_project(&root);
    let loader = detected["loader"].as_str().filter(|l| *l != "unknown").unwrap_or("fabric").to_string();
    let hint = detected.get("minecraftHint").filter(|h| !h.is_null()).map(|h| {
        let s = js::string(h);
        s.trim_start_matches(|c: char| "~^>=<".contains(c) || c.is_whitespace()).to_string()
    });
    let minecraft = opts.get("minecraft").and_then(Value::as_str).map(str::to_string).or(hint);
    let loader_version = opts.get("loaderVersion").and_then(Value::as_str).map(str::to_string).or_else(|| detected["loaderVersionHint"].as_str().map(str::to_string));
    let (Some(minecraft), Some(loader_version)) = (minecraft.filter(|m| !m.is_empty()), loader_version.filter(|l| !l.is_empty())) else {
        return Err("Could not determine Minecraft and loader versions from the project. Provide them explicitly.".into());
    };
    let entry = catalog.entries.iter().find(|e| e["loader"] == loader.as_str() && e["minecraft"] == minecraft.as_str());
    let kind = opts["type"].as_str().unwrap_or("mod");
    let mut platform = Map::new();
    platform.insert("loader".into(), json!(loader));
    platform.insert("minecraft".into(), json!(minecraft));
    platform.insert("loaderVersion".into(), json!(loader_version));
    if let Some(e) = entry {
        platform.insert("catalogEntry".into(), e["id"].clone());
    }
    let profiles: Vec<Value> = default_profiles(if kind == "modpack" { "client" } else { "both" })
        .into_iter()
        .map(|mut pr| {
            pr["includeSourceMod"] = json!(kind != "modpack");
            pr
        })
        .collect();
    let mut m = Map::new();
    m.insert("schemaVersion".into(), json!(1));
    m.insert("name".into(), opts.get("name").and_then(Value::as_str).map(|n| json!(n)).unwrap_or_else(|| json!(basename(&root))));
    m.insert("type".into(), json!(kind));
    if let Some(id) = detected["modMetadata"].as_array().and_then(|a| a.iter().find_map(|x| x.get("id").filter(|i| js::truthy(Some(i))).cloned())) {
        m.insert("modId".into(), id);
    }
    m.insert("platform".into(), Value::Object(platform));
    m.insert("source".into(), json!({ "kind": if kind == "modpack" { "none" } else { "gradle" }, "root": "." }));
    m.insert("dependencies".into(), json!([]));
    m.insert("profiles".into(), Value::Array(profiles));
    m.insert("createdBy".into(), json!(format!("Modsmith {}", crate::api::api().version)));
    let parsed = crate::schema::parse(&manifest::schemas()["manifest"], &Value::Object(m)).map_err(|issues| crate::schema::zod_error_message(&issues))?;
    manifest::write_manifest(&root, &parsed)?;
    ensure_gitignore(&root);
    Ok(parsed)
}
