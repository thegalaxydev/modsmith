use crate::http::{encode_uri_component, js_slice, post_bytes, request, Response, USER_AGENT};
use crate::js;
use crate::manifest;
use crate::providers::modrinth_api;
use crate::rt::Runtime;
use crate::secrets::{self, SecretStore};
use crate::workspace;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::sync::Arc;

const PROVIDERS: [&str; 2] = ["modrinth", "curseforge"];

struct TokenMeta {
    secret: &'static str,
    env: &'static str,
    label: &'static str,
}

fn meta(provider: &str) -> TokenMeta {
    if provider == "modrinth" {
        TokenMeta { secret: "modrinth.token", env: "MODSMITH_MODRINTH_TOKEN", label: "Modrinth" }
    } else {
        TokenMeta { secret: "curseforge.uploadToken", env: "MODSMITH_CURSEFORGE_UPLOAD_TOKEN", label: "CurseForge" }
    }
}

fn label(provider: &str) -> &'static str {
    meta(provider).label
}

fn loader_name(loader: &str) -> String {
    match loader {
        "fabric" => "Fabric".into(),
        "neoforge" => "NeoForge".into(),
        "forge" => "Forge".into(),
        "quilt" => "Quilt".into(),
        other => other.to_string(),
    }
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn cf_upload_api() -> String {
    env_value("MODSMITH_CURSEFORGE_UPLOAD_API").unwrap_or_else(|| "https://minecraft.curseforge.com".into())
}

fn error_text(body: &str) -> String {
    if let Ok(j) = serde_json::from_str::<Value>(body) {
        for k in ["description", "errorMessage", "error"] {
            if let Some(msg) = j.get(k).and_then(Value::as_str).filter(|m| !m.is_empty()) {
                return js_slice(msg, 200);
            }
        }
    }
    js_slice(body, 200)
}

pub fn multipart(field: &str, json: &str, file_name: &str, bytes: &[u8]) -> (Vec<u8>, String) {
    let boundary = format!("ModsmithBoundary{}", &hex::encode(Sha256::digest(bytes))[..16]);
    let safe: String = file_name.chars().map(|c| if c == '"' || c == '\r' || c == '\n' { '_' } else { c }).collect();
    let head = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"\r\nContent-Type: application/json\r\n\r\n{json}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{safe}\"\r\nContent-Type: application/java-archive\r\n\r\n"
    );
    let mut body = head.into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (body, format!("multipart/form-data; boundary={boundary}"))
}

pub fn modrinth_ref(input: &str) -> String {
    let re = regex::Regex::new(r"modrinth\.com/(?:mod|plugin|datapack|resourcepack|shader|modpack|project)/([^/?#]+)").expect("modrinth url regex");
    re.captures(input).map(|c| c[1].to_string()).unwrap_or_else(|| input.to_string()).trim().to_string()
}

pub fn link_url(provider: &str, link: &Value) -> String {
    let id = js::string(&link["id"]);
    let slug = link.get("slug").and_then(Value::as_str);
    if provider == "modrinth" {
        return format!("https://modrinth.com/mod/{}", slug.unwrap_or(&id));
    }
    match slug {
        Some(s) => format!("https://www.curseforge.com/minecraft/mc-mods/{s}"),
        None => format!("https://www.curseforge.com/projects/{id}"),
    }
}

fn with_url(provider: &str, link: &Value) -> Value {
    let mut o = link.as_object().cloned().unwrap_or_default();
    o.insert("url".into(), json!(link_url(provider, link)));
    Value::Object(o)
}

fn store(rt: &Runtime) -> SecretStore {
    SecretStore::new(rt.data.join("secrets.json"))
}

fn rejected(provider: &str) -> String {
    format!("{} rejected the upload token; add a new one in Project settings", label(provider))
}

fn answered(provider: &str, res: &Response) -> String {
    format!("{} answered HTTP {}: {}", label(provider), res.status, error_text(&res.body))
}

struct Job {
    bytes: Vec<u8>,
    file_name: String,
    name: String,
    version: String,
    changelog: String,
    release_type: String,
    game_versions: Vec<String>,
    loaders: Vec<String>,
}

