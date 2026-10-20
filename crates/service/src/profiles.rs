use crate::http::{download_verified, hash_file, Expected};
use crate::js;
use crate::manifest::{self, schemas};
use crate::ops::{OpCtx, Ops};
use crate::packlink::{self, PackFolder};
use crate::providers::{cf_distributable, cf_file_page, cf_to_project, cf_to_version, Providers};
use crate::resolver::{self, describe_ref, ModProvider};
use crate::schema;
use crate::store::Store;
use crate::workspace;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

pub const FABRIC_API_PROJECT: &str = "P7dR8mSH";
pub const CF_FABRIC_API_PROJECT: &str = "306612";

pub type Events = Vec<(&'static str, Value)>;

pub struct Profiles {
    pub providers: Arc<Providers>,
    pub store: Arc<Store>,
    pub ops: Arc<Ops>,
    pub cache: PathBuf,
}

fn s(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

fn basename(p: &str) -> String {
    Path::new(p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

pub fn parse_with(name: &str, v: &Value) -> Result<Value, String> {
    schema::parse(&schemas()[name], v).map_err(|issues| schema::zod_error_message(&issues))
}

fn changed(dir: &Path) -> (&'static str, Value) {
    ("workspace.changed", json!({ "workspace": s(dir) }))
}

fn profiles_of(m: &Value) -> Vec<Value> {
    m["profiles"].as_array().cloned().unwrap_or_default()
}

fn find_profile(m: &Value, id: &str) -> Option<Value> {
    profiles_of(m).into_iter().find(|p| p["id"] == id)
}

fn set_or_remove(m: &mut Map<String, Value>, key: &str, v: Option<&Value>) {
    match v {
        Some(v) => {
            m.insert(key.to_string(), v.clone());
        }
        None => {
            m.shift_remove(key);
        }
    }
}

fn mod_matches(m: &Value, key: &str) -> bool {
    describe_ref(m) == key || (m["source"] == "modrinth" && (m["projectId"] == key || m["slug"] == key))
}

pub fn classpath_mod_ids(classpath: &[String]) -> Vec<String> {
    static CACHE: OnceLock<Mutex<HashMap<String, (f64, Vec<String>)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut ids: Vec<String> = Vec::new();
    let add = |id: String, ids: &mut Vec<String>| {
        if !ids.contains(&id) {
            ids.push(id);
        }
    };
    for entry in classpath {
        let Ok(st) = fs::metadata(entry) else { continue };
        if st.is_dir() {
            let fmj = Path::new(entry).join("fabric.mod.json");
            if fmj.exists() {
                let Ok(j) = fs::read_to_string(&fmj).map_err(|_| ()).and_then(|t| serde_json::from_str::<Value>(&t).map_err(|_| ())) else { continue };
                if js::truthy(j.get("id")) {
                    add(js::string(&j["id"]), &mut ids);
                }
                if let Some(p) = j.get("provides").and_then(Value::as_array) {
                    for x in p {
                        add(js::string(x), &mut ids);
                    }
                }
            }
            let toml = Path::new(entry).join("META-INF").join("neoforge.mods.toml");
            if toml.exists() {
                if let Ok(mods) = fs::read_to_string(&toml).map_err(|e| e.to_string()).and_then(|t| crate::jarmeta::parse_mods_toml(&t, "neoforge")) {
                    for m in mods {
                        add(js::string(&m["id"]), &mut ids);
                    }
                }
            }
            continue;
        }
        if !entry.ends_with(".jar") || st.len() > 20 * 1024 * 1024 {
            continue;
        }
        let mtime = js::mtime_ms(&st);
        let cached = cache.lock().unwrap_or_else(|e| e.into_inner()).get(entry).filter(|(m, _)| *m == mtime).map(|(_, l)| l.clone());
        let list = match cached {
            Some(l) => l,
            None => match crate::jarmeta::read_jar_metadata(entry) {
                Ok(meta) => {
                    let l = resolver::all_mod_ids(meta.as_array().map(Vec::as_slice).unwrap_or(&[]));
                    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(entry.clone(), (mtime, l.clone()));
                    l
                }
                Err(_) => continue,
            },
        };
        for i in list {
            add(i, &mut ids);
        }
    }
    ids
}

pub fn refs_hash(manifest: &Value, profile: &Value, mode: &str) -> String {
    use sha2::Digest;
    let mut o = Map::new();
    o.insert("deps".into(), manifest["dependencies"].clone());
    o.insert("mods".into(), profile["mods"].clone());
    o.insert("side".into(), profile["side"].clone());
    o.insert("mode".into(), json!(mode));
    o.insert("mc".into(), manifest["platform"]["minecraft"].clone());
    o.insert("loader".into(), manifest["platform"]["loaderVersion"].clone());
    o.insert("bridge".into(), profile["bridge"].clone());
    let text = serde_json::to_string(&Value::Object(o)).unwrap_or_default();
    hex::encode(sha2::Sha256::digest(text.as_bytes()))[..16].to_string()
}

struct ModrinthApi<'a>(&'a Providers);

impl ModProvider for ModrinthApi<'_> {
    fn project(&self, id: &str) -> Result<Value, String> {
        self.0.modrinth_project(id)
    }
    fn versions(&self, project_id: &str, loader: &str, minecraft: &str) -> Result<Vec<Value>, String> {
        Ok(self.0.modrinth_versions(project_id, Some(loader), Some(minecraft))?.as_array().cloned().unwrap_or_default())
    }
    fn version(&self, version_id: &str, _project_id: Option<&str>) -> Result<Value, String> {
        self.0.modrinth_version(version_id)
    }
}

struct CurseForgeApi<'a> {
    p: &'a Providers,
    mods: Mutex<HashMap<String, Result<Value, String>>>,
}

impl CurseForgeApi<'_> {
    fn mod_of(&self, id: &str) -> Result<Value, String> {
        if let Some(r) = self.mods.lock().unwrap_or_else(|e| e.into_inner()).get(id) {
            return r.clone();
        }
        let r = self.p.cf_mod(id);
        self.mods.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), r.clone());
        r
    }

    fn to_version(&self, f: &Value) -> Result<Value, String> {
        let m = self.mod_of(&js::string(&f["modId"]))?;
        let mut v = cf_to_version(f);
        if let Some(o) = v.as_object_mut() {
            o.insert("distribution".into(), json!(if cf_distributable(&m, f) { "direct" } else { "manual" }));
            o.insert("manualUrl".into(), json!(cf_file_page(Some(&m), f)));
        }
        Ok(v)
    }
}

