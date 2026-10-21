use crate::http::{encode_uri_component, query, request, Http};
use crate::js;
use crate::manifest::{schemas, Catalog};
use crate::schema;
use crate::secrets::{self, SecretStore};
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const CF_KEY: &str = "curseforge.apiKey";
const CLASS_MODS: i64 = 6;
pub const CLASS_MODPACKS: i64 = 4471;

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| default.to_string())
}

pub fn modrinth_api() -> String {
    env_or("MODSMITH_MODRINTH_API", "https://api.modrinth.com/v2")
}

pub fn curseforge_api() -> String {
    env_or("MODSMITH_CURSEFORGE_API", "https://api.curseforge.com/v1")
}

fn fabric_meta() -> String {
    env_or("MODSMITH_FABRIC_META", "https://meta.fabricmc.net/v2")
}

fn neoforge_versions() -> String {
    env_or("MODSMITH_NEOFORGE_VERSIONS", "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge")
}

fn loader_type(loader: &str) -> Option<i64> {
    match loader {
        "forge" => Some(1),
        "fabric" => Some(4),
        "quilt" => Some(5),
        "neoforge" => Some(6),
        _ => None,
    }
}

fn loader_name(loader: &str) -> Option<&'static str> {
    match loader {
        "forge" => Some("Forge"),
        "fabric" => Some("Fabric"),
        "quilt" => Some("Quilt"),
        "neoforge" => Some("NeoForge"),
        _ => None,
    }
}

fn present(v: Option<&Value>) -> Option<&Value> {
    v.filter(|x| !x.is_null())
}

fn coalesce(a: Option<&Value>, b: Option<&Value>) -> Option<Value> {
    present(a).or(b).cloned()
}

fn put(m: &mut Map<String, Value>, key: &str, v: Option<Value>) {
    if let Some(v) = v {
        m.insert(key.to_string(), v);
    }
}

fn js_join(items: &[Value], sep: &str) -> String {
    items.iter().map(|i| if i.is_null() { String::new() } else { js::string(i) }).collect::<Vec<_>>().join(sep)
}

pub fn date_parse(s: &str) -> f64 {
    let re = regex::Regex::new(r"^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?)?$").unwrap();
    let Some(c) = re.captures(s.trim()) else { return f64::NAN };
    let n = |i: usize| c.get(i).map(|m| m.as_str().parse::<i64>().unwrap_or(0)).unwrap_or(0);
    let (y, mo, d) = (n(1), n(2), n(3));
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return f64::NAN;
    }
    let ms = c.get(7).map(|m| format!("{:0<3}", &m.as_str()[..m.as_str().len().min(3)]).parse::<i64>().unwrap_or(0)).unwrap_or(0);
    let days = {
        let (y, m) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let doy = (153 * m + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146097 + doe - 719468
    };
    let mut t = days * 86_400_000 + n(4) * 3_600_000 + n(5) * 60_000 + n(6) * 1000 + ms;
    if let Some(z) = c.get(8).map(|m| m.as_str()).filter(|z| *z != "Z") {
        let sign = if z.starts_with('-') { -1 } else { 1 };
        let off = z[1..3].parse::<i64>().unwrap_or(0) * 60 + z[4..6].parse::<i64>().unwrap_or(0);
        t -= sign * off * 60_000;
    } else if c.get(8).is_none() && c.get(4).is_some() {
        return f64::NAN;
    }
    t as f64
}

fn ordering(x: f64) -> std::cmp::Ordering {
    if x.is_nan() || x == 0.0 {
        std::cmp::Ordering::Equal
    } else if x < 0.0 {
        std::cmp::Ordering::Less
    } else {
        std::cmp::Ordering::Greater
    }
}

pub fn pick_version<'a>(versions: &'a [Value], loader: &str, minecraft: &str) -> Option<&'a Value> {
    let rank = |v: &Value| match v["version_type"].as_str() {
        Some("release") => 0.0,
        Some("beta") => 1.0,
        Some("alpha") => 2.0,
        _ => f64::NAN,
    };
    let has = |v: &Value, key: &str, item: &str| v[key].as_array().is_some_and(|a| a.iter().any(|x| x == item));
    let mut ok: Vec<&Value> = versions.iter().filter(|v| has(v, "loaders", loader) && has(v, "game_versions", minecraft)).collect();
    ok.sort_by(|a, b| {
        let r = rank(a) - rank(b);
        if r != 0.0 && !r.is_nan() {
            return ordering(r);
        }
        ordering(date_parse(b["date_published"].as_str().unwrap_or("")) - date_parse(a["date_published"].as_str().unwrap_or("")))
    });
    ok.first().copied()
}

pub fn pick_cf_file<'a>(files: &'a [Value], loader: &str, minecraft: &str) -> Option<&'a Value> {
    let name = loader_name(loader);
    let has = |f: &Value, item: &str| f["gameVersions"].as_array().is_some_and(|a| a.iter().any(|x| x == item));
    let mut ok: Vec<&Value> = files.iter().filter(|f| f["isAvailable"] != false && !js::truthy(f.get("isServerPack")) && has(f, minecraft) && name.is_none_or(|n| has(f, n))).collect();
    ok.sort_by(|a, b| {
        let r = a["releaseType"].as_f64().unwrap_or(f64::NAN) - b["releaseType"].as_f64().unwrap_or(f64::NAN);
        if r != 0.0 && !r.is_nan() {
            return ordering(r);
        }
        ordering(date_parse(b["fileDate"].as_str().unwrap_or("")) - date_parse(a["fileDate"].as_str().unwrap_or("")))
    });
    ok.first().copied()
}

