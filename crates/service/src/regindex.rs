use crate::clientinstall::ClientInstaller;
use crate::js;
use crate::manifest;
use crate::rt::Runtime;
use crate::workspace;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

const MAX_ENTRY: u64 = 8 * 1024 * 1024;
const TAG_REGISTRIES: [(&str, &str); 8] = [("item", "item"), ("items", "item"), ("block", "block"), ("blocks", "block"), ("entity_type", "entity_type"), ("entity_types", "entity_type"), ("fluid", "fluid"), ("fluids", "fluid")];

#[derive(Default)]
pub struct Scan {
    namespaces: BTreeSet<String>,
    models: BTreeSet<String>,
    textures: BTreeSet<String>,
    lang: BTreeMap<String, String>,
    blocks: BTreeSet<String>,
    item_defs: BTreeSet<String>,
    item_models: BTreeSet<String>,
    tags: BTreeMap<(String, String), Vec<String>>,
}

struct Patterns {
    namespace: Regex,
    model: Regex,
    texture: Regex,
    lang: Regex,
    blockstate: Regex,
    item_def: Regex,
    item_model: Regex,
    tag: Regex,
    key: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| Patterns {
        namespace: Regex::new(r"^(?:assets|data)/([a-z0-9_.-]+)/").unwrap(),
        model: Regex::new(r"^assets/([a-z0-9_.-]+)/models/([a-z0-9_./-]+)\.json$").unwrap(),
        texture: Regex::new(r"^assets/([a-z0-9_.-]+)/textures/([a-z0-9_./-]+)\.png$").unwrap(),
        lang: Regex::new(r"^assets/[a-z0-9_.-]+/lang/en_us\.json$").unwrap(),
        blockstate: Regex::new(r"^assets/([a-z0-9_.-]+)/blockstates/([a-z0-9_./-]+)\.json$").unwrap(),
        item_def: Regex::new(r"^assets/([a-z0-9_.-]+)/items/([a-z0-9_./-]+)\.json$").unwrap(),
        item_model: Regex::new(r"^assets/([a-z0-9_.-]+)/models/item/([a-z0-9_./-]+)\.json$").unwrap(),
        tag: Regex::new(r"^data/([a-z0-9_.-]+)/tags/(item|items|block|blocks|entity_type|entity_types|fluid|fluids)/([a-z0-9_./-]+)\.json$").unwrap(),
        key: Regex::new(r"^(item|block|entity)\.([a-z0-9_-]+)\.([a-z0-9_/]+)$").unwrap(),
    })
}

fn tag_values(text: &[u8]) -> Vec<String> {
    let v: Value = serde_json::from_slice(text).unwrap_or(Value::Null);
    v["values"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string).or_else(|| x["id"].as_str().map(str::to_string))).collect())
        .unwrap_or_default()
}

fn scan_files(names: &[String], read: &mut dyn FnMut(&str) -> Option<Vec<u8>>) -> Scan {
    let p = patterns();
    let mut s = Scan::default();
    for name in names {
        if let Some(c) = p.namespace.captures(name) {
            if !s.namespaces.contains(&c[1]) {
                s.namespaces.insert(c[1].to_string());
            }
        }
        if let Some(c) = p.model.captures(name) {
            s.models.insert(format!("{}:{}", &c[1], &c[2]));
        } else if let Some(c) = p.texture.captures(name) {
            s.textures.insert(format!("{}:{}", &c[1], &c[2]));
        }
        if p.lang.is_match(name) {
            if let Some(bytes) = read(name) {
                if let Ok(Value::Object(m)) = serde_json::from_slice::<Value>(&bytes) {
                    for (k, v) in m {
                        if let Some(t) = v.as_str() {
                            s.lang.entry(k).or_insert_with(|| t.to_string());
                        }
                    }
                }
            }
        } else if let Some(c) = p.blockstate.captures(name) {
            s.blocks.insert(format!("{}:{}", &c[1], &c[2]));
        } else if let Some(c) = p.item_def.captures(name) {
            s.item_defs.insert(format!("{}:{}", &c[1], &c[2]));
        } else if let Some(c) = p.item_model.captures(name) {
            s.item_models.insert(format!("{}:{}", &c[1], &c[2]));
        } else if let Some(c) = p.tag.captures(name) {
            let reg = TAG_REGISTRIES.iter().find(|(d, _)| *d == &c[2]).map(|(_, r)| *r).unwrap_or("item");
            let values = read(name).map(|b| tag_values(&b)).unwrap_or_default();
            let list = s.tags.entry((reg.to_string(), format!("{}:{}", &c[1], &c[3]))).or_default();
            for v in values {
                if !list.contains(&v) {
                    list.push(v);
                }
            }
        }
    }
    s
}