fn upload_modrinth(link: &Value, token: &str, job: &Job) -> Result<(String, String), String> {
    let id = js::string(&link["id"]);
    let data = json!({
        "changelog": job.changelog,
        "dependencies": [],
        "featured": true,
        "file_parts": ["file"],
        "game_versions": job.game_versions,
        "loaders": job.loaders,
        "name": job.name,
        "primary_file": "file",
        "project_id": id,
        "version_number": job.version,
        "version_type": job.release_type
    })
    .to_string();
    let (body, content_type) = multipart("data", &data, &job.file_name, &job.bytes);
    let res = post_bytes(&format!("{}/version", modrinth_api()), &[("Authorization", token), ("User-Agent", USER_AGENT), ("Accept", "application/json"), ("Content-Type", &content_type)], body)?;
    if res.status == 401 {
        return Err(rejected("modrinth"));
    }
    if !res.ok() {
        return Err(answered("modrinth", &res));
    }
    let v: Value = serde_json::from_str(&res.body).map_err(|e| e.to_string())?;
    let vid = js::string(&v["id"]);
    let slug = link.get("slug").and_then(Value::as_str).map(str::to_string).unwrap_or(id);
    Ok((vid.clone(), format!("https://modrinth.com/mod/{slug}/version/{vid}")))
}

fn upload_curseforge(link: &Value, token: &str, job: &Job) -> Result<(String, String), String> {
    let headers = [("X-Api-Token", token), ("User-Agent", USER_AGENT), ("Accept", "application/json")];
    let get = |path: &str| -> Result<Value, String> {
        let res = request("GET", &format!("{}{path}", cf_upload_api()), &headers, None)?;
        if res.status == 401 || res.status == 403 {
            return Err(rejected("curseforge"));
        }
        if !res.ok() {
            return Err(answered("curseforge", &res));
        }
        serde_json::from_str(&res.body).map_err(|e| e.to_string())
    };
    let types = get("/api/game/version-types")?;
    let versions = get("/api/game/versions")?;
    let type_ids = |pred: &dyn Fn(&str) -> bool| -> Vec<i64> { types.as_array().into_iter().flatten().filter(|t| pred(t["slug"].as_str().unwrap_or_default())).filter_map(|t| t["id"].as_i64()).collect() };
    let mc_types = type_ids(&|s| s.starts_with("minecraft-"));
    let loader_types = type_ids(&|s| s == "modloader");
    let list = versions.as_array().cloned().unwrap_or_default();
    let mut ids: Vec<i64> = Vec::new();
    for gv in &job.game_versions {
        let v = list.iter().find(|x| x["gameVersionTypeID"].as_i64().is_some_and(|t| mc_types.contains(&t)) && x["name"].as_str() == Some(gv.as_str())).ok_or_else(|| format!("CurseForge does not list Minecraft {gv}"))?;
        ids.push(v["id"].as_i64().unwrap_or_default());
    }
    for loader in &job.loaders {
        let name = loader_name(loader);
        let v = list
            .iter()
            .find(|x| x["gameVersionTypeID"].as_i64().is_some_and(|t| loader_types.contains(&t)) && x["name"].as_str().is_some_and(|n| n.to_lowercase() == name.to_lowercase()))
            .ok_or_else(|| format!("CurseForge does not list the {name} loader"))?;
        ids.push(v["id"].as_i64().unwrap_or_default());
    }
    let metadata = json!({ "changelog": job.changelog, "changelogType": "markdown", "displayName": job.name, "gameVersions": ids, "releaseType": job.release_type }).to_string();
    let (body, content_type) = multipart("metadata", &metadata, &job.file_name, &job.bytes);
    let id = js::string(&link["id"]);
    let res = post_bytes(&format!("{}/api/projects/{id}/upload-file", cf_upload_api()), &[headers[0], headers[1], headers[2], ("Content-Type", &content_type)], body)?;
    if res.status == 401 || res.status == 403 {
        return Err(rejected("curseforge"));
    }
    if !res.ok() {
        return Err(answered("curseforge", &res));
    }
    let f: Value = serde_json::from_str(&res.body).map_err(|e| e.to_string())?;
    let fid = js::string(&f["id"]);
    let page = match link.get("slug").and_then(Value::as_str) {
        Some(slug) => format!("https://www.curseforge.com/minecraft/mc-mods/{slug}/files/{fid}"),
        None => format!("https://www.curseforge.com/projects/{id}"),
    };
    Ok((fid, page))
}

impl Runtime {
    fn publish_token(&self, provider: &str) -> Option<String> {
        let m = meta(provider);
        if let Some(t) = env_value(m.env) {
            return Some(t);
        }
        if secrets::supported() {
            store(self).get(m.secret).ok().flatten()
        } else {
            None
        }
    }

