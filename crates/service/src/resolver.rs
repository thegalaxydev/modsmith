use crate::js;
use crate::providers::pick_version;
use crate::versionrange::satisfies;
use serde_json::{json, Map, Value};
use std::path::Path;

pub trait ModProvider {
    fn project(&self, id: &str) -> Result<Value, String>;
    fn versions(&self, project_id: &str, loader: &str, minecraft: &str) -> Result<Vec<Value>, String>;
    fn version(&self, version_id: &str, project_id: Option<&str>) -> Result<Value, String>;
}

pub struct Env<'a> {
    pub modrinth: Option<&'a dyn ModProvider>,
    pub curseforge: Option<&'a dyn ModProvider>,
    pub fetch_file: &'a dyn Fn(&Value) -> Result<String, String>,
    pub read_metadata: &'a dyn Fn(&str) -> Result<Vec<Value>, String>,
    pub hash_local: &'a dyn Fn(&str) -> Result<(String, String, u64), String>,
}

pub struct Input<'a> {
    pub loader: &'a str,
    pub minecraft: &'a str,
    pub side: &'a str,
    pub refs: Vec<(Value, String)>,
    pub provided_mod_ids: Vec<String>,
    pub provided_modrinth_projects: Map<String, Value>,
    pub base_dir: &'a Path,
    pub extra_entries: Vec<Value>,
}

pub struct Output {
    pub entries: Vec<Value>,
    pub issues: Vec<Value>,
    pub files: Map<String, Value>,
    pub optional_suggestions: Vec<Value>,
}

struct Item {
    provider: &'static str,
    project_id: String,
    version_id: Option<String>,
    reason: String,
    required: bool,
    pinned: bool,
}

fn issue(severity: &str, message: String) -> Value {
    json!({ "severity": severity, "message": message })
}

fn label(provider: &str) -> &'static str {
    if provider == "modrinth" {
        "Modrinth"
    } else {
        "CurseForge"
    }
}

fn sev(required: bool) -> &'static str {
    if required {
        "error"
    } else {
        "warning"
    }
}

fn st(v: &Value, key: &str) -> Option<String> {
    v.get(key).filter(|x| !x.is_null()).map(js::string)
}

pub fn describe_ref(r: &Value) -> String {
    let src = r["source"].as_str().unwrap_or_default();
    match src {
        "modrinth" => format!("modrinth:{}", st(r, "slug").or_else(|| st(r, "projectId")).unwrap_or_else(|| "undefined".into())),
        "curseforge" => format!("curseforge:{}", st(r, "projectId").unwrap_or_else(|| "undefined".into())),
        "local" => format!("local:{}", st(r, "path").unwrap_or_else(|| "undefined".into())),
        _ => format!("maven:{}", st(r, "coordinates").unwrap_or_else(|| "undefined".into())),
    }
}

pub fn all_mod_ids(meta: &[Value]) -> Vec<String> {
    fn walk(m: &Value, out: &mut Vec<String>) {
        let id = js::string(&m["id"]);
        if !out.contains(&id) {
            out.push(id);
        }
        for p in m["provides"].as_array().into_iter().flatten() {
            let p = js::string(p);
            if !out.contains(&p) {
                out.push(p);
            }
        }
        for n in m["nested"].as_array().into_iter().flatten() {
            walk(n, out);
        }
    }
    let mut out = Vec::new();
    for m in meta {
        walk(m, &mut out);
    }
    out
}

pub fn primary_file(v: &Value) -> Option<Value> {
    let files = v["files"].as_array()?;
    files.iter().find(|f| f["primary"] == true).or_else(|| files.iter().find(|f| f["filename"].as_str().is_some_and(|n| n.ends_with(".jar")))).or(files.first()).cloned()
}

fn has(v: &Value, key: &str, item: &str) -> bool {
    v[key].as_array().is_some_and(|a| a.iter().any(|x| x == item))
}