fn scan_jar(file: &Path) -> Option<Scan> {
    let f = fs::File::open(file).ok()?;
    let mut zip = zip::ZipArchive::new(f).ok()?;
    let mut names: Vec<String> = (0..zip.len()).filter_map(|i| zip.by_index_raw(i).ok().map(|e| String::from_utf8_lossy(e.name_raw()).to_string())).collect();
    names.sort();
    let mut read = |name: &str| -> Option<Vec<u8>> {
        let e = zip.by_name(name).ok()?;
        if e.size() > MAX_ENTRY {
            return None;
        }
        let mut buf = Vec::new();
        e.take(MAX_ENTRY).read_to_end(&mut buf).ok()?;
        Some(buf)
    };
    Some(scan_files(&names, &mut read))
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(root, &p, out);
        } else if let Ok(rel) = p.strip_prefix(root) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
}

fn scan_dir(dir: &Path) -> Scan {
    let mut names = Vec::new();
    for top in ["assets", "data"] {
        walk(dir, &dir.join(top), &mut names);
    }
    names.sort();
    let mut read = |name: &str| -> Option<Vec<u8>> {
        let f = dir.join(name);
        if fs::metadata(&f).ok()?.len() > MAX_ENTRY {
            return None;
        }
        fs::read(f).ok()
    };
    scan_files(&names, &mut read)
}

fn archives() -> &'static Mutex<HashMap<PathBuf, zip::ZipArchive<fs::File>>> {
    static A: OnceLock<Mutex<HashMap<PathBuf, zip::ZipArchive<fs::File>>>> = OnceLock::new();
    A.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn read_resource(sources: &[Src], rel: &str) -> Option<Vec<u8>> {
    for s in sources {
        match s {
            Src::Dir(d) => {
                let f = d.join(rel);
                if f.is_file() {
                    if let Ok(b) = fs::read(&f) {
                        return Some(b);
                    }
                }
            }
            Src::Jar(j) => {
                let mut map = archives().lock().unwrap_or_else(|e| e.into_inner());
                if !map.contains_key(j) {
                    let Some(z) = fs::File::open(j).ok().and_then(|f| zip::ZipArchive::new(f).ok()) else { continue };
                    map.insert(j.clone(), z);
                }
                let Some(zip) = map.get_mut(j) else { continue };
                let Ok(e) = zip.by_name(rel) else { continue };
                if e.size() > MAX_ENTRY {
                    continue;
                }
                let mut buf = Vec::new();
                if e.take(MAX_ENTRY).read_to_end(&mut buf).is_ok() {
                    return Some(buf);
                }
            }
        }
    }
    None
}

fn jar_cache() -> &'static Mutex<HashMap<String, Arc<Scan>>> {
    static C: OnceLock<Mutex<HashMap<String, Arc<Scan>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_jar(file: &Path) -> Option<Arc<Scan>> {
    let meta = fs::metadata(file).ok()?;
    let stamp = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
    let key = format!("{}|{}|{stamp}", file.display(), meta.len());
    if let Some(s) = jar_cache().lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return Some(s.clone());
    }
    let scan = Arc::new(scan_jar(file)?);
    jar_cache().lock().unwrap_or_else(|e| e.into_inner()).insert(key, scan.clone());
    Some(scan)
}

