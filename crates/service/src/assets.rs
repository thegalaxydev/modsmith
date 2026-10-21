use crate::regindex::{read_resource, Collected};
use crate::rt::Runtime;
use base64::Engine;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::Path;
use std::sync::{Arc, OnceLock};

pub struct Ctx {
    pub key: Option<String>,
    pub parent_key: Option<String>,
    pub ancestors: Vec<String>,
    pub first_key: Option<String>,
    pub siblings: BTreeMap<String, String>,
}

#[derive(Debug, PartialEq)]
pub struct Want {
    pub registry: &'static str,
    pub ids: bool,
    pub tags: bool,
    pub hash: bool,
}

const ITEM_KEYS: [&str; 9] = ["item", "items", "ingredient", "ingredients", "base", "addition", "template", "input", "icon"];
const ENTITY_PARENTS: [&str; 11] = ["entity", "this", "killer", "killer_entity", "direct_killer_entity", "direct_entity", "source_entity", "vehicle", "passenger", "targeted_entity", "projectile"];

struct Rx {
    tag_file: Regex,
    recipe: Regex,
    id: Regex,
    model: Regex,
    blockstate: Regex,
    item_def: Regex,
    lang: Regex,
    data: Regex,
}

fn rx() -> &'static Rx {
    static R: OnceLock<Rx> = OnceLock::new();
    R.get_or_init(|| Rx {
        tag_file: Regex::new(r"(?:^|/)data/[^/]+/tags/(item|items|block|blocks|entity_type|entity_types|fluid|fluids)/").unwrap(),
        recipe: Regex::new(r"(?:^|/)data/[^/]+/recipes?/").unwrap(),
        id: Regex::new(r"^([a-z0-9_.-]+:)?[a-z0-9_./-]+$").unwrap(),
        model: Regex::new(r"^assets/([a-z0-9_.-]+)/models/([a-z0-9_./-]+)\.json$").unwrap(),
        blockstate: Regex::new(r"^assets/([a-z0-9_.-]+)/blockstates/([a-z0-9_./-]+)\.json$").unwrap(),
        item_def: Regex::new(r"^assets/([a-z0-9_.-]+)/items/([a-z0-9_./-]+)\.json$").unwrap(),
        lang: Regex::new(r"^assets/([a-z0-9_.-]+)/lang/en_us\.json$").unwrap(),
        data: Regex::new(r"^data/([a-z0-9_.-]+)/.+\.json$").unwrap(),
    })
}

fn tag_dir(d: &str) -> &'static str {
    match d {
        "block" | "blocks" => "block",
        "entity_type" | "entity_types" => "entity_type",
        "fluid" | "fluids" => "fluid",
        _ => "item",
    }
}

fn is_type(v: Option<&String>, name: &str) -> bool {
    v.is_some_and(|v| v == name || *v == format!("minecraft:{name}"))
}

