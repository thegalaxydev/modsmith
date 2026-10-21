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
    pub rt: Arc<crate::rt::Runtime>,
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

const METHODS: [&str; 50] = [
    "profile.check_updates",
    "profile.preview_update",
    "profile.apply_update",
    "profile.update_history",
    "profile.rollback_update",
    "system.check_update",
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
    METHODS.contains(&method) || RUNTIME_METHODS.contains(&method)
}

const RUNTIME_METHODS: [&str; 86] = [
    "perf.run",
    "perf.results",
    "perf.compare",
    "perf.delete",
    "session.start",
    "session.list",
    "session.stop",
    "assets.validate",
    "assets.model",
    "registry.index",
    "instance.hotswap",
    "instance.debug_port_check",
    "operation.status",
    "operation.wait",
    "operation.cancel",
    "operation.log",
    "system.info",
    "system.capabilities",
    "java.list",
    "java.add",
    "java.install",
    "java.requirements",
    "catalog.starters",
    "workspace.open",
    "workspace.trust",
    "workspace.init",
    "project.validate_create",
    "project.plan_dependencies",
    "project.create",
    "project.validate",
    "project.build",
    "project.diagnostics",
    "project.datagen",
    "instance.launch",
    "instance.stop",
    "instance.list",
    "instance.status",
    "instance.history",
    "instance.eula_status",
    "instance.accept_eula",
    "server.export_pack",
    "theme.inspect",
    "theme.install",
    "theme.list",
    "theme.remove",
    "lsp.status",
    "lsp.install",
    "lsp.start",
    "lsp.send",
    "lsp.stop",
    "instance.send_input",
    "logs.read",
    "crash.inspect",
    "crash.bundle",
    "bridge.status",
    "bridge.call",
    "game.status",
    "game.mods",
    "game.telemetry",
    "game.reload",
    "game.reload_capabilities",
    "registry.search",
    "world.open",
    "world.inspect_target",
    "world.give_item",
    "world.run_command",
    "world.entities",
    "world.recipes",
    "world.tags",
    "world.snapshot",
    "world.snapshots",
    "world.restore",
    "viewport.capture",
    "scenario.list",
    "scenario.run",
    "scenario.results",
    "scenario.save",
    "scenario.delete",
    "bisect.start",
    "bisect.status",
    "bisect.record",
    "bisect.reset",
    "mcp.config",
    "viewport.window",
    "service.shutdown",
    "operation.list",
];

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
            "system.check_update" => Ok(Outcome::value(crate::updates::check(&self.providers.http, p["force"] == true))),
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
            "profile.check_updates" => Ok(Outcome::value(self.profiles.check_updates(s(p, "path"), s(p, "id"), p["mode"].as_str())?)),
            "profile.preview_update" => Ok(Outcome::value(self.profiles.preview_update(s(p, "path"), s(p, "id"), p["mode"].as_str(), keys(p))?)),
            "profile.apply_update" => Ok(Outcome::value(self.profiles.apply_update(s(p, "path"), s(p, "id"), p["mode"].as_str(), keys(p))?)),
            "profile.update_history" => Ok(Outcome::value(self.profiles.update_history(s(p, "path"), p["id"].as_str())?)),
            "profile.rollback_update" => Ok(Outcome::value(self.profiles.rollback_update(s(p, "path"), s(p, "rollback"))?)),
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
            _ => self.runtime_call(method, p),
        }
    }
}

fn pick(p: &Value, keys: &[&str]) -> Value {
    let mut o = serde_json::Map::new();
    for k in keys {
        if let Some(v) = p.get(*k).filter(|v| !v.is_null()) {
            o.insert(k.to_string(), v.clone());
        }
    }
    Value::Object(o)
}

fn merge(a: &Value, b: &Value) -> Value {
    let mut o = a.as_object().cloned().unwrap_or_default();
    for (k, v) in b.as_object().cloned().unwrap_or_default() {
        o.insert(k, v);
    }
    Value::Object(o)
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().map(crate::js::string).collect()).unwrap_or_default()
}

fn keys(p: &Value) -> Option<Vec<String>> {
    p["keys"].as_array().map(|a| a.iter().map(crate::js::string).collect())
}

fn none() -> Result<Outcome, String> {
    Ok(Outcome { value: None, events: vec![], invalidate: vec![] })
}