pub fn cf_distributable(m: &Value, f: &Value) -> bool {
    js::truthy(f.get("downloadUrl")) && m.get("allowModDistribution") != Some(&Value::Bool(false))
}

pub struct Providers {
    pub http: Http,
    secrets: SecretStore,
    cf_key: Mutex<Option<Option<String>>>,
    data_dir: PathBuf,
    catalog: Arc<Catalog>,
}

impl Providers {
    pub fn new(http: Http, data_dir: PathBuf, catalog: Arc<Catalog>) -> Providers {
        Providers { http, secrets: SecretStore::new(data_dir.join("secrets.json")), cf_key: Mutex::new(None), data_dir, catalog }
    }

    pub fn http(&self) -> &Http {
        &self.http
    }

    pub fn cf_key(&self) -> Option<String> {
        if let Some(k) = std::env::var("MODSMITH_CURSEFORGE_API_KEY").ok().filter(|v| !v.is_empty()) {
            return Some(k);
        }
        let mut slot = self.cf_key.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_none() {
            *slot = Some(if secrets::supported() { self.secrets.get(CF_KEY).ok().flatten() } else { None });
        }
        slot.clone().flatten().filter(|k| !k.is_empty())
    }

    fn reset_cf_key(&self) {
        *self.cf_key.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    fn require_cf_key(&self) -> Result<String, String> {
        self.cf_key().ok_or_else(|| {
            "CurseForge requires an API key from the CurseForge for Studios console (console.curseforge.com). Add it in Settings > Providers or set MODSMITH_CURSEFORGE_API_KEY.".to_string()
        })
    }

    fn cf_get(&self, path_and_query: &str, max_age: i64) -> Result<Value, String> {
        let key = self.require_cf_key()?;
        let res = self.http.get_json(&format!("{}{path_and_query}", curseforge_api()), max_age, &[("x-api-key", &key)])?;
        Ok(res.data["data"].clone())
    }

    pub fn provider_status(&self) -> Value {
        let configured = self.cf_key().is_some();
        let source = if std::env::var("MODSMITH_CURSEFORGE_API_KEY").ok().is_some_and(|v| !v.is_empty()) {
            json!("environment")
        } else if self.secrets.has(CF_KEY) {
            json!("os-secret-store")
        } else {
            Value::Null
        };
        json!({ "providers": [
            { "id": "modrinth", "name": "Modrinth", "usable": true, "detail": "Public API, no key required" },
            {
                "id": "curseforge",
                "name": "CurseForge",
                "usable": configured,
                "keySource": source,
                "detail": if configured { "API key configured. Files whose authors disallow third-party distribution must be downloaded manually." } else { "Requires your own API key from the CurseForge for Studios console (console.curseforge.com). Modsmith does not ship one." },
                "secretStorage": if secrets::supported() { secrets::storage_label() } else { "unavailable; use MODSMITH_CURSEFORGE_API_KEY" }
            }
        ] })
    }

    pub fn set_cf_key(&self, key: &str) -> Result<Value, String> {
        if !secrets::supported() {
            return Err("OS secret storage is not available on this platform; set MODSMITH_CURSEFORGE_API_KEY instead".into());
        }
        let probe = request("GET", &format!("{}/games/432", curseforge_api()), &[("x-api-key", key), ("Accept", "application/json")], None)?;
        if probe.status == 403 || probe.status == 401 {
            return Err("CurseForge rejected this API key".into());
        }
        if !probe.ok() {
            return Err(format!("Could not verify the key (HTTP {})", probe.status));
        }
        self.secrets.set(CF_KEY, key)?;
        self.reset_cf_key();
        Ok(json!({ "stored": true, "storage": secrets::storage_short() }))
    }

    pub fn clear_cf_key(&self) -> Result<Value, String> {
        self.secrets.delete(CF_KEY)?;
        self.reset_cf_key();
        Ok(json!({ "cleared": true }))
    }

    fn modrinth_search(
        &self,
        q: &str,
        loader: Option<&str>,
        minecraft: Option<&str>,
        project_type: &str,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<(Value, i64, bool, Option<String>), String> {
        let mut facets = vec![vec![format!("project_type:{project_type}")]];
        if let Some(l) = loader.filter(|s| !s.is_empty()) {
            facets.push(vec![format!("categories:{l}")]);
        }
        if let Some(m) = minecraft.filter(|s| !s.is_empty()) {
            facets.push(vec![format!("versions:{m}")]);
        }
        let params = query(&[
            ("query", q.to_string()),
            ("limit", limit.unwrap_or(20).to_string()),
            ("offset", offset.unwrap_or(0).to_string()),
            ("facets", serde_json::to_string(&facets).unwrap_or_default()),
            ("index", "relevance".into()),
        ]);
        let r = self.http.get_json(&format!("{}/search?{params}", modrinth_api()), 10 * 60 * 1000, &[])?;
        Ok((r.data, r.fetched_at, r.stale, r.error))
    }

    fn cf_search(&self, q: &str, loader: Option<&str>, minecraft: Option<&str>, class_id: i64, limit: Option<i64>, offset: Option<i64>) -> Result<(Value, i64, bool), String> {
        let key = self.require_cf_key()?;
        let mut pairs = vec![
            ("gameId", "432".to_string()),
            ("classId", class_id.to_string()),
            ("searchFilter", q.to_string()),
            ("sortField", "2".into()),
            ("sortOrder", "desc".into()),
            ("pageSize", limit.unwrap_or(20).min(50).to_string()),
            ("index", offset.unwrap_or(0).to_string()),
        ];
        let mc = minecraft.filter(|s| !s.is_empty());
        if let Some(m) = mc {
            pairs.push(("gameVersion", m.to_string()));
        }
        if let (Some(t), Some(_)) = (loader.filter(|s| !s.is_empty()).and_then(loader_type), mc) {
            pairs.push(("modLoaderType", t.to_string()));
        }
        let r = self.http.get_json(&format!("{}/mods/search?{}", curseforge_api(), query(&pairs)), 10 * 60 * 1000, &[("x-api-key", &key)])?;
        Ok((r.data, r.fetched_at, r.stale))
    }

    pub fn dependency_search(&self, p: &Value) -> Result<Value, String> {
        let (q, loader, mc, limit, offset) = (p["query"].as_str().unwrap_or(""), p["loader"].as_str(), p["minecraft"].as_str(), p["limit"].as_i64(), p["offset"].as_i64());
        if p["provider"] == "curseforge" {
            let (data, fetched_at, stale) = self.cf_search(q, loader, mc, CLASS_MODS, limit, offset)?;
            let hits: Vec<Value> = data["data"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|m| {
                    let mut h = Map::new();
                    h.insert("id".into(), json!(js::string(&m["id"])));
                    put(&mut h, "slug", m.get("slug").cloned());
                    put(&mut h, "title", m.get("name").cloned());
                    put(&mut h, "description", m.get("summary").cloned());
                    h.insert(
                        "author".into(),
                        json!(present(m.get("authors"))
                            .and_then(Value::as_array)
                            .map(|a| js_join(&a.iter().map(|x| x.get("name").cloned().unwrap_or(Value::Null)).collect::<Vec<_>>(), ", "))
                            .unwrap_or_default()),
                    );
                    put(&mut h, "downloads", m.get("downloadCount").cloned());
                    let logo = present(m.get("logo"));
                    put(&mut h, "iconUrl", coalesce(logo.and_then(|l| l.get("thumbnailUrl")), logo.and_then(|l| l.get("url"))));
                    h.insert("clientSide".into(), json!("unknown"));
                    h.insert("serverSide".into(), json!("unknown"));
                    h.insert("license".into(), json!(""));
                    h.insert("distribution".into(), json!(if m.get("allowModDistribution") == Some(&Value::Bool(false)) { "manual" } else { "direct" }));
                    put(&mut h, "url", present(m.get("links")).and_then(|l| l.get("websiteUrl")).cloned());
                    Value::Object(h)
                })
                .collect();
            let mut out = Map::new();
            out.insert("provider".into(), json!("curseforge"));
            put(&mut out, "total", data.get("pagination").and_then(|pg| pg.get("totalCount")).cloned());
            out.insert("stale".into(), json!(stale));
            out.insert("fetchedAt".into(), json!(fetched_at));
            out.insert("hits".into(), Value::Array(hits));
            return Ok(Value::Object(out));
        }
        let (data, fetched_at, stale, _) = self.modrinth_search(q, loader, mc, "mod", limit, offset)?;
        let hits: Vec<Value> = data["hits"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|h| {
                let mut o = Map::new();
                for (to, from) in [
                    ("id", "project_id"),
                    ("slug", "slug"),
                    ("title", "title"),
                    ("description", "description"),
                    ("author", "author"),
                    ("downloads", "downloads"),
                    ("iconUrl", "icon_url"),
                    ("clientSide", "client_side"),
                    ("serverSide", "server_side"),
                    ("license", "license"),
                ] {
                    put(&mut o, to, h.get(from).cloned());
                }
                o.insert("distribution".into(), json!("direct"));
                o.insert("url".into(), json!(format!("https://modrinth.com/mod/{}", h.get("slug").map(js::string).unwrap_or_else(|| "undefined".into()))));
                Value::Object(o)
            })
            .collect();
        let mut out = Map::new();
        out.insert("provider".into(), json!("modrinth"));
        put(&mut out, "total", data.get("total_hits").cloned());
        out.insert("stale".into(), json!(stale));
        out.insert("fetchedAt".into(), json!(fetched_at));
        out.insert("hits".into(), Value::Array(hits));
        Ok(Value::Object(out))
    }

    pub fn modrinth_versions(&self, project: &str, loader: Option<&str>, minecraft: Option<&str>) -> Result<Value, String> {
        let mut pairs = Vec::new();
        if let Some(l) = loader.filter(|s| !s.is_empty()) {
            pairs.push(("loaders", serde_json::to_string(&[l]).unwrap_or_default()));
        }
        if let Some(m) = minecraft.filter(|s| !s.is_empty()) {
            pairs.push(("game_versions", serde_json::to_string(&[m]).unwrap_or_default()));
        }
        let url = format!("{}/project/{}/version?{}", modrinth_api(), encode_uri_component(project), query(&pairs));
        Ok(self.http.get_json(&url, 15 * 60 * 1000, &[])?.data)
    }

    pub fn dependency_versions(&self, p: &Value) -> Result<Value, String> {
        let (project, loader, mc) = (p["projectId"].as_str().unwrap_or(""), p["loader"].as_str(), p["minecraft"].as_str());
        if p["provider"] != "curseforge" {
            return self.modrinth_versions(project, loader, mc);
        }
        let mut pairs = vec![("pageSize", "50".to_string())];
        if let Some(m) = mc.filter(|s| !s.is_empty()) {
            pairs.push(("gameVersion", m.to_string()));
        }
        if let Some(t) = loader.filter(|s| !s.is_empty()).and_then(loader_type) {
            pairs.push(("modLoaderType", t.to_string()));
        }
        let files = self.cf_get(&format!("/mods/{}/files?{}", encode_uri_component(project), query(&pairs)), 15 * 60 * 1000)?;
        let m = self.cf_get(&format!("/mods/{}", encode_uri_component(project)), 60 * 60 * 1000)?;
        let list = files.as_array().cloned().unwrap_or_default();
        let best = match (loader.filter(|s| !s.is_empty()), mc.filter(|s| !s.is_empty())) {
            (Some(l), Some(v)) => pick_cf_file(&list, l, v).map(|f| f["id"].clone()),
            _ => None,
        };
        Ok(Value::Array(
            list.iter()
                .map(|f| {
                    let mut o = Map::new();
                    o.insert("id".into(), json!(js::string(&f["id"])));
                    for (to, from) in [("name", "displayName"), ("fileName", "fileName"), ("releaseType", "releaseType"), ("gameVersions", "gameVersions"), ("date", "fileDate")] {
                        put(&mut o, to, f.get(from).cloned());
                    }
                    o.insert("distribution".into(), json!(if cf_distributable(&m, f) { "direct" } else { "manual" }));
                    o.insert("recommended".into(), json!(best.as_ref().is_some_and(|b| b == &f["id"])));
                    Value::Object(o)
                })
                .collect(),
        ))
    }

    pub fn modpack_search(&self, p: &Value) -> Result<Value, String> {
        let (q, loader, mc, limit, offset) = (p["query"].as_str().unwrap_or(""), p["loader"].as_str(), p["minecraft"].as_str(), p["limit"].as_i64(), p["offset"].as_i64());
        if p["provider"] == "curseforge" {
            let (data, _, _) = self.cf_search(q, loader, mc, CLASS_MODPACKS, limit, offset)?;
            let hits: Vec<Value> = data["data"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|m| {
                    let mut h = Map::new();
                    h.insert("id".into(), json!(js::string(&m["id"])));
                    put(&mut h, "slug", m.get("slug").cloned());
                    put(&mut h, "title", m.get("name").cloned());
                    put(&mut h, "description", m.get("summary").cloned());
                    h.insert(
                        "author".into(),
                        json!(present(m.get("authors"))
                            .and_then(Value::as_array)
                            .map(|a| js_join(&a.iter().map(|x| x.get("name").cloned().unwrap_or(Value::Null)).collect::<Vec<_>>(), ", "))
                            .unwrap_or_default()),
                    );
                    put(&mut h, "downloads", m.get("downloadCount").cloned());
                    let logo = present(m.get("logo"));
                    h.insert("iconUrl".into(), present(coalesce(logo.and_then(|l| l.get("thumbnailUrl")), logo.and_then(|l| l.get("url"))).as_ref()).cloned().unwrap_or(Value::Null));
                    h.insert("url".into(), present(present(m.get("links")).and_then(|l| l.get("websiteUrl"))).cloned().unwrap_or(Value::Null));
                    Value::Object(h)
                })
                .collect();
            let mut out = Map::new();
            out.insert("provider".into(), json!("curseforge"));
            put(&mut out, "total", data.get("pagination").and_then(|pg| pg.get("totalCount")).cloned());
            out.insert("hits".into(), Value::Array(hits));
            return Ok(Value::Object(out));
        }
        let (data, _, _, _) = self.modrinth_search(q, loader, mc, "modpack", limit, offset)?;
        let hits: Vec<Value> = data["hits"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|h| {
                let mut o = Map::new();
                for (to, from) in [("id", "project_id"), ("slug", "slug"), ("title", "title"), ("description", "description"), ("author", "author"), ("downloads", "downloads")] {
                    put(&mut o, to, h.get(from).cloned());
                }
                o.insert("iconUrl".into(), present(h.get("icon_url")).cloned().unwrap_or(Value::Null));
                o.insert("url".into(), json!(format!("https://modrinth.com/modpack/{}", h.get("slug").map(js::string).unwrap_or_else(|| "undefined".into()))));
                Value::Object(o)
            })
            .collect();
        let mut out = Map::new();
        out.insert("provider".into(), json!("modrinth"));
        put(&mut out, "total", data.get("total_hits").cloned());
        out.insert("hits".into(), Value::Array(hits));
        Ok(Value::Object(out))
    }

    fn meta_result(versions: Value, fetched_at: i64, stale: bool, error: Option<String>) -> Value {
        let mut o = Map::new();
        o.insert("versions".into(), versions);
        o.insert("fetchedAt".into(), json!(fetched_at));
        o.insert("stale".into(), json!(stale));
        put(&mut o, "error", error.map(Value::String));
        Value::Object(o)
    }

    fn neoforge_list(&self) -> Result<(Vec<String>, i64, bool, Option<String>), String> {
        let r = self.http.get_json(&neoforge_versions(), 6 * 3600 * 1000, &[])?;
        let list = r.data["versions"].as_array().ok_or_else(|| "Cannot read properties of undefined (reading 'map')".to_string())?.iter().map(js::string).collect();
        Ok((list, r.fetched_at, r.stale, r.error))
    }

    pub fn game_versions(&self, loader: &str) -> Result<Value, String> {
        match loader {
            "fabric" => {
                let r = self.http.get_json(&format!("{}/versions/game", fabric_meta()), 6 * 3600 * 1000, &[])?;
                Ok(Self::meta_result(r.data, r.fetched_at, r.stale, r.error))
            }
            "neoforge" => {
                let (list, at, stale, error) = self.neoforge_list()?;
                let mut games: Vec<String> = Vec::new();
                for v in &list {
                    if let Some(mc) = mc_from_neo(v) {
                        if !games.contains(&mc) {
                            games.push(mc);
                        }
                    }
                }
                games.reverse();
                Ok(Self::meta_result(Value::Array(games.into_iter().map(|v| json!({ "version": v, "stable": true })).collect()), at, stale, error))
            }
            _ => Ok(Self::meta_result(json!([]), crate::support::now_ms() as i64, false, Some("Forge metadata is not implemented yet".into()))),
        }
    }

    pub fn loader_versions(&self, loader: &str, minecraft: &str) -> Result<Value, String> {
        match loader {
            "fabric" => {
                let r = self.http.get_json(&format!("{}/versions/loader/{}", fabric_meta(), encode_uri_component(minecraft)), 6 * 3600 * 1000, &[])?;
                let list = r.data.as_array().ok_or_else(|| "res.data.map is not a function".to_string())?.iter().map(|d| d.get("loader").cloned().unwrap_or(Value::Null)).collect();
                Ok(Self::meta_result(Value::Array(list), r.fetched_at, r.stale, r.error))
            }
            "neoforge" => {
                let (list, at, stale, error) = self.neoforge_list()?;
                let unstable = regex::Regex::new("beta|alpha").unwrap();
                let mut matching: Vec<Value> = list.iter().filter(|v| mc_from_neo(v).as_deref() == Some(minecraft)).map(|v| json!({ "version": v, "stable": !unstable.is_match(v) })).collect();
                matching.reverse();
                Ok(Self::meta_result(Value::Array(matching), at, stale, error))
            }
            _ => Ok(Self::meta_result(json!([]), crate::support::now_ms() as i64, false, Some("Forge metadata is not implemented yet".into()))),
        }
    }

    fn preset_schema() -> &'static Value {
        &schemas()["preset"]
    }

    fn parse_preset(v: &Value) -> Result<Value, String> {
        schema::parse(Self::preset_schema(), v).map_err(|issues| schema::zod_error_message(&issues))
    }

    fn builtin_presets() -> Vec<Value> {
        [
            json!({ "id": "fabric-minimal", "name": "Fabric minimal", "description": "Empty Fabric 1.21.1 mod with the bridge and client/server profiles.", "builtin": true, "catalogEntryId": "fabric-1.21.1", "starters": ["empty", "bridge", "profiles"] }),
            json!({ "id": "fabric-content", "name": "Fabric content mod", "description": "Item, block, command, config and data generation starters.", "builtin": true, "catalogEntryId": "fabric-1.21.1", "starters": ["empty", "item", "block", "command", "config", "datagen", "bridge", "profiles"] }),
            json!({ "id": "fabric-modmenu", "name": "Fabric with Mod Menu", "description": "Adds Mod Menu as a compile dependency for config screens.", "builtin": true, "catalogEntryId": "fabric-1.21.1", "starters": ["empty", "config", "bridge", "profiles"], "dependencies": [{ "source": "modrinth", "projectId": "mOgUt4GM", "title": "Mod Menu", "usage": "compile", "required": false, "environment": "client" }] }),
            json!({ "id": "create-addon-fabric", "name": "Create addon (Fabric)", "description": "Create as a compile dependency. Availability is checked against Modrinth before use.", "builtin": true, "catalogEntryId": "fabric-1.21.1", "starters": ["empty", "item", "bridge", "profiles"], "dependencies": [{ "source": "modrinth", "projectId": "Xbc0uyRg", "title": "Create Fabric", "usage": "compile", "required": true }] }),
            json!({ "id": "neoforge-minimal", "name": "NeoForge minimal", "description": "Empty NeoForge 1.21.1 mod with the bridge and client/server profiles.", "builtin": true, "catalogEntryId": "neoforge-1.21.1", "starters": ["empty", "bridge", "profiles"] }),
            json!({ "id": "neoforge-content", "name": "NeoForge content mod", "description": "Item, block, command, config and data generation starters.", "builtin": true, "catalogEntryId": "neoforge-1.21.1", "starters": ["empty", "item", "block", "command", "config", "datagen", "bridge", "profiles"] }),
            json!({ "id": "create-addon-neoforge", "name": "Create addon (NeoForge)", "description": "Create as a compile dependency. Availability is checked against Modrinth before use.", "builtin": true, "catalogEntryId": "neoforge-1.21.1", "starters": ["empty", "item", "bridge", "profiles"], "dependencies": [{ "source": "modrinth", "projectId": "LNytGWDc", "title": "Create", "usage": "compile", "required": true }] }),
        ]
        .iter()
        .filter_map(|p| Self::parse_preset(p).ok())
        .collect()
    }

    fn presets_file(&self) -> PathBuf {
        self.data_dir.join("presets.json")
    }

    pub fn preset_list(&self) -> Result<Vec<Value>, String> {
        let mut out = Self::builtin_presets();
        let file = self.presets_file();
        if file.exists() {
            let text = std::fs::read_to_string(&file).map_err(|e| js::fs_error(&e, "open", &file))?;
            let raw: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            for p in raw.as_array().ok_or("JSON.parse(...).map is not a function")? {
                out.push(Self::parse_preset(p)?);
            }
        }
        Ok(out)
    }

    pub fn preset_save(&self, input: &Value) -> Result<Value, String> {
        let mut obj = input.as_object().cloned().unwrap_or_default();
        obj.insert("builtin".into(), json!(false));
        let p = Self::parse_preset(&Value::Object(obj))?;
        if Self::builtin_presets().iter().any(|b| b["id"] == p["id"]) {
            return Err("Cannot overwrite a built-in preset".into());
        }
        let mut user: Vec<Value> = self.preset_list()?.into_iter().filter(|x| x["builtin"] != true && x["id"] != p["id"]).collect();
        user.push(p.clone());
        let file = self.presets_file();
        std::fs::write(&file, js::pretty(&Value::Array(user))).map_err(|e| js::fs_error(&e, "open", &file))?;
        Ok(p)
    }

    pub fn preset_check(&self, id: &str) -> Result<Value, String> {
        let presets = self.preset_list()?;
        let p = presets.iter().find(|x| x["id"] == id).ok_or_else(|| format!("Unknown preset {id}"))?;
        let entry_id = p["catalogEntryId"].as_str().unwrap_or_default();
        let Some(entry) = self.catalog.get(entry_id) else {
            return Ok(json!({ "preset": p, "usable": false, "entry": null, "dependencies": [], "reason": format!("Unknown catalog entry {entry_id}") }));
        };
        let (loader, mc) = (entry["loader"].as_str().unwrap_or_default(), entry["minecraft"].as_str().unwrap_or_default());
        let mut deps = Vec::new();
        let declared = p["dependencies"].as_array().cloned().unwrap_or_default();
        for d in &declared {
            let mut o = Map::new();
            o.insert("projectId".into(), d["projectId"].clone());
            put(&mut o, "title", d.get("title").cloned());
            match self.modrinth_versions(d["projectId"].as_str().unwrap_or_default(), Some(loader), Some(mc)) {
                Ok(versions) => {
                    let list = versions.as_array().cloned().unwrap_or_default();
                    let v = pick_version(&list, loader, mc);
                    o.insert("available".into(), json!(v.is_some()));
                    o.insert("version".into(), v.map(|v| v["version_number"].clone()).unwrap_or(Value::Null));
                    o.insert(
                        "detail".into(),
                        json!(match v {
                            Some(v) => format!("{} ({})", js::string(&v["version_number"]), js::string(&v["version_type"])),
                            None => format!("No {loader} build for Minecraft {mc} on Modrinth"),
                        }),
                    );
                }
                Err(e) => {
                    o.insert("available".into(), json!(false));
                    o.insert("version".into(), Value::Null);
                    o.insert("detail".into(), json!(e));
                }
            }
            deps.push(Value::Object(o));
        }
        let blocking: Vec<&Value> = deps.iter().enumerate().filter(|(i, d)| d["available"] != true && declared[*i]["required"] == true).map(|(_, d)| d).collect();
        let status = entry["status"].as_str().unwrap_or_default();
        let usable_entry = crate::manifest::generatable(entry);
        let reason = if !usable_entry {
            json!(format!("{entry_id} is {status}"))
        } else if !blocking.is_empty() {
            json!(format!(
                "Required dependencies unavailable: {}",
                blocking.iter().map(|b| present(b.get("title")).map(js::string).unwrap_or_else(|| js::string(&b["projectId"]))).collect::<Vec<_>>().join(", ")
            ))
        } else {
            Value::Null
        };
        Ok(json!({ "preset": p, "usable": usable_entry && blocking.is_empty(), "entry": entry["id"], "dependencies": deps, "reason": reason }))
    }
}

pub fn cf_sha1(file: &Value) -> Option<String> {
    file["hashes"].as_array().and_then(|h| h.iter().find(|x| x["algo"] == 1)).and_then(|x| x.get("value")).filter(|v| !v.is_null()).map(js::string)
}

pub fn cf_file_page(m: Option<&Value>, file: &Value) -> String {
    let website = m.and_then(|m| present(m.get("links"))).and_then(|l| present(l.get("websiteUrl"))).map(js::string);
    let base =
        website.unwrap_or_else(|| format!("https://www.curseforge.com/minecraft/mc-mods/{}", m.and_then(|m| present(m.get("slug"))).map(js::string).unwrap_or_else(|| js::string(&file["modId"]))));
    format!("{}/files/{}", base.strip_suffix('/').unwrap_or(&base), js::string(&file["id"]))
}

pub fn cf_to_project(m: &Value, file: Option<&Value>) -> Value {
    let gv: Vec<Value> = file.and_then(|f| f["gameVersions"].as_array().cloned()).unwrap_or_default();
    let has_client = gv.iter().any(|g| g == "Client");
    let has_server = gv.iter().any(|g| g == "Server");
    let mut o = Map::new();
    o.insert("id".into(), json!(js::string(&m["id"])));
    put(&mut o, "slug", m.get("slug").cloned());
    put(&mut o, "title", m.get("name").cloned());
    put(&mut o, "description", m.get("summary").cloned());
    o.insert(
        "client_side".into(),
        json!(if has_server && !has_client {
            "unsupported"
        } else if has_client {
            "required"
        } else {
            "unknown"
        }),
    );
    o.insert(
        "server_side".into(),
        json!(if has_client && !has_server {
            "unsupported"
        } else if has_server {
            "required"
        } else {
            "unknown"
        }),
    );
    o.insert("project_type".into(), json!(if m["classId"] == CLASS_MODPACKS { "modpack" } else { "mod" }));
    Value::Object(o)
}

pub fn cf_to_version(f: &Value) -> Value {
    let gv: Vec<Value> = f["gameVersions"].as_array().cloned().unwrap_or_default();
    let loaders: Vec<Value> = gv
        .iter()
        .filter_map(|g| match g.as_str() {
            Some("Forge") => Some(json!("forge")),
            Some("Fabric") => Some(json!("fabric")),
            Some("Quilt") => Some(json!("quilt")),
            Some("NeoForge") => Some(json!("neoforge")),
            _ => None,
        })
        .collect();
    let versions_re = regex::Regex::new(r"^\d+\.\d+").unwrap();
    let games: Vec<Value> = gv.iter().filter(|g| versions_re.is_match(&js::string(g))).cloned().collect();
    let deps: Vec<Value> = f["dependencies"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|d| {
            let t = match d["relationType"].as_i64() {
                Some(1) | Some(6) => "embedded",
                Some(2) => "optional",
                Some(3) => "required",
                Some(5) => "incompatible",
                _ => return None,
            };
            Some(json!({ "version_id": null, "project_id": js::string(&d["modId"]), "file_name": null, "dependency_type": t }))
        })
        .collect();
    let release = match f["releaseType"].as_i64() {
        Some(2) => "beta",
        Some(3) => "alpha",
        _ => "release",
    };
    let mut file = Map::new();
    file.insert("hashes".into(), json!({ "sha1": cf_sha1(f).unwrap_or_default(), "sha512": "" }));
    file.insert("url".into(), present(f.get("downloadUrl")).cloned().unwrap_or_else(|| json!("")));
    put(&mut file, "filename", f.get("fileName").cloned());
    file.insert("primary".into(), json!(true));
    put(&mut file, "size", f.get("fileLength").cloned());
    let mut o = Map::new();
    o.insert("id".into(), json!(js::string(&f["id"])));
    o.insert("project_id".into(), json!(js::string(&f["modId"])));
    put(&mut o, "name", f.get("displayName").cloned());
    put(&mut o, "version_number", f.get("displayName").cloned());
    o.insert("version_type".into(), json!(release));
    o.insert("loaders".into(), Value::Array(loaders));
    o.insert("game_versions".into(), Value::Array(games));
    put(&mut o, "date_published", f.get("fileDate").cloned());
    o.insert("dependencies".into(), Value::Array(deps));
    o.insert("files".into(), json!([Value::Object(file)]));
    Value::Object(o)
}

impl Providers {
    pub fn modrinth_project(&self, id: &str) -> Result<Value, String> {
        Ok(self.http.get_json(&format!("{}/project/{}", modrinth_api(), encode_uri_component(id)), 60 * 60 * 1000, &[])?.data)
    }

