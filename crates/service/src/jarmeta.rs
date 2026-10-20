use crate::js;
use serde_json::{json, Map, Value};
use std::io::{Cursor, Read};

fn as_record(v: Option<&Value>) -> Value {
    let mut out = Map::new();
    if let Some(Value::Object(o)) = v {
        for (k, val) in o {
            let text = match val {
                Value::Array(items) => items.iter().map(js::string).collect::<Vec<_>>().join(" || "),
                other => js::string(other),
            };
            out.insert(k.clone(), Value::String(text));
        }
    }
    Value::Object(out)
}

pub fn escape_control_chars_in_strings(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut quote: Option<char> = None;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            if c == '\\' {
                out.push(c);
                if let Some(n) = chars.next() {
                    out.push(n);
                }
                continue;
            }
            if c == q {
                quote = None;
            } else {
                let named = match c {
                    '\n' => Some("\\n"),
                    '\r' => Some("\\r"),
                    '\t' => Some("\\t"),
                    _ => None,
                };
                if let Some(n) = named {
                    out.push_str(n);
                    continue;
                }
            }
        } else if c == '"' || c == '\'' {
            quote = Some(c);
        }
        out.push(c);
    }
    out
}

fn parse_lenient_json(text: &str) -> Result<Value, String> {
    let clean = text.strip_prefix('\u{feff}').unwrap_or(text);
    match json5::from_str::<Value>(clean) {
        Ok(v) => Ok(v),
        Err(first) => json5::from_str::<Value>(&escape_control_chars_in_strings(clean)).map_err(|_| format!("JSON5: {first}")),
    }
}

fn opt_string(v: Option<&Value>) -> Option<Value> {
    v.and_then(Value::as_str).map(|s| Value::String(s.to_string()))
}

pub fn parse_fabric_mod_json(text: &str) -> Result<Map<String, Value>, String> {
    let j = parse_lenient_json(text)?;
    let Some(id) = j.get("id").and_then(Value::as_str) else { return Err("fabric.mod.json has no id".into()) };
    let mut m = Map::new();
    m.insert("loader".into(), json!("fabric"));
    m.insert("id".into(), json!(id));
    m.insert("version".into(), json!(j.get("version").filter(|v| !v.is_null()).map(js::string).unwrap_or_default()));
    if let Some(v) = opt_string(j.get("name")) {
        m.insert("name".into(), v);
    }
    if let Some(v) = opt_string(j.get("description")) {
        m.insert("description".into(), v);
    }
    match j.get("license") {
        Some(Value::Array(items)) => {
            m.insert("license".into(), json!(items.iter().map(|i| if i.is_null() { String::new() } else { js::string(i) }).collect::<Vec<_>>().join(", ")));
        }
        Some(Value::String(s)) => {
            m.insert("license".into(), json!(s));
        }
        _ => {}
    }
    m.insert("environment".into(), opt_string(j.get("environment")).unwrap_or_else(|| json!("*")));
    let provides: Vec<String> = j.get("provides").and_then(Value::as_array).map(|a| a.iter().map(js::string).collect()).unwrap_or_default();
    m.insert("provides".into(), json!(provides));
    for key in ["depends", "recommends", "breaks", "conflicts"] {
        m.insert(key.into(), as_record(j.get(key)));
    }
    Ok(m)
}

fn toml_to_json(v: &toml::Value) -> Value {
    match v {
        toml::Value::String(s) => json!(s),
        toml::Value::Integer(i) => json!(i),
        toml::Value::Float(f) => serde_json::Number::from_f64(*f).map(Value::Number).unwrap_or(Value::Null),
        toml::Value::Boolean(b) => json!(b),
        toml::Value::Datetime(d) => json!(d.to_string()),
        toml::Value::Array(a) => Value::Array(a.iter().map(toml_to_json).collect()),
        toml::Value::Table(t) => Value::Object(t.iter().map(|(k, v)| (k.clone(), toml_to_json(v))).collect()),
    }
}

pub fn parse_mods_toml(text: &str, loader: &str) -> Result<Vec<Map<String, Value>>, String> {
    let table: toml::Table = text.parse().map_err(|e: toml::de::Error| e.message().to_string())?;
    let t = toml_to_json(&toml::Value::Table(table));
    let empty = vec![];
    let mods = t.get("mods").and_then(Value::as_array).unwrap_or(&empty);
    let deps = t.get("dependencies").cloned().unwrap_or(Value::Null);
    let mut out = Vec::new();
    for m in mods {
        let id = m.get("modId").map(js::string).unwrap_or_else(|| "undefined".into());
        let mut depends = Map::new();
        let mut breaks = Map::new();
        for d in deps.get(&id).and_then(Value::as_array).into_iter().flatten() {
            let mandatory = d.get("mandatory");
            let kind = match d.get("type").filter(|v| !v.is_null()) {
                Some(v) => js::string(v),
                None => (if js::truthy(mandatory) { "required" } else { "optional" }).to_string(),
            }
            .to_lowercase();
            let range = d.get("versionRange").filter(|v| !v.is_null()).map(js::string).unwrap_or_else(|| "*".into());
            let dep_id = d.get("modId").map(js::string).unwrap_or_else(|| "undefined".into());
            if kind == "required" || mandatory == Some(&Value::Bool(true)) {
                depends.insert(dep_id.clone(), json!(range));
            }
            if kind == "incompatible" {
                breaks.insert(dep_id, json!(range));
            }
        }
        let mut e = Map::new();
        e.insert("loader".into(), json!(loader));
        e.insert("id".into(), json!(id));
        e.insert("version".into(), json!(m.get("version").filter(|v| !v.is_null()).map(js::string).unwrap_or_default()));
        if js::truthy(m.get("displayName")) {
            e.insert("name".into(), json!(js::string(&m["displayName"])));
        }
        if js::truthy(m.get("description")) {
            e.insert("description".into(), json!(js::string(&m["description"])));
        }
        if js::truthy(t.get("license")) {
            e.insert("license".into(), json!(js::string(&t["license"])));
        }
        e.insert("provides".into(), json!([]));
        e.insert("depends".into(), Value::Object(depends));
        e.insert("recommends".into(), json!({}));
        e.insert("breaks".into(), Value::Object(breaks));
        e.insert("conflicts".into(), json!({}));
        out.push(e);
    }
    Ok(out)
}

