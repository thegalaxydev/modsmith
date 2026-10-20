use crate::js;
use crate::manifest::{self, Catalog};
use crate::packimport::read_zip;
use crate::profiles::{parse_with, Profiles};
use serde_json::{json, Map, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn s(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

pub fn validate_destination(dest: &str) -> Option<String> {
    if dest.is_empty() {
        return Some("Destination is required".into());
    }
    let p = Path::new(dest);
    if !p.is_absolute() {
        return Some("Destination must be an absolute path".into());
    }
    let tail: String = dest.chars().skip(2).collect();
    if tail.chars().any(|c| "<>\"|?*".contains(c)) {
        return Some("Destination contains characters that are not allowed in Windows paths".into());
    }
    if p.exists() {
        if !p.is_dir() {
            return Some("Destination exists and is a file".into());
        }
        let count = fs::read_dir(p).map(|it| it.count()).unwrap_or(0);
        if count > 0 {
            return Some(format!("Destination is not empty ({count} entries). Choose an empty or new directory; existing projects are never overwritten."));
        }
    } else {
        let mut parent = p.parent().map(Path::to_path_buf).unwrap_or_else(|| p.to_path_buf());
        while !parent.exists() {
            let Some(next) = parent.parent().map(Path::to_path_buf) else { return Some("Destination drive does not exist".into()) };
            if next == parent {
                return Some("Destination drive does not exist".into());
            }
            parent = next;
        }
        if fs::metadata(&parent).map(|m| m.permissions().readonly()).unwrap_or(true) {
            return Some(format!("Cannot write to {}", s(&parent)));
        }
    }
    None
}

fn select_entry<'a>(catalog: &'a Catalog, loader: &str, minecraft: &str) -> Option<&'a Value> {
    catalog.entries.iter().find(|e| e["loader"] == loader && e["minecraft"] == minecraft)
}

fn write_overrides(entries: &[(String, Vec<u8>)], prefixes: &[&str], dir: &Path) -> Result<usize, String> {
    let mut count = 0;
    for (p, data) in entries {
        for prefix in prefixes {
            if p.starts_with(prefix) && !p.ends_with('/') {
                let out = js::resolve_within(dir, &p[prefix.len()..])?;
                if let Some(d) = out.parent() {
                    fs::create_dir_all(d).map_err(|e| js::fs_error(&e, "mkdir", d))?;
                }
                fs::write(&out, data).map_err(|e| js::fs_error(&e, "open", &out))?;
                count += 1;
            }
        }
    }
    Ok(count)
}

fn zip_bytes(files: &[(String, Vec<u8>)]) -> Result<Vec<u8>, String> {
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut w = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in files {
            w.start_file(name.as_str(), opts).map_err(|e| e.to_string())?;
            w.write_all(data).map_err(|e| e.to_string())?;
        }
        w.finish().map_err(|e| e.to_string())?;
    }
    Ok(buf.into_inner())
}

fn config_overrides(dir: &Path, profile: &Value, files: &mut Vec<(String, Vec<u8>)>) {
    let Some(cfg_rel) = profile.get("configDir").and_then(Value::as_str).filter(|c| !c.is_empty()) else { return };
    let cfg = dir.join(cfg_rel);
    fn walk(cfg: &Path, d: &Path, files: &mut Vec<(String, Vec<u8>)>) {
        let Ok(entries) = fs::read_dir(d) else { return };
        for e in entries.flatten() {
            let full = e.path();
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                walk(cfg, &full, files);
            } else if let Ok(data) = fs::read(&full) {
                let rel = full.strip_prefix(cfg).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
                files.push((format!("overrides/config/{rel}"), data));
            }
        }
    }
    if cfg.exists() {
        walk(&cfg, &cfg, files);
    }
}

impl Profiles {
    fn finish_import(&self, dest: &Path, manifest: &Value) -> Result<String, String> {
        manifest::write_manifest(dest, manifest)?;
        fs::write(dest.join(".gitignore"), ".modsmith/\n").map_err(|e| js::fs_error(&e, "open", &dest.join(".gitignore")))?;
        let normalized = s(&crate::workspace::normalize(&s(dest)));
        self.store.add_recent(&normalized, &js::string(&manifest["name"]), "modpack").map_err(|e| e.to_string())?;
        Ok(normalized)
    }

