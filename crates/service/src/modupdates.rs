use crate::js;
use crate::manifest;
use crate::ops::OpCtx;
use crate::profiles::{lock_key, ref_key, ref_pin, with_pin, Plan, Profiles};
use crate::providers::{date_parse, pick_version};
use crate::workspace;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn s(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

fn is_remote(e: &Value) -> bool {
    e["provider"] == "modrinth" || e["provider"] == "curseforge"
}

fn put(o: &mut Map<String, Value>, key: &str, v: Option<&Value>) {
    if let Some(v) = v.filter(|v| !v.is_null()) {
        o.insert(key.into(), v.clone());
    }
}

fn entries(v: &Value) -> Vec<Value> {
    v["entries"].as_array().cloned().unwrap_or_default()
}

fn issues(v: &Value) -> Vec<Value> {
    v["issues"].as_array().cloned().unwrap_or_default()
}

pub fn diff_lock(before: &[Value], after: &[Value], before_issues: &[Value], after_issues: &[Value]) -> Value {
    let identity = |e: &Value| e.get("versionId").filter(|v| !v.is_null()).or_else(|| e.get("sha1")).cloned().unwrap_or(Value::Null);
    let mut changed = Vec::new();
    let mut added = Vec::new();
    let mut removed = Vec::new();
    for e in after {
        let mut o = Map::new();
        o.insert("key".into(), e["key"].clone());
        o.insert("title".into(), e["title"].clone());
        match before.iter().find(|b| b["key"] == e["key"]) {
            None => {
                put(&mut o, "version", e.get("versionNumber"));
                added.push(Value::Object(o));
            }
            Some(b) if identity(b) != identity(e) => {
                put(&mut o, "from", b.get("versionNumber"));
                put(&mut o, "to", e.get("versionNumber"));
                changed.push(Value::Object(o));
            }
            _ => {}
        }
    }
    for b in before {
        if !after.iter().any(|e| e["key"] == b["key"]) {
            let mut o = Map::new();
            o.insert("key".into(), b["key"].clone());
            o.insert("title".into(), b["title"].clone());
            put(&mut o, "version", b.get("versionNumber"));
            removed.push(Value::Object(o));
        }
    }
    let serious = |l: &[Value]| l.iter().filter(|i| i["severity"] != "info").cloned().collect::<Vec<_>>();
    let sig = |i: &Value| format!("{}|{}", js::string(&i["severity"]), js::string(&i["message"]));
    let (was, is) = (serious(before_issues), serious(after_issues));
    let new_issues: Vec<Value> = is.iter().filter(|i| !was.iter().any(|w| sig(w) == sig(i))).cloned().collect();
    let fixed: Vec<Value> = was.iter().filter(|w| !is.iter().any(|i| sig(i) == sig(w))).cloned().collect();
    json!({ "changed": changed, "added": added, "removed": removed, "newIssues": new_issues, "fixedIssues": fixed })
}

struct Loaded {
    dir: PathBuf,
    m: Value,
    profile: Value,
    mode: String,
    previous: Value,
}

fn refs_of(m: &Value, profile: &Value) -> Vec<Value> {
    let mut out = m["dependencies"].as_array().cloned().unwrap_or_default();
    out.extend(profile["mods"].as_array().cloned().unwrap_or_default());
    out
}

fn repin(m: &mut Value, profile_id: &str, pins: &Map<String, Value>) {
    let apply = |list: &mut Value| {
        if let Some(a) = list.as_array_mut() {
            for r in a.iter_mut() {
                if let Some(k) = ref_key(r).filter(|k| pins.contains_key(k)) {
                    *r = with_pin(r, pins[&k].as_str());
                }
            }
        }
    };
    apply(&mut m["dependencies"]);
    if let Some(p) = m["profiles"].as_array_mut().and_then(|a| a.iter_mut().find(|p| p["id"] == profile_id)) {
        apply(&mut p["mods"]);
    }
}

fn select(updates: Vec<Value>, keys: Option<&Vec<String>>) -> Result<Vec<Value>, String> {
    let Some(keys) = keys else { return Ok(updates) };
    for k in keys {
        if !updates.iter().any(|u| u["key"] == k.as_str()) {
            return Err(format!("{k} has no update available"));
        }
    }
    Ok(updates.into_iter().filter(|u| keys.iter().any(|k| u["key"] == k.as_str())).collect())
}

fn now_iso() -> String {
    humantime::format_rfc3339_millis(std::time::SystemTime::now()).to_string()
}

impl Profiles {
    fn updates_dir(dir: &Path) -> PathBuf {
        manifest::state_dir(dir).join("updates")
    }

    fn load_for_update(&self, root: &str, id: &str, mode: Option<&str>) -> Result<Loaded, String> {
        let dir = workspace::normalize(root);
        let m = manifest::require_manifest(&dir, &s(&dir))?;
        let profile = m["profiles"].as_array().into_iter().flatten().find(|p| p["id"] == id).cloned().ok_or_else(|| format!("Unknown profile {id}"))?;
        let mode = mode.map(str::to_string).unwrap_or_else(|| js::string(&profile["mode"]));
        let previous = manifest::read_lock(&dir)?["profiles"][lock_key(id, &mode)].clone();
        if previous.is_null() {
            return Err(format!("Profile {id} has not been resolved yet. Resolve it first so there is a lock file to compare with."));
        }
        Ok(Loaded { dir, m, profile, mode, previous })
    }

    fn available(&self, m: &Value, profile: &Value, previous: &Value, ctx: &OpCtx) -> Result<Value, String> {
        let refs = refs_of(m, profile);
        let list: Vec<Value> = entries(previous).into_iter().filter(|e| is_remote(e) && js::truthy(e.get("projectId")) && js::truthy(e.get("versionId"))).collect();
        let loader = js::string(&m["platform"]["loader"]);
        let minecraft = js::string(&m["platform"]["minecraft"]);
        self.with_fresh_apis(|modrinth, cf| {
            let mut updates = Vec::new();
            let mut failed = Vec::new();
            for (i, e) in list.iter().enumerate() {
                ctx.check()?;
                let title = js::string(&e["title"]);
                ctx.progress(Some(i as f64 / list.len().max(1) as f64), Some(&format!("Checking {title}")));
                let api = if e["provider"] == "modrinth" { Some(modrinth) } else { cf };
                let Some(api) = api else {
                    failed.push(json!({ "key": e["key"], "title": e["title"], "error": "CurseForge is not configured" }));
                    continue;
                };
                let project_id = js::string(&e["projectId"]);
                let version_id = js::string(&e["versionId"]);
                let all = match api.versions(&project_id, &loader, &minecraft) {
                    Ok(a) => a,
                    Err(err) => {
                        failed.push(json!({ "key": e["key"], "title": e["title"], "error": err }));
                        continue;
                    }
                };
                let Some(latest) = pick_version(&all, &loader, &minecraft).cloned() else { continue };
                if latest["id"] == version_id.as_str() {
                    continue;
                }
                let current = all.iter().find(|v| v["id"] == version_id.as_str()).cloned().or_else(|| api.version(&version_id, Some(&project_id)).ok());
                if let Some(c) = &current {
                    if !(date_parse(latest["date_published"].as_str().unwrap_or("")) > date_parse(c["date_published"].as_str().unwrap_or(""))) {
                        continue;
                    }
                }
                let key = js::string(&e["key"]);
                let matching: Vec<&Value> = refs.iter().filter(|r| ref_key(r).as_deref() == Some(key.as_str())).collect();
                updates.push(json!({
                    "key": key,
                    "provider": e["provider"],
                    "projectId": project_id,
                    "title": e["title"],
                    "direct": !matching.is_empty(),
                    "pinned": matching.iter().any(|r| ref_pin(r).is_some()),
                    "from": { "versionId": e["versionId"], "versionNumber": e["versionNumber"] },
                    "to": { "versionId": latest["id"], "versionNumber": latest["version_number"] },
                }));
            }
            Ok(json!({ "checked": list.len(), "updates": updates, "failed": failed }))
        })
    }

    pub fn check_updates(self: &Arc<Self>, root: &str, id: &str, mode: Option<&str>) -> Result<Value, String> {
        let l = self.load_for_update(root, id, mode)?;
        let me = self.clone();
        let title = format!("Check updates for {}", js::string(&l.profile["name"]));
        Ok(self.ops.start("profile.check_updates", &title, Some(s(&l.dir)), move |ctx| {
            let r = me.available(&l.m, &l.profile, &l.previous, ctx)?;
            ctx.log(&format!("{} of {} mods have a newer version", r["updates"].as_array().map_or(0, Vec::len), r["checked"]));
            let mut out = Map::new();
            out.insert("profile".into(), l.profile["id"].clone());
            out.insert("mode".into(), json!(l.mode));
            for (k, v) in r.as_object().cloned().unwrap_or_default() {
                out.insert(k, v);
            }
            Ok(Some(Value::Object(out)))
        }))
    }

    fn pins_for(chosen: &[Value]) -> Map<String, Value> {
        chosen.iter().filter(|u| u["pinned"] == true).map(|u| (js::string(&u["key"]), u["to"]["versionId"].clone())).collect()
    }

    pub fn preview_update(self: &Arc<Self>, root: &str, id: &str, mode: Option<&str>, keys: Option<Vec<String>>) -> Result<Value, String> {
        let l = self.load_for_update(root, id, mode)?;
        let me = self.clone();
        let title = format!("Preview updates for {}", js::string(&l.profile["name"]));
        Ok(self.ops.start("profile.preview_update", &title, Some(s(&l.dir)), move |ctx| {
            let all = me.available(&l.m, &l.profile, &l.previous, ctx)?;
            let chosen = select(all["updates"].as_array().cloned().unwrap_or_default(), keys.as_ref())?;
            let plan = Plan { update: chosen.iter().map(|u| js::string(&u["key"])).collect(), pins: Self::pins_for(&chosen), dry_run: true, ..Default::default() };
            ctx.progress(Some(0.8), Some("Resolving with the updates"));
            let (res, _) = me.resolve_with(&s(&l.dir), &js::string(&l.profile["id"]), Some(ctx), Some(&l.mode), None, vec![], &plan)?;
            let diff = diff_lock(&entries(&l.previous), &res.entries, &issues(&l.previous), &res.issues);
            Ok(Some(json!({ "profile": l.profile["id"], "mode": l.mode, "updates": chosen, "diff": diff })))
        }))
    }

    pub fn apply_update(self: &Arc<Self>, root: &str, id: &str, mode: Option<&str>, keys: Option<Vec<String>>) -> Result<Value, String> {
        let l = self.load_for_update(root, id, mode)?;
        let me = self.clone();
        let title = format!("Update mods of {}", js::string(&l.profile["name"]));
        Ok(self.ops.start("profile.apply_update", &title, Some(s(&l.dir)), move |ctx| {
            let pid = js::string(&l.profile["id"]);
            let mut m = manifest::require_manifest(&l.dir, &s(&l.dir))?;
            let current = m["profiles"].as_array().into_iter().flatten().find(|p| p["id"] == pid.as_str()).cloned().unwrap_or(Value::Null);
            let all = me.available(&m, &current, &l.previous, ctx)?;
            let chosen = select(all["updates"].as_array().cloned().unwrap_or_default(), keys.as_ref())?;
            if chosen.is_empty() {
                return Err("There are no updates to apply".into());
            }
            let refs = refs_of(&m, &current);
            let mut before_pins = Map::new();
            for u in chosen.iter().filter(|u| u["pinned"] == true) {
                let key = js::string(&u["key"]);
                let pin = refs.iter().filter(|r| ref_key(r).as_deref() == Some(key.as_str())).find_map(ref_pin);
                before_pins.insert(key, pin.map(Value::from).unwrap_or(Value::Null));
            }
            repin(&mut m, &pid, &Self::pins_for(&chosen));
            manifest::write_manifest(&l.dir, &m)?;
            ctx.progress(Some(0.8), Some("Resolving with the updates"));
            let plan = Plan { update: chosen.iter().map(|u| js::string(&u["key"])).collect(), ..Default::default() };
            let (res, changed) = me.resolve_with(&s(&l.dir), &pid, Some(ctx), Some(&l.mode), None, vec![], &plan)?;
            me.ops.emit_event("workspace.changed", changed);
            let diff = diff_lock(&entries(&l.previous), &res.entries, &issues(&l.previous), &res.issues);
            let rid = crate::ops::uuid_v4()[..8].to_string();
            let point = json!({
                "id": rid,
                "profile": pid,
                "mode": l.mode,
                "createdAt": now_iso(),
                "keys": chosen.iter().map(|u| u["key"].clone()).collect::<Vec<_>>(),
                "pins": before_pins,
                "before": l.previous,
                "diff": diff,
            });
            let dir = Self::updates_dir(&l.dir);
            fs::create_dir_all(&dir).map_err(|e| js::fs_error(&e, "mkdir", &dir))?;
            let file = dir.join(format!("{rid}.json"));
            fs::write(&file, js::pretty(&point)).map_err(|e| js::fs_error(&e, "open", &file))?;
            ctx.log(&format!(
                "Rollback point {rid}: {} changed, {} added, {} removed",
                diff["changed"].as_array().map_or(0, Vec::len),
                diff["added"].as_array().map_or(0, Vec::len),
                diff["removed"].as_array().map_or(0, Vec::len)
            ));
            Ok(Some(json!({ "profile": pid, "mode": l.mode, "rollback": rid, "updates": chosen, "diff": diff })))
        }))
    }

    pub fn update_history(&self, root: &str, id: Option<&str>) -> Result<Value, String> {
        let dir = Self::updates_dir(&workspace::normalize(root));
        let mut points: Vec<Value> = fs::read_dir(&dir)
            .map(|rd| rd.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "json")).filter_map(|e| fs::read_to_string(e.path()).ok()).filter_map(|t| serde_json::from_str::<Value>(&t).ok()).collect())
            .unwrap_or_default();
        points.retain(|p| id.is_none_or(|i| p["profile"] == i));
        points.sort_by(|a, b| js::string(&b["createdAt"]).cmp(&js::string(&a["createdAt"])));
        Ok(Value::Array(
            points
                .into_iter()
                .map(|p| json!({ "id": p["id"], "profile": p["profile"], "mode": p["mode"], "createdAt": p["createdAt"], "rolledBackAt": p.get("rolledBackAt").cloned().unwrap_or(Value::Null), "keys": p["keys"], "diff": p["diff"] }))
                .collect(),
        ))
    }

    pub fn rollback_update(self: &Arc<Self>, root: &str, rollback: &str) -> Result<Value, String> {
        let dir = workspace::normalize(root);
        let file = Self::updates_dir(&dir).join(format!("{rollback}.json"));
        if rollback.is_empty() || !rollback.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') || !file.exists() {
            return Err(format!("Unknown rollback point {rollback}"));
        }
        let mut point: Value = serde_json::from_str(&fs::read_to_string(&file).map_err(|e| js::fs_error(&e, "open", &file))?).map_err(|e| e.to_string())?;
        let mut m = manifest::require_manifest(&dir, &s(&dir))?;
        let pid = js::string(&point["profile"]);
        let profile = m["profiles"].as_array().into_iter().flatten().find(|p| p["id"] == pid.as_str()).cloned().ok_or_else(|| format!("Unknown profile {pid}"))?;
        let me = self.clone();
        let title = format!("Roll back mod updates of {}", js::string(&profile["name"]));
        Ok(self.ops.start("profile.rollback_update", &title, Some(s(&dir)), move |ctx| {
            let mode = js::string(&point["mode"]);
            let current = manifest::read_lock(&dir)?["profiles"][lock_key(&pid, &mode)].clone();
            repin(&mut m, &pid, point["pins"].as_object().unwrap_or(&Map::new()));
            manifest::write_manifest(&dir, &m)?;
            let held: Map<String, Value> = entries(&point["before"]).into_iter().filter(|e| is_remote(e) && js::truthy(e.get("versionId"))).map(|e| (js::string(&e["key"]), e["versionId"].clone())).collect();
            let plan = Plan { held, ..Default::default() };
            let (res, changed) = me.resolve_with(&s(&dir), &pid, Some(ctx), Some(&mode), None, vec![], &plan)?;
            me.ops.emit_event("workspace.changed", changed);
            point["rolledBackAt"] = json!(now_iso());
            fs::write(&file, js::pretty(&point)).map_err(|e| js::fs_error(&e, "open", &file))?;
            let diff = diff_lock(&entries(&current), &res.entries, &issues(&current), &res.issues);
            Ok(Some(json!({ "profile": pid, "mode": mode, "rollback": point["id"], "diff": diff })))
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diffs_lock_entries_and_issues() {
        let before = vec![json!({ "key": "modrinth:a", "title": "A", "versionId": "a1", "versionNumber": "1.0" }), json!({ "key": "modrinth:b", "title": "B", "versionId": "b1", "versionNumber": "2.0" })];
        let after = vec![json!({ "key": "modrinth:a", "title": "A", "versionId": "a2", "versionNumber": "1.1" }), json!({ "key": "modrinth:c", "title": "C", "versionId": "c1" })];
        let d = diff_lock(&before, &after, &[json!({ "severity": "error", "message": "old" })], &[json!({ "severity": "warning", "message": "new" }), json!({ "severity": "info", "message": "x" })]);
        assert_eq!(d["changed"], json!([{ "key": "modrinth:a", "title": "A", "from": "1.0", "to": "1.1" }]));
        assert_eq!(d["added"], json!([{ "key": "modrinth:c", "title": "C" }]));
        assert_eq!(d["removed"], json!([{ "key": "modrinth:b", "title": "B", "version": "2.0" }]));
        assert_eq!(d["newIssues"], json!([{ "severity": "warning", "message": "new" }]));
        assert_eq!(d["fixedIssues"], json!([{ "severity": "error", "message": "old" }]));
    }
}