    pub fn modrinth_version(&self, id: &str) -> Result<Value, String> {
        Ok(self.http.get_json(&format!("{}/version/{}", modrinth_api(), encode_uri_component(id)), 24 * 3600 * 1000, &[])?.data)
    }

    pub fn modrinth_projects(&self, ids: &[String]) -> Result<Vec<Value>, String> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let list = serde_json::to_string(ids).unwrap_or_default();
        Ok(self.http.get_json(&format!("{}/projects?ids={}", modrinth_api(), encode_uri_component(&list)), 60 * 60 * 1000, &[])?.data.as_array().cloned().unwrap_or_default())
    }

    pub fn modrinth_versions_from_hashes(&self, hashes: &[String]) -> Result<Map<String, Value>, String> {
        let mut out = Map::new();
        for chunk in hashes.chunks(500) {
            let body = json!({ "hashes": chunk, "algorithm": "sha1" }).to_string();
            let res = crate::http::fetch_with_retry(
                "POST",
                &format!("{}/version_files", modrinth_api()),
                &[("Content-Type", "application/json"), ("Accept", "application/json"), ("User-Agent", crate::http::USER_AGENT)],
                Some(&body),
            )?;
            if !res.ok() {
                return Err(format!("Modrinth HTTP {} looking up file hashes", res.status));
            }
            if let Value::Object(m) = serde_json::from_str::<Value>(&res.body).map_err(|e| e.to_string())? {
                out.extend(m);
            }
        }
        Ok(out)
    }