    pub fn import_mrpack(self: &Arc<Self>, catalog: Arc<Catalog>, file: &str, destination: &str, name: Option<String>) -> Result<Value, String> {
        let dest = js::absolute(destination);
        if let Some(err) = validate_destination(&s(&dest)) {
            return Err(err);
        }
        let me = self.clone();
        let file = file.to_string();
        let base = Path::new(&file).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let dest_c = dest.clone();
        Ok(self.ops.start("modpack.import", &format!("Import {base}"), Some(s(&dest)), move |ctx| {
            let entries = read_zip(&fs::read(&file).map_err(|e| js::fs_error(&e, "open", Path::new(&file)))?)?;
            let raw = entries.iter().find(|(n, _)| n == "modrinth.index.json").map(|(_, d)| d).ok_or("Not a Modrinth pack: modrinth.index.json is missing")?;
            let index = parse_with("mrpackIndex", &serde_json::from_str::<Value>(&String::from_utf8_lossy(raw)).map_err(|e| e.to_string())?)?;
            let deps = &index["dependencies"];
            let has = |k: &str| deps.get(k).is_some_and(|v| js::truthy(Some(v)));
            let mc = deps.get("minecraft").filter(|v| js::truthy(Some(v))).map(js::string);
            let loader = if has("fabric-loader") {
                Some("fabric")
            } else if has("neoforge") {
                Some("neoforge")
            } else if has("forge") {
                Some("forge")
            } else {
                None
            };
            let (Some(mc), Some(loader)) = (mc, loader) else { return Err("Pack does not declare a Minecraft version and a supported loader".into()) };
            let loader_version = ["fabric-loader", "neoforge", "forge"].iter().find_map(|k| deps.get(*k).filter(|v| !v.is_null()).cloned());
            let entry = select_entry(&catalog, loader, &mc).map(|e| e["id"].clone());
            let mut mods = Vec::new();
            let mut unresolved: Vec<String> = Vec::new();
            let files = index["files"].as_array().cloned().unwrap_or_default();
            for (i, f) in files.iter().enumerate() {
                ctx.check()?;
                let path = js::string(&f["path"]);
                let fname = Path::new(&path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                ctx.progress(Some(i as f64 / files.len().max(1) as f64), Some(&format!("Identifying {fname}")));
                if !path.starts_with("mods/") {
                    unresolved.push(format!("{path}: non-mod file downloads are not imported"));
                    continue;
                }
                let Some(v) = me.providers.modrinth_version_from_hash(&js::string(&f["hashes"]["sha1"])) else {
                    unresolved.push(format!("{path}: not found on Modrinth by hash"));
                    continue;
                };
                let env = f.get("env").filter(|e| !e.is_null());
                let environment = if env.is_some_and(|e| e["client"] == "unsupported") {
                    "server"
                } else if env.is_some_and(|e| e["server"] == "unsupported") {
                    "client"
                } else {
                    "both"
                };
                mods.push(json!({ "source": "modrinth", "projectId": v["project_id"], "versionId": v["id"], "title": fname, "required": true, "usage": "runtime", "environment": environment }));
            }
            fs::create_dir_all(&dest_c).map_err(|e| js::fs_error(&e, "mkdir", &dest_c))?;
            let overrides_dir = dest_c.join("profiles").join("pack").join("overrides");
            let overrides = write_overrides(&entries, &["overrides/", "client-overrides/"], &overrides_dir)?;
            let has_config = overrides_dir.join("config").exists();
            let mut profile = Map::new();
            profile.insert("id".into(), json!("pack-client"));
            profile.insert("name".into(), json!(format!("{} client", js::string(&index["name"]))));
            profile.insert("side".into(), json!("client"));
            profile.insert("includeSourceMod".into(), json!(false));
            profile.insert("mods".into(), Value::Array(mods.clone()));
            if has_config {
                profile.insert("configDir".into(), json!("profiles/pack/overrides/config"));
            }
            let profile = parse_with("profile", &Value::Object(profile))?;
            let mut platform = Map::new();
            platform.insert("loader".into(), json!(loader));
            platform.insert("minecraft".into(), json!(mc));
            if let Some(lv) = loader_version {
                platform.insert("loaderVersion".into(), lv);
            }
            if let Some(e) = &entry {
                platform.insert("catalogEntry".into(), e.clone());
            }
            let manifest = parse_with("manifest", &json!({ "schemaVersion": 1, "name": name.clone().map(Value::String).unwrap_or_else(|| index["name"].clone()), "type": "modpack", "platform": platform, "source": { "kind": "none", "root": "." }, "dependencies": [], "profiles": [profile], "createdBy": format!("{} {} (mrpack import)", crate::api::api().product, crate::api::api().version) }))?;
            let path = me.finish_import(&dest_c, &manifest)?;
            ctx.log(&format!("Imported {} mods, {overrides} override files; {} unresolved", mods.len(), unresolved.len()));
            for u in &unresolved {
                ctx.log(&format!("[warning] {u}"));
            }
            Ok(Some(json!({ "path": path, "mods": mods.len(), "overrides": overrides, "unresolved": unresolved, "catalogEntry": entry.unwrap_or(Value::Null) })))
        }))
    }

    pub fn import_curseforge(self: &Arc<Self>, catalog: Arc<Catalog>, file: &str, destination: &str, name: Option<String>) -> Result<Value, String> {
        let dest = js::absolute(destination);
        if let Some(err) = validate_destination(&s(&dest)) {
            return Err(err);
        }
        let me = self.clone();
        let file = file.to_string();
        let base = Path::new(&file).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let dest_c = dest.clone();
        Ok(self.ops.start("modpack.import", &format!("Import {base}"), Some(s(&dest)), move |ctx| {
            let entries = read_zip(&fs::read(&file).map_err(|e| js::fs_error(&e, "open", Path::new(&file)))?)?;
            let raw = entries.iter().find(|(n, _)| n == "manifest.json").map(|(_, d)| d).ok_or("Not a CurseForge modpack: manifest.json is missing")?;
            let cf = parse_with("cfManifest", &serde_json::from_str::<Value>(&String::from_utf8_lossy(raw)).map_err(|e| e.to_string())?)?;
            let loaders = cf["minecraft"]["modLoaders"].as_array().cloned().unwrap_or_default();
            let primary = loaders.iter().find(|l| l["primary"] == true).or(loaders.first());
            let id = primary.map(|p| js::string(&p["id"])).unwrap_or_default();
            let caps = regex::Regex::new(r"^(fabric|neoforge|forge|quilt)-(.+)$").unwrap().captures(&id).map(|c| (c[1].to_string(), c[2].to_string()));
            let Some((loader, loader_version)) = caps else { return Err(format!("Unsupported mod loader {}", if id.is_empty() { "(none)".to_string() } else { id })) };
            if !["fabric", "neoforge", "forge"].contains(&loader.as_str()) {
                return Err(format!("{loader} is not a supported loader"));
            }
            let mc = js::string(&cf["minecraft"]["version"]);
            let entry = select_entry(&catalog, &loader, &mc).map(|e| e["id"].clone());
            let mut titles: Vec<(i64, Value)> = Vec::new();
            let files = cf["files"].as_array().cloned().unwrap_or_default();
            if me.providers.cf_configured() {
                match me.providers.cf_mods(&files.iter().map(|f| f["projectID"].as_i64().unwrap_or(0)).collect::<Vec<_>>()) {
                    Ok(list) => {
                        for m in list {
                            titles.push((m["id"].as_i64().unwrap_or(0), m["name"].clone()));
                        }
                    }
                    Err(e) => ctx.log(&format!("[warning] Could not fetch CurseForge project names: {e}")),
                }
            } else {
                ctx.log("[info] No CurseForge API key configured; mods were imported by id. Resolution needs an API key.");
            }
            let mods: Vec<Value> = files
                .iter()
                .map(|f| {
                    let pid = f["projectID"].as_i64().unwrap_or(0);
                    let title = titles.iter().rev().find(|t| t.0 == pid).map(|t| t.1.clone()).unwrap_or_else(|| json!(format!("CurseForge {pid}")));
                    json!({ "source": "curseforge", "projectId": pid.to_string(), "fileId": js::string(&f["fileID"]), "title": title, "required": f["required"] != false, "usage": "runtime", "environment": "both" })
                })
                .collect();
            fs::create_dir_all(&dest_c).map_err(|e| js::fs_error(&e, "mkdir", &dest_c))?;
            let overrides_dir = dest_c.join("profiles").join("pack").join("overrides");
            let prefix = format!("{}/", cf.get("overrides").filter(|v| !v.is_null()).map(js::string).unwrap_or_else(|| "overrides".into()));
            let overrides = write_overrides(&entries, &[&prefix], &overrides_dir)?;
            let has_config = overrides_dir.join("config").exists();
            let mut profile = Map::new();
            profile.insert("id".into(), json!("pack-client"));
            profile.insert("name".into(), json!(format!("{} client", js::string(&cf["name"]))));
            profile.insert("side".into(), json!("client"));
            profile.insert("includeSourceMod".into(), json!(false));
            profile.insert("mods".into(), Value::Array(mods.clone()));
            if has_config {
                profile.insert("configDir".into(), json!("profiles/pack/overrides/config"));
            }
            let profile = parse_with("profile", &Value::Object(profile))?;
            let mut platform = Map::new();
            platform.insert("loader".into(), json!(loader));
            platform.insert("minecraft".into(), json!(mc));
            platform.insert("loaderVersion".into(), json!(loader_version));
            if let Some(e) = &entry {
                platform.insert("catalogEntry".into(), e.clone());
            }
            let manifest = parse_with("manifest", &json!({ "schemaVersion": 1, "name": name.clone().map(Value::String).unwrap_or_else(|| cf["name"].clone()), "type": "modpack", "platform": platform, "source": { "kind": "none", "root": "." }, "dependencies": [], "profiles": [profile], "createdBy": format!("{} {} (CurseForge import)", crate::api::api().product, crate::api::api().version) }))?;
            let path = me.finish_import(&dest_c, &manifest)?;
            ctx.log(&format!("Imported {} CurseForge mods and {overrides} override files", mods.len()));
            Ok(Some(json!({ "path": path, "mods": mods.len(), "overrides": overrides, "catalogEntry": entry.unwrap_or(Value::Null) })))
        }))
    }

    fn export_common(root: &str, profile_id: &str) -> Result<(PathBuf, Value, Value, Value), String> {
        let dir = crate::workspace::normalize(root);
        let m = manifest::require_manifest(&dir, root)?;
        let profile = m["profiles"].as_array().and_then(|l| l.iter().find(|p| p["id"] == profile_id)).cloned().ok_or_else(|| format!("Unknown profile {profile_id}"))?;
        let lock = manifest::read_lock(&dir)?;
        let lp = lock["profiles"].get(profile_id).cloned().ok_or_else(|| format!("Resolve profile {profile_id} before exporting"))?;
        Ok((dir, m, profile, lp))
    }

    fn write_out(output: &str, ext: &str, files: &[(String, Vec<u8>)]) -> Result<String, String> {
        let name = if output.ends_with(ext) { output.to_string() } else { format!("{output}{ext}") };
        let out = js::absolute(&name);
        if let Some(d) = out.parent() {
            fs::create_dir_all(d).map_err(|e| js::fs_error(&e, "mkdir", d))?;
        }
        fs::write(&out, zip_bytes(files)?).map_err(|e| js::fs_error(&e, "open", &out))?;
        Ok(s(&out))
    }

    pub fn export_curseforge(&self, root: &str, profile_id: &str, output: &str, version: &str) -> Result<Value, String> {
        let (dir, m, profile, lp) = Self::export_common(root, profile_id)?;
        let mut files = Vec::new();
        let mut manual = Vec::new();
        for e in lp["entries"].as_array().cloned().unwrap_or_default() {
            if e["provider"] == "bridge" {
                continue;
            }
            if e["provider"] == "curseforge" && js::truthy(e.get("projectId")) && js::truthy(e.get("versionId")) {
                let num = |v: &Value| js::string(v).parse::<f64>().map(|n| json!(n as i64)).unwrap_or(Value::Null);
                files.push(json!({ "projectID": num(&e["projectId"]), "fileID": num(&e["versionId"]), "required": e["required"] }));
            } else {
                manual.push(format!(
                    "{} ({}, {}): CurseForge manifests can only reference CurseForge files. It was not embedded because redistribution rights are unknown; players must add it manually.",
                    js::string(&e["title"]),
                    js::string(&e["fileName"]),
                    js::string(&e["provider"])
                ));
            }
        }
        let cf = json!({
            "minecraft": { "version": m["platform"]["minecraft"], "modLoaders": [{ "id": format!("{}-{}", js::string(&m["platform"]["loader"]), js::string(&m["platform"]["loaderVersion"])), "primary": true }] },
            "manifestType": "minecraftModpack",
            "manifestVersion": 1,
            "name": m["name"],
            "version": version,
            "author": "",
            "files": files,
            "overrides": "overrides"
        });
        parse_with("cfManifest", &cf)?;
        let mut zip = vec![("manifest.json".to_string(), js::pretty(&cf).into_bytes())];
        config_overrides(&dir, &profile, &mut zip);
        let file = Self::write_out(output, ".zip", &zip)?;
        Ok(json!({ "file": file, "files": files.len(), "manualSteps": manual }))
    }

    pub fn export_mrpack(&self, root: &str, profile_id: &str, output: &str, version: &str) -> Result<Value, String> {
        let (dir, m, profile, lp) = Self::export_common(root, profile_id)?;
        let loader = js::string(&m["platform"]["loader"]);
        let loader_key = if loader == "fabric" { "fabric-loader".to_string() } else { loader };
        let mut files = Vec::new();
        let mut manual = Vec::new();
        for e in lp["entries"].as_array().cloned().unwrap_or_default() {
            if e["provider"] == "bridge" {
                continue;
            }
            if e["provider"] == "modrinth" && ["url", "sha1", "sha512", "size"].iter().all(|k| js::truthy(e.get(*k))) {
                let mut f = Map::new();
                f.insert("path".into(), json!(format!("mods/{}", js::string(&e["fileName"]))));
                f.insert("hashes".into(), json!({ "sha1": e["sha1"], "sha512": e["sha512"] }));
                if let Some(env) = e.get("environment").filter(|v| js::truthy(Some(v))) {
                    let side = |k: &str| if env.get(k) == Some(&json!("unsupported")) { "unsupported" } else { "required" };
                    f.insert("env".into(), json!({ "client": side("client"), "server": side("server") }));
                }
                f.insert("downloads".into(), json!([e["url"]]));
                f.insert("fileSize".into(), e["size"].clone());
                files.push(Value::Object(f));
            } else {
                manual.push(format!(
                    "{} ({}): not hosted on Modrinth; it was not embedded because redistribution rights are unknown. Obtain it from its original source and place it in mods/.",
                    js::string(&e["title"]),
                    js::string(&e["fileName"])
                ));
            }
        }
        let mut deps = Map::new();
        deps.insert("minecraft".into(), m["platform"]["minecraft"].clone());
        deps.insert(loader_key, m["platform"]["loaderVersion"].clone());
        let index = json!({ "formatVersion": 1, "game": "minecraft", "versionId": version, "name": m["name"], "summary": format!("Exported by Modsmith from profile {profile_id}"), "files": files, "dependencies": deps });
        parse_with("mrpackIndex", &index)?;
        let mut zip = vec![("modrinth.index.json".to_string(), js::pretty(&index).into_bytes())];
        config_overrides(&dir, &profile, &mut zip);
        let file = Self::write_out(output, ".mrpack", &zip)?;
        Ok(json!({ "file": file, "files": files.len(), "manualSteps": manual }))
    }
}
