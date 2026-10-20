use crate::js;
use crate::schema;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const SCHEMAS_JSON: &str = include_str!("../../../resources/schemas.json");
pub const MANIFEST_FILE: &str = "modsmith.json";
pub const STATE_DIR: &str = ".modsmith";
const LEGACY_ID: &str = "modworkbench";
const PRODUCT_ID: &str = "modsmith";

pub fn schemas() -> &'static Value {
    static S: OnceLock<Value> = OnceLock::new();
    S.get_or_init(|| serde_json::from_str(SCHEMAS_JSON).expect("resources/schemas.json is valid JSON"))
}

pub fn manifest_path(root: &Path) -> PathBuf {
    root.join(MANIFEST_FILE)
}

pub fn lock_path(root: &Path) -> PathBuf {
    root.join(format!("{PRODUCT_ID}.lock.json"))
}

pub fn state_dir(root: &Path) -> PathBuf {
    root.join(STATE_DIR)
}

pub fn validate_manifest(raw: &Value) -> (Option<Value>, Vec<String>) {
    match schema::parse(&schemas()["manifest"], raw) {
        Err(issues) => (None, issues.iter().map(schema::Issue::text).collect()),
        Ok(m) => {
            let mut ids = std::collections::HashSet::new();
            let mut errors = Vec::new();
            for p in m["profiles"].as_array().into_iter().flatten() {
                let id = p["id"].as_str().unwrap_or_default().to_string();
                if !ids.insert(id.clone()) {
                    errors.push(format!("profiles: duplicate profile id {id}"));
                }
            }
            if errors.is_empty() {
                (Some(m), errors)
            } else {
                (None, errors)
            }
        }
    }
}

pub fn read_manifest(root: &Path) -> (Option<Value>, Vec<String>) {
    let file = manifest_path(root);
    if !file.exists() {
        return (None, vec![]);
    }
    let text = match fs::read_to_string(&file) {
        Ok(t) => t,
        Err(e) => return (None, vec![format!("{MANIFEST_FILE} is not valid JSON: {}", js::fs_error(&e, "open", &file))]),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(raw) => validate_manifest(&raw),
        Err(e) => (None, vec![format!("{MANIFEST_FILE} is not valid JSON: {e}")]),
    }
}

pub fn write_manifest(root: &Path, manifest: &Value) -> Result<(), String> {
    let data =
        schema::parse(&schemas()["manifest"], manifest).map_err(|issues| format!("Refusing to write invalid manifest: {}", issues.iter().map(|i| i.message.clone()).collect::<Vec<_>>().join("; ")))?;
    js::write_file_atomic(&manifest_path(root), format!("{}\n", js::pretty(&data)).as_bytes())
}

pub fn require_manifest(root: &Path, display: &str) -> Result<Value, String> {
    let (manifest, errors) = read_manifest(root);
    match manifest {
        Some(m) => Ok(m),
        None if !errors.is_empty() => Err(format!("Invalid {MANIFEST_FILE}: {}", errors.join("; "))),
        None => Err(format!("No {MANIFEST_FILE} in {display}. Initialize the workspace first.")),
    }
}

pub fn read_lock(root: &Path) -> Result<Value, String> {
    let file = lock_path(root);
    if !file.exists() {
        return Ok(json!({ "schemaVersion": 1, "profiles": {} }));
    }
    let text = fs::read_to_string(&file).map_err(|e| js::fs_error(&e, "open", &file))?;
    let raw: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    schema::parse(&schemas()["lock"], &raw).map_err(|issues| format!("Invalid lock file: {}", issues.iter().map(|i| i.message.clone()).collect::<Vec<_>>().join("; ")))
}

fn move_path(from: &Path, to: &Path) -> bool {
    if !from.exists() || to.exists() {
        return false;
    }
    fs::rename(from, to).is_ok()
}

fn replace_in_file(file: &Path, from: &str, to: &str) {
    if let Ok(text) = fs::read_to_string(file) {
        if text.contains(from) {
            let _ = fs::write(file, text.replace(from, to));
        }
    }
}

pub fn migrate_project(root: &Path) {
    let legacy_manifest = root.join(format!("{LEGACY_ID}.json"));
    let manifest = manifest_path(root);
    if !legacy_manifest.exists() || manifest.exists() {
        return;
    }
    move_path(&root.join(format!("{LEGACY_ID}.lock.json")), &lock_path(root));
    let deps_old = format!("{LEGACY_ID}.dependencies.gradle");
    let deps_new = format!("{PRODUCT_ID}.dependencies.gradle");
    if move_path(&root.join(&deps_old), &root.join(&deps_new)) {
        for f in ["build.gradle", "build.gradle.kts"] {
            replace_in_file(&root.join(f), &deps_old, &deps_new);
        }
    }
    move_path(&root.join(format!(".{LEGACY_ID}")), &state_dir(root));
    replace_in_file(&root.join(".gitignore"), &format!(".{LEGACY_ID}/"), &format!("{STATE_DIR}/"));
    let _ = fs::rename(&legacy_manifest, &manifest);
}

pub struct Catalog {
    pub updated: Value,
    pub entries: Vec<Value>,
}

pub fn find_resources_dir() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("MODSMITH_RESOURCES_DIR").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(p));
    }
    resources_near(&crate::paths::exe_dir())
}

fn resources_near(exe_dir: &Path) -> Option<PathBuf> {
    let mut dir = Some(exe_dir.to_path_buf());
    for _ in 0..6 {
        let d = dir?;
        for candidate in [d.join("resources"), d.join("lib").join(crate::paths::PRODUCT_NAME).join("resources")] {
            if candidate.join("templates").exists() {
                return Some(candidate);
            }
        }
        dir = d.parent().map(Path::to_path_buf);
    }
    None
}

pub fn load_catalog(resources: &Path) -> Result<Catalog, String> {
    let file = resources.join("catalog").join("compatibility.json");
    let text = fs::read_to_string(&file).map_err(|e| js::fs_error(&e, "open", &file))?;
    let raw: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let parsed = schema::parse(&schemas()["catalog"], &raw).map_err(|issues| issues.iter().map(schema::Issue::text).collect::<Vec<_>>().join("; "))?;
    let entries = parsed["entries"].as_array().cloned().unwrap_or_default();
    let mut ids = std::collections::HashSet::new();
    for e in &entries {
        let id = e["id"].as_str().unwrap_or_default();
        if !ids.insert(id.to_string()) {
            return Err(format!("Duplicate catalog entry {id}"));
        }
    }
    Ok(Catalog { updated: parsed["updated"].clone(), entries })
}

impl Catalog {
    pub fn get(&self, id: &str) -> Option<&Value> {
        self.entries.iter().find(|e| e["id"] == id)
    }
}

#[cfg(test)]
mod tests {
    use super::resources_near;
    use std::fs;

    #[test]
    fn finds_resources_in_installed_layouts() {
        let root = std::env::temp_dir().join(format!("modsmith-res-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let deb = root.join("deb");
        fs::create_dir_all(deb.join("usr/bin")).unwrap();
        fs::create_dir_all(deb.join("usr/lib/Modsmith/resources/templates")).unwrap();
        assert_eq!(resources_near(&deb.join("usr/bin")), Some(deb.join("usr/lib/Modsmith/resources")));
        let flat = root.join("flat");
        fs::create_dir_all(flat.join("resources/templates")).unwrap();
        assert_eq!(resources_near(&flat), Some(flat.join("resources")));
        assert_eq!(resources_near(&root.join("deb/usr/lib")), Some(deb.join("usr/lib/Modsmith/resources")));
        fs::remove_dir_all(&root).unwrap();
    }
}