    pub fn modrinth_version_from_hash(&self, sha1: &str) -> Option<Value> {
        self.http.get_json(&format!("{}/version_file/{sha1}?algorithm=sha1", modrinth_api()), 24 * 3600 * 1000, &[]).ok().map(|r| r.data)
    }

    pub fn cf_configured(&self) -> bool {
        self.cf_key().is_some()
    }

    pub fn cf_mod(&self, id: &str) -> Result<Value, String> {
        self.cf_get(&format!("/mods/{}", encode_uri_component(id)), 60 * 60 * 1000)
    }

    pub fn cf_files(&self, mod_id: &str, loader: Option<&str>, minecraft: Option<&str>) -> Result<Vec<Value>, String> {
        let mut pairs = vec![("pageSize", "50".to_string())];
        if let Some(m) = minecraft.filter(|s| !s.is_empty()) {
            pairs.push(("gameVersion", m.to_string()));
        }
        if let Some(t) = loader.filter(|s| !s.is_empty()).and_then(loader_type) {
            pairs.push(("modLoaderType", t.to_string()));
        }
        Ok(self.cf_get(&format!("/mods/{}/files?{}", encode_uri_component(mod_id), query(&pairs)), 15 * 60 * 1000)?.as_array().cloned().unwrap_or_default())
    }

