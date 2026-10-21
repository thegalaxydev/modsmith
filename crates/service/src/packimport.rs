use crate::http::{download_verified, Expected};
use crate::js;
use crate::manifest;
use crate::ops::OpCtx;
use crate::profiles::{parse_with, Profiles};
use crate::providers::{cf_distributable, cf_file_page, cf_sha1, pick_cf_file, pick_version, CLASS_MODPACKS};
use crate::resolver::{describe_ref, primary_file};
use serde_json::{json, Map, Value};
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub struct MrFile {
    pub path: String,
    pub sha1: String,
    pub sha512: Option<String>,
    pub size: Option<u64>,
    pub downloads: Vec<String>,
    pub environment: &'static str,
    pub supported: bool,
}

pub struct ParsedPack {
    pub format: &'static str,
    pub name: String,
    pub version: Option<String>,
    pub minecraft: String,
    pub loader: String,
    pub loader_version: Option<String>,
    pub mr_files: Vec<MrFile>,
    pub cf_files: Vec<(i64, i64, bool)>,
    pub overrides: Vec<(String, Vec<u8>)>,
}

pub fn read_zip(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let mut out: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().map(|n| n.to_string()).map_err(|e| e.to_string())?;
        let mut data = Vec::new();
        entry.read_to_end(&mut data).map_err(|e| e.to_string())?;
        match out.iter_mut().find(|(n, _)| *n == name) {
            Some(slot) => slot.1 = data,
            None => out.push((name, data)),
        }
    }
    Ok(out)
}

fn entry<'a>(entries: &'a [(String, Vec<u8>)], name: &str) -> Option<&'a Vec<u8>> {
    entries.iter().find(|(n, _)| n == name).map(|(_, d)| d)
}

fn take(entries: &[(String, Vec<u8>)], prefix: &str, overrides: &mut Vec<(String, Vec<u8>)>) {
    for (p, data) in entries {
        if p.starts_with(prefix) && !p.ends_with('/') && p.len() > prefix.len() {
            let rel = p[prefix.len()..].to_string();
            match overrides.iter_mut().find(|(k, _)| *k == rel) {
                Some(slot) => slot.1 = data.clone(),
                None => overrides.push((rel, data.clone())),
            }
        }
    }
}

fn st(v: &Value, k: &str) -> Option<String> {
    v.get(k).filter(|x| !x.is_null()).map(js::string)
}