pub fn project_roots(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let src = dir.join("src");
    let mut sets: Vec<PathBuf> = fs::read_dir(&src).map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()).unwrap_or_default();
    sets.sort();
    for set in sets {
        for sub in ["resources", "generated"] {
            let p = set.join(sub);
            if p.is_dir() && !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out
}

fn spec_jars(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for run in ["runClient", "runServer"] {
        let f = manifest::state_dir(dir).join("launch").join(format!("{run}.json"));
        let Ok(text) = fs::read_to_string(&f) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        for cp in v["runs"][run]["classpath"].as_array().into_iter().flatten().filter_map(|x| x.as_str()) {
            let p = PathBuf::from(cp);
            if cp.to_lowercase().ends_with(".jar") && p.is_file() && !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out
}

fn stem(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default().trim_end_matches(".jar").to_string()
}

#[derive(Default)]
pub struct Merged {
    pub lang: BTreeMap<String, String>,
    pub items: BTreeMap<String, String>,
    pub blocks: BTreeMap<String, String>,
    pub entities: BTreeMap<String, String>,
    pub tags: BTreeMap<(String, String), (Vec<String>, String)>,
    pub models: BTreeSet<String>,
    pub textures: BTreeSet<String>,
    pub item_defs: BTreeSet<String>,
    pub namespaces: BTreeSet<String>,
    sources: Vec<Value>,
    queued: Vec<(Arc<Scan>, String, String)>,
}

pub enum Src {
    Dir(PathBuf),
    Jar(PathBuf),
}

pub struct Collected {
    pub dir: PathBuf,
    pub vanilla: bool,
    pub minecraft: String,
    pub merged: Merged,
    pub warnings: Vec<String>,
    pub pending: Option<String>,
    pub sources: Vec<Src>,
    pub roots: Vec<PathBuf>,
}

impl Collected {
    pub fn modern_items(&self) -> bool {
        self.merged.item_defs.iter().any(|i| i.starts_with("minecraft:"))
    }
}

struct Known {
    namespaces: BTreeSet<String>,
    def_namespaces: BTreeSet<String>,
    model_namespaces: BTreeSet<String>,
    models: BTreeSet<String>,
}

impl Merged {
    fn add(&mut self, scan: Arc<Scan>, label: &str, kind: &str) {
        self.queued.push((scan, label.to_string(), kind.to_string()));
    }

    fn finish(&mut self) {
        let queued = std::mem::take(&mut self.queued);
        let ns = |set: &BTreeSet<String>| -> BTreeSet<String> { set.iter().filter_map(|i| i.split(':').next().map(str::to_string)).collect() };
        let mut known = Known { namespaces: BTreeSet::new(), def_namespaces: BTreeSet::new(), model_namespaces: BTreeSet::new(), models: BTreeSet::new() };
        for (scan, _, _) in &queued {
            self.models.extend(scan.models.iter().cloned());
            self.textures.extend(scan.textures.iter().cloned());
            self.item_defs.extend(scan.item_defs.iter().cloned());
            self.namespaces.extend(scan.namespaces.iter().cloned());
            known.namespaces.extend(scan.namespaces.iter().cloned());
            known.def_namespaces.extend(ns(&scan.item_defs));
            known.model_namespaces.extend(ns(&scan.item_models));
            known.models.extend(scan.item_models.iter().cloned());
        }
        for (scan, label, kind) in &queued {
            self.apply(scan, label, kind, &known);
        }
    }

    fn apply(&mut self, scan: &Scan, label: &str, kind: &str, known: &Known) {
        let p = patterns();
        for (k, v) in &scan.lang {
            self.lang.entry(k.clone()).or_insert_with(|| v.clone());
        }
        let mut items: BTreeSet<String> = BTreeSet::new();
        let mut entities: BTreeSet<String> = BTreeSet::new();
        items.extend(scan.item_defs.iter().cloned());
        for (key, value) in &scan.lang {
            if let Some(c) = p.key.captures(key).filter(|c| known.namespaces.contains(&c[2])) {
                let id = format!("{}:{}", &c[2], &c[3]);
                match &c[1] {
                    "item" if !known.def_namespaces.contains(&c[2]) && (!known.model_namespaces.contains(&c[2]) || known.models.contains(&id)) => {
                        items.insert(id);
                    }
                    "entity" if !value.contains('%') => {
                        entities.insert(id);
                    }
                    _ => {}
                }
            }
        }
        for m in &scan.item_models {
            let (ns, path) = m.split_once(':').unwrap_or(("", m));
            if known.def_namespaces.contains(ns) {
                continue;
            }
            let prefix = format!("item.{ns}.{path}.");
            if scan.blocks.contains(m) || scan.lang.keys().any(|k| k.starts_with(&prefix)) {
                items.insert(m.clone());
            }
        }
        let (mut ni, mut nb, mut ne, mut nt) = (0, 0, 0, 0);
        for id in items {
            if !self.items.contains_key(&id) {
                self.items.insert(id, label.to_string());
                ni += 1;
            }
        }
        for id in &scan.blocks {
            let (ns, path) = id.split_once(':').unwrap_or(("", id));
            let named = |kind: &str| scan.lang.contains_key(&format!("{kind}.{ns}.{path}"));
            if !named("block") && (named("item") || named("entity")) {
                continue;
            }
            if !self.blocks.contains_key(id) {
                self.blocks.insert(id.clone(), label.to_string());
                nb += 1;
            }
        }
        for id in entities {
            if !self.entities.contains_key(&id) {
                self.entities.insert(id, label.to_string());
                ne += 1;
            }
        }
        for (key, values) in &scan.tags {
            match self.tags.get_mut(key) {
                Some((list, _)) => {
                    for v in values {
                        if !list.contains(v) {
                            list.push(v.clone());
                        }
                    }
                }
                None => {
                    self.tags.insert(key.clone(), (values.clone(), label.to_string()));
                    nt += 1;
                }
            }
        }
        if ni + nb + ne + nt > 0 {
            self.sources.push(json!({ "label": label, "kind": kind, "items": ni, "blocks": nb, "entities": ne, "tags": nt }));
        }
    }

    fn name(&self, kind: &str, id: &str) -> Option<String> {
        let (ns, path) = id.split_once(':')?;
        self.lang.get(&format!("{kind}.{ns}.{path}")).cloned()
    }

    fn entries(&self, map: &BTreeMap<String, String>, kinds: &[&str]) -> Value {
        Value::Array(
            map.iter()
                .map(|(id, source)| {
                    let mut o = Map::new();
                    o.insert("id".into(), json!(id));
                    if let Some(n) = kinds.iter().find_map(|k| self.name(k, id)) {
                        o.insert("name".into(), json!(n));
                    }
                    o.insert("source".into(), json!(source));
                    Value::Object(o)
                })
                .collect(),
        )
    }
}

fn locked_jars(dir: &Path, downloads: &Path) -> Vec<PathBuf> {
    let lock = manifest::read_lock(dir).unwrap_or(Value::Null);
    let mut out: Vec<PathBuf> = Vec::new();
    let mut profiles: Vec<(&String, &Value)> = lock["profiles"].as_object().map(|o| o.iter().collect()).unwrap_or_default();
    profiles.sort_by(|a, b| a.0.cmp(b.0));
    for (_, p) in profiles {
        for e in p["entries"].as_array().into_iter().flatten() {
            let file = js::string(&e["fileName"]);
            let key = js::string(&e["key"]);
            let candidate = if let Some(rest) = key.strip_prefix("local:") {
                let p = PathBuf::from(rest);
                Some(if p.is_absolute() { p } else { dir.join(p) })
            } else if let Some(sha1) = e["sha1"].as_str().filter(|s| s.len() > 2) {
                let provider = js::string(&e["provider"]);
                let direct = downloads.join(&provider).join(&sha1[..2]).join(sha1).join(&file);
                if direct.is_file() {
                    Some(direct)
                } else {
                    let manual = downloads.join("manual").join(sha1);
                    fs::read_dir(&manual).ok().and_then(|rd| {
                        let mut jars: Vec<PathBuf> = rd.flatten().map(|x| x.path()).filter(|x| x.to_string_lossy().to_lowercase().ends_with(".jar")).collect();
                        jars.sort();
                        jars.into_iter().next()
                    })
                }
            } else {
                None
            };
            if let Some(c) = candidate.filter(|c| c.is_file() && c.to_string_lossy().to_lowercase().ends_with(".jar")) {
                if !out.contains(&c) {
                    out.push(c);
                }
            }
        }
    }
    out
}

fn download_ops() -> &'static Mutex<HashMap<String, String>> {
    static D: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    D.get_or_init(|| Mutex::new(HashMap::new()))
}

impl Runtime {
    pub fn registry_index(self: &Arc<Self>, root: &str) -> Result<Value, String> {
        let c = self.collect_registry(root)?;
        let merged = &c.merged;
        let mut tags = Map::new();
        for reg in ["item", "block", "entity_type", "fluid"] {
            let list: Vec<Value> = merged.tags.iter().filter(|((r, _), _)| r == reg).map(|((_, id), (values, source))| json!({ "id": id, "values": values, "source": source })).collect();
            tags.insert(reg.into(), Value::Array(list));
        }
        Ok(json!({
            "minecraft": c.minecraft,
            "sources": merged.sources,
            "items": merged.entries(&merged.items, &["item", "block"]),
            "blocks": merged.entries(&merged.blocks, &["block"]),
            "entities": merged.entries(&merged.entities, &["entity"]),
            "tags": tags,
            "warnings": c.warnings,
            "pending": c.pending
        }))
    }

    pub fn collect_registry(self: &Arc<Self>, root: &str) -> Result<Collected, String> {
        let dir = workspace::normalize(root);
        let m = manifest::require_manifest(&dir, root)?;
        let minecraft = js::string(&m["platform"]["minecraft"]);
        let installer_root = self.cache.join("minecraft");
        let jar = ClientInstaller { http: self.providers.http(), root: installer_root.clone() }.client_jar_path(&minecraft);
        let mut merged = Merged::default();
        let mut warnings: Vec<String> = Vec::new();
        let mut pending: Option<String> = None;
        let mut vanilla = false;
        if jar.is_file() {
            match cached_jar(&jar) {
                Some(scan) => {
                    merged.add(scan, &format!("Minecraft {minecraft}"), "vanilla");
                    vanilla = true;
                }
                None => warnings.push(format!("The Minecraft {minecraft} client jar could not be read")),
            }
        } else if !minecraft.is_empty() {
            pending = Some(self.vanilla_download(&minecraft));
            warnings.push(format!("Downloading Minecraft {minecraft} data for completion"));
        }
        let project = js::string(&m["name"]);
        let label = if project.is_empty() { "Project".to_string() } else { project };
        let roots = project_roots(&dir);
        let mut sources: Vec<Src> = roots.iter().map(|r| Src::Dir(r.clone())).collect();
        for r in &roots {
            merged.add(Arc::new(scan_dir(r)), &label, "project");
        }
        for j in locked_jars(&dir, &self.downloads()) {
            if let Some(scan) = cached_jar(&j) {
                merged.add(scan, &stem(&j), "mod");
                sources.push(Src::Jar(j));
            }
        }
        for j in spec_jars(&dir) {
            if j == jar {
                continue;
            }
            if let Some(scan) = cached_jar(&j) {
                merged.add(scan, &stem(&j), "library");
                sources.push(Src::Jar(j));
            }
        }
        if jar.is_file() {
            sources.push(Src::Jar(jar.clone()));
        }
        merged.finish();
        Ok(Collected { dir, vanilla, minecraft, merged, warnings, pending, sources, roots })
    }

    fn vanilla_download(self: &Arc<Self>, minecraft: &str) -> String {
        let mut ops = download_ops().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(id) = ops.get(minecraft) {
            if self.ops.get(id).is_some_and(|o| o["status"] == "running") {
                return id.clone();
            }
        }
        let me = self.clone();
        let mc = minecraft.to_string();
        let info = self.ops.start("registry.download", &format!("Download Minecraft {minecraft} data"), None, move |ctx| {
            let installer = ClientInstaller { http: me.providers.http(), root: me.cache.join("minecraft") };
            ctx.progress(None, Some(&format!("Downloading the Minecraft {mc} client")));
            let jar = installer.client_jar(&mc, ctx)?;
            Ok(Some(json!({ "minecraft": mc, "jar": jar.to_string_lossy() })))
        });
        let id = js::string(&info["id"]);
        ops.insert(minecraft.to_string(), id.clone());
        id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(files: &[(&str, &str)]) -> Scan {
        let names: Vec<String> = files.iter().map(|(n, _)| n.to_string()).collect();
        let mut read = |n: &str| files.iter().find(|(x, _)| *x == n).map(|(_, t)| t.as_bytes().to_vec());
        scan_files(&names, &mut read)
    }

    #[test]
    fn derives_items_blocks_entities_and_tags() {
        let s = scan(&[
            ("assets/minecraft/lang/en_us.json", r#"{"item.minecraft.stick":"Stick","block.minecraft.stone":"Stone","block.minecraft.water":"Water","entity.minecraft.zombie":"Zombie","entity.minecraft.villager.armorer":"Armorer","item.minecraft.potion.effect.water":"Water Bottle","item.minecraft.scute":"Scute","entity.minecraft.item_frame":"Item Frame","entity.minecraft.falling_block_type":"Falling %s","item.modifiers.any":"When in any slot"}"#),
            ("assets/minecraft/blockstates/stone.json", "{}"),
            ("assets/minecraft/blockstates/water.json", "{}"),
            ("assets/minecraft/models/item/stone.json", "{}"),
            ("assets/minecraft/models/item/stick.json", "{}"),
            ("assets/minecraft/blockstates/item_frame.json", "{}"),
            ("assets/minecraft/models/item/potion.json", "{}"),
            ("assets/minecraft/models/item/bow_pulling_0.json", "{}"),
            ("data/minecraft/tags/item/logs.json", r##"{"values":["minecraft:oak_log","#minecraft:birch_logs",{"id":"other:log","required":false}]}"##),
            ("data/c/tags/items/ingots.json", r#"{"values":["minecraft:iron_ingot"]}"#),
        ]);
        let mut m = Merged::default();
        m.add(Arc::new(s), "Minecraft", "vanilla");
        m.finish();
        assert_eq!(m.items.keys().cloned().collect::<Vec<_>>(), vec!["minecraft:potion", "minecraft:stick", "minecraft:stone"]);
        assert_eq!(m.blocks.keys().cloned().collect::<Vec<_>>(), vec!["minecraft:stone", "minecraft:water"]);
        assert_eq!(m.entities.keys().cloned().collect::<Vec<_>>(), vec!["minecraft:item_frame", "minecraft:zombie"]);
        assert_eq!(m.tags[&("item".to_string(), "minecraft:logs".to_string())].0, vec!["minecraft:oak_log", "#minecraft:birch_logs", "other:log"]);
        assert!(m.tags.contains_key(&("item".to_string(), "c:ingots".to_string())));
        assert_eq!(m.name("item", "minecraft:stone").or_else(|| m.name("block", "minecraft:stone")), Some("Stone".to_string()));
    }

    #[test]
    fn item_definitions_replace_model_guessing() {
        let s = scan(&[("assets/minecraft/items/stick.json", "{}"), ("assets/minecraft/models/item/template_x.json", "{}"), ("assets/minecraft/lang/en_us.json", r#"{"item.minecraft.unused":"Unused"}"#)]);
        let mut m = Merged::default();
        m.add(Arc::new(s), "Minecraft", "vanilla");
        m.finish();
        assert_eq!(m.items.keys().cloned().collect::<Vec<_>>(), vec!["minecraft:stick"]);
    }
}