pub fn want_for(file: &str, c: &Ctx) -> Option<Want> {
    let f = file.replace('\\', "/");
    let r = rx();
    if let Some(t) = r.tag_file.captures(&f) {
        if c.first_key.as_deref() == Some("values") {
            return Some(Want { registry: tag_dir(&t[1]), ids: true, tags: true, hash: true });
        }
    }
    let recipe = r.recipe.is_match(&f);
    let k = c.key.as_deref()?;
    let has = |names: &[&str]| c.ancestors.iter().any(|a| names.contains(&a.as_str()));
    if k == "tag" {
        let mut entity: Vec<&str> = ENTITY_PARENTS.to_vec();
        entity.push("entity_type");
        let registry = if has(&["block", "blocks", "location", "block_state"]) {
            "block"
        } else if has(&entity) {
            "entity_type"
        } else if has(&["fluid", "fluids"]) {
            "fluid"
        } else {
            "item"
        };
        return Some(Want { registry, ids: false, tags: true, hash: false });
    }
    if k == "name" && is_type(c.siblings.get("type"), "item") {
        return Some(Want { registry: "item", ids: true, tags: false, hash: false });
    }
    if k == "name" && is_type(c.siblings.get("type"), "tag") {
        return Some(Want { registry: "item", ids: false, tags: true, hash: false });
    }
    if k == "type" && c.parent_key.as_deref().is_some_and(|p| ENTITY_PARENTS.contains(&p)) {
        return Some(Want { registry: "entity_type", ids: true, tags: true, hash: true });
    }
    if k == "block" || k == "blocks" || k == "Name" {
        return Some(Want { registry: "block", ids: true, tags: k == "blocks", hash: true });
    }
    if k == "entity_type" || k == "entity_types" {
        return Some(Want { registry: "entity_type", ids: true, tags: true, hash: true });
    }
    if k == "fluid" || k == "fluids" {
        return Some(Want { registry: "fluid", ids: false, tags: true, hash: true });
    }
    if k == "result" || (k == "id" && matches!(c.parent_key.as_deref(), Some("result") | Some("icon"))) {
        return Some(Want { registry: "item", ids: true, tags: false, hash: false });
    }
    if ITEM_KEYS.contains(&k) || (recipe && c.parent_key.as_deref() == Some("key")) {
        return Some(Want { registry: "item", ids: true, tags: k != "icon" && k != "item", hash: true });
    }
    None
}

pub fn norm_id(raw: &str) -> String {
    if raw.contains(':') {
        raw.to_string()
    } else {
        format!("minecraft:{raw}")
    }
}

fn split(id: &str) -> (&str, &str) {
    id.split_once(':').unwrap_or(("", id))
}

fn line_of(text: &str, needle: &str, nth: usize) -> u64 {
    let mut from = 0;
    let mut found = None;
    for _ in 0..=nth {
        match text[from..].find(needle) {
            Some(i) => {
                found = Some(from + i);
                from = from + i + needle.len();
            }
            None => {
                found = None;
                break;
            }
        }
    }
    match found {
        Some(i) => 1 + text[..i].bytes().filter(|b| *b == b'\n').count() as u64,
        None => 1,
    }
}

fn walk_files(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk_files(root, &p, out);
        } else if let Ok(rel) = p.strip_prefix(root) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
}

fn blockstate_models(json: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let mut take = |v: &Value| {
        let list: Vec<&Value> = match v {
            Value::Array(a) => a.iter().collect(),
            other => vec![other],
        };
        for x in list {
            if let Some(m) = x.get("model").and_then(|m| m.as_str()) {
                out.push(m.to_string());
            }
        }
    };
    if let Some(Value::Object(v)) = json.get("variants") {
        for val in v.values() {
            take(val);
        }
    }
    if let Some(Value::Array(parts)) = json.get("multipart") {
        for part in parts {
            if let Some(apply) = part.as_object().and_then(|o| o.get("apply")) {
                take(apply);
            }
        }
    }
    out
}

fn nested_models(json: &Value, out: &mut Vec<String>) {
    match json {
        Value::Array(a) => a.iter().for_each(|v| nested_models(v, out)),
        Value::Object(o) => {
            for (k, v) in o {
                match (k.as_str(), v) {
                    ("model", Value::String(s)) => out.push(s.clone()),
                    _ => nested_models(v, out),
                }
            }
        }
        _ => {}
    }
}

fn visit_strings(json: &Value, ancestors: &[String], holder: Option<&Map<String, Value>>, out: &mut dyn FnMut(&str, &Ctx, Option<&Map<String, Value>>)) {
    match json {
        Value::String(s) => {
            let siblings: BTreeMap<String, String> = holder.map(|h| h.iter().filter_map(|(k, v)| v.as_str().map(|t| (k.clone(), t.to_string()))).collect()).unwrap_or_default();
            let ctx = Ctx { key: ancestors.first().cloned(), parent_key: ancestors.get(1).cloned(), ancestors: ancestors.to_vec(), first_key: ancestors.last().cloned(), siblings };
            out(s, &ctx, holder);
        }
        Value::Array(a) => a.iter().for_each(|v| visit_strings(v, ancestors, holder, out)),
        Value::Object(o) => {
            for (k, v) in o {
                let mut next = vec![k.clone()];
                next.extend(ancestors.iter().cloned());
                visit_strings(v, &next, Some(o), out);
            }
        }
        _ => {}
    }
}