impl ModProvider for CurseForgeApi<'_> {
    fn project(&self, id: &str) -> Result<Value, String> {
        Ok(cf_to_project(&self.mod_of(id)?, None))
    }
    fn versions(&self, project_id: &str, loader: &str, minecraft: &str) -> Result<Vec<Value>, String> {
        self.p.cf_files(project_id, Some(loader), Some(minecraft))?.iter().filter(|f| f["isAvailable"] != false && !js::truthy(f.get("isServerPack"))).map(|f| self.to_version(f)).collect()
    }
    fn version(&self, version_id: &str, project_id: Option<&str>) -> Result<Value, String> {
        let Some(project) = project_id.filter(|p| !p.is_empty()) else { return Err(format!("CurseForge file {version_id} needs its project id")) };
        self.to_version(&self.p.cf_file(project, version_id)?)
    }
}

impl Profiles {
    fn normalize(p: &str) -> PathBuf {
        workspace::normalize(p)
    }

    fn manifest(root: &str) -> Result<Value, String> {
        manifest::require_manifest(&Self::normalize(root), root)
    }

    fn save(root: &str, m: &Value) -> Result<(&'static str, Value), String> {
        let dir = Self::normalize(root);
        manifest::write_manifest(&dir, m)?;
        Ok(changed(&dir))
    }

    pub fn list(&self, root: &str) -> Result<Value, String> {
        let m = Self::manifest(root)?;
        let lock = manifest::read_lock(&Self::normalize(root))?;
        Ok(Value::Array(
            profiles_of(&m)
                .into_iter()
                .map(|mut p| {
                    let id = js::string(&p["id"]);
                    let resolved = match lock["profiles"].get(&id) {
                        Some(l) => json!({ "resolvedAt": l["resolvedAt"], "entries": l["entries"].as_array().map(Vec::len).unwrap_or(0), "issues": l["issues"].as_array().map(Vec::len).unwrap_or(0) }),
                        None => Value::Null,
                    };
                    if let Some(o) = p.as_object_mut() {
                        o.insert("resolved".into(), resolved);
                    }
                    p
                })
                .collect(),
        ))
    }

    pub fn create(&self, root: &str, input: &Value) -> Result<(Value, Events), String> {
        let mut m = Self::manifest(root)?;
        let profile = parse_with("profile", input)?;
        if profiles_of(&m).iter().any(|p| p["id"] == profile["id"]) {
            return Err(format!("Profile {} already exists", js::string(&profile["id"])));
        }
        if let Some(list) = m["profiles"].as_array_mut() {
            list.push(profile.clone());
        }
        let ev = Self::save(root, &m)?;
        Ok((profile, vec![ev]))
    }

    pub fn update(&self, root: &str, id: &str, patch: &Value) -> Result<(Value, Events), String> {
        let mut m = Self::manifest(root)?;
        let list = m["profiles"].as_array_mut().ok_or("profiles missing")?;
        let idx = list.iter().position(|p| p["id"] == id).ok_or_else(|| format!("Unknown profile {id}"))?;
        let mut merged = list[idx].as_object().cloned().unwrap_or_default();
        for (k, v) in patch.as_object().into_iter().flatten() {
            merged.insert(k.clone(), v.clone());
        }
        merged.insert("id".into(), json!(id));
        let next = parse_with("profile", &Value::Object(merged))?;
        list[idx] = next.clone();
        let ev = Self::save(root, &m)?;
        Ok((next, vec![ev]))
    }

