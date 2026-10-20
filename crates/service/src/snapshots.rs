use crate::js;
use crate::manifest;
use crate::rt::{s, Runtime};
use crate::workspace::{self, instance_dir_for};
use regex::Regex;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn root(ws: &Path) -> PathBuf {
    manifest::state_dir(ws).join("snapshots")
}

fn dir_size(d: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(d) else { return 0 };
    entries
        .flatten()
        .map(|e| {
            let full = d.join(e.file_name());
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                dir_size(&full)
            } else {
                fs::metadata(&full).map(|m| m.len()).unwrap_or(0)
            }
        })
        .sum()
}

fn locale_string() -> String {
    chrono::Local::now().format("%-m/%-d/%Y, %-I:%M:%S\u{202f}%p").to_string()
}

pub struct WorldDir {
    pub world_dir: PathBuf,
    pub world: String,
    pub instance_dir: PathBuf,
}

pub fn list(workspace: &str) -> Value {
    let r = root(&workspace::normalize(workspace));
    let Ok(entries) = fs::read_dir(&r) else { return json!([]) };
    let mut out: Vec<Value> =
        entries.flatten().map(|e| r.join(e.file_name()).join("snapshot.json")).filter(|f| f.exists()).filter_map(|f| fs::read_to_string(f).ok().and_then(|t| serde_json::from_str(&t).ok())).collect();
    out.sort_by(|a: &Value, b: &Value| js::locale_compare(b["createdAt"].as_str().unwrap_or(""), a["createdAt"].as_str().unwrap_or("")));
    Value::Array(out)
}

pub fn world_dir(workspace: &str, profile_id: &str, world: Option<&str>) -> Result<WorldDir, String> {
    let dir = workspace::normalize(workspace);
    let m = manifest::require_manifest(&dir, workspace)?;
    let profile = m["profiles"].as_array().into_iter().flatten().find(|p| p["id"] == profile_id).cloned().ok_or_else(|| format!("Unknown profile {profile_id}"))?;
    let side = js::string(&profile["side"]);
    let instance_dir = instance_dir_for(&dir, profile_id, &js::string(&profile["mode"]), &side);
    if side == "server" {
        let level = world
            .map(str::to_string)
            .or_else(|| fs::read_to_string(instance_dir.join("server.properties")).ok().and_then(|t| Regex::new(r"(?m)^level-name=(.*)$").ok()?.captures(&t).map(|c| c[1].trim().to_string())));
        let level = level.unwrap_or_else(|| "world".into());
        return Ok(WorldDir { world_dir: instance_dir.join(&level), world: level, instance_dir });
    }
    let saves = instance_dir.join("saves");
    let mut name = world.map(str::to_string).or_else(|| profile["world"]["name"].as_str().filter(|n| !n.is_empty()).map(str::to_string));
    if name.is_none() {
        if let Ok(entries) = fs::read_dir(&saves) {
            let mut worlds: Vec<(f64, String)> = entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|w| saves.join(w).join("level.dat").exists())
                .map(|w| (fs::metadata(saves.join(&w)).map(|m| js::mtime_ms(&m)).unwrap_or(0.0), w))
                .collect();
            worlds.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            name = worlds.into_iter().next().map(|(_, w)| w);
        }
    }
    let name = name.ok_or_else(|| format!("Profile {profile_id} has no world to snapshot yet"))?;
    Ok(WorldDir { world_dir: saves.join(&name), world: name, instance_dir })
}

impl Runtime {
    pub fn snapshot_op(self: &Arc<Self>, workspace: &str, profile: &str, world: Option<String>, name: Option<String>) -> Value {
        let dir = workspace::normalize(workspace);
        let me = self.clone();
        let profile = profile.to_string();
        self.ops.start("world.snapshot", &format!("Snapshot {profile}"), Some(s(&dir)), move |_| {
            let ws = s(&dir);
            let running = me.instances.list().into_iter().find(|i| i["workspace"] == ws.as_str() && i["profileId"] == profile.as_str() && (i["status"] == "running" || i["status"] == "starting"));
            let w = world_dir(&ws, &profile, world.as_deref())?;
            if !w.world_dir.join("level.dat").exists() {
                return Err(format!("World {} has no level.dat at {}", w.world, w.world_dir.display()));
            }
            if let Some(r) = running {
                let id = js::string(&r["id"]);
                if me.bridge.status(&id)["connected"] == true {
                    me.bridge.call(&id, "world.save", json!({}), 60000)?;
                }
            }
            let now = js::iso_now();
            let mut rnd = [0u8; 3];
            getrandom::fill(&mut rnd).map_err(|e| e.to_string())?;
            let id = format!("{}-{}", js::stamp(&now), hex::encode(rnd));
            let dest = root(&dir).join(&id);
            fs::create_dir_all(&dest).map_err(|e| js::fs_error(&e, "mkdir", &dest))?;
            js::copy_recursive(&w.world_dir, &dest.join("world"), &|p: &Path| p.file_name().is_some_and(|n| n == "session.lock"))?;
            let meta = json!({
                "id": id,
                "name": name.clone().unwrap_or_else(|| format!("{} {}", w.world, locale_string())),
                "profile": profile,
                "world": w.world,
                "createdAt": js::iso_now(),
                "sizeBytes": dir_size(&dest.join("world")),
                "source": s(&w.world_dir)
            });
            fs::write(dest.join("snapshot.json"), js::pretty(&meta)).map_err(|e| js::fs_error(&e, "open", &dest))?;
            Ok(Some(meta))
        })
    }

    pub fn snapshot_restore(&self, workspace: &str, profile: &str, snapshot: &str, confirm: bool) -> Result<Value, String> {
        if !confirm {
            return Err("Restoring a snapshot replaces the current world; pass confirm: true".into());
        }
        let dir = workspace::normalize(workspace);
        let snaps = list(&s(&dir));
        let snap = snaps.as_array().into_iter().flatten().find(|x| x["id"] == snapshot).cloned().ok_or_else(|| format!("Unknown snapshot {snapshot}"))?;
        let w = world_dir(&s(&dir), profile, snap["world"].as_str())?;
        if self.instances.active_for_dir(&w.instance_dir).is_some() {
            return Err("Stop the instance before restoring a world snapshot".into());
        }
        let tmp = PathBuf::from(format!("{}.restore-{}", w.world_dir.display(), crate::support::now_ms()));
        js::copy_recursive(&root(&dir).join(snapshot).join("world"), &tmp, &|_| false)?;
        if w.world_dir.exists() {
            fs::remove_dir_all(&w.world_dir).map_err(|e| js::fs_error(&e, "rm", &w.world_dir))?;
        }
        fs::rename(&tmp, &w.world_dir).map_err(|e| js::fs_error(&e, "rename", &tmp))?;
        Ok(json!({ "restoredTo": s(&w.world_dir) }))
    }
}