fn reg_label(r: &str) -> &'static str {
    match r {
        "block" => "block",
        "entity_type" => "entity type",
        "fluid" => "fluid",
        _ => "item",
    }
}

struct Problems {
    file: String,
    list: Vec<Value>,
}

impl Problems {
    fn add(&mut self, severity: &str, code: &str, message: String, line: u64) {
        self.list.push(json!({ "file": self.file, "line": line, "severity": severity, "message": message, "code": code }));
    }
}

fn check(c: &Collected, res: &str, text: &str, json: &Value, p: &mut Problems) {
    let m = &c.merged;
    let r = rx();
    let modern = c.modern_items();
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut at = |v: &str| -> u64 {
        let needle = serde_json::to_string(v).unwrap_or_default();
        let n = *seen.get(&needle).unwrap_or(&0);
        seen.insert(needle.clone(), n + 1);
        line_of(text, &needle, n)
    };
    let named = |kind: &str, id: &str| {
        let (ns, path) = split(id);
        m.lang.contains_key(&format!("{kind}.{ns}.{path}"))
    };
    let hint = |kind: &str, id: &str| {
        let (ns, path) = split(id);
        format!("add {kind}.{ns}.{path} to assets/{ns}/lang/en_us.json")
    };
    if let Some(cap) = r.model.captures(res) {
        let (ns, path) = (cap[1].to_string(), cap[2].to_string());
        if let Some(parent) = json.get("parent").and_then(|v| v.as_str()).filter(|s| !s.starts_with("builtin/")) {
            if !r.id.is_match(parent) {
                let l = at(parent);
                p.add("error", "parent", format!("{parent} is not a valid model ID"), l);
            } else if !m.models.contains(&norm_id(parent)) {
                let l = at(parent);
                p.add("error", "parent", format!("Parent model {} does not exist", norm_id(parent)), l);
            }
        }
        if let Some(Value::Object(t)) = json.get("textures") {
            for v in t.values() {
                let Some(v) = v.as_str().filter(|v| !v.starts_with('#')) else { continue };
                if !r.id.is_match(v) {
                    let l = at(v);
                    p.add("error", "texture", format!("{v} is not a valid texture ID"), l);
                } else if !m.textures.contains(&norm_id(v)) {
                    let l = at(v);
                    p.add("error", "texture", format!("Texture {} does not exist", norm_id(v)), l);
                }
            }
        }
        if !modern {
            if let Some(item) = path.strip_prefix("item/") {
                let id = format!("{ns}:{item}");
                if !named("item", &id) && !named("block", &id) {
                    p.add("warning", "name", format!("Item {id} has no English name ({})", hint("item", &id)), 1);
                }
            }
        }
    } else if let Some(cap) = r.blockstate.captures(res) {
        let id = format!("{}:{}", &cap[1], &cap[2]);
        for model in blockstate_models(json) {
            check_model(&model, m, &mut at, p);
        }
        if !named("block", &id) {
            p.add("warning", "name", format!("Block {id} has no English name ({})", hint("block", &id)), 1);
        }
    } else if let Some(cap) = r.item_def.captures(res) {
        let id = format!("{}:{}", &cap[1], &cap[2]);
        let mut models = Vec::new();
        nested_models(json, &mut models);
        for model in models {
            check_model(&model, m, &mut at, p);
        }
        if !named("item", &id) && !named("block", &id) {
            p.add("warning", "name", format!("Item {id} has no English name ({})", hint("item", &id)), 1);
        }
    } else if let Some(cap) = r.lang.captures(res) {
        let ns = cap[1].to_string();
        let Value::Object(o) = json else { return };
        let key = Regex::new(&format!(r"^item\.{}\.([a-z0-9_/]+)$", regex::escape(&ns))).unwrap();
        for k in o.keys() {
            let Some(km) = key.captures(k) else { continue };
            let item = km[1].to_string();
            let id = format!("{ns}:{item}");
            let missing = if modern { !m.item_defs.contains(&id) } else { !m.models.contains(&format!("{ns}:item/{item}")) };
            if missing {
                let message = if modern {
                    format!("Item {id} has a name but no item definition (assets/{ns}/items/{item}.json)")
                } else {
                    format!("Item {id} has a name but no item model (assets/{ns}/models/item/{item}.json)")
                };
                p.add("warning", "item-model", message, line_of(text, &serde_json::to_string(k).unwrap_or_default(), 0));
            }
        }
    } else if r.data.is_match(res) {
        let mut visit = |v: &str, ctx: &Ctx, holder: Option<&Map<String, Value>>| {
            if v.is_empty() {
                return;
            }
            let line = at(v);
            let Some(want) = want_for(res, ctx) else { return };
            if holder.is_some_and(|h| h.get("required") == Some(&Value::Bool(false))) {
                return;
            }
            if v.starts_with('#') && !want.tags {
                p.add("error", "tag-not-allowed", format!("Tags are not allowed here: {v}"), line);
                return;
            }
            let is_tag = v.starts_with('#') || (want.tags && !want.ids);
            let raw = v.strip_prefix('#').unwrap_or(v);
            if !r.id.is_match(raw) {
                p.add("error", "id-format", format!("{v} is not a valid ID"), line);
                return;
            }
            let full = norm_id(raw);
            let (ns, _) = split(&full);
            if !m.namespaces.contains(ns) {
                p.add("info", "namespace", format!("No mod provides the namespace {ns}"), line);
                return;
            }
            if is_tag {
                if !m.tags.contains_key(&(want.registry.to_string(), full.clone())) {
                    p.add("warning", "tag", format!("Unknown {} tag #{full}", reg_label(want.registry)), line);
                }
                return;
            }
            let known = match want.registry {
                "item" => Some(&m.items),
                "block" => Some(&m.blocks),
                "entity_type" => Some(&m.entities),
                _ => None,
            };
            if known.is_some_and(|k| !k.contains_key(&full)) {
                p.add("warning", "id", format!("Unknown {} {full}", reg_label(want.registry)), line);
            }
        };
        visit_strings(json, &[], None, &mut visit);
    }
}