    fn publish_token_source(&self, provider: &str) -> Value {
        let m = meta(provider);
        if env_value(m.env).is_some() {
            json!("environment")
        } else if store(self).has(m.secret) {
            json!("os-secret-store")
        } else {
            Value::Null
        }
    }

    pub fn publish_status(&self, root: &str) -> Result<Value, String> {
        let dir = workspace::normalize(root);
        let m = manifest::require_manifest(&dir, &dir.to_string_lossy())?;
        let mut out = Map::new();
        out.insert("storage".into(), if secrets::supported() { json!(secrets::storage_short()) } else { Value::Null });
        for p in PROVIDERS {
            let link = &m["publish"][p];
            out.insert(p.into(), json!({ "project": if link.is_object() { with_url(p, link) } else { Value::Null }, "token": self.publish_token_source(p) }));
        }
        Ok(Value::Object(out))
    }

    pub fn publish_link(&self, root: &str, provider: &str, project: Option<&str>) -> Result<Value, String> {
        let dir = workspace::normalize(root);
        let mut m = manifest::require_manifest(&dir, &dir.to_string_lossy())?;
        let mut link: Option<Value> = None;
        if let Some(input) = project.filter(|p| !p.trim().is_empty()) {
            if provider == "modrinth" {
                let r = modrinth_ref(input);
                let res = request("GET", &format!("{}/project/{}", modrinth_api(), encode_uri_component(&r)), &[("User-Agent", USER_AGENT), ("Accept", "application/json")], None)?;
                if res.status == 404 {
                    return Err(format!("Modrinth has no project {r}"));
                }
                if !res.ok() {
                    return Err(answered("modrinth", &res));
                }
                let p: Value = serde_json::from_str(&res.body).map_err(|e| e.to_string())?;
                if let Some(kind) = p["project_type"].as_str().filter(|k| !k.is_empty() && *k != "mod") {
                    return Err(format!("{} is a {kind} on Modrinth, not a mod", p["title"].as_str().map(str::to_string).unwrap_or(r)));
                }
                let mut o = Map::new();
                o.insert("id".into(), json!(js::string(&p["id"])));
                for k in ["slug", "title"] {
                    if let Some(v) = p[k].as_str() {
                        o.insert(k.into(), json!(v));
                    }
                }
                link = Some(Value::Object(o));
            } else {
                let id = input.trim().to_string();
                if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
                    return Err("Enter the numeric Project ID from the About Project box on your CurseForge project page".into());
                }
                let mut o = Map::new();
                o.insert("id".into(), json!(id));
                if self.providers.cf_key().is_some() {
                    let md = self.providers.cf_mod(&id).map_err(|_| format!("CurseForge has no project {id}"))?;
                    for (k, from) in [("slug", "slug"), ("title", "name")] {
                        if let Some(v) = md[from].as_str() {
                            o.insert(k.into(), json!(v));
                        }
                    }
                }
                link = Some(Value::Object(o));
            }
        }
        let obj = m.as_object_mut().ok_or("Invalid manifest")?;
        let mut publish = obj.get("publish").and_then(Value::as_object).cloned().unwrap_or_default();
        match &link {
            Some(l) => {
                publish.insert(provider.into(), l.clone());
            }
            None => {
                publish.remove(provider);
            }
        }
        if publish.is_empty() {
            obj.remove("publish");
        } else {
            obj.insert("publish".into(), Value::Object(publish));
        }
        manifest::write_manifest(&dir, &m)?;
        Ok(link.map(|l| with_url(provider, &l)).unwrap_or(Value::Null))
    }

    pub fn publish_set_token(&self, provider: &str, token: &str) -> Result<Value, String> {
        let m = meta(provider);
        if !secrets::supported() {
            return Err(format!("OS secret storage is not available on this platform; set {} instead", m.env));
        }
        let res = if provider == "modrinth" {
            request("GET", &format!("{}/user", modrinth_api()), &[("Authorization", token), ("User-Agent", USER_AGENT), ("Accept", "application/json")], None)?
        } else {
            request("GET", &format!("{}/api/game/version-types", cf_upload_api()), &[("X-Api-Token", token), ("User-Agent", USER_AGENT), ("Accept", "application/json")], None)?
        };
        if res.status == 401 || res.status == 403 {
            return Err(format!("{} rejected this token", m.label));
        }
        if !res.ok() {
            return Err(format!("Could not verify the token (HTTP {})", res.status));
        }
        store(self).set(m.secret, token)?;
        Ok(json!({ "stored": true, "storage": secrets::storage_short() }))
    }

    pub fn publish_clear_token(&self, provider: &str) -> Result<Value, String> {
        store(self).delete(meta(provider).secret)?;
        Ok(json!({ "cleared": true }))
    }

    pub fn project_publish(self: &Arc<Self>, p: &Value) -> Result<Value, String> {
        let dir = workspace::normalize(p["path"].as_str().unwrap_or_default());
        let m = manifest::require_manifest(&dir, &dir.to_string_lossy())?;
        let file_name = js::string(&p["file"]);
        if !file_name.ends_with(".jar") || file_name.contains('/') || file_name.contains('\\') || file_name.starts_with('.') {
            return Err(format!("{file_name} is not a JAR in build/libs"));
        }
        let file = manifest::target_dir(&dir, Some(&m))?.join("build").join("libs").join(&file_name);
        if !file.exists() {
            return Err(format!("{file_name} is not in build/libs; build the project first"));
        }
        let wanted: Vec<String> = p["targets"].as_array().into_iter().flatten().map(js::string).collect();
        let targets: Vec<&str> = PROVIDERS.into_iter().filter(|t| wanted.iter().any(|w| w == t)).collect();
        if targets.is_empty() {
            return Err("Choose where to publish".into());
        }
        let mut tokens: Vec<(String, String)> = Vec::new();
        for t in &targets {
            if !m["publish"][*t].is_object() {
                return Err(format!("Link a {} project in Project settings first", label(t)));
            }
            match self.publish_token(t) {
                Some(tok) => tokens.push((t.to_string(), tok)),
                None => return Err(format!("Add a {} upload token in Project settings first", label(t))),
            }
        }
        let version = p["version"].as_str().unwrap_or_default().trim().to_string();
        if version.is_empty() {
            return Err("Enter a version number".into());
        }
        let list = |key: &str, fallback: &Value| -> Vec<String> {
            let v: Vec<String> = p[key].as_array().into_iter().flatten().map(js::string).collect();
            if v.is_empty() {
                vec![js::string(fallback)]
            } else {
                v
            }
        };
        let name = p["name"].as_str().map(str::trim).filter(|n| !n.is_empty()).map(str::to_string).unwrap_or_else(|| format!("{} {version}", js::string(&m["name"])));
        let job = Job {
            bytes: fs::read(&file).map_err(|e| js::fs_error(&e, "open", &file))?,
            file_name: file_name.clone(),
            name: name.clone(),
            version,
            changelog: p["changelog"].as_str().unwrap_or_default().to_string(),
            release_type: p["releaseType"].as_str().unwrap_or("release").to_string(),
            game_versions: list("gameVersions", &m["platform"]["minecraft"]),
            loaders: list("loaders", &m["platform"]["loader"]),
        };
        let links = m["publish"].clone();
        let count = targets.len();
        let targets: Vec<String> = targets.into_iter().map(str::to_string).collect();
        Ok(self.ops.start("project.publish", &format!("Publish {name}"), Some(dir.to_string_lossy().to_string()), move |ctx| {
            let mut results: Vec<Value> = Vec::new();
            for (i, t) in targets.iter().enumerate() {
                ctx.progress(Some(i as f64 / count as f64), Some(&format!("Uploading to {}", label(t))));
                let token = tokens.iter().find(|(p, _)| p == t).map(|(_, tok)| tok.as_str()).unwrap_or_default();
                let r = if t == "modrinth" { upload_modrinth(&links["modrinth"], token, &job) } else { upload_curseforge(&links["curseforge"], token, &job) };
                match r {
                    Ok((id, url)) => {
                        ctx.log(&format!("{}: published {} ({url})", label(t), job.file_name));
                        results.push(json!({ "provider": t, "ok": true, "id": id, "url": url }));
                    }
                    Err(error) => {
                        ctx.log(&format!("{}: {error}", label(t)));
                        results.push(json!({ "provider": t, "ok": false, "error": error }));
                    }
                }
            }
            if results.iter().all(|r| r["ok"] != true) {
                return Err(results.iter().map(|r| format!("{}: {}", label(r["provider"].as_str().unwrap_or_default()), js::string(&r["error"]))).collect::<Vec<_>>().join("; "));
            }
            Ok(Some(json!({ "results": results })))
        }))
    }
}