pub fn resolve_profile(input: Input, env: &Env) -> Output {
    let mut issues: Vec<Value> = Vec::new();
    let mut entries: Vec<Value> = input.extra_entries.clone();
    let mut files = Map::new();
    let mut metadata = Map::new();
    let mut optional = Vec::new();
    let mut chosen: Vec<(String, (String, bool, String))> = Vec::new();
    let mut incompatibilities: Vec<(String, String)> = Vec::new();
    let mut queue: std::collections::VecDeque<Item> = std::collections::VecDeque::new();

    for (r, reason) in &input.refs {
        let title_or = || st(r, "title").unwrap_or_else(|| describe_ref(r));
        if r.get("enabled") == Some(&Value::Bool(false)) {
            issues.push(issue("info", format!("{} is disabled in this profile", title_or())));
            continue;
        }
        let environment = r["environment"].as_str().unwrap_or("both");
        if environment != "both" && environment != input.side {
            issues.push(issue("info", format!("{} skipped: {environment}-only and this profile is {}", title_or(), input.side)));
            continue;
        }
        let required = r["required"] == true;
        match r["source"].as_str().unwrap_or_default() {
            "modrinth" => {
                if r["usage"] == "compile" {
                    continue;
                }
                let v = st(r, "versionId").filter(|s| !s.is_empty());
                queue.push_back(Item { provider: "modrinth", project_id: js::string(&r["projectId"]), pinned: js::truthy(r.get("versionId")), version_id: v, reason: reason.clone(), required });
            }
            "curseforge" => {
                let v = st(r, "fileId").filter(|s| !s.is_empty());
                queue.push_back(Item { provider: "curseforge", project_id: js::string(&r["projectId"]), pinned: js::truthy(r.get("fileId")), version_id: v, reason: reason.clone(), required });
            }
            "local" => {
                let rel = js::string(&r["path"]);
                let abs = js::absolute(&input.base_dir.join(&rel).to_string_lossy());
                let abs_s = abs.to_string_lossy().to_string();
                if !abs.exists() {
                    issues.push(issue(sev(required), format!("Local mod file not found: {rel}")));
                    continue;
                }
                let (sha1, sha512, size) = match (env.hash_local)(&abs_s) {
                    Ok(h) => h,
                    Err(e) => {
                        issues.push(issue(sev(required), e));
                        continue;
                    }
                };
                let base = abs.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let meta = match (env.read_metadata)(&abs_s) {
                    Ok(m) => m,
                    Err(e) => {
                        issues.push(issue("warning", format!("Could not read mod metadata from {base}: {e}")));
                        vec![]
                    }
                };
                let key = format!("local:{rel}");
                let mut e = Map::new();
                e.insert("key".into(), json!(key));
                e.insert("provider".into(), json!("local"));
                e.insert(
                    "title".into(),
                    r.get("title").filter(|t| !t.is_null()).cloned().or_else(|| meta.first().and_then(|m| m.get("name")).filter(|n| !n.is_null()).cloned()).unwrap_or_else(|| json!(base)),
                );
                e.insert("fileName".into(), json!(base));
                e.insert("sha1".into(), json!(sha1));
                e.insert("sha512".into(), json!(sha512));
                e.insert("size".into(), json!(size));
                e.insert("modIds".into(), json!(all_mod_ids(&meta)));
                if let Some(l) = meta.first().and_then(|m| m.get("license")) {
                    e.insert("license".into(), l.clone());
                }
                e.insert("reason".into(), json!(reason));
                e.insert("required".into(), json!(required));
                entries.push(Value::Object(e));
                files.insert(key.clone(), json!(abs_s));
                metadata.insert(key, Value::Array(meta));
            }
            _ => {}
        }
    }

    while let Some(item) = queue.pop_front() {
        let api = if item.provider == "modrinth" { env.modrinth } else { env.curseforge };
        let lbl = label(item.provider);
        let key = format!("{}:{}", item.provider, item.project_id);
        let Some(api) = api else {
            issues.push(issue(sev(item.required), format!("{lbl} project {} cannot be resolved: {lbl} is not configured ({})", item.project_id, item.reason)));
            continue;
        };
        if item.provider == "modrinth" {
            if let Some(name) = input.provided_modrinth_projects.get(&item.project_id).filter(|v| js::truthy(Some(v))) {
                issues.push(issue("info", format!("{} ({}) is already provided by the development classpath; not added to the instance ({})", js::string(name), item.project_id, item.reason)));
                continue;
            }
        }
        if let Some(pos) = chosen.iter().position(|(k, _)| *k == key) {
            let (existing_version, existing_pinned, existing_reason) = chosen[pos].1.clone();
            match &item.version_id {
                Some(v) if *v != existing_version => {
                    if item.pinned && !existing_pinned {
                        issues.push(issue("warning", format!("{lbl} project {}: pinned version {v} replaces {existing_version} chosen for {existing_reason}", item.project_id)));
                        if let Some(idx) = entries.iter().position(|e| e["key"] == key.as_str()) {
                            entries.remove(idx);
                        }
                        chosen.remove(pos);
                    } else {
                        issues.push(issue(
                            "warning",
                            format!(
                                "{lbl} project {}: {} requests version {v} but {existing_version} is already selected ({existing_reason}). Keeping the existing selection; compatibility is unknown.",
                                item.project_id, item.reason
                            ),
                        ));
                        continue;
                    }
                }
                _ => continue,
            }
        }
        let project = match api.project(&item.project_id) {
            Ok(p) => p,
            Err(e) => {
                issues.push(issue(sev(item.required), format!("Could not fetch {lbl} project {}: {e}", item.project_id)));
                continue;
            }
        };
        let title = st(&project, "title").unwrap_or_else(|| "undefined".into());
        let side_value = if input.side == "client" { &project["client_side"] } else { &project["server_side"] };
        if side_value == "unsupported" {
            issues.push(issue("info", format!("{title} skipped: {lbl} marks it unsupported on the {} side", input.side)));
            continue;
        }
        let project_id = js::string(&project["id"]);
        let version = match &item.version_id {
            Some(v) => api.version(v, Some(&project_id)).map(|ver| {
                if !has(&ver, "loaders", input.loader) || !has(&ver, "game_versions", input.minecraft) {
                    issues.push(issue("warning", format!("{title} {} does not declare {} {} support on {lbl}", js::string(&ver["version_number"]), input.loader, input.minecraft)));
                }
                Some(ver)
            }),
            None => api.versions(&project_id, input.loader, input.minecraft).map(|all| pick_version(&all, input.loader, input.minecraft).cloned()),
        };
        let version = match version {
            Ok(Some(v)) => v,
            Ok(None) => {
                issues.push(issue(sev(item.required), format!("{title} has no {} version for Minecraft {} on {lbl} ({})", input.loader, input.minecraft, item.reason)));
                continue;
            }
            Err(e) => {
                issues.push(issue(sev(item.required), format!("Could not fetch versions for {title}: {e}")));
                continue;
            }
        };
        let Some(file) = primary_file(&version) else {
            issues.push(issue("error", format!("{title} {} has no downloadable file", js::string(&version["version_number"]))));
            continue;
        };
        let version_id = js::string(&version["id"]);
        chosen.push((key.clone(), (version_id.clone(), item.pinned, item.reason.clone())));
        let mut entry = Map::new();
        entry.insert("key".into(), json!(key));
        entry.insert("provider".into(), json!(item.provider));
        entry.insert("projectId".into(), project["id"].clone());
        entry.insert("versionId".into(), version["id"].clone());
        entry.insert("versionNumber".into(), version["version_number"].clone());
        entry.insert("title".into(), project["title"].clone());
        entry.insert("fileName".into(), file["filename"].clone());
        if js::truthy(file.get("url")) {
            entry.insert("url".into(), file["url"].clone());
        }
        if js::truthy(file["hashes"].get("sha1")) {
            entry.insert("sha1".into(), file["hashes"]["sha1"].clone());
        }
        if js::truthy(file["hashes"].get("sha512")) {
            entry.insert("sha512".into(), file["hashes"]["sha512"].clone());
        }
        if let Some(size) = file.get("size") {
            entry.insert("size".into(), size.clone());
        }
        entry.insert("modIds".into(), json!([]));
        if let Some(l) = project.get("license").filter(|l| !l.is_null()).and_then(|l| l.get("id")) {
            entry.insert("license".into(), l.clone());
        }
        let mut environment = Map::new();
        if let Some(c) = project.get("client_side") {
            environment.insert("client".into(), c.clone());
        }
        if let Some(c) = project.get("server_side") {
            environment.insert("server".into(), c.clone());
        }
        entry.insert("environment".into(), Value::Object(environment));
        let distribution = version.get("distribution").filter(|d| !d.is_null()).cloned().unwrap_or_else(|| json!("direct"));
        entry.insert("distribution".into(), distribution.clone());
        if let Some(m) = version.get("manualUrl") {
            entry.insert("manualUrl".into(), m.clone());
        }
        entry.insert("reason".into(), json!(item.reason));
        entry.insert("required".into(), json!(item.required));
        entries.push(Value::Object(entry));
        if distribution == "manual" {
            issues.push(issue(
                "warning",
                format!(
                    "{title}: the author does not allow third-party downloads. Download {} manually from {} and provide it with Mods > Provide downloaded file.",
                    js::string(&file["filename"]),
                    version.get("manualUrl").map(js::string).unwrap_or_else(|| "undefined".into())
                ),
            ));
        }
        for dep in version["dependencies"].as_array().cloned().unwrap_or_default() {
            let kind = dep["dependency_type"].as_str().unwrap_or_default();
            if kind == "embedded" {
                continue;
            }
            let mut dep_project = st(&dep, "project_id").filter(|s| !s.is_empty());
            let dep_version = st(&dep, "version_id").filter(|s| !s.is_empty());
            if dep_project.is_none() {
                if let Some(v) = &dep_version {
                    dep_project = api.version(v, None).ok().and_then(|ver| st(&ver, "project_id"));
                }
            }
            let Some(dep_project) = dep_project else { continue };
            match kind {
                "required" => {
                    queue.push_back(Item { provider: item.provider, project_id: dep_project, version_id: dep_version, reason: format!("required by {title}"), required: true, pinned: false })
                }
                "optional" => optional.push(json!({ "projectId": dep_project, "provider": item.provider, "requestedBy": project["title"] })),
                "incompatible" => incompatibilities.push((format!("{}:{dep_project}", item.provider), title.clone())),
                _ => {}
            }
        }
    }

    for e in entries.iter_mut() {
        let provider = e["provider"].as_str().unwrap_or_default().to_string();
        if provider != "modrinth" && provider != "curseforge" {
            continue;
        }
        let key = js::string(&e["key"]);
        let title = js::string(&e["title"]);
        let required = e["required"] == true;
        let f = match (env.fetch_file)(e) {
            Ok(f) => f,
            Err(err) => {
                let what = if e["distribution"] == "manual" { "Manual file missing" } else { "Download failed" };
                issues.push(issue(sev(required), format!("{what} for {title}: {err}")));
                continue;
            }
        };
        files.insert(key.clone(), json!(f));
        let file_name = js::string(&e["fileName"]);
        let meta = match (env.read_metadata)(&f) {
            Ok(m) => m,
            Err(err) => {
                metadata.insert(key, json!([]));
                issues.push(issue("warning", format!("Could not read the mod metadata of {file_name}: {err}. It is still loaded; its dependencies were not checked.")));
                continue;
            }
        };
        if let Some(o) = e.as_object_mut() {
            o.insert("modIds".into(), json!(all_mod_ids(&meta)));
        }
        if meta.is_empty() {
            issues.push(issue("warning", format!("{file_name} has no recognizable mod metadata")));
        } else if meta[0]["loader"] != input.loader {
            issues.push(issue("error", format!("{file_name} is a {} mod, not {}", js::string(&meta[0]["loader"]), input.loader)));
        }
        metadata.insert(key, Value::Array(meta));
    }

    for (key, by) in &incompatibilities {
        if chosen.iter().any(|(k, _)| k == key) {
            let other = entries.iter().find(|e| e["key"] == key.as_str()).map(|e| js::string(&e["title"])).unwrap_or_else(|| key.clone());
            issues.push(issue("error", format!("{by} declares {other} incompatible")));
        }
    }

    let mut provided: Vec<String> = input.provided_mod_ids.clone();
    for e in &input.extra_entries {
        for id in e["modIds"].as_array().into_iter().flatten() {
            provided.push(js::string(id));
        }
    }
    let mut i = entries.len();
    while i > 0 {
        i -= 1;
        let reason = js::string(&entries[i]["reason"]);
        if !reason.starts_with("pack ") && !reason.starts_with("linked pack ") {
            continue;
        }
        let key = js::string(&entries[i]["key"]);
        let own: Vec<String> = metadata
            .get(&key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .flat_map(|m| std::iter::once(js::string(&m["id"])).chain(m["provides"].as_array().into_iter().flatten().map(js::string)))
            .collect();
        let Some(clash) = own.into_iter().find(|id| provided.contains(id)) else { continue };
        let title = js::string(&entries[i]["title"]);
        entries.remove(i);
        files.shift_remove(&key);
        metadata.shift_remove(&key);
        chosen.retain(|(k, _)| *k != key);
        let pack = regex::Regex::new(r"^(linked )?pack ").unwrap().replace(&reason, "").to_string();
        issues.push(issue("info", format!("{title} from the {pack} pack not loaded: \"{clash}\" comes from this project's development build instead")));
    }

    let loader_ids: Vec<&str> = match input.loader {
        "neoforge" => vec!["neoforge"],
        "forge" => vec!["forge"],
        _ => vec!["fabricloader"],
    };
    let mut graph_provided = input.provided_mod_ids.clone();
    for id in loader_ids {
        if !input.provided_mod_ids.iter().any(|p| p == id) {
            graph_provided.push(id.to_string());
        }
    }
    issues.extend(check_mod_graph(&entries, &metadata, &graph_provided));
    Output { entries, issues, files, optional_suggestions: optional }
}

fn push_unique(list: &mut Vec<(String, Vec<String>)>, key: &str, value: String, dedupe: bool) {
    match list.iter_mut().find(|(k, _)| k == key) {
        Some((_, v)) => {
            if !dedupe || !v.contains(&value) {
                v.push(value);
            }
        }
        None => list.push((key.to_string(), vec![value])),
    }
}

pub fn check_mod_graph(entries: &[Value], metadata: &Map<String, Value>, provided: &[String]) -> Vec<Value> {
    let mut issues = Vec::new();
    let mut owners: Vec<(String, Vec<String>)> = Vec::new();
    let mut top: Vec<(String, Vec<String>)> = Vec::new();
    let meta_of = |e: &Value| metadata.get(&js::string(&e["key"])).and_then(Value::as_array).cloned().unwrap_or_default();
    for e in entries {
        let title = js::string(&e["title"]);
        for m in meta_of(e) {
            push_unique(&mut top, &js::string(&m["id"]), title.clone(), false);
        }
        for id in e["modIds"].as_array().into_iter().flatten() {
            push_unique(&mut owners, &js::string(id), title.clone(), true);
        }
    }
    for (id, list) in &top {
        if list.len() > 1 {
            issues.push(issue("error", format!("Duplicate mod ID \"{id}\" provided by: {}", list.join(", "))));
        }
        if provided.contains(id) {
            issues.push(issue("error", format!("Mod ID \"{id}\" from {} duplicates a mod on the development classpath", list.join(", "))));
        }
    }
    let mut names: Vec<(String, Vec<String>)> = Vec::new();
    for e in entries {
        push_unique(&mut names, &js::string(&e["fileName"]).to_lowercase(), js::string(&e["title"]), false);
    }
    for (name, list) in &names {
        if list.len() > 1 {
            issues.push(issue("error", format!("Conflicting file name {name} from: {}", list.join(", "))));
        }
    }
    let mut hashes: Vec<(String, Vec<String>)> = Vec::new();
    for e in entries {
        let Some(sha1) = e.get("sha1").filter(|s| js::truthy(Some(s))) else { continue };
        push_unique(&mut hashes, &js::string(sha1), format!("{} ({})", js::string(&e["title"]), js::string(&e["provider"])), false);
    }
    for (_, list) in &hashes {
        if list.len() > 1 {
            issues.push(issue("error", format!("The same file is included more than once: {}", list.join(", "))));
        }
    }
    let mut available: Vec<String> = owners.iter().map(|(k, _)| k.clone()).collect();
    available.extend(provided.iter().cloned());
    available.extend(["minecraft", "java", "fabricloader"].map(String::from));
    let mut versions: Vec<(String, Vec<(String, String)>)> = Vec::new();
    fn add_versions(title: &str, m: &Value, versions: &mut Vec<(String, Vec<(String, String)>)>) {
        let ids = std::iter::once(js::string(&m["id"])).chain(m["provides"].as_array().into_iter().flatten().map(js::string)).collect::<Vec<_>>();
        for id in ids {
            let entry = (title.to_string(), js::string(&m["version"]));
            match versions.iter_mut().find(|(k, _)| *k == id) {
                Some((_, v)) => v.push(entry),
                None => versions.push((id, vec![entry])),
            }
        }
        for n in m["nested"].as_array().into_iter().flatten() {
            add_versions(title, n, versions);
        }
    }
    for e in entries {
        for m in meta_of(e) {
            add_versions(&js::string(&e["title"]), &m, &mut versions);
        }
    }
    for e in entries {
        let title = js::string(&e["title"]);
        for m in meta_of(e) {
            let mid = js::string(&m["id"]);
            for dep in m["depends"].as_object().into_iter().flatten().map(|(k, _)| k.clone()) {
                if !available.contains(&dep) {
                    issues.push(issue("warning", format!("{title} ({mid}) declares a dependency on \"{dep}\" which is not present. Version ranges were not evaluated.")));
                }
            }
            let rules: Vec<(String, String, bool)> = m["breaks"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, v)| (k.clone(), js::string(v), true))
                .chain(m["conflicts"].as_object().into_iter().flatten().map(|(k, v)| (k.clone(), js::string(v), false)))
                .collect();
            for (b, range, hard) in rules {
                let Some((_, owner_list)) = owners.iter().find(|(k, _)| *k == b) else { continue };
                let present = versions.iter().find(|(k, _)| *k == b).map(|(_, v)| v.clone()).unwrap_or_default();
                let verdicts: Vec<Option<bool>> = if present.is_empty() { vec![None] } else { present.iter().map(|(_, v)| satisfies(v, &range)).collect() };
                if verdicts.iter().all(|v| *v == Some(false)) {
                    continue;
                }
                let kind = if hard { "breaking" } else { "conflicting" };
                let which = if present.is_empty() { owner_list.join(", ") } else { present.iter().map(|(t, v)| format!("{t} {v}")).collect::<Vec<_>>().join(", ") };
                let known = verdicts.contains(&Some(true));
                let range_text = if !range.is_empty() && range != "*" { format!(" for versions {range}") } else { String::new() };
                issues.push(issue(
                    if hard && known { "error" } else { "warning" },
                    format!(
                        "{title} ({mid}) declares \"{b}\" as {kind}{range_text}, and {}: {which}",
                        if known { "a matching version is present" } else { "it is present (version range could not be checked)" }
                    ),
                ));
            }
        }
    }
    issues
}
