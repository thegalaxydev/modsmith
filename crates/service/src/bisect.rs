use crate::jarmeta::read_jar_metadata;
use crate::js;
use crate::manifest;
use crate::rt::{s, Runtime};
use crate::workspace;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

fn file(dir: &Path) -> PathBuf {
    manifest::state_dir(dir).join("bisect.json")
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().map(js::string).collect()).unwrap_or_default()
}

pub fn closure(keys: &[String], units: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    let mut stack: Vec<String> = keys.to_vec();
    while let Some(k) = stack.pop() {
        if !seen.insert(k.clone()) {
            continue;
        }
        out.push(k.clone());
        if let Some(u) = units.iter().find(|u| u["key"] == k.as_str()) {
            stack.extend(strings(&u["requires"]));
        }
    }
    out
}

pub fn next_split(candidates: &[String], skips: usize) -> Vec<String> {
    let n = candidates.len();
    if n <= 1 {
        return candidates.to_vec();
    }
    let r = skips % n;
    let mut rotated = candidates[r..].to_vec();
    rotated.extend_from_slice(&candidates[..r]);
    rotated.truncate(n.div_ceil(2));
    rotated
}

pub fn apply_outcome(state: &Value, outcome: &str) -> Result<Value, String> {
    let Some(tested) = state["current"].as_array().map(|a| a.iter().map(js::string).collect::<Vec<_>>()) else { return Err("No attempt in progress".into()) };
    let mut next = state.as_object().cloned().unwrap_or_default();
    let mut attempts = state["attempts"].as_array().cloned().unwrap_or_default();
    attempts.push(json!({ "tested": tested, "outcome": outcome, "at": js::iso_now() }));
    next.insert("attempts".into(), Value::Array(attempts));
    let candidates = strings(&state["candidates"]);
    let tested_candidates: Vec<String> = candidates.iter().filter(|c| tested.contains(c)).cloned().collect();
    match outcome {
        "bad" => {
            next.insert("candidates".into(), json!(tested_candidates));
        }
        "good" => {
            next.insert("candidates".into(), json!(candidates.iter().filter(|c| !tested.contains(c)).cloned().collect::<Vec<_>>()));
            let mut cleared = strings(&state["cleared"]);
            cleared.extend(tested_candidates);
            next.insert("cleared".into(), json!(cleared));
        }
        _ => {
            next.insert("skips".into(), json!(state["skips"].as_u64().unwrap_or(0) + 1));
        }
    }
    let now: Vec<String> = strings(&next["candidates"]);
    let units = state["units"].as_array().cloned().unwrap_or_default();
    if now.len() <= 1 {
        next.insert("done".into(), json!(true));
        next.insert("current".into(), Value::Null);
        let conclusion = match now.first() {
            Some(c) => {
                let title = units.iter().find(|u| u["key"] == c.as_str()).map(|u| js::string(&u["title"])).unwrap_or_else(|| c.clone());
                format!("The problem reproduced with a set containing {title} (plus its required dependencies) and not without it. This is evidence that it is involved, not proof that it alone is defective; interactions with its dependencies or the remaining mods are possible.")
            }
            None => {
                "Every candidate was cleared; the problem did not reproduce with any tested subset. It may need the full combination, the source mod alone, or depend on world/config state.".into()
            }
        };
        next.insert("conclusion".into(), json!(conclusion));
    } else {
        let skips = next["skips"].as_u64().unwrap_or(0) as usize;
        next.insert("current".into(), json!(closure(&next_split(&now, skips), &units)));
    }
    Ok(Value::Object(next))
}

impl Runtime {
    pub fn bisect_status(&self, workspace: &str) -> Result<Value, String> {
        let f = file(&workspace::normalize(workspace));
        if !f.exists() {
            return Ok(Value::Null);
        }
        let text = fs::read_to_string(&f).map_err(|e| js::fs_error(&e, "open", &f))?;
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }

    pub fn bisect_start(&self, workspace: &str, profile_id: &str, predicate: &str) -> Result<Value, String> {
        let dir = workspace::normalize(workspace);
        let m = manifest::require_manifest(&dir, workspace)?;
        if !m["profiles"].as_array().into_iter().flatten().any(|p| p["id"] == profile_id) {
            return Err(format!("Unknown profile {profile_id}"));
        }
        let lock = manifest::read_lock(&dir)?;
        let Some(lp) = lock["profiles"].get(profile_id).filter(|v| !v.is_null()).cloned() else { return Err(format!("Resolve profile {profile_id} before bisecting")) };
        let entries: Vec<Value> = lp["entries"].as_array().into_iter().flatten().filter(|e| e["provider"] == "modrinth" || e["provider"] == "local").cloned().collect();
        if entries.len() < 2 {
            return Err("Bisection needs at least two external mods in the profile".into());
        }
        let files_file = manifest::state_dir(&dir).join(format!("resolved-{profile_id}.files.json"));
        let files: Map<String, Value> = fs::read_to_string(&files_file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["files"].as_object().cloned()).unwrap_or_default();
        let mut owner: HashMap<String, String> = HashMap::new();
        let mut metas: HashMap<String, Vec<String>> = HashMap::new();
        for e in &entries {
            let key = js::string(&e["key"]);
            for id in strings(&e["modIds"]) {
                owner.insert(id, key.clone());
            }
            let deps = files
                .get(&key)
                .and_then(Value::as_str)
                .and_then(|f| read_jar_metadata(f).ok())
                .map(|meta| meta.as_array().into_iter().flatten().flat_map(|m| m["depends"].as_object().map(|d| d.keys().cloned().collect::<Vec<_>>()).unwrap_or_default()).collect())
                .unwrap_or_default();
            metas.insert(key, deps);
        }
        let mut units: Vec<Value> = entries
            .iter()
            .map(|e| {
                let key = js::string(&e["key"]);
                let mut requires: Vec<String> = Vec::new();
                for dep in metas.get(&key).cloned().unwrap_or_default() {
                    if let Some(o) = owner.get(&dep) {
                        if *o != key && !requires.contains(o) {
                            requires.push(o.clone());
                        }
                    }
                }
                json!({ "key": key, "title": e["title"], "requires": requires })
            })
            .collect();
        let re = Regex::new(r"^required by (.+)$").expect("reason regex");
        for e in &entries {
            let Some(c) = re.captures(e["reason"].as_str().unwrap_or("")) else { continue };
            let Some(parent) = entries.iter().find(|p| p["title"] == c[1].to_string().as_str()) else { continue };
            if let Some(u) = units.iter_mut().find(|u| u["key"] == parent["key"]) {
                let req = u["requires"].as_array_mut().expect("requires array");
                if !req.contains(&e["key"]) {
                    req.push(e["key"].clone());
                }
            }
        }
        let required_by_others: HashSet<String> = units.iter().flat_map(|u| strings(&u["requires"])).collect();
        let candidates: Vec<String> = units.iter().map(|u| js::string(&u["key"])).filter(|k| !required_by_others.contains(k)).collect();
        let bisect_profile: String = format!("{profile_id}-bisect").chars().take(48).collect();
        let current = closure(&next_split(&candidates, 0), &units);
        let state = json!({ "profile": profile_id, "bisectProfile": bisect_profile, "predicate": predicate, "units": units, "candidates": candidates, "cleared": [], "current": current, "attempts": [], "skips": 0, "done": false });
        self.bisect_apply(&dir, &state, lp["entries"].as_array().cloned().unwrap_or_default())?;
        fs::write(file(&dir), js::pretty(&state)).map_err(|e| js::fs_error(&e, "open", &file(&dir)))?;
        Ok(state)
    }