fn check_model(raw: &str, m: &crate::regindex::Merged, at: &mut dyn FnMut(&str) -> u64, p: &mut Problems) {
    if !rx().id.is_match(raw) {
        let l = at(raw);
        p.add("error", "model", format!("{raw} is not a valid model ID"), l);
        return;
    }
    let id = norm_id(raw);
    if !m.models.contains(&id) {
        let l = at(raw);
        p.add("error", "model", format!("Model {id} does not exist"), l);
    }
}

impl Runtime {
    pub fn assets_validate(self: &Arc<Self>, root: &str, file: Option<&str>, content: Option<&str>) -> Result<Value, String> {
        let c = self.collect_registry(root)?;
        let target = file.map(|f| f.replace('\\', "/"));
        let mut files: Vec<(String, String, std::path::PathBuf)> = Vec::new();
        for r in &c.roots {
            let mut names = Vec::new();
            for top in ["assets", "data"] {
                walk_files(r, &r.join(top), &mut names);
            }
            for res in names {
                let abs = r.join(&res);
                let rel = abs.strip_prefix(&c.dir).map(|x| x.to_string_lossy().replace('\\', "/")).unwrap_or_else(|_| res.clone());
                files.push((rel, res, abs));
            }
        }
        files.sort_by(|a, b| a.0.cmp(&b.0));
        let mut all: Vec<Value> = Vec::new();
        let mut checked = 0;
        for (rel, res, abs) in files {
            if target.as_ref().is_some_and(|t| *t != rel) || !res.ends_with(".json") {
                continue;
            }
            let text = match (&target, content) {
                (Some(_), Some(c)) => c.to_string(),
                _ => match fs::read(&abs) {
                    Ok(b) => String::from_utf8_lossy(&b).to_string(),
                    Err(_) => continue,
                },
            };
            let text = text.strip_prefix('\u{feff}').unwrap_or(&text).to_string();
            checked += 1;
            let mut p = Problems { file: rel.clone(), list: Vec::new() };
            match serde_json::from_str::<Value>(&text) {
                Err(_) => p.add("error", "json", "This file is not valid JSON".into(), 1),
                Ok(json) => {
                    if c.vanilla {
                        check(&c, &res, &text, &json, &mut p);
                    }
                }
            }
            all.extend(p.list);
        }
        let mut seen = BTreeSet::new();
        let mut unique: Vec<Value> = all.into_iter().filter(|p| seen.insert(format!("{}|{}|{}", p["file"], p["line"], p["message"]))).collect();
        unique.sort_by(|a, b| {
            let ka = (a["file"].as_str().unwrap_or(""), a["line"].as_u64().unwrap_or(0), a["message"].as_str().unwrap_or(""));
            let kb = (b["file"].as_str().unwrap_or(""), b["line"].as_u64().unwrap_or(0), b["message"].as_str().unwrap_or(""));
            ka.cmp(&kb)
        });
        Ok(json!({ "problems": unique, "checked": checked, "complete": c.vanilla, "pending": c.pending }))
    }

