use crate::jarmeta;
use crate::manifest::{Catalog, MANIFEST_FILE};
use crate::ops::Ops;
use crate::profiles::Profiles;
use crate::providers::Providers;
use crate::store::Store;
use crate::workspace;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

pub struct Native {
    pub store: Arc<Store>,
    pub catalog: Arc<Catalog>,
    pub providers: Arc<Providers>,
    pub profiles: Arc<Profiles>,
    pub ops: Arc<Ops>,
}

pub struct Outcome {
    pub value: Option<Value>,
    pub events: Vec<(&'static str, Value)>,
    pub invalidate: Vec<&'static str>,
}

impl Outcome {
    fn value(v: Value) -> Outcome {
        Outcome { value: Some(v), events: vec![], invalidate: vec![] }
    }
}

const METHODS: [&str; 44] = [
    "profile.list",
    "profile.create",
    "profile.update",
    "profile.clone",
    "profile.remove",
    "profile.resolve",
    "profile.compare",
    "profile.linked_packs",
    "profile.link_pack",
    "profile.unlink_pack",
    "profile.discover_packs",
    "profile.lock",
    "dependency.provide_file",
    "dependency.add",
    "dependency.remove",
    "dependency.set_enabled",
    "profile.import_pack",
    "profile.remove_pack",
    "modpack.import_mrpack",
    "modpack.import_curseforge",
    "modpack.export_curseforge",
    "modpack.export_mrpack",
    "meta.game_versions",
    "meta.loader_versions",
    "provider.status",
    "provider.set_curseforge_key",
    "provider.clear_curseforge_key",
    "dependency.search",
    "dependency.versions",
    "modpack.search",
    "preset.list",
    "preset.save",
    "preset.check",
    "workspace.list",
    "activity.list",
    "catalog.list",
    "dependency.inspect_jar",
    "workspace.inspect",
    "workspace.tree",
    "workspace.read_file",
    "workspace.write_file",
    "workspace.image",
    "workspace.set_image",
    "workspace.delete_file",
];

pub fn is_native(method: &str) -> bool {
    METHODS.contains(&method)
}

fn with_events((value, events): (Value, crate::profiles::Events)) -> Result<Outcome, String> {
    Ok(Outcome { value: Some(value), events, invalidate: vec![] })
}

fn no_value(events: crate::profiles::Events) -> Result<Outcome, String> {
    Ok(Outcome { value: None, events, invalidate: vec![] })
}

fn db<T>(r: rusqlite::Result<T>) -> Result<T, String> {
    r.map_err(|e| e.to_string())
}

fn s<'a>(p: &'a Value, key: &str) -> &'a str {
    p[key].as_str().unwrap_or_default()
}

fn changed(p: &Value, file: &str) -> (&'static str, Value) {
    ("workspace.file_changed", json!({ "workspace": workspace::normalize(s(p, "path")).to_string_lossy(), "file": file }))
}