pub fn parse_pack_archive(bytes: &[u8], side: &str) -> Result<ParsedPack, String> {
    let entries = read_zip(bytes)?;
    let mut overrides = Vec::new();
    if let Some(raw) = entry(&entries, "modrinth.index.json") {
        let index = parse_with("mrIndex", &serde_json::from_str::<Value>(&String::from_utf8_lossy(raw)).map_err(|e| e.to_string())?)?;
        let deps = &index["dependencies"];
        let has = |k: &str| deps.get(k).is_some_and(|v| js::truthy(Some(v)));
        let loader = if has("fabric-loader") {
            "fabric"
        } else if has("neoforge") {
            "neoforge"
        } else if has("forge") {
            "forge"
        } else if has("quilt-loader") {
            "quilt"
        } else {
            ""
        };
        if !has("minecraft") || loader.is_empty() {
            return Err("The pack does not declare a Minecraft version and a mod loader".into());
        }
        take(&entries, "overrides/", &mut overrides);
        take(&entries, if side == "client" { "client-overrides/" } else { "server-overrides/" }, &mut overrides);
        let loader_version = ["fabric-loader", "neoforge", "forge", "quilt-loader"].iter().find_map(|k| deps.get(*k).filter(|v| !v.is_null()).map(js::string));
        let mr_files = index["files"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|f| {
                let env = f.get("env").filter(|e| !e.is_null());
                let environment = if env.is_some_and(|e| e["client"] == "unsupported") {
                    "server"
                } else if env.is_some_and(|e| e["server"] == "unsupported") {
                    "client"
                } else {
                    "both"
                };
                MrFile {
                    path: js::string(&f["path"]).replace('\\', "/"),
                    sha1: js::string(&f["hashes"]["sha1"]).to_lowercase(),
                    sha512: st(&f["hashes"], "sha512"),
                    size: f["fileSize"].as_f64().map(|n| n as u64),
                    downloads: f["downloads"].as_array().into_iter().flatten().map(js::string).collect(),
                    environment,
                    supported: env.is_none_or(|e| e[side] != "unsupported"),
                }
            })
            .collect();
        return Ok(ParsedPack {
            format: "mrpack",
            name: js::string(&index["name"]),
            version: st(&index, "versionId"),
            minecraft: js::string(&deps["minecraft"]),
            loader: loader.into(),
            loader_version,
            mr_files,
            cf_files: vec![],
            overrides,
        });
    }
    if let Some(raw) = entry(&entries, "manifest.json") {
        let m = parse_with("cfManifest", &serde_json::from_str::<Value>(&String::from_utf8_lossy(raw)).map_err(|e| e.to_string())?)?;
        let loaders = m["minecraft"]["modLoaders"].as_array().cloned().unwrap_or_default();
        let primary = loaders.iter().find(|l| l["primary"] == true).or(loaders.first());
        let id = primary.map(|p| js::string(&p["id"])).unwrap_or_default();
        let caps = regex::Regex::new(r"^(fabric|neoforge|forge|quilt)-(.+)$").unwrap().captures(&id).map(|c| (c[1].to_string(), c[2].to_string()));
        let Some((loader, version)) = caps else {
            return Err(format!("Unsupported mod loader {}", if id.is_empty() { "(none)".to_string() } else { id }));
        };
        let prefix = format!("{}/", st(&m, "overrides").unwrap_or_else(|| "overrides".into()));
        take(&entries, &prefix, &mut overrides);
        let cf_files = m["files"].as_array().into_iter().flatten().map(|f| (f["projectID"].as_i64().unwrap_or(0), f["fileID"].as_i64().unwrap_or(0), f["required"] != false)).collect();
        return Ok(ParsedPack {
            format: "curseforge",
            name: js::string(&m["name"]),
            version: st(&m, "version"),
            minecraft: js::string(&m["minecraft"]["version"]),
            loader,
            loader_version: Some(version),
            mr_files: vec![],
            cf_files,
            overrides,
        });
    }
    Err("Not a modpack: expected modrinth.index.json (Modrinth .mrpack) or manifest.json (CurseForge .zip)".into())
}

pub fn slug_id(name: &str) -> String {
    let lower = name.to_lowercase();
    let replaced = regex::Regex::new(r"[^a-z0-9]+").unwrap().replace_all(&lower, "-").to_string();
    let trimmed = replaced.trim_matches('-');
    let cut: String = trimmed.chars().take(40).collect();
    if cut.is_empty() {
        "pack".into()
    } else {
        cut
    }
}

struct Archive {
    bytes: Vec<u8>,
    provider: &'static str,
    project: Option<String>,
    version: Option<String>,
    version_name: Option<String>,
}