    pub fn assets_model(self: &Arc<Self>, root: &str, model: &str) -> Result<Value, String> {
        let c = self.collect_registry(root)?;
        let id = norm_id(model);
        let mut chain: Vec<String> = Vec::new();
        let mut missing: Vec<String> = Vec::new();
        let mut textures: Map<String, Value> = Map::new();
        let mut elements = Value::Null;
        let mut display = Value::Null;
        let mut gui_light = Value::Null;
        let mut generated = false;
        let mut builtin = Value::Null;
        let mut cur = id.clone();
        for _ in 0..16 {
            let plain = cur.strip_prefix("minecraft:").unwrap_or(&cur).to_string();
            if plain.starts_with("builtin/") {
                if plain == "builtin/generated" {
                    generated = true;
                } else {
                    builtin = json!(plain);
                }
                break;
            }
            let (ns, path) = split(&cur);
            let json: Option<Value> = read_resource(&c.sources, &format!("assets/{ns}/models/{path}.json")).and_then(|b| {
                let t = String::from_utf8_lossy(&b).to_string();
                serde_json::from_str::<Value>(t.strip_prefix('\u{feff}').unwrap_or(&t)).ok()
            });
            let Some(Value::Object(j)) = json else {
                missing.push(cur.clone());
                break;
            };
            chain.push(cur.clone());
            if let Some(Value::Object(t)) = j.get("textures") {
                for (k, v) in t {
                    if v.is_string() && !textures.contains_key(k) {
                        textures.insert(k.clone(), v.clone());
                    }
                }
            }
            if elements.is_null() {
                if let Some(e @ Value::Array(_)) = j.get("elements") {
                    elements = e.clone();
                }
            }
            if display.is_null() {
                if let Some(g @ Value::Object(_)) = j.get("display").and_then(|d| d.as_object()).and_then(|d| d.get("gui")) {
                    display = g.clone();
                }
            }
            if gui_light.is_null() {
                if let Some(g @ Value::String(_)) = j.get("gui_light") {
                    gui_light = g.clone();
                }
            }
            let Some(parent) = j.get("parent").and_then(|p| p.as_str()) else { break };
            let next = if parent.starts_with("builtin/") { parent.to_string() } else { norm_id(parent) };
            if chain.contains(&next) {
                break;
            }
            cur = next;
        }
        let mut resolved: BTreeMap<String, String> = BTreeMap::new();
        let mut keys: Vec<&String> = textures.keys().collect();
        keys.sort();
        for k in keys {
            let mut v = textures[k].as_str().unwrap_or("").to_string();
            for _ in 0..8 {
                if !v.starts_with('#') {
                    break;
                }
                match textures.get(&v[1..]).and_then(|x| x.as_str()) {
                    Some(n) => v = n.to_string(),
                    None => break,
                }
            }
            if !v.starts_with('#') && rx().id.is_match(&v) {
                resolved.insert(k.clone(), norm_id(&v));
            }
        }
        let mut images = Map::new();
        let unique: BTreeSet<&String> = resolved.values().collect();
        for t in unique {
            let (ns, path) = split(t);
            match read_resource(&c.sources, &format!("assets/{ns}/textures/{path}.png")) {
                Some(bytes) => {
                    images.insert(t.clone(), json!(base64::engine::general_purpose::STANDARD.encode(bytes)));
                }
                None => missing.push(t.clone()),
            }
        }
        Ok(json!({
            "id": id,
            "chain": chain,
            "generated": generated,
            "builtin": builtin,
            "elements": elements,
            "textures": resolved,
            "display": display,
            "guiLight": gui_light,
            "images": images,
            "missing": missing
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(ancestors: &[&str], siblings: &[(&str, &str)]) -> Ctx {
        let a: Vec<String> = ancestors.iter().map(|s| s.to_string()).collect();
        Ctx { key: a.first().cloned(), parent_key: a.get(1).cloned(), first_key: a.last().cloned(), ancestors: a, siblings: siblings.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect() }
    }

    #[test]
    fn rules_match_the_editor() {
        let recipe = "src/main/resources/data/demo/recipe/crate.json";
        assert_eq!(want_for(recipe, &ctx(&["item", "#", "key"], &[])), Some(Want { registry: "item", ids: true, tags: false, hash: true }));
        assert_eq!(want_for(recipe, &ctx(&["#", "key"], &[])), Some(Want { registry: "item", ids: true, tags: true, hash: true }));
        assert_eq!(want_for(recipe, &ctx(&["tag", "X", "key"], &[])), Some(Want { registry: "item", ids: false, tags: true, hash: false }));
        assert_eq!(want_for(recipe, &ctx(&["id", "result"], &[])), Some(Want { registry: "item", ids: true, tags: false, hash: false }));
        assert_eq!(want_for("data/demo/tags/block/x.json", &ctx(&["values"], &[])), Some(Want { registry: "block", ids: true, tags: true, hash: true }));
        assert_eq!(want_for("data/demo/loot_table/a.json", &ctx(&["name", "entries", "pools"], &[("type", "minecraft:item")])), Some(Want { registry: "item", ids: true, tags: false, hash: false }));
        assert_eq!(want_for("data/demo/advancement/a.json", &ctx(&["type", "entity", "conditions", "k", "criteria"], &[])), Some(Want { registry: "entity_type", ids: true, tags: true, hash: true }));
        assert_eq!(want_for("data/demo/predicate/p.json", &ctx(&["tag", "block", "location", "predicate"], &[])), Some(Want { registry: "block", ids: false, tags: true, hash: false }));
        assert_eq!(want_for(recipe, &ctx(&["type"], &[])), None);
    }

    #[test]
    fn finds_the_line_of_the_nth_occurrence() {
        let text = "{\n  \"a\": \"x\",\n  \"b\": \"x\"\n}";
        assert_eq!(line_of(text, "\"x\"", 0), 2);
        assert_eq!(line_of(text, "\"x\"", 1), 3);
        assert_eq!(line_of(text, "\"x\"", 2), 1);
    }
}