    pub fn cf_file(&self, mod_id: &str, file_id: &str) -> Result<Value, String> {
        self.cf_get(&format!("/mods/{}/files/{}", encode_uri_component(mod_id), encode_uri_component(file_id)), 24 * 3600 * 1000)
    }

    pub fn cf_mods(&self, ids: &[i64]) -> Result<Vec<Value>, String> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let key = self.require_cf_key()?;
        let body = json!({ "modIds": ids }).to_string();
        let res = crate::http::fetch_with_retry(
            "POST",
            &format!("{}/mods", curseforge_api()),
            &[("x-api-key", &key), ("Content-Type", "application/json"), ("Accept", "application/json"), ("User-Agent", crate::http::USER_AGENT)],
            Some(&body),
        )?;
        if res.status == 403 {
            return Err("CurseForge rejected the API key (403)".into());
        }
        if !res.ok() {
            return Err(format!("CurseForge HTTP {}", res.status));
        }
        Ok(serde_json::from_str::<Value>(&res.body).map_err(|e| e.to_string())?["data"].as_array().cloned().unwrap_or_default())
    }
}

pub fn mc_from_neo(v: &str) -> Option<String> {
    let c = regex::Regex::new(r"^(\d+)\.(\d+)\.").unwrap().captures(v)?;
    let major: i64 = c[1].parse().ok()?;
    let minor: i64 = c[2].parse().ok()?;
    if !(20..=21).contains(&major) {
        return None;
    }
    Some(if minor == 0 { format!("1.{major}") } else { format!("1.{major}.{minor}") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dates_like_v8() {
        assert_eq!(date_parse("2024-05-01T12:34:56.789123Z"), 1714566896789.0);
        assert_eq!(date_parse("2024-05-01T12:34:56Z"), 1714566896000.0);
        assert_eq!(date_parse("2024-05-01"), 1714521600000.0);
        assert!(date_parse("garbage").is_nan());
    }

    #[test]
    fn neoforge_minecraft_versions() {
        assert_eq!(mc_from_neo("21.1.77").as_deref(), Some("1.21.1"));
        assert_eq!(mc_from_neo("21.0.1-beta").as_deref(), Some("1.21"));
        assert_eq!(mc_from_neo("19.1.1"), None);
    }

    #[test]
    fn encodes_like_javascript() {
        assert_eq!(encode_uri_component("a b/c?d=é!'()*~"), "a%20b%2Fc%3Fd%3D%C3%A9!'()*~");
        assert_eq!(query(&[("query", "mod menu".into()), ("facets", "[[\"a:b\"]]".into())]), "query=mod+menu&facets=%5B%5B%22a%3Ab%22%5D%5D");
    }
}