    pub fn remove(&self, root: &str, id: &str, confirm: bool) -> Result<Events, String> {
        if !confirm {
            return Err("Removing a profile is destructive; pass confirm: true".into());
        }
        let mut m = Self::manifest(root)?;
        if let Some(list) = m["profiles"].as_array_mut() {
            list.retain(|p| p["id"] != id);
        }
        Ok(vec![Self::save(root, &m)?])
    }

    pub fn clone_profile(&self, root: &str, source: &str, new_id: &str, name: Option<&str>) -> Result<(Value, Events), String> {
        let mut m = Self::manifest(root)?;
        let src = find_profile(&m, source).ok_or_else(|| format!("Unknown profile {source}"))?;
        let mut copy = src.as_object().cloned().unwrap_or_default();
        copy.insert("id".into(), json!(new_id));
        copy.insert("name".into(), json!(name.map(str::to_string).unwrap_or_else(|| format!("{} (copy)", js::string(&src["name"])))));
        let copy = parse_with("profile", &Value::Object(copy))?;
        if profiles_of(&m).iter().any(|p| p["id"] == new_id) {
            return Err(format!("Profile {new_id} already exists"));
        }
        if let Some(list) = m["profiles"].as_array_mut() {
            list.push(copy.clone());
        }
        let ev = Self::save(root, &m)?;
        Ok((copy, vec![ev]))
    }

    pub fn add_mod(&self, root: &str, profile_id: Option<&str>, input: &Value) -> Result<(Value, Events), String> {
        let mut m = Self::manifest(root)?;
        let r = parse_with("modRef", input)?;
        let key = describe_ref(&r);
        let same = |x: &Value| describe_ref(x) == key || (x["source"] == "modrinth" && r["source"] == "modrinth" && x["projectId"] == r["projectId"]);
        match profile_id {
            Some(pid) => {
                let list = m["profiles"].as_array_mut().ok_or("profiles missing")?;
                let p = list.iter_mut().find(|p| p["id"] == pid).ok_or_else(|| format!("Unknown profile {pid}"))?;
                let mods = p["mods"].as_array_mut().ok_or("mods missing")?;
                if mods.iter().any(same) {
                    return Err(format!("{key} is already in profile {pid}"));
                }
                mods.push(r.clone());
            }
            None => {
                if m["dependencies"].as_array().is_some_and(|d| d.iter().any(same)) {
                    return Err(format!("{key} is already a project dependency"));
                }
                if r["usage"] == "compile" && m["source"]["kind"] != "gradle" {
                    return Err("Compile dependencies require a Gradle source project".into());
                }
                if let Some(d) = m["dependencies"].as_array_mut() {
                    d.push(r.clone());
                }
            }
        }
        let ev = Self::save(root, &m)?;
        Ok((r, vec![ev]))
    }