impl Native {
    fn runtime_call(&self, method: &str, p: &Value) -> Result<Outcome, String> {
        let rt = &self.rt;
        let id = s(p, "id");
        let v = |x: Value| Ok(Outcome::value(x));
        match method {
            "system.info" => v(rt.system_info()),
            "system.capabilities" => v(rt.capabilities()),
            "java.list" => v(Value::Array(rt.java.list(p["refresh"] == true))),
            "java.add" => v(rt.java.add_home(s(p, "home"))?),
            "java.install" => v(rt.java_install(p["major"].as_i64().unwrap_or(0), s(p, "imageType"))),
            "java.requirements" => v(rt.java_requirements(p)?),
            "catalog.starters" => {
                let e = self.catalog.get(s(p, "entryId")).ok_or_else(|| format!("Unknown catalog entry {}", s(p, "entryId")))?;
                v(Value::Array(crate::scaffold::starter_options(e)))
            }
            "workspace.open" => v(workspace::open(&self.store, &self.catalog, s(p, "path"))?),
            "workspace.trust" => v(workspace::trust(&self.store, &self.catalog, s(p, "path"), p["trusted"] == true)?),
            "workspace.init" => v(workspace::init_manifest(&self.catalog, s(p, "path"), p)?),
            "project.validate_create" => v(json!({ "issues": rt.validate_create(&p["input"]) })),
            "project.plan_dependencies" => v(Value::Array(rt.plan_dependencies(s(p, "minecraft"), s(p, "loader"), p["refs"].as_array().map(Vec::as_slice).unwrap_or(&[])))),
            "project.create" => v(rt.create_project(p)?),
            "project.validate" => v(rt.validate_project(s(p, "path"))),
            "project.build" => v(rt.build(s(p, "path"), p["clean"] == true, strs(&p["tasks"]))?),
            "project.diagnostics" => v(rt.diagnostics(s(p, "path"))?),
            "project.datagen" => v(rt.datagen(s(p, "path"))?),
            "instance.launch" => v(rt.launch(s(p, "path"), s(p, "profile"), p["mode"].as_str())?),
            "instance.stop" => v(rt.stop_instance(id, p["force"] == true)?),
            "instance.hotswap" => v(rt.hotswap(id)?),
            "registry.index" => v(rt.registry_index(s(p, "path"))?),
            "assets.validate" => v(rt.assets_validate(s(p, "path"), p["file"].as_str(), p["content"].as_str())?),
            "assets.model" => v(rt.assets_model(s(p, "path"), s(p, "model"))?),
            "instance.debug_port_check" => v(rt.debug_port_check(p["port"].as_u64().unwrap_or(5005).min(65535) as u16)),
            "instance.list" => v(Value::Array(rt.instances.list())),
            "session.start" => v(rt.session_start(p)?),
            "perf.run" => v(rt.perf_run(p)?),
            "perf.results" => v(rt.perf_results(s(p, "path"))),
            "perf.compare" => v(rt.perf_compare(s(p, "path"), s(p, "a"), s(p, "b"))?),
            "perf.delete" => v(rt.perf_delete(s(p, "path"), id)?),
            "session.list" => v(Value::Array(rt.session_list(p["path"].as_str()))),
            "session.stop" => v(rt.session_stop(id)?),
            "instance.status" => {
                let info = rt.instance_or_err(id)?;
                let mut out = info.as_object().cloned().unwrap_or_default();
                out.insert("bridge".into(), merge(&info["bridge"], &rt.bridge.status(id)));
                v(Value::Object(out))
            }
            "instance.history" => {
                let ws = p["path"].as_str().map(|x| workspace::normalize(x).to_string_lossy().to_string());
                v(db(self.store.list_launches(ws.as_deref(), 50))?)
            }
            "instance.eula_status" => v(rt.eula_status(s(p, "path"), s(p, "profile"), p["mode"].as_str().unwrap_or("development"))),
            "lsp.status" => v(rt.lsp_status(s(p, "path"), s(p, "language"))?),
            "lsp.install" => v(rt.lsp_install(s(p, "language"))?),
            "lsp.start" => v(rt.lsp_start(s(p, "path"), s(p, "language"))?),
            "lsp.send" => v(rt.lsp_send(s(p, "session"), s(p, "message"))?),
            "lsp.stop" => v(rt.lsp_stop(s(p, "session"))),
            "theme.inspect" => v(rt.theme_inspect(s(p, "file"))?),
            "theme.install" => v(rt.theme_install(s(p, "file"), p["variants"].as_array().map(|a| a.iter().map(crate::js::string).collect()))?),
            "theme.list" => v(rt.theme_list()),
            "theme.remove" => v(rt.theme_remove(s(p, "id"))?),
            "server.export_pack" => v(rt.export_server_pack(s(p, "path"), s(p, "profile"), s(p, "output"), p["zip"] == true)?),
            "instance.accept_eula" => v(rt.accept_eula(s(p, "path"), s(p, "profile"), p["mode"].as_str().unwrap_or("development"), p["accept"] == true)?),
            "instance.send_input" => {
                rt.instances.send_input(id, s(p, "line"))?;
                none()
            }
            "logs.read" => {
                let q = crate::logs::Query {
                    since: p["since"].as_f64().map(|x| x.max(0.0) as u64),
                    limit: p["limit"].as_u64().map(|x| x as usize),
                    levels: strs(&p["levels"]),
                    search: p["search"].as_str().filter(|x| !x.is_empty()).map(str::to_string),
                    logger: p["logger"].as_str().filter(|x| !x.is_empty()).map(str::to_string),
                    thread: p["thread"].as_str().filter(|x| !x.is_empty()).map(str::to_string),
                };
                v(rt.instances.logs(id, &q)?)
            }
            "crash.inspect" => v(rt.crash_inspect(id)?),
            "crash.bundle" => v(rt.crash_bundle(id, p["notes"].as_str())?),
            "bridge.status" => v(merge(&json!({ "instance": id }), &rt.bridge.status(id))),
            "bridge.call" => v(rt.bridge_call(id, s(p, "method"), if p["params"].is_object() { p["params"].clone() } else { json!({}) }, 20000)?),
            "game.status" => {
                let i = rt.instance_or_err(id)?;
                let base = rt.bridge_call(id, "game.status", json!({}), 20000)?;
                if i["side"] != "client" {
                    let mut o = base.as_object().cloned().unwrap_or_default();
                    o.insert("inWorld".into(), base.get("worldLoaded").cloned().unwrap_or(Value::Null));
                    return v(Value::Object(o));
                }
                v(merge(&base, &rt.bridge_call(id, "client.status", json!({}), 20000)?))
            }
            "game.mods" => v(rt.bridge_call(id, "game.mods", json!({}), 20000)?),
            "game.telemetry" => v(rt.bridge_call(id, "game.telemetry", json!({}), 20000)?),
            "game.reload" => v(rt.bridge_call(id, if p["kind"] == "resources" { "client.reload_resources" } else { "world.reload_datapacks" }, json!({}), 120000)?),
            "game.reload_capabilities" => {
                let i = rt.instance_or_err(id)?;
                let connected = rt.bridge.status(id)["connected"] == true;
                let client = i["side"] == "client";
                let debug = i.get("debugPort").filter(|d| crate::js::truthy(Some(d))).map(crate::js::string);
                let hotswap = match (&debug, i["mode"] == "development") {
                    (_, false) => "Release runs use the built JAR. Rebuild and restart to apply code changes.".to_string(),
                    (Some(port), true) => format!(
                        "Apply changes compiles the project and replaces changed method bodies in the running game through the debug port 127.0.0.1:{port}. New or removed methods and fields, signature or hierarchy changes, static initializers, mixins and registration changes need a restart."
                    ),
                    (None, true) => "Turn on hot reload for this profile, which enables the debug port, and restart the game.".to_string(),
                };
                let resources = if client {
                    "Reloads textures, models, sounds, language files from resource packs and mod JARs. Changed source files must be rebuilt into the classpath first (Build updates build/resources)."
                } else {
                    "Dedicated servers have no client resources"
                };
                v(json!({
                    "instance": id,
                    "actions": [
                        { "id": "resources", "label": "Asset/resource reload", "supported": connected && client, "detail": resources },
                        { "id": "datapacks", "label": "Datapack reload", "supported": connected, "detail": "Runs /reload on the logical server: recipes, tags, loot tables, advancements, functions." },
                        { "id": "config", "label": "Config reload", "supported": false, "detail": "Config reload depends on each mod; no generic mechanism is available. Restart to apply config changes unless the mod provides its own reload command." },
                        { "id": "hotswap", "label": "Java hot reload", "supported": debug.is_some() && i["mode"] == "development", "detail": hotswap },
                        { "id": "restart", "label": "Full rebuild and restart", "supported": true, "detail": "Required for new registry entries, mixins, added or changed mods, entrypoints, and structural Java changes." }
                    ]
                }))
            }
            "registry.search" => {
                let mut q = pick(p, &["registry", "query"]);
                q["limit"] = p.get("limit").filter(|l| !l.is_null()).cloned().unwrap_or(json!(100));
                v(rt.bridge_call(id, "registry.search", q, 20000)?)
            }
            "world.open" => {
                if rt.instance_or_err(id)?["side"] != "client" {
                    return Err("Opening worlds is only possible in a client instance".into());
                }
                v(rt.bridge_call(id, "world.open", pick(p, &["name", "create", "flat", "seed"]), 20000)?)
            }
            "world.inspect_target" => v(rt.bridge_call(id, "world.inspect_target", json!({}), 20000)?),
            "world.give_item" => v(rt.bridge_call(id, "world.give_item", pick(p, &["item", "count", "player"]), 20000)?),
            "world.run_command" => v(rt.bridge_call(id, "world.run_command", pick(p, &["command"]), 60000)?),
            "world.entities" | "world.recipes" | "world.tags" => {
                let keys: &[&str] = match method {
                    "world.entities" => &["radius"],
                    "world.recipes" => &["query"],
                    _ => &["registry", "query"],
                };
                let mut q = pick(p, keys);
                q["limit"] = p.get("limit").filter(|l| !l.is_null()).cloned().unwrap_or(json!(100));
                v(rt.bridge_call(id, method, q, 20000)?)
            }
            "world.snapshot" => v(rt.snapshot_op(s(p, "path"), s(p, "profile"), p["world"].as_str().map(str::to_string), p["name"].as_str().map(str::to_string))),
            "world.snapshots" => v(crate::snapshots::list(s(p, "path"))),
            "world.restore" => v(rt.snapshot_restore(s(p, "path"), s(p, "profile"), s(p, "snapshot"), p["confirm"] == true)?),
            "viewport.capture" => {
                use base64::Engine;
                let i = rt.instance_or_err(id)?;
                if i["side"] != "client" {
                    return Err("Screenshots require a client instance".into());
                }
                let r = rt.bridge.call(id, "client.screenshot", json!({}), 30000)?;
                let dir = Path::new(i["instanceDir"].as_str().unwrap_or("")).join("screenshots").join("modsmith");
                std::fs::create_dir_all(&dir).map_err(|e| crate::js::fs_error(&e, "mkdir", &dir))?;
                let file = dir.join(format!("capture-{}.png", crate::js::stamp(&crate::js::iso_now())));
                let png = r["png"].as_str().unwrap_or("").to_string();
                let bytes = base64::engine::general_purpose::STANDARD.decode(&png).map_err(|e| e.to_string())?;
                std::fs::write(&file, bytes).map_err(|e| crate::js::fs_error(&e, "open", &file))?;
                v(json!({ "file": file.to_string_lossy(), "width": r["width"], "height": r["height"], "pngBase64": png }))
            }
            "scenario.list" => v(crate::scenarios::list(s(p, "path"))?),
            "scenario.run" => v(rt.scenario_run(s(p, "path"), s(p, "scenario"), p["instance"].as_str().map(str::to_string))?),
            "scenario.results" => v(crate::scenarios::results(s(p, "path"))),
            "scenario.save" => v(crate::scenarios::save(s(p, "path"), s(p, "file"), &p["scenario"])?),
            "scenario.delete" => v(crate::scenarios::remove(s(p, "path"), s(p, "file"), p["confirm"] == true)?),
            "bisect.start" => v(rt.bisect_start(s(p, "path"), s(p, "profile"), s(p, "predicate"))?),
            "bisect.status" => v(rt.bisect_status(s(p, "path"))?),
            "bisect.record" => v(rt.bisect_record(s(p, "path"), s(p, "outcome"))?),
            "bisect.reset" => {
                rt.bisect_reset(s(p, "path"))?;
                none()
            }
            "mcp.config" => v(crate::rt::mcp_config()),
            "viewport.window" => {
                let i = rt.instance_or_err(id)?;
                v(crate::win32::viewport_window(i["pid"].as_u64().map(|p| p as u32)))
            }
            "service.shutdown" => {
                let stop = p["stopInstances"] == true;
                let rt = rt.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    if let Some(f) = rt.shutdown.get() {
                        f(stop);
                    }
                });
                v(json!({ "stopping": true }))
            }
            "operation.list" => v(Value::Array(self.ops.list())),
            _ => Err(format!("Unknown method {method}")),
        }
    }
}