impl Native {
    pub fn call(&self, method: &str, p: &Value) -> Result<Outcome, String> {
        match method {
            "workspace.list" => {
                let rows = db(self.store.list_recent())?;
                Ok(Outcome::value(Value::Array(
                    rows.into_iter().map(|(path, name, kind, opened)| json!({ "path": path, "name": name, "type": kind, "openedAt": opened, "exists": Path::new(&path).exists() })).collect(),
                )))
            }
            "activity.list" => Ok(Outcome::value(db(self.store.list_activity(p["limit"].as_i64().unwrap_or(200), p["source"].as_str()))?)),
            "catalog.list" => Ok(Outcome::value(json!({ "updated": self.catalog.updated, "entries": self.catalog.entries }))),
            "dependency.inspect_jar" => Ok(Outcome::value(jarmeta::read_jar_metadata(s(p, "file"))?)),
            "workspace.inspect" => Ok(Outcome::value(workspace::inspect(&self.store, &self.catalog, s(p, "path")))),
            "workspace.tree" => Ok(Outcome::value(workspace::tree(s(p, "path"), p["dir"].as_str().unwrap_or(""), p["depth"].as_u64().unwrap_or(3) as usize)?)),
            "workspace.read_file" => Ok(Outcome::value(workspace::read_file(s(p, "path"), s(p, "file"))?)),
            "workspace.write_file" => {
                let r = workspace::write_file(s(p, "path"), s(p, "file"), s(p, "content"), p["expectedMtime"].as_f64(), p["create"] == true)?;
                Ok(Outcome { value: Some(r), events: vec![changed(p, s(p, "file"))], invalidate: vec![] })
            }
            "workspace.image" => Ok(Outcome::value(workspace::image(s(p, "path")))),
            "workspace.set_image" => {
                let r = workspace::set_image(s(p, "path"), p["file"].as_str())?;
                Ok(Outcome { value: Some(r), events: vec![changed(p, MANIFEST_FILE)], invalidate: vec![] })
            }
            "workspace.delete_file" => {
                workspace::delete_file(s(p, "path"), s(p, "file"), p["confirm"] == true)?;
                Ok(Outcome { value: None, events: vec![], invalidate: vec![] })
            }
            "meta.game_versions" => Ok(Outcome::value(self.providers.game_versions(s(p, "loader"))?)),
            "meta.loader_versions" => Ok(Outcome::value(self.providers.loader_versions(s(p, "loader"), s(p, "minecraft"))?)),
            "provider.status" => Ok(Outcome::value(self.providers.provider_status())),
            "provider.set_curseforge_key" => Ok(Outcome { value: Some(self.providers.set_cf_key(s(p, "key"))?), events: vec![], invalidate: vec!["curseforge-key"] }),
            "provider.clear_curseforge_key" => Ok(Outcome { value: Some(self.providers.clear_cf_key()?), events: vec![], invalidate: vec!["curseforge-key"] }),
            "dependency.search" => Ok(Outcome::value(self.providers.dependency_search(p)?)),
            "dependency.versions" => Ok(Outcome::value(self.providers.dependency_versions(p)?)),
            "modpack.search" => Ok(Outcome::value(self.providers.modpack_search(p)?)),
            "preset.list" => Ok(Outcome::value(Value::Array(self.providers.preset_list()?))),
            "preset.save" => Ok(Outcome::value(self.providers.preset_save(&p["preset"])?)),
            "preset.check" => Ok(Outcome::value(self.providers.preset_check(s(p, "id"))?)),
            "operation.status" => self.ops.get(s(p, "id")).map(Outcome::value).ok_or_else(|| format!("Unknown operation {}", s(p, "id"))),
            "operation.wait" => self.ops.wait(s(p, "id"), p["timeoutMs"].as_u64().unwrap_or(60000)).map(Outcome::value).ok_or_else(|| format!("Unknown operation {}", s(p, "id"))),
            "operation.cancel" => Ok(Outcome::value(json!({ "cancelled": self.ops.cancel(s(p, "id")) }))),
            "operation.log" => {
                let lines = self.ops.full_log(s(p, "id"));
                let lines = match p["tail"].as_u64() {
                    Some(t) if t > 0 => lines[lines.len().saturating_sub(t as usize)..].to_vec(),
                    _ => lines,
                };
                Ok(Outcome::value(json!({ "lines": lines })))
            }
            "profile.list" => Ok(Outcome::value(self.profiles.list(s(p, "path"))?)),
            "profile.create" => with_events(self.profiles.create(s(p, "path"), &p["profile"])?),
            "profile.update" => with_events(self.profiles.update(s(p, "path"), s(p, "id"), &p["patch"])?),
            "profile.clone" => with_events(self.profiles.clone_profile(s(p, "path"), s(p, "source"), s(p, "id"), p["name"].as_str())?),
            "profile.remove" => no_value(self.profiles.remove(s(p, "path"), s(p, "id"), p["confirm"] == true)?),
            "profile.resolve" => Ok(Outcome::value(self.profiles.resolve_op(s(p, "path"), s(p, "id"), p["mode"].as_str().map(str::to_string)))),
            "profile.compare" => Ok(Outcome::value(self.profiles.compare(s(p, "path"), s(p, "a"), s(p, "b"))?)),
            "profile.linked_packs" => Ok(Outcome::value(self.profiles.linked_packs(s(p, "path"), s(p, "profile"))?)),
            "profile.link_pack" => with_events(self.profiles.link_pack(s(p, "path"), s(p, "profile"), s(p, "folder"), p["enabled"].as_bool(), p["configs"].as_bool())?),
            "profile.unlink_pack" => no_value(self.profiles.unlink_pack(s(p, "path"), s(p, "profile"), s(p, "folder"))?),
            "profile.discover_packs" => Ok(Outcome::value(self.profiles.discover_packs(s(p, "path"), s(p, "profile"))?)),
            "profile.lock" => Ok(Outcome::value(self.profiles.lock(s(p, "path"))?)),
            "dependency.provide_file" => Ok(Outcome::value(self.profiles.provide_manual_file(s(p, "file"))?)),
            "dependency.add" => with_events(self.profiles.add_dependency(s(p, "path"), p["profile"].as_str(), &p["ref"])?),
            "dependency.remove" => no_value(self.profiles.remove_mod(s(p, "path"), p["profile"].as_str(), s(p, "key"))?),
            "dependency.set_enabled" => with_events(self.profiles.set_mod_enabled(s(p, "path"), p["profile"].as_str(), s(p, "key"), p["enabled"] == true)?),
            "profile.import_pack" => Ok(Outcome::value(self.profiles.import_into_profile(s(p, "path"), p)?)),
            "profile.remove_pack" => with_events(self.profiles.remove_imported(s(p, "path"), s(p, "profile"), s(p, "pack"))?),
            "modpack.import_mrpack" => Ok(Outcome::value(self.profiles.import_mrpack(self.catalog.clone(), s(p, "file"), s(p, "destination"), p["name"].as_str().map(str::to_string))?)),
            "modpack.import_curseforge" => Ok(Outcome::value(self.profiles.import_curseforge(self.catalog.clone(), s(p, "file"), s(p, "destination"), p["name"].as_str().map(str::to_string))?)),
            "modpack.export_curseforge" => Ok(Outcome::value(self.profiles.export_curseforge(s(p, "path"), s(p, "profile"), s(p, "output"), s(p, "version"))?)),
            "modpack.export_mrpack" => Ok(Outcome::value(self.profiles.export_mrpack(s(p, "path"), s(p, "profile"), s(p, "output"), s(p, "version"))?)),
            _ => Err(format!("Unknown method {method}")),
        }
    }
}