fn nested_jar(name: &str) -> bool {
    (name.starts_with("META-INF/jars/") || name.starts_with("META-INF/jarjar/")) && name.ends_with(".jar")
}

fn with(mut m: Map<String, Value>, nested: &[Value], file: &str) -> Value {
    m.insert("nested".into(), Value::Array(nested.to_vec()));
    m.insert("file".into(), json!(file));
    Value::Object(m)
}

fn read_jar_buffer(buf: &[u8], file: &str, depth: usize) -> Result<Vec<Value>, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(buf)).map_err(|e| e.to_string())?;
    let wanted = ["fabric.mod.json", "quilt.mod.json", "META-INF/neoforge.mods.toml", "META-INF/mods.toml"];
    let mut found: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().map(|n| n.to_string()).map_err(|e| e.to_string())?;
        if wanted.contains(&name.as_str()) || (depth < 2 && nested_jar(&name)) {
            let mut data = Vec::new();
            entry.read_to_end(&mut data).map_err(|e| e.to_string())?;
            if let Some(slot) = found.iter_mut().find(|(n, _)| *n == name) {
                slot.1 = data;
            } else {
                found.push((name, data));
            }
        }
    }
    let mut nested: Vec<Value> = Vec::new();
    for (name, data) in &found {
        if nested_jar(name) {
            if let Ok(inner) = read_jar_buffer(data, &format!("{file}!/{name}"), depth + 1) {
                nested.extend(inner);
            }
        }
    }
    let get = |n: &str| found.iter().find(|(name, _)| name == n).map(|(_, d)| String::from_utf8_lossy(d).into_owned());
    if let Some(text) = get("fabric.mod.json") {
        return Ok(vec![with(parse_fabric_mod_json(&text)?, &nested, file)]);
    }
    if let Some(text) = get("quilt.mod.json") {
        let q: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let ql = &q["quilt_loader"];
        let mut m = Map::new();
        m.insert("loader".into(), json!("quilt"));
        m.insert("id".into(), ql.get("id").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!("unknown")));
        m.insert("version".into(), ql.get("version").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!("")));
        if let Some(name) = ql.get("metadata").and_then(|md| md.get("name")) {
            m.insert("name".into(), name.clone());
        }
        for (k, v) in [("provides", json!([])), ("depends", json!({})), ("recommends", json!({})), ("breaks", json!({})), ("conflicts", json!({}))] {
            m.insert(k.into(), v);
        }
        return Ok(vec![with(m, &nested, file)]);
    }
    for (entry, loader) in [("META-INF/neoforge.mods.toml", "neoforge"), ("META-INF/mods.toml", "forge")] {
        if let Some(text) = get(entry) {
            return Ok(parse_mods_toml(&text, loader)?.into_iter().map(|m| with(m, &nested, file)).collect());
        }
    }
    if !nested.is_empty() {
        return Ok(nested
            .into_iter()
            .map(|mut m| {
                if let Some(o) = m.as_object_mut() {
                    o.insert("file".into(), json!(file));
                }
                m
            })
            .collect());
    }
    Ok(vec![])
}

pub fn read_jar_metadata(file: &str) -> Result<Value, String> {
    let path = std::path::Path::new(file);
    let buf = std::fs::read(path).map_err(|e| js::fs_error(&e, "open", path))?;
    Ok(Value::Array(read_jar_buffer(&buf, file, 0)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lenient_fabric_json() {
        let text = "\u{feff}{\n  \"schemaVersion\": 1,\n  \"id\": \"bettergrass\",\n  \"version\": \"1.8.6\",\n  \"description\": \"Gamers can finally touch grass!\nOptiFine's better grass\",\n  \"depends\": { \"fabricloader\": \">=0.15\" }\n}";
        let m = parse_fabric_mod_json(text).unwrap();
        assert_eq!(m["id"], "bettergrass");
        assert_eq!(m["description"], "Gamers can finally touch grass!\nOptiFine's better grass");
        assert_eq!(m["depends"], json!({ "fabricloader": ">=0.15" }));
    }

    #[test]
    fn escapes_only_inside_strings() {
        assert_eq!(escape_control_chars_in_strings("{\n\"a\": \"x\ty\",\n\"b\": \"q\\\"\nr\"}"), "{\n\"a\": \"x\\ty\",\n\"b\": \"q\\\"\\nr\"}");
    }
}