    fn mod_list<'a>(m: &'a mut Value, profile_id: Option<&str>) -> Option<&'a mut Vec<Value>> {
        match profile_id {
            Some(pid) => m["profiles"].as_array_mut()?.iter_mut().find(|p| p["id"] == pid)?["mods"].as_array_mut(),
            None => m["dependencies"].as_array_mut(),
        }
    }

    pub fn set_mod_enabled(&self, root: &str, profile_id: Option<&str>, key: &str, enabled: bool) -> Result<(Value, Events), String> {
        let mut m = Self::manifest(root)?;
        let list = Self::mod_list(&mut m, profile_id).ok_or_else(|| format!("Unknown profile {}", profile_id.unwrap_or("null")))?;
        let r = list
            .iter_mut()
            .find(|x| mod_matches(x, key))
            .ok_or_else(|| format!("{key} is not in {}", profile_id.map(|p| format!("profile {p}")).unwrap_or_else(|| "the project dependencies".into())))?;
        if let Some(o) = r.as_object_mut() {
            o.insert("enabled".into(), json!(enabled));
        }
        let out = r.clone();
        let ev = Self::save(root, &m)?;
        Ok((out, vec![ev]))
    }

    pub fn remove_mod(&self, root: &str, profile_id: Option<&str>, key: &str) -> Result<Events, String> {
        let mut m = Self::manifest(root)?;
        match profile_id {
            Some(pid) => {
                let list = m["profiles"].as_array_mut().ok_or("profiles missing")?;
                let p = list.iter_mut().find(|p| p["id"] == pid).ok_or_else(|| format!("Unknown profile {pid}"))?;
                if let Some(mods) = p["mods"].as_array_mut() {
                    mods.retain(|x| !mod_matches(x, key));
                }
            }
            None => {
                if let Some(d) = m["dependencies"].as_array_mut() {
                    d.retain(|x| !mod_matches(x, key));
                }
            }
        }
        Ok(vec![Self::save(root, &m)?])
    }

    fn pack_summary(pack: &PackFolder, m: &Value) -> Map<String, Value> {
        let mc = m["platform"]["minecraft"].as_str().unwrap_or_default();
        let loader = m["platform"]["loader"].as_str().unwrap_or_default();
        let blockers = packlink::compatibility_problems(pack, mc, loader);
        let mut problems = blockers.clone();
        problems.extend(pack.problems.iter().cloned());
        let mut o = Map::new();
        o.insert("path".into(), json!(pack.path));
        o.insert("kind".into(), json!(pack.kind));
        o.insert("name".into(), json!(pack.name));
        o.insert("minecraft".into(), json!(pack.minecraft));
        o.insert("loader".into(), json!(pack.loader));
        o.insert("loaderVersion".into(), json!(pack.loader_version));
        o.insert("mods".into(), json!(pack.jars.len()));
        o.insert("disabledMods".into(), json!(pack.disabled_jars));
        o.insert("configFolders".into(), json!(pack.config_dirs.iter().map(|d| basename(d)).collect::<Vec<_>>()));
        o.insert("problems".into(), json!(problems));
        o.insert("compatible".into(), json!(blockers.is_empty() && !pack.jars.is_empty()));
        o
    }

    pub fn linked_packs(&self, root: &str, profile_id: &str) -> Result<Value, String> {
        let dir = Self::normalize(root);
        let m = manifest::require_manifest(&dir, &s(&dir))?;
        let profile = find_profile(&m, profile_id).ok_or_else(|| format!("Unknown profile {profile_id}"))?;
        let side = profile["side"].as_str().unwrap_or("client");
        let links = packlink::read_links(&dir);
        Ok(Value::Array(
            links
                .get(profile_id)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|link| {
                    let path = js::string(&link["path"]);
                    let mut o = link.as_object().cloned().unwrap_or_default();
                    match packlink::detect_pack_folder(&path, side) {
                        Ok(pack) => {
                            o.insert("found".into(), json!(true));
                            for (k, v) in Self::pack_summary(&pack, &m) {
                                o.insert(k, v);
                            }
                            o.insert("path".into(), json!(path));
                        }
                        Err(e) => {
                            o.insert("found".into(), json!(false));
                            o.insert("kind".into(), json!("folder"));
                            o.insert("name".into(), json!(basename(&path)));
                            for k in ["minecraft", "loader", "loaderVersion"] {
                                o.insert(k.into(), Value::Null);
                            }
                            o.insert("mods".into(), json!(0));
                            o.insert("disabledMods".into(), json!(0));
                            o.insert("configFolders".into(), json!([]));
                            o.insert("problems".into(), json!([e]));
                            o.insert("compatible".into(), json!(false));
                        }
                    }
                    Value::Object(o)
                })
                .collect(),
        ))
    }

    pub fn link_pack(&self, root: &str, profile_id: &str, folder: &str, enabled: Option<bool>, configs: Option<bool>) -> Result<(Value, Events), String> {
        let dir = Self::normalize(root);
        let m = manifest::require_manifest(&dir, &s(&dir))?;
        let profile = find_profile(&m, profile_id).ok_or_else(|| format!("Unknown profile {profile_id}"))?;
        let pack = packlink::detect_pack_folder(folder, profile["side"].as_str().unwrap_or("client"))?;
        if packlink::same_path(&pack.path, &s(&dir)) {
            return Err("A project cannot link to itself".into());
        }
        let blockers = packlink::compatibility_problems(&pack, m["platform"]["minecraft"].as_str().unwrap_or_default(), m["platform"]["loader"].as_str().unwrap_or_default());
        if !blockers.is_empty() {
            return Err(blockers.join("; "));
        }
        if pack.jars.is_empty() {
            return Err(pack.problems.first().cloned().unwrap_or_else(|| "No mods found in this folder".into()));
        }
        let mut links = packlink::read_links(&dir);
        let mut list = links.get(profile_id).and_then(Value::as_array).cloned().unwrap_or_default();
        let idx = list.iter().position(|l| packlink::same_path(&js::string(&l["path"]), &pack.path));
        let prev = idx.map(|i| list[i].clone());
        let next = parse_with(
            "linkedPack",
            &json!({ "path": pack.path, "enabled": enabled.or_else(|| prev.as_ref().and_then(|p| p["enabled"].as_bool())).unwrap_or(true), "configs": configs.or_else(|| prev.as_ref().and_then(|p| p["configs"].as_bool())).unwrap_or(true) }),
        )?;
        match idx {
            Some(i) => list[i] = next.clone(),
            None => list.push(next.clone()),
        }
        links.insert(profile_id.to_string(), Value::Array(list));
        packlink::write_links(&dir, &links)?;
        let mut o = next.as_object().cloned().unwrap_or_default();
        for (k, v) in Self::pack_summary(&pack, &m) {
            o.insert(k, v);
        }
        o.insert("path".into(), json!(pack.path));
        Ok((Value::Object(o), vec![changed(&dir)]))
    }

    pub fn unlink_pack(&self, root: &str, profile_id: &str, folder: &str) -> Result<Events, String> {
        let dir = Self::normalize(root);
        let mut links = packlink::read_links(&dir);
        let list = links.get(profile_id).and_then(Value::as_array).cloned().unwrap_or_default();
        let next: Vec<Value> = list.iter().filter(|l| !packlink::same_path(&js::string(&l["path"]), folder)).cloned().collect();
        if next.len() == list.len() {
            return Err(format!("{folder} is not linked to profile {profile_id}"));
        }
        links.insert(profile_id.to_string(), Value::Array(next));
        packlink::write_links(&dir, &links)?;
        Ok(vec![changed(&dir)])
    }

    pub fn discover_packs(&self, root: &str, profile_id: &str) -> Result<Value, String> {
        let dir = Self::normalize(root);
        let m = manifest::require_manifest(&dir, &s(&dir))?;
        let profile = find_profile(&m, profile_id).ok_or_else(|| format!("Unknown profile {profile_id}"))?;
        let side = profile["side"].as_str().unwrap_or("client");
        let recent: Vec<String> = self.store.list_recent().map_err(|e| e.to_string())?.into_iter().map(|r| r.0).filter(|p| !packlink::same_path(p, &s(&dir))).collect();
        let mut out = Vec::new();
        for folder in packlink::discover_pack_folders(&recent) {
            let Ok(pack) = packlink::detect_pack_folder(&folder, side) else { continue };
            if pack.kind == "folder" && pack.jars.is_empty() {
                continue;
            }
            if pack.kind == "modsmith" && pack.problems.iter().any(|p| p.contains("mod project")) {
                continue;
            }
            out.push(Self::pack_summary(&pack, &m));
        }
        out.sort_by(|a, b| (b["compatible"] == true).cmp(&(a["compatible"] == true)).then_with(|| js::locale_compare(&js::string(&a["name"]), &js::string(&b["name"]))));
        Ok(Value::Array(out.into_iter().map(Value::Object).collect()))
    }

    fn dev_classpath_ids(dir: &Path, side: &str) -> Option<Vec<String>> {
        let task = if side == "client" { "runClient" } else { "runServer" };
        let spec = manifest::state_dir(dir).join("launch").join(format!("{task}.json"));
        let j: Value = serde_json::from_str(&fs::read_to_string(spec).ok()?).ok()?;
        let run = j.get("runs").and_then(|r| r.get(task)).filter(|r| js::truthy(Some(r)))?;
        let cp: Vec<String> = run["classpath"].as_array()?.iter().map(js::string).collect();
        Some(classpath_mod_ids(&cp))
    }

    pub fn manual_dir(&self) -> PathBuf {
        self.cache.join("downloads").join("manual")
    }

    pub fn fetch_locked(&self, e: &Value, ctx: Option<&OpCtx>) -> Result<String, String> {
        let title = js::string(&e["title"]);
        let Some(sha1) = e.get("sha1").filter(|v| js::truthy(Some(v))).map(js::string) else {
            return Err(format!("{title} has no published SHA-1; refusing to use an unverified file"));
        };
        let file_name = js::string(&e["fileName"]);
        if e["distribution"] == "manual" || !js::truthy(e.get("url")) {
            let dir = self.manual_dir().join(&sha1);
            let candidate = fs::read_dir(&dir).ok().and_then(|it| it.flatten().map(|f| f.path()).find(|f| f.to_string_lossy().ends_with(".jar")));
            if let Some(c) = candidate {
                if hash_file(&c, "sha1")? == sha1.to_lowercase() {
                    return Ok(s(&c));
                }
            }
            return Err(format!(
                "Not redistributable through the API. Download {file_name} from {} and provide it (dependency_provide_file).",
                e.get("manualUrl").filter(|v| !v.is_null()).map(js::string).unwrap_or_else(|| "the project page".into())
            ));
        }
        if let Some(c) = ctx {
            c.log(&format!("Downloading {file_name}"));
        }
        let dest = self.cache.join("downloads").join(js::string(&e["provider"])).join(&sha1[..sha1.len().min(2)]).join(&sha1).join(&file_name);
        let sha512 = e.get("sha512").filter(|v| js::truthy(Some(v))).map(js::string);
        let expected = Expected { sha1: Some(&sha1), sha512: sha512.as_deref(), size: e["size"].as_u64() };
        let cancelled = || ctx.is_some_and(|c| c.cancelled());
        let (path, cached) = download_verified(&js::string(&e["url"]), &dest, &expected, &cancelled, &|_, _| {})?;
        if let Some(c) = ctx {
            c.log(&format!("{} {file_name}", if cached { "Cached" } else { "Downloaded and verified" }));
        }
        Ok(s(&path))
    }

    pub fn provide_manual_file(&self, file: &str) -> Result<Value, String> {
        if !Path::new(file).exists() || !file.to_lowercase().ends_with(".jar") {
            return Err("Choose an existing .jar file".into());
        }
        let sha1 = hash_file(Path::new(file), "sha1")?;
        let dir = self.manual_dir().join(&sha1);
        fs::create_dir_all(&dir).map_err(|e| js::fs_error(&e, "mkdir", &dir))?;
        let stored = dir.join(basename(file));
        let tmp = PathBuf::from(format!("{}.tmp", s(&stored)));
        fs::copy(file, &tmp).map_err(|e| js::fs_error(&e, "copyfile", Path::new(file)))?;
        fs::rename(&tmp, &stored).map_err(|e| js::fs_error(&e, "rename", &tmp))?;
        let mut matches = Vec::new();
        for (path, _, _, _) in self.store.list_recent().map_err(|e| e.to_string())? {
            let Ok(lock) = manifest::read_lock(Path::new(&path)) else { continue };
            for (profile, p) in lock["profiles"].as_object().into_iter().flatten() {
                for e in p["entries"].as_array().into_iter().flatten() {
                    if e.get("sha1").and_then(Value::as_str).map(str::to_lowercase).as_deref() == Some(sha1.as_str()) {
                        matches.push(json!({ "workspace": path, "profile": profile, "title": e["title"] }));
                    }
                }
            }
        }
        Ok(json!({ "sha1": sha1, "stored": s(&stored), "matches": matches }))
    }

    pub fn resolve(&self, root: &str, profile_id: &str, ctx: Option<&OpCtx>, mode_override: Option<&str>) -> Result<(resolver::Output, Value), String> {
        let dir = Self::normalize(root);
        let m = manifest::require_manifest(&dir, &s(&dir))?;
        let profile = find_profile(&m, profile_id).ok_or_else(|| format!("Unknown profile {profile_id}"))?;
        let mode = mode_override.map(str::to_string).unwrap_or_else(|| js::string(&profile["mode"]));
        let loader = m["platform"]["loader"].as_str().unwrap_or_default().to_string();
        let minecraft = m["platform"]["minecraft"].as_str().unwrap_or_default().to_string();
        let side = profile["side"].as_str().unwrap_or("client").to_string();
        let deps = m["dependencies"].as_array().cloned().unwrap_or_default();
        let mut refs: Vec<(Value, String)> = Vec::new();
        for d in &deps {
            if mode == "development" && d["usage"] == "compile" {
                continue;
            }
            let mut r = d.clone();
            if d["usage"] == "compile" && d["source"] == "modrinth" {
                r["usage"] = json!("runtime");
            }
            refs.push((r, "project dependency".into()));
        }
        for md in profile["mods"].as_array().cloned().unwrap_or_default() {
            let reason = match md.get("from").filter(|f| js::truthy(Some(f))) {
                Some(f) => format!("pack {}", js::string(f)),
                None => format!("profile {profile_id}"),
            };
            refs.push((md, reason));
        }
        let mut provided = Map::new();
        let mut provided_ids: Vec<String> = Vec::new();
        if mode == "development" && m["source"]["kind"] == "gradle" {
            provided_ids = Self::dev_classpath_ids(&dir, &side).unwrap_or_else(|| {
                [m.get("modId").map(js::string).unwrap_or_default(), if loader == "fabric" { "fabric-api".into() } else { "neoforge".into() }].into_iter().filter(|x| !x.is_empty()).collect()
            });
            if provided_ids.iter().any(|i| i == "fabric-api") {
                provided.insert(FABRIC_API_PROJECT.into(), json!("Fabric API"));
            }
            for d in &deps {
                if d["source"] == "modrinth" && d["usage"] == "compile" {
                    provided.insert(js::string(&d["projectId"]), d.get("title").filter(|t| !t.is_null()).cloned().unwrap_or_else(|| d["projectId"].clone()));
                }
            }
        }
        let mut link_issues: Vec<Value> = Vec::new();
        let mut pack_ids: Vec<String> = Vec::new();
        let replaced = provided_ids.clone();
        let links = packlink::read_links(&dir);
        for link in links.get(profile_id).and_then(Value::as_array).cloned().unwrap_or_default() {
            if link["enabled"] != true {
                continue;
            }
            let path = js::string(&link["path"]);
            let pack = match packlink::detect_pack_folder(&path, &side) {
                Ok(p) => p,
                Err(e) => {
                    link_issues.push(json!({ "severity": "error", "message": format!("Linked modpack folder is missing: {path} ({e})") }));
                    continue;
                }
            };
            let mut blockers = packlink::compatibility_problems(&pack, &minecraft, &loader);
            if pack.jars.is_empty() {
                blockers.extend(pack.problems.iter().cloned());
            }
            if !blockers.is_empty() {
                for b in blockers {
                    link_issues.push(json!({ "severity": "error", "message": format!("Linked modpack: {b}") }));
                }
                continue;
            }
            let sel = packlink::select_pack_jars(&pack, &side, &replaced);
            for j in &sel.used {
                for meta in packlink::jar_metadata(&j.file) {
                    pack_ids.push(js::string(&meta["id"]));
                }
            }
            for j in &sel.used {
                refs.push((json!({ "source": "local", "path": j.file, "required": true, "usage": "runtime", "environment": "both" }), format!("linked pack {}", pack.name)));
            }
            for (name, reason) in &sel.skipped {
                link_issues.push(json!({ "severity": "info", "message": format!("{name} from {} not loaded: {reason}", pack.name) }));
            }
            if let Some(c) = ctx {
                let disabled = if pack.disabled_jars > 0 { format!(", {} disabled in the pack", pack.disabled_jars) } else { String::new() };
                let skipped = if sel.skipped.is_empty() { String::new() } else { format!(", {} skipped", sel.skipped.len()) };
                c.log(&format!("Linked modpack {}: {} mods{disabled}{skipped}", pack.name, sel.used.len()));
            }
        }
        if mode == "production" && m["source"]["kind"] == "gradle" && profile["includeSourceMod"] == true {
            let has_api = refs.iter().any(|(r, _)| (r["source"] == "modrinth" && r["projectId"] == FABRIC_API_PROJECT) || (r["source"] == "curseforge" && r["projectId"] == CF_FABRIC_API_PROJECT));
            if loader == "fabric" && !pack_ids.iter().any(|i| i == "fabric-api") && !has_api {
                refs.push((
                    json!({ "source": "modrinth", "projectId": FABRIC_API_PROJECT, "title": "Fabric API", "required": true, "usage": "runtime", "environment": "both" }),
                    "required by the source mod (fabric-api)".into(),
                ));
            }
            for d in &deps {
                if d["source"] == "modrinth" && d["usage"] == "compile" {
                    let mut r = d.clone();
                    r["usage"] = json!("runtime");
                    refs.push((r, "compile dependency packaged for production".into()));
                }
            }
        }
        let modrinth = ModrinthApi(&self.providers);
        let cf = CurseForgeApi { p: &self.providers, mods: Mutex::new(HashMap::new()) };
        let cf_on = self.providers.cf_configured();
        let fetch = |e: &Value| self.fetch_locked(e, ctx);
        let read = |f: &str| crate::jarmeta::read_jar_metadata(f).map(|v| v.as_array().cloned().unwrap_or_default());
        let hash = |f: &str| -> Result<(String, String, u64), String> { Ok((hash_file(Path::new(f), "sha1")?, hash_file(Path::new(f), "sha512")?, fs::metadata(f).map(|m| m.len()).unwrap_or(0))) };
        let env = resolver::Env { modrinth: Some(&modrinth), curseforge: if cf_on { Some(&cf) } else { None }, fetch_file: &fetch, read_metadata: &read, hash_local: &hash };
        let input =
            resolver::Input { loader: &loader, minecraft: &minecraft, side: &side, refs, provided_mod_ids: provided_ids, provided_modrinth_projects: provided, base_dir: &dir, extra_entries: vec![] };
        let mut res = resolver::resolve_profile(input, &env);
        let mut issues = link_issues;
        issues.append(&mut res.issues);
        res.issues = issues;
        let mut lock = manifest::read_lock(&dir)?;
        let key = if mode == "production" { format!("{profile_id}@production") } else { profile_id.to_string() };
        let entries: Vec<Value> = res
            .entries
            .iter()
            .map(|e| {
                let mut o = e.as_object().cloned().unwrap_or_default();
                if e["provider"] == "local" || e["provider"] == "bridge" {
                    o.shift_remove("url");
                }
                Value::Object(o)
            })
            .collect();
        let mut lp = Map::new();
        lp.insert("resolvedAt".into(), json!(humantime::format_rfc3339_millis(std::time::SystemTime::now()).to_string()));
        lp.insert("minecraft".into(), json!(minecraft));
        lp.insert("loader".into(), json!(loader));
        lp.insert("loaderVersion".into(), m["platform"]["loaderVersion"].clone());
        lp.insert("entries".into(), Value::Array(entries));
        lp.insert("issues".into(), Value::Array(res.issues.clone()));
        if let Some(p) = lock["profiles"].as_object_mut() {
            p.insert(key.clone(), Value::Object(lp));
        }
        js::write_file_atomic(&manifest::lock_path(&dir), format!("{}\n", js::pretty(&lock)).as_bytes())?;
        let state = manifest::state_dir(&dir);
        fs::create_dir_all(&state).map_err(|e| js::fs_error(&e, "mkdir", &state))?;
        let files_json = json!({ "hash": refs_hash(&m, &profile, &mode), "files": res.files });
        let target = state.join(format!("resolved-{}.files.json", key.replace('@', "-")));
        fs::write(&target, js::pretty(&files_json)).map_err(|e| js::fs_error(&e, "open", &target))?;
        if let Some(c) = ctx {
            for i in &res.issues {
                c.log(&format!("[{}] {}", js::string(&i["severity"]), js::string(&i["message"])));
            }
        }
        Ok((res, json!({ "workspace": s(&dir) })))
    }

    pub fn resolve_op(self: &Arc<Self>, root: &str, profile_id: &str, mode: Option<String>) -> Value {
        let dir = Self::normalize(root);
        let me = self.clone();
        let (dir_s, pid) = (s(&dir), profile_id.to_string());
        self.ops.start("profile.resolve", &format!("Resolve profile {profile_id}"), Some(dir_s.clone()), move |ctx| {
            let (r, changed) = me.resolve(&dir_s, &pid, Some(ctx), mode.as_deref())?;
            me.ops.emit_event("workspace.changed", changed);
            Ok(Some(json!({ "entries": r.entries, "issues": r.issues, "optionalSuggestions": r.optional_suggestions })))
        })
    }

    pub fn compare(&self, root: &str, a: &str, b: &str) -> Result<Value, String> {
        let dir = Self::normalize(root);
        let m = manifest::require_manifest(&dir, &s(&dir))?;
        let lock = manifest::read_lock(&dir)?;
        let (Some(pa), Some(pb)) = (find_profile(&m, a), find_profile(&m, b)) else { return Err("Unknown profile".into()) };
        let entries = |id: &str| lock["profiles"].get(id).and_then(|p| p["entries"].as_array().cloned()).unwrap_or_default();
        let (la, lb) = (entries(a), entries(b));
        let key_of = |e: &Value| e.get("projectId").filter(|v| !v.is_null()).map(js::string).unwrap_or_else(|| js::string(&e["key"]));
        let find = |list: &[Value], k: &str| list.iter().find(|e| key_of(e) == k).cloned();
        let label = |e: &Value| format!("{} {}", js::string(&e["title"]), e.get("versionNumber").filter(|v| !v.is_null()).map(js::string).unwrap_or_default()).trim().to_string();
        let only_a: Vec<String> = la.iter().filter(|e| find(&lb, &key_of(e)).is_none()).map(label).collect();
        let only_b: Vec<String> = lb.iter().filter(|e| find(&la, &key_of(e)).is_none()).map(label).collect();
        let ver = |e: &Value| e.get("versionNumber").filter(|v| !v.is_null()).cloned().or_else(|| e.get("sha1").cloned());
        let changed: Vec<Value> = la
            .iter()
            .filter_map(|e| {
                let other = find(&lb, &key_of(e))?;
                let sa = e.get("sha1").filter(|v| !v.is_null()).map(js::string).unwrap_or_default();
                let sb = other.get("sha1").filter(|v| !v.is_null()).map(js::string).unwrap_or_default();
                if sa == sb {
                    return None;
                }
                let mut o = Map::new();
                o.insert("title".into(), e["title"].clone());
                if let Some(v) = ver(e) {
                    o.insert("a".into(), v);
                }
                if let Some(v) = ver(&other) {
                    o.insert("b".into(), v);
                }
                Some(Value::Object(o))
            })
            .collect();
        let mut settings = Vec::new();
        for k in ["side", "mode", "includeSourceMod", "bridge", "configDir", "resourcePacks", "datapacks", "scripts", "world", "jvm", "java", "debug", "programArgs"] {
            let (x, y) = (pa.get(k), pb.get(k));
            if x.map(|v| v.to_string()) != y.map(|v| v.to_string()) {
                let mut o = Map::new();
                o.insert("field".into(), json!(k));
                if let Some(v) = x {
                    o.insert("a".into(), v.clone());
                }
                if let Some(v) = y {
                    o.insert("b".into(), v.clone());
                }
                settings.push(Value::Object(o));
            }
        }
        Ok(
            json!({ "a": a, "b": b, "resolved": { "a": lock["profiles"].get(a).is_some(), "b": lock["profiles"].get(b).is_some() }, "onlyA": only_a, "onlyB": only_b, "changed": changed, "settings": settings }),
        )
    }

    pub fn lock(&self, root: &str) -> Result<Value, String> {
        manifest::read_lock(&Self::normalize(root))
    }

    pub fn add_dependency(&self, root: &str, profile_id: Option<&str>, input: &Value) -> Result<(Value, Events), String> {
        let mut r = input.as_object().cloned().unwrap_or_default();
        match r.get("source").and_then(Value::as_str) {
            Some("modrinth") => {
                if !js::truthy(r.get("projectId")) {
                    return Err("projectId is required for Modrinth mods".into());
                }
                let proj = self.providers.modrinth_project(&js::string(&r["projectId"]))?;
                set_or_remove(&mut r, "projectId", proj.get("id"));
                set_or_remove(&mut r, "slug", proj.get("slug"));
                if r.get("title").is_none_or(Value::is_null) {
                    set_or_remove(&mut r, "title", proj.get("title"));
                }
            }
            Some("curseforge") => {
                let pid = r.get("projectId").map(js::string).unwrap_or_default();
                if !js::truthy(r.get("projectId")) || !pid.chars().all(|c| c.is_ascii_digit()) || pid.is_empty() {
                    return Err("A numeric CurseForge projectId is required".into());
                }
                let m = self.providers.cf_mod(&pid)?;
                set_or_remove(&mut r, "slug", m.get("slug"));
                if r.get("title").is_none_or(Value::is_null) {
                    set_or_remove(&mut r, "title", m.get("name"));
                }
                r.insert("usage".into(), json!("runtime"));
                if js::truthy(r.get("versionId")) && !js::truthy(r.get("fileId")) {
                    let v = r["versionId"].clone();
                    r.insert("fileId".into(), v);
                }
                r.shift_remove("versionId");
            }
            Some("local") => {
                if !js::truthy(r.get("path")) {
                    return Err("path is required for local mods".into());
                }
                let base = Self::normalize(root);
                let abs = js::absolute(&base.join(js::string(&r["path"])).to_string_lossy());
                if !abs.exists() {
                    return Err(format!("File not found: {}", s(&abs)));
                }
                r.insert("path".into(), json!(s(&abs)));
            }
            _ => {}
        }
        self.add_mod(root, profile_id, &Value::Object(r))
    }
}