fn s(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

fn basename(p: &str) -> String {
    Path::new(p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

impl Profiles {
    fn fetch_archive(&self, m: &Value, input: &Value, ctx: &OpCtx) -> Result<Archive, String> {
        let loader = js::string(&m["platform"]["loader"]);
        let minecraft = js::string(&m["platform"]["minecraft"]);
        let cancelled = || ctx.cancelled();
        if let Some(file) = input.get("file").and_then(Value::as_str) {
            return Ok(Archive { bytes: fs::read(file).map_err(|e| js::fs_error(&e, "open", Path::new(file)))?, provider: "file", project: None, version: None, version_name: None });
        }
        if let Some(mr) = input.get("modrinth").filter(|v| js::truthy(Some(v))) {
            let project = self.providers.modrinth_project(&js::string(&mr["project"]))?;
            let title = js::string(&project["title"]);
            if project["project_type"] != "modpack" {
                return Err(format!("{title} is a {} on Modrinth, not a modpack", js::string(&project["project_type"])));
            }
            let version = match mr.get("version").filter(|v| js::truthy(Some(v))) {
                Some(v) => Some(self.providers.modrinth_version(&js::string(v))?),
                None => {
                    let all = self.providers.modrinth_versions(&js::string(&project["id"]), Some(&loader), Some(&minecraft))?;
                    pick_version(all.as_array().map(Vec::as_slice).unwrap_or(&[]), &loader, &minecraft).cloned()
                }
            };
            let version = version.ok_or_else(|| format!("{title} has no version for Minecraft {minecraft} with {loader}"))?;
            let file = version["files"].as_array().and_then(|f| f.iter().find(|x| x["filename"].as_str().is_some_and(|n| n.ends_with(".mrpack")))).cloned().or_else(|| primary_file(&version));
            let file = file.ok_or_else(|| format!("{title} {} has no .mrpack file", js::string(&version["version_number"])))?;
            ctx.log(&format!("Downloading {title} {}", js::string(&version["version_number"])));
            let sha1 = js::string(&file["hashes"]["sha1"]);
            let dest = self.cache.join("downloads").join("modpacks").join("modrinth").join(&sha1).join(js::string(&file["filename"]));
            let sha512 = st(&file["hashes"], "sha512");
            let (path, _) =
                download_verified(&js::string(&file["url"]), &dest, &Expected { sha1: Some(&sha1), sha256: None, sha512: sha512.as_deref(), size: file["size"].as_u64() }, &cancelled, &|_, _| {})?;
            return Ok(Archive {
                bytes: fs::read(&path).map_err(|e| js::fs_error(&e, "open", &path))?,
                provider: "modrinth",
                project: st(&project, "id"),
                version: st(&version, "id"),
                version_name: st(&version, "version_number"),
            });
        }
        let cfin = &input["curseforge"];
        let mod_ = self.providers.cf_mod(&js::string(&cfin["project"]))?;
        let name = js::string(&mod_["name"]);
        if mod_.get("classId").is_some_and(|c| !c.is_null()) && mod_["classId"] != CLASS_MODPACKS {
            return Err(format!("{name} is not a CurseForge modpack"));
        }
        let mod_id = js::string(&mod_["id"]);
        let file = match cfin.get("file").filter(|v| js::truthy(Some(v))) {
            Some(f) => Some(self.providers.cf_file(&mod_id, &js::string(f))?),
            None => pick_cf_file(&self.providers.cf_files(&mod_id, Some(&loader), Some(&minecraft))?, &loader, &minecraft).cloned(),
        };
        let file = file.ok_or_else(|| format!("{name} has no file for Minecraft {minecraft} with {loader}"))?;
        let sha1 = cf_sha1(&file);
        let file_name = js::string(&file["fileName"]);
        if !cf_distributable(&mod_, &file) || !js::truthy(file.get("downloadUrl")) {
            return Err(format!("The author of {name} does not allow downloads through the API. Download {file_name} from {} and import the file instead.", cf_file_page(Some(&mod_), &file)));
        }
        let Some(sha1) = sha1.filter(|s| !s.is_empty()) else { return Err(format!("{file_name} has no published SHA-1; refusing to download it unverified")) };
        ctx.log(&format!("Downloading {name} {}", js::string(&file["displayName"])));
        let dest = self.cache.join("downloads").join("modpacks").join("curseforge").join(&sha1).join(&file_name);
        let (path, _) =
            download_verified(&js::string(&file["downloadUrl"]), &dest, &Expected { sha1: Some(&sha1), sha256: None, sha512: None, size: file["fileLength"].as_u64() }, &cancelled, &|_, _| {})?;
        Ok(Archive {
            bytes: fs::read(&path).map_err(|e| js::fs_error(&e, "open", &path))?,
            provider: "curseforge",
            project: Some(mod_id),
            version: Some(js::string(&file["id"])),
            version_name: st(&file, "displayName"),
        })
    }

    fn import_run(&self, dir: &Path, mut m: Value, input: &Value, ctx: &OpCtx) -> Result<Value, String> {
        let archive = self.fetch_archive(&m, input, ctx)?;
        let profile_id = js::string(&input["profile"]);
        let existing = m["profiles"].as_array().and_then(|l| l.iter().find(|p| p["id"] == profile_id.as_str())).cloned();
        let side = existing.as_ref().and_then(|p| st(p, "side")).or_else(|| st(input, "side")).unwrap_or_else(|| "client".into());
        let pack = parse_pack_archive(&archive.bytes, &side)?;
        let mc = js::string(&m["platform"]["minecraft"]);
        let loader = js::string(&m["platform"]["loader"]);
        if pack.minecraft != mc {
            return Err(format!("{} is for Minecraft {}; this project uses {mc}", pack.name, pack.minecraft));
        }
        if pack.loader != loader {
            return Err(format!("{} uses {}; this project uses {loader}", pack.name, pack.loader));
        }
        ctx.log(
            format!(
                "{}{}: Minecraft {}, {} {}",
                pack.name,
                pack.version.as_ref().filter(|v| !v.is_empty()).map(|v| format!(" {v}")).unwrap_or_default(),
                pack.minecraft,
                pack.loader,
                pack.loader_version.clone().unwrap_or_default()
            )
            .trim(),
        );
        let mut profile = match &existing {
            Some(p) => p.clone(),
            None => parse_with(
                "profile",
                &json!({ "id": profile_id, "name": st(input, "name").unwrap_or_else(|| format!("{} test", pack.name)), "side": side, "includeSourceMod": m["source"]["kind"] == "gradle" }),
            )?,
        };
        let pid = js::string(&profile["id"]);
        let mut warnings: Vec<String> = Vec::new();
        let mut manual: Vec<String> = Vec::new();
        let mut refs: Vec<Value> = Vec::new();
        let overrides_rel = format!("profiles/{pid}/packs/{}", slug_id(&pack.name));
        let overrides_abs = js::resolve_within(dir, &overrides_rel)?;
        let mut local_files = 0;
        if pack.format == "mrpack" {
            let files: Vec<&MrFile> = pack.mr_files.iter().filter(|f| f.supported).collect();
            let mod_re = regex::Regex::new(r"(?i)^mods/[^/]+\.jar$").unwrap();
            let mods: Vec<&MrFile> = files.iter().copied().filter(|f| mod_re.is_match(&f.path)).collect();
            ctx.progress(Some(0.2), Some(&format!("Identifying {} mods on Modrinth", mods.len())));
            let found = if mods.is_empty() { Map::new() } else { self.providers.modrinth_versions_from_hashes(&mods.iter().map(|f| f.sha1.clone()).collect::<Vec<_>>())? };
            let mut project_ids: Vec<String> = Vec::new();
            for v in found.values() {
                let p = js::string(&v["project_id"]);
                if !project_ids.contains(&p) {
                    project_ids.push(p);
                }
            }
            let mut titles: Vec<(String, Value)> = Vec::new();
            match self.providers.modrinth_projects(&project_ids) {
                Ok(list) => {
                    for p in list {
                        titles.push((js::string(&p["id"]), p["title"].clone()));
                    }
                }
                Err(e) => warnings.push(format!("Could not fetch Modrinth project names: {e}")),
            }
            let title_of = |id: &str| titles.iter().rev().find(|(k, _)| k == id).map(|(_, t)| t.clone());
            let is_mod = |f: &MrFile| mods.iter().any(|m| std::ptr::eq(*m, f));
            let other: Vec<&MrFile> = files.iter().copied().filter(|f| !found.contains_key(&f.sha1) || !is_mod(f)).collect();
            for f in &mods {
                if let Some(v) = found.get(&f.sha1) {
                    let pid_ = js::string(&v["project_id"]);
                    refs.push(json!({ "source": "modrinth", "projectId": pid_, "versionId": v["id"], "title": title_of(&pid_).unwrap_or_else(|| json!(basename(&f.path))), "required": true, "usage": "runtime", "environment": f.environment, "from": pack.name }));
                }
            }
            let total = other.len().max(1) as f64;
            for (i, f) in other.iter().enumerate() {
                ctx.check()?;
                ctx.progress(Some(0.4 + (0.3 * i as f64) / total), Some(&format!("Downloading {}", basename(&f.path))));
                let dest = js::resolve_within(&overrides_abs, &f.path)?;
                let cached = self.cache.join("downloads").join("modpacks").join("files").join(&f.sha1).join(basename(&f.path));
                let cancelled = || ctx.cancelled();
                let res = download_verified(
                    f.downloads.first().map(String::as_str).unwrap_or(""),
                    &cached,
                    &Expected { sha1: Some(&f.sha1), sha256: None, sha512: f.sha512.as_deref(), size: f.size },
                    &cancelled,
                    &|_, _| {},
                )
                .and_then(|(got, _)| {
                    if let Some(d) = dest.parent() {
                        fs::create_dir_all(d).map_err(|e| js::fs_error(&e, "mkdir", d))?;
                    }
                    fs::copy(&got, &dest).map(|_| ()).map_err(|e| js::fs_error(&e, "copyfile", &got))
                });
                match res {
                    Ok(()) => local_files += 1,
                    Err(e) => warnings.push(format!("{}: {e}", f.path)),
                }
            }
        } else {
            let mut titles: Vec<(i64, String, bool, Option<String>)> = Vec::new();
            if self.providers.cf_configured() {
                match self.providers.cf_mods(&pack.cf_files.iter().map(|f| f.0).collect::<Vec<_>>()) {
                    Ok(list) => {
                        for md in list {
                            titles.push((
                                md["id"].as_i64().unwrap_or(0),
                                js::string(&md["name"]),
                                md.get("allowModDistribution") != Some(&Value::Bool(false)),
                                md.get("links").and_then(|l| l.get("websiteUrl")).filter(|v| !v.is_null()).map(js::string),
                            ));
                        }
                    }
                    Err(e) => warnings.push(format!("Could not fetch CurseForge project names: {e}")),
                }
            } else {
                warnings.push("No CurseForge API key is configured. The mods were added by id; checking and launching this profile needs a key (Settings > Providers).".into());
            }
            for (project, file, required) in &pack.cf_files {
                let t = titles.iter().rev().find(|t| t.0 == *project);
                if let Some(t) = t.filter(|t| !t.2) {
                    manual.push(format!("{}: the author only allows downloads from CurseForge{}", t.1, t.3.as_ref().filter(|p| !p.is_empty()).map(|p| format!(" ({p})")).unwrap_or_default()));
                }
                refs.push(json!({ "source": "curseforge", "projectId": project.to_string(), "fileId": file.to_string(), "title": t.map(|t| t.1.clone()).unwrap_or_else(|| format!("CurseForge {project}")), "required": required, "usage": "runtime", "environment": "both", "from": pack.name }));
            }
        }
        ctx.progress(Some(0.75), Some("Writing pack overrides"));
        let mut overrides = 0;
        for (rel, data) in &pack.overrides {
            let out = js::resolve_within(&overrides_abs, rel)?;
            if let Some(d) = out.parent() {
                fs::create_dir_all(d).map_err(|e| js::fs_error(&e, "mkdir", d))?;
            }
            fs::write(&out, data).map_err(|e| js::fs_error(&e, "open", &out))?;
            overrides += 1;
        }
        let mods_dir = overrides_abs.join("mods");
        if mods_dir.exists() {
            for e in fs::read_dir(&mods_dir).map_err(|e| js::fs_error(&e, "scandir", &mods_dir))?.flatten() {
                let f = e.file_name().to_string_lossy().to_string();
                if f.to_lowercase().ends_with(".jar") {
                    refs.push(json!({ "source": "local", "path": format!("{overrides_rel}/mods/{f}"), "title": f, "required": true, "usage": "runtime", "environment": "both", "from": pack.name }));
                }
            }
        }
        let mods = profile["mods"].as_array().cloned().unwrap_or_default();
        let previous = mods.iter().filter(|x| x["from"] == pack.name.as_str()).count();
        let kept: Vec<Value> = mods.into_iter().filter(|x| x["from"] != pack.name.as_str()).collect();
        let mut keys: Vec<String> = kept.iter().map(describe_ref).collect();
        let kept_projects: Vec<(String, Option<Value>)> = kept
            .iter()
            .filter(|x| x["source"] == "modrinth" || x["source"] == "curseforge")
            .map(|x| (format!("{}:{}", js::string(&x["source"]), js::string(&x["projectId"])), x.get("title").filter(|t| !t.is_null()).cloned()))
            .collect();
        let mut skipped: Vec<String> = Vec::new();
        let mut added: Vec<Value> = Vec::new();
        for r in refs {
            let project = if r["source"] == "modrinth" || r["source"] == "curseforge" { Some(format!("{}:{}", js::string(&r["source"]), js::string(&r["projectId"]))) } else { None };
            let kept_title = project.as_ref().and_then(|p| kept_projects.iter().rev().find(|(k, _)| k == p));
            if keys.contains(&describe_ref(&r)) || kept_title.is_some() {
                let label = kept_title.and_then(|(_, t)| t.clone()).map(|t| js::string(&t)).or_else(|| r.get("title").filter(|t| !t.is_null()).map(js::string)).unwrap_or_else(|| describe_ref(&r));
                skipped.push(format!("{label} is already in the profile"));
                continue;
            }
            keys.push(describe_ref(&r));
            added.push(r);
        }
        let mut all_mods = kept;
        all_mods.extend(added.iter().cloned());
        profile["mods"] = Value::Array(all_mods);
        let prefix = format!("{overrides_rel}/");
        let mut scripts: Vec<Value> = profile["scripts"].as_array().cloned().unwrap_or_default().into_iter().filter(|x| !js::string(x).starts_with(&prefix)).collect();
        let mut packs: Vec<Value> = profile["resourcePacks"].as_array().cloned().unwrap_or_default().into_iter().filter(|x| !js::string(x).starts_with(&prefix)).collect();
        if overrides_abs.exists() {
            for e in fs::read_dir(&overrides_abs).map_err(|e| js::fs_error(&e, "scandir", &overrides_abs))?.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                if name == "mods" {
                    continue;
                }
                if name == "config" && is_dir {
                    let current = profile.get("configDir").filter(|v| js::truthy(Some(v))).map(js::string);
                    match current {
                        Some(c) if !c.starts_with(&format!("profiles/{pid}/packs/")) => {
                            warnings.push(format!("The profile already uses {c} for config files; the pack config is in {overrides_rel}/config"))
                        }
                        _ => profile["configDir"] = json!(format!("{overrides_rel}/config")),
                    }
                    continue;
                }
                if name == "resourcepacks" && is_dir {
                    for rp in fs::read_dir(overrides_abs.join("resourcepacks")).map_err(|e| e.to_string())?.flatten() {
                        packs.push(json!(format!("{overrides_rel}/resourcepacks/{}", rp.file_name().to_string_lossy())));
                    }
                    continue;
                }
                scripts.push(json!(format!("{overrides_rel}/{name}")));
            }
        }
        profile["scripts"] = Value::Array(scripts);
        profile["resourcePacks"] = Value::Array(packs);
        let mut imports: Vec<Value> = profile["imports"].as_array().cloned().unwrap_or_default().into_iter().filter(|i| i["name"] != pack.name.as_str()).collect();
        let mut rec = Map::new();
        rec.insert("name".into(), json!(pack.name));
        rec.insert("provider".into(), json!(archive.provider));
        if let Some(p) = &archive.project {
            rec.insert("project".into(), json!(p));
        }
        if let Some(v) = &archive.version {
            rec.insert("version".into(), json!(v));
        }
        if let Some(v) = archive.version_name.clone().or(pack.version.clone()) {
            rec.insert("versionName".into(), json!(v));
        }
        rec.insert("overrides".into(), json!(overrides_rel));
        rec.insert("importedAt".into(), json!(humantime::format_rfc3339_millis(std::time::SystemTime::now()).to_string()));
        imports.push(Value::Object(rec));
        profile["imports"] = Value::Array(imports);
        let next = parse_with("profile", &profile)?;
        let list = m["profiles"].as_array_mut().ok_or("profiles missing")?;
        match list.iter().position(|p| p["id"] == next["id"]) {
            Some(i) if existing.is_some() => list[i] = next.clone(),
            _ => list.push(next.clone()),
        }
        manifest::write_manifest(dir, &m)?;
        self.ops.emit_event("workspace.changed", json!({ "workspace": s(dir) }));
        ctx.log(&format!(
            "Added {} mods from {}{}; {} already present; {overrides} override files",
            added.len(),
            pack.name,
            if previous > 0 { format!(" (replacing {previous} from an earlier import)") } else { String::new() },
            skipped.len()
        ));
        for w in &warnings {
            ctx.log(&format!("[warning] {w}"));
        }
        for x in &manual {
            ctx.log(&format!("[info] {x}"));
        }
        Ok(
            json!({ "profile": next["id"], "pack": pack.name, "version": archive.version_name.or(pack.version), "added": added.len(), "replaced": previous, "skipped": skipped, "localFiles": local_files, "overrides": overrides, "manual": manual, "warnings": warnings }),
        )
    }

    pub fn import_into_profile(self: &Arc<Self>, root: &str, input: &Value) -> Result<Value, String> {
        let dir = workspace_dir(root);
        let m = manifest::require_manifest(&dir, &s(&dir))?;
        let sources = ["file", "modrinth", "curseforge"].iter().filter(|k| js::truthy(input.get(**k))).count();
        if sources != 1 {
            return Err("Give exactly one of file, modrinth or curseforge".into());
        }
        if let Some(f) = input.get("file").and_then(Value::as_str).filter(|f| !f.is_empty()) {
            if !Path::new(f).exists() {
                return Err(format!("File not found: {f}"));
            }
        }
        if js::truthy(input.get("curseforge")) && !self.providers.cf_configured() {
            return Err("Importing from CurseForge needs a CurseForge API key (Settings > Providers)".into());
        }
        let label = match input.get("file").and_then(Value::as_str).filter(|f| !f.is_empty()) {
            Some(f) => basename(f),
            None if js::truthy(input.get("modrinth")) => format!("Modrinth {}", js::string(&input["modrinth"]["project"])),
            None => format!("CurseForge {}", js::string(&input["curseforge"]["project"])),
        };
        let me = self.clone();
        let input = input.clone();
        let dir_c = dir.clone();
        Ok(self.ops.start("profile.import_pack", &format!("Import {label} into a test profile"), Some(s(&dir)), move |ctx| me.import_run(&dir_c, m, &input, ctx).map(Some)))
    }

    pub fn remove_imported(&self, root: &str, profile_id: &str, pack_name: &str) -> Result<(Value, crate::profiles::Events), String> {
        let dir = workspace_dir(root);
        let mut m = manifest::require_manifest(&dir, &s(&dir))?;
        let list = m["profiles"].as_array_mut().ok_or("profiles missing")?;
        let profile = list.iter_mut().find(|p| p["id"] == profile_id).ok_or_else(|| format!("Unknown profile {profile_id}"))?;
        let record = profile["imports"].as_array().and_then(|l| l.iter().find(|i| i["name"] == pack_name)).cloned();
        let removed = profile["mods"].as_array().map(|l| l.iter().filter(|x| x["from"] == pack_name).count()).unwrap_or(0);
        if record.is_none() && removed == 0 {
            return Err(format!("{pack_name} was not imported into profile {profile_id}"));
        }
        let filter = |key: &str, p: &mut Value, keep: &dyn Fn(&Value) -> bool| {
            let next: Vec<Value> = p[key].as_array().cloned().unwrap_or_default().into_iter().filter(|x| keep(x)).collect();
            p[key] = Value::Array(next);
        };
        filter("mods", profile, &|x| x["from"] != pack_name);
        filter("imports", profile, &|x| x["name"] != pack_name);
        let overrides = record.as_ref().and_then(|r| r.get("overrides")).filter(|v| js::truthy(Some(v))).map(js::string);
        if let Some(o) = &overrides {
            let prefix = format!("{o}/");
            filter("scripts", profile, &|x| !js::string(x).starts_with(&prefix));
            filter("resourcePacks", profile, &|x| !js::string(x).starts_with(&prefix));
            if profile.get("configDir").and_then(Value::as_str).is_some_and(|c| c.starts_with(&prefix)) {
                if let Some(obj) = profile.as_object_mut() {
                    obj.shift_remove("configDir");
                }
            }
        }
        manifest::write_manifest(&dir, &m)?;
        Ok((json!({ "removed": removed, "overridesKept": overrides }), vec![("workspace.changed", json!({ "workspace": s(&dir) }))]))
    }
}

fn workspace_dir(root: &str) -> PathBuf {
    crate::workspace::normalize(root)
}