    pub fn bisect_record(&self, workspace: &str, outcome: &str) -> Result<Value, String> {
        let dir = workspace::normalize(workspace);
        let state = self.bisect_status(&s(&dir))?;
        if state.is_null() {
            return Err("No bisection in progress".into());
        }
        let next = apply_outcome(&state, outcome)?;
        let lock = manifest::read_lock(&dir)?;
        if let (true, Some(lp)) = (next["current"].is_array(), lock["profiles"].get(state["profile"].as_str().unwrap_or("")).filter(|v| !v.is_null())) {
            self.bisect_apply(&dir, &next, lp["entries"].as_array().cloned().unwrap_or_default())?;
        }
        fs::write(file(&dir), js::pretty(&next)).map_err(|e| js::fs_error(&e, "open", &file(&dir)))?;
        Ok(next)
    }

    pub fn bisect_reset(&self, workspace: &str) -> Result<(), String> {
        let dir = workspace::normalize(workspace);
        let state = self.bisect_status(&s(&dir))?;
        if !state.is_null() {
            let mut m = manifest::require_manifest(&dir, workspace)?;
            let bp = state["bisectProfile"].clone();
            if let Some(p) = m["profiles"].as_array_mut() {
                p.retain(|x| x["id"] != bp);
            }
            manifest::write_manifest(&dir, &m)?;
        }
        let _ = fs::remove_file(file(&dir));
        Ok(())
    }

    fn bisect_apply(&self, dir: &Path, state: &Value, entries: Vec<Value>) -> Result<(), String> {
        let mut m = manifest::require_manifest(dir, &s(dir))?;
        let base = m["profiles"].as_array().into_iter().flatten().find(|p| p["id"] == state["profile"]).cloned().ok_or("Unknown profile")?;
        let mut mods = Vec::new();
        for key in strings(&state["current"]) {
            let Some(e) = entries.iter().find(|x| x["key"] == key.as_str()) else { continue };
            if e["provider"] == "modrinth" && js::truthy(e.get("projectId")) {
                let mut r = Map::new();
                r.insert("source".into(), json!("modrinth"));
                r.insert("projectId".into(), e["projectId"].clone());
                if let Some(v) = e.get("versionId").filter(|v| !v.is_null()) {
                    r.insert("versionId".into(), v.clone());
                }
                r.insert("title".into(), e["title"].clone());
                r.insert("required".into(), json!(true));
                r.insert("usage".into(), json!("runtime"));
                r.insert("environment".into(), json!("both"));
                mods.push(Value::Object(r));
            } else if e["provider"] == "local" {
                mods.push(json!({ "source": "local", "path": key.strip_prefix("local:").unwrap_or(&key), "title": e["title"], "required": true, "usage": "runtime", "environment": "both" }));
            }
        }
        let mut bp = base.as_object().cloned().unwrap_or_default();
        bp.insert("id".into(), state["bisectProfile"].clone());
        bp.insert("name".into(), json!(format!("{} (bisect)", js::string(&base["name"]))));
        bp.insert("mods".into(), Value::Array(mods));
        let profiles = m["profiles"].as_array_mut().ok_or("Invalid manifest")?;
        match profiles.iter().position(|p| p["id"] == state["bisectProfile"]) {
            Some(i) => profiles[i] = Value::Object(bp),
            None => profiles.push(Value::Object(bp)),
        }
        manifest::write_manifest(dir, &m)?;
        self.emit("workspace.changed", json!({ "workspace": s(dir) }));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_and_closures() {
        let c: Vec<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        assert_eq!(next_split(&c, 0), vec!["a", "b"]);
        assert_eq!(next_split(&c, 1), vec!["b", "c"]);
        let units = vec![json!({ "key": "a", "requires": ["c"] }), json!({ "key": "b", "requires": [] }), json!({ "key": "c", "requires": [] })];
        assert_eq!(closure(&["a".into()], &units), vec!["a", "c"]);
    }
}
