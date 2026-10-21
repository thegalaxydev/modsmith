use crate::js;
use crate::rt::{s, Runtime};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_THEME_FILE: u64 = 5 * 1024 * 1024;
const MAX_PACKAGE: u64 = 100 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;
const MAX_UNPACKED: u64 = 300 * 1024 * 1024;
const MAX_DEPTH: usize = 16;

pub fn strip_jsonc(text: &str) -> String {
    let chars: Vec<char> = text.trim_start_matches('\u{feff}').chars().collect();
    let mut out = String::with_capacity(chars.len());
    let mut i = 0;
    let mut in_string = false;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if c == '\\' && i + 1 < chars.len() {
                out.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_string = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == '/' && i + 1 < chars.len() && chars[i + 1] == '/' {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                if chars[i] == '\n' {
                    out.push('\n');
                }
                i += 1;
            }
            i += 2;
            continue;
        }
        if c == ',' {
            let mut j = i + 1;
            let mut trailing = false;
            loop {
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                if j + 1 < chars.len() && chars[j] == '/' && chars[j + 1] == '/' {
                    while j < chars.len() && chars[j] != '\n' {
                        j += 1;
                    }
                    continue;
                }
                if j + 1 < chars.len() && chars[j] == '/' && chars[j + 1] == '*' {
                    j += 2;
                    while j + 1 < chars.len() && !(chars[j] == '*' && chars[j + 1] == '/') {
                        j += 1;
                    }
                    j += 2;
                    continue;
                }
                if j < chars.len() && (chars[j] == '}' || chars[j] == ']') {
                    trailing = true;
                }
                break;
            }
            if !trailing {
                out.push(c);
            }
            i += 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

pub fn parse_jsonc(text: &str, label: &str) -> Result<Value, String> {
    serde_json::from_str(&strip_jsonc(text)).map_err(|_| format!("{label} is not valid JSON or JSONC"))
}

pub fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_end_matches('-').to_string();
    if trimmed.is_empty() {
        "theme".into()
    } else {
        trimmed.chars().take(60).collect()
    }
}

fn valid_id(id: &str) -> bool {
    let ok_chars = id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-');
    !id.is_empty() && id.len() <= 200 && ok_chars && !id.starts_with('.') && !id.contains("..")
}

pub fn normalize_rel(base_dir: &str, rel: &str, root: &str, what: &str) -> Result<String, String> {
    let rel = rel.replace('\\', "/");
    if rel.starts_with('/') || rel.contains(':') {
        return Err(format!("{rel} points outside the {what}"));
    }
    let mut parts: Vec<String> = base_dir.split('/').filter(|p| !p.is_empty()).map(str::to_string).collect();
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(format!("{rel} points outside the {what}"));
                }
            }
            other => parts.push(other.to_string()),
        }
    }
    let joined = parts.join("/");
    let root_prefix = if root.is_empty() { String::new() } else { format!("{root}/") };
    if !root.is_empty() && !joined.starts_with(&root_prefix) {
        return Err(format!("{rel} points outside the {what}"));
    }
    Ok(joined)
}

fn dirname(rel: &str) -> String {
    match rel.rfind('/') {
        Some(i) => rel[..i].to_string(),
        None => String::new(),
    }
}

enum Source {
    Dir { root: PathBuf },
    Package { files: HashMap<String, Vec<u8>> },
}

impl Source {
    fn what(&self) -> &'static str {
        match self {
            Source::Dir { .. } => "theme folder",
            Source::Package { .. } => "extension",
        }
    }

    fn root(&self) -> &'static str {
        match self {
            Source::Dir { .. } => "",
            Source::Package { .. } => "extension",
        }
    }

    fn read(&self, rel: &str) -> Result<Vec<u8>, String> {
        match self {
            Source::Dir { root } => {
                let file = root.join(rel);
                let meta = fs::metadata(&file).map_err(|_| format!("{rel} is missing"))?;
                if !meta.is_file() {
                    return Err(format!("{rel} is missing"));
                }
                if meta.len() > MAX_THEME_FILE {
                    return Err(format!("{rel} is too large; theme files are limited to 5 MB"));
                }
                fs::read(&file).map_err(|e| js::fs_error(&e, "open", &file))
            }
            Source::Package { files } => files.get(rel).cloned().ok_or_else(|| format!("{rel} is missing")),
        }
    }
}

fn open_package(file: &Path) -> Result<zip::ZipArchive<fs::File>, String> {
    let meta = fs::metadata(file).map_err(|e| js::fs_error(&e, "stat", file))?;
    if meta.len() > MAX_PACKAGE {
        return Err("The package is too large; .vsix files are limited to 100 MB".into());
    }
    let handle = fs::File::open(file).map_err(|e| js::fs_error(&e, "open", file))?;
    let mut zip = zip::ZipArchive::new(handle).map_err(|_| "The package is not a valid .vsix archive".to_string())?;
    if zip.len() > MAX_ENTRIES {
        return Err("The package has too many files".into());
    }
    let mut total = 0u64;
    for i in 0..zip.len() {
        let entry = zip.by_index_raw(i).map_err(|_| "The package is not a valid .vsix archive".to_string())?;
        let name = String::from_utf8_lossy(entry.name_raw()).to_string();
        if name.starts_with('/') || name.starts_with('\\') || name.contains('\\') || name.contains(':') || name.split('/').any(|p| p == "..") {
            return Err(format!("The package has an unsafe file path: {name}"));
        }
        total += entry.size();
        if total > MAX_UNPACKED {
            return Err("The package unpacks to more than 300 MB".into());
        }
    }
    Ok(zip)
}

fn read_entry(zip: &mut zip::ZipArchive<fs::File>, name: &str) -> Result<Option<Vec<u8>>, String> {
    let mut entry = match zip.by_name(name) {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };
    if entry.is_dir() {
        return Ok(None);
    }
    if entry.size() > MAX_THEME_FILE {
        return Err(format!("{name} is too large; theme files are limited to 5 MB"));
    }
    let mut buf = Vec::new();
    (&mut entry).take(MAX_THEME_FILE + 1).read_to_end(&mut buf).map_err(|_| "The package is not a valid .vsix archive".to_string())?;
    if buf.len() as u64 > MAX_THEME_FILE {
        return Err(format!("{name} is too large; theme files are limited to 5 MB"));
    }
    Ok(Some(buf))
}

fn package_files(zip: &mut zip::ZipArchive<fs::File>) -> Result<HashMap<String, Vec<u8>>, String> {
    let names: Vec<String> = zip.file_names().filter_map(|n| n.ok().map(|n| n.to_string())).collect();
    let mut files = HashMap::new();
    for name in names {
        if !name.starts_with("extension/") || !(name.ends_with(".json") || name.ends_with(".jsonc")) {
            continue;
        }
        let too_big = zip.by_name(&name).map(|e| e.size() > MAX_THEME_FILE).unwrap_or(true);
        if too_big && name != "extension/package.json" {
            continue;
        }
        if let Some(bytes) = read_entry(zip, &name)? {
            files.insert(name, bytes);
        }
    }
    Ok(files)
}

fn ui_type(ui: &str) -> Value {
    match ui {
        "vs" => json!("light"),
        "vs-dark" => json!("dark"),
        "hc-black" => json!("hc-dark"),
        "hc-light" => json!("hc-light"),
        _ => Value::Null,
    }
}

fn json_type(t: &Value) -> Value {
    match t.as_str().unwrap_or("").to_lowercase().as_str() {
        "light" | "vs" => json!("light"),
        "dark" | "vs-dark" => json!("dark"),
        "hc" | "hc-black" | "hcdark" | "hc-dark" => json!("hc-dark"),
        "hclight" | "hc-light" => json!("hc-light"),
        _ => Value::Null,
    }
}

struct Loaded {
    theme: Map<String, Value>,
    files: Vec<String>,
    warnings: Vec<String>,
}

fn text_of(bytes: &[u8], rel: &str) -> Result<String, String> {
    String::from_utf8(bytes.to_vec()).map_err(|_| format!("{rel} is not valid JSON or JSONC"))
}

fn load(src: &Source, rel: &str, stack: &mut Vec<String>) -> Result<Loaded, String> {
    if stack.iter().any(|r| r == rel) {
        let mut chain = stack.clone();
        chain.push(rel.to_string());
        return Err(format!("Include cycle: {}", chain.join(" -> ")));
    }
    if stack.len() >= MAX_DEPTH {
        return Err(format!("Includes are nested more than {MAX_DEPTH} levels deep at {rel}"));
    }
    let bytes = src.read(rel)?;
    let value = parse_jsonc(&text_of(&bytes, rel)?, rel)?;
    let Some(obj) = value.as_object() else {
        return Err(format!("{rel} is not a VS Code color theme (expected an object with colors or tokenColors)"));
    };
    stack.push(rel.to_string());
    let dir = dirname(rel);
    let mut out = Loaded { theme: Map::new(), files: vec![rel.to_string()], warnings: Vec::new() };
    let mut colors = Map::new();
    let mut token_colors: Vec<Value> = Vec::new();
    let mut semantic = Map::new();
    let mut semantic_on = Value::Null;
    if let Some(inc) = obj.get("include") {
        let Some(inc) = inc.as_str() else {
            stack.pop();
            return Err(format!("{rel} has an include that is not a file path"));
        };
        let target = normalize_rel(&dir, inc, src.root(), src.what())?;
        let base = load(src, &target, stack)?;
        if let Some(c) = base.theme.get("colors").and_then(Value::as_object) {
            colors.extend(c.clone());
        }
        if let Some(t) = base.theme.get("tokenColors").and_then(Value::as_array) {
            token_colors.extend(t.iter().cloned());
        }
        if let Some(sm) = base.theme.get("semanticTokenColors").and_then(Value::as_object) {
            semantic.extend(sm.clone());
        }
        if let Some(b) = base.theme.get("semanticHighlighting").filter(|v| v.is_boolean()) {
            semantic_on = b.clone();
        }
        for k in ["name", "type"] {
            if let Some(v) = base.theme.get(k) {
                out.theme.insert(k.into(), v.clone());
            }
        }
        out.files.extend(base.files);
        out.warnings.extend(base.warnings);
    }
    if let Some(c) = obj.get("colors") {
        match c.as_object() {
            Some(c) => colors.extend(c.iter().filter(|(_, v)| v.is_string() || v.is_null()).map(|(k, v)| (k.clone(), v.clone()))),
            None => out.warnings.push(format!("{rel}: colors is not an object and was ignored")),
        }
    }
    match obj.get("tokenColors") {
        Some(Value::Array(rules)) => token_colors.extend(rules.iter().filter(|r| r.is_object()).cloned()),
        Some(Value::String(path)) => {
            let target = normalize_rel(&dir, path, src.root(), src.what())?;
            if target.ends_with(".json") || target.ends_with(".jsonc") {
                let bytes = src.read(&target)?;
                let v = parse_jsonc(&text_of(&bytes, &target)?, &target)?;
                let rules = v.as_array().cloned().or_else(|| v.get("tokenColors").and_then(Value::as_array).cloned()).unwrap_or_default();
                token_colors.extend(rules.into_iter().filter(Value::is_object));
                out.files.push(target);
            } else {
                out.warnings.push(format!("{rel}: tokenColors from {path} were skipped because .tmTheme files are not supported"));
            }
        }
        Some(_) => out.warnings.push(format!("{rel}: tokenColors is not a list and was ignored")),
        None => {}
    }
    if let Some(sm) = obj.get("semanticTokenColors").and_then(Value::as_object) {
        semantic.extend(sm.clone());
    }
    if let Some(b) = obj.get("semanticHighlighting").filter(|v| v.is_boolean()) {
        semantic_on = b.clone();
    }
    for k in ["name", "type"] {
        if let Some(v) = obj.get(k).filter(|v| v.is_string()) {
            out.theme.insert(k.into(), v.clone());
        }
    }
    out.theme.insert("colors".into(), Value::Object(colors));
    out.theme.insert("tokenColors".into(), Value::Array(token_colors));
    out.theme.insert("semanticTokenColors".into(), Value::Object(semantic));
    out.theme.insert("semanticHighlighting".into(), semantic_on);
    stack.pop();
    Ok(out)
}

fn is_package(file: &str) -> bool {
    file.to_lowercase().ends_with(".vsix")
}

fn is_json(file: &str) -> bool {
    let f = file.to_lowercase();
    f.ends_with(".json") || f.ends_with(".jsonc")
}

fn unsupported() -> String {
    "Choose a VS Code color theme (.json or .jsonc) or a theme extension (.vsix)".into()
}

struct Variant {
    key: String,
    label: String,
    ui: Value,
}

struct Package {
    extension: Value,
    variants: Vec<Variant>,
    files: HashMap<String, Vec<u8>>,
}

fn read_package(file: &Path) -> Result<Package, String> {
    let mut zip = open_package(file)?;
    let manifest = read_entry(&mut zip, "extension/package.json")?.ok_or("The package has no extension/package.json")?;
    let pkg = parse_jsonc(&text_of(&manifest, "extension/package.json")?, "extension/package.json")?;
    let themes = pkg["contributes"]["themes"].as_array().cloned().unwrap_or_default();
    if themes.is_empty() {
        return Err("This extension does not contribute any color themes".into());
    }
    let mut variants = Vec::new();
    for t in themes {
        let Some(path) = t["path"].as_str() else { continue };
        let key = normalize_rel("extension", path, "extension", "extension")?;
        let label = t["label"].as_str().or(t["id"].as_str()).unwrap_or(path).to_string();
        variants.push(Variant { key, label, ui: ui_type(t["uiTheme"].as_str().unwrap_or("")) });
    }
    if variants.is_empty() {
        return Err("This extension does not contribute any color themes".into());
    }
    let files = package_files(&mut zip)?;
    let extension = json!({
        "publisher": pkg["publisher"].as_str().unwrap_or(""),
        "name": pkg["name"].as_str().unwrap_or(""),
        "displayName": pkg["displayName"].as_str().unwrap_or(pkg["name"].as_str().unwrap_or("")),
        "version": pkg["version"].as_str().unwrap_or("")
    });
    Ok(Package { extension, variants, files })
}

fn record(id: &str, name: &str, author: Value, ty: Value, source: Value, loaded: &Loaded) -> Value {
    let mut theme = loaded.theme.clone();
    let ty = if ty.is_null() { json_type(theme.get("type").unwrap_or(&Value::Null)) } else { ty };
    theme.remove("name");
    theme.remove("type");
    json!({
        "id": id,
        "name": name,
        "author": author,
        "type": ty,
        "source": source,
        "installedAt": js::iso_now(),
        "theme": Value::Object(theme),
        "warnings": loaded.warnings
    })
}

impl Runtime {
    fn themes_dir(&self) -> PathBuf {
        self.data.join("themes")
    }

    pub fn theme_inspect(&self, file: &str) -> Result<Value, String> {
        let path = js::absolute(file);
        if !path.is_file() {
            return Err(format!("{} does not exist", path.display()));
        }
        let name = s(&path);
        if is_package(&name) {
            let pkg = read_package(&path)?;
            let variants: Vec<Value> = pkg.variants.iter().map(|v| json!({ "key": v.key, "label": v.label, "type": v.ui })).collect();
            return Ok(json!({ "kind": "vsix", "extension": pkg.extension, "variants": variants }));
        }
        if !is_json(&name) {
            return Err(unsupported());
        }
        let root = path.parent().map(Path::to_path_buf).unwrap_or_default();
        let rel = crate::rt::basename(&path);
        let loaded = load(&Source::Dir { root }, &rel, &mut Vec::new())?;
        let label = loaded.theme.get("name").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| rel.trim_end_matches(".jsonc").trim_end_matches(".json").to_string());
        Ok(json!({ "kind": "json", "extension": Value::Null, "variants": [{ "key": "theme", "label": label, "type": json_type(loaded.theme.get("type").unwrap_or(&Value::Null)) }] }))
    }

    pub fn theme_install(&self, file: &str, variants: Option<Vec<String>>) -> Result<Value, String> {
        let path = js::absolute(file);
        if !path.is_file() {
            return Err(format!("{} does not exist", path.display()));
        }
        let name = s(&path);
        let mut prepared: Vec<(Value, Vec<(String, Vec<u8>)>)> = Vec::new();
        if is_package(&name) {
            let pkg = read_package(&path)?;
            let wanted: Vec<&Variant> = match &variants {
                Some(keys) if !keys.is_empty() => {
                    let mut out = Vec::new();
                    for k in keys {
                        out.push(pkg.variants.iter().find(|v| &v.key == k).ok_or_else(|| format!("{k} is not a theme in this package"))?);
                    }
                    out
                }
                _ => pkg.variants.iter().collect(),
            };
            let src = Source::Package { files: pkg.files.clone() };
            for v in wanted {
                let loaded = load(&src, &v.key, &mut Vec::new())?;
                let id = format!("{}.{}.{}", slug(pkg.extension["publisher"].as_str().unwrap_or("")), slug(pkg.extension["name"].as_str().unwrap_or("")), slug(&v.label));
                let source = json!({ "kind": "vsix", "file": name, "extension": pkg.extension, "path": v.key });
                let author = pkg.extension["publisher"].as_str().filter(|p| !p.is_empty()).map(|p| json!(p)).unwrap_or(Value::Null);
                let rec = record(&id, &v.label, author, v.ui.clone(), source, &loaded);
                let mut files: Vec<(String, Vec<u8>)> = vec![("extension/package.json".into(), pkg.files.get("extension/package.json").cloned().unwrap_or_default())];
                for f in &loaded.files {
                    if let Some(b) = pkg.files.get(f) {
                        files.push((f.clone(), b.clone()));
                    }
                }
                prepared.push((rec, files));
            }
        } else if is_json(&name) {
            let root = path.parent().map(Path::to_path_buf).unwrap_or_default();
            let rel = crate::rt::basename(&path);
            let src = Source::Dir { root };
            let loaded = load(&src, &rel, &mut Vec::new())?;
            let label = loaded.theme.get("name").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| rel.trim_end_matches(".jsonc").trim_end_matches(".json").to_string());
            let id = format!("file.{}", slug(&label));
            let source = json!({ "kind": "json", "file": name, "extension": Value::Null, "path": rel });
            let rec = record(&id, &label, Value::Null, Value::Null, source, &loaded);
            let mut files = Vec::new();
            for f in &loaded.files {
                files.push((f.clone(), src.read(f)?));
            }
            prepared.push((rec, files));
        } else {
            return Err(unsupported());
        }
        let dir = self.themes_dir();
        fs::create_dir_all(&dir).map_err(|e| js::fs_error(&e, "mkdir", &dir))?;
        let mut installed = Vec::new();
        let mut updated = Vec::new();
        for (rec, files) in prepared {
            let id = js::string(&rec["id"]);
            if !valid_id(&id) {
                return Err(format!("Could not derive a safe id for {}", js::string(&rec["name"])));
            }
            let target = dir.join(&id);
            let part = dir.join(format!("{id}.part"));
            let _ = fs::remove_dir_all(&part);
            fs::create_dir_all(part.join("source")).map_err(|e| js::fs_error(&e, "mkdir", &part))?;
            for (rel, bytes) in &files {
                let dest = part.join("source").join(rel);
                if let Some(p) = dest.parent() {
                    fs::create_dir_all(p).map_err(|e| js::fs_error(&e, "mkdir", p))?;
                }
                fs::write(&dest, bytes).map_err(|e| js::fs_error(&e, "open", &dest))?;
            }
            let theme_file = part.join("theme.json");
            fs::write(&theme_file, js::pretty(&rec)).map_err(|e| js::fs_error(&e, "open", &theme_file))?;
            if target.exists() {
                updated.push(json!(id));
                fs::remove_dir_all(&target).map_err(|e| js::fs_error(&e, "rmdir", &target))?;
            }
            fs::rename(&part, &target).map_err(|e| js::fs_error(&e, "rename", &part))?;
            installed.push(rec);
        }
        Ok(json!({ "installed": installed, "updated": updated }))
    }

    pub fn theme_list(&self) -> Value {
        let dir = self.themes_dir();
        let mut out: Vec<Value> = fs::read_dir(&dir)
            .map(|d| {
                d.flatten()
                    .filter(|e| e.path().is_dir() && !e.file_name().to_string_lossy().ends_with(".part"))
                    .filter_map(|e| fs::read_to_string(e.path().join("theme.json")).ok())
                    .filter_map(|t| serde_json::from_str::<Value>(&t).ok())
                    .filter(|v| v["id"].is_string() && v["theme"].is_object())
                    .collect()
            })
            .unwrap_or_default();
        out.sort_by(|a, b| js::locale_compare(&js::string(&a["name"]), &js::string(&b["name"])).then_with(|| js::string(&a["id"]).cmp(&js::string(&b["id"]))));
        Value::Array(out)
    }

    pub fn theme_remove(&self, id: &str) -> Result<Value, String> {
        let target = self.themes_dir().join(id);
        if !valid_id(id) || !target.join("theme.json").is_file() {
            return Err(format!("No imported theme {id}"));
        }
        fs::remove_dir_all(&target).map_err(|e| js::fs_error(&e, "rmdir", &target))?;
        Ok(json!({ "removed": id }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsonc() {
        let v = parse_jsonc("{\n // c\n \"a\": \"x//y\", /* b */ \"c\": [1,2,],\n}", "t").unwrap();
        assert_eq!(v, json!({ "a": "x//y", "c": [1, 2] }));
        assert!(parse_jsonc("{ a: 1 }", "t").is_err());
    }

    #[test]
    fn paths() {
        assert_eq!(normalize_rel("extension/themes", "../x.json", "extension", "extension").unwrap(), "extension/x.json");
        assert!(normalize_rel("extension", "../x.json", "extension", "extension").is_err());
        assert!(normalize_rel("", "../x.json", "", "theme folder").is_err());
        assert_eq!(slug("One Dark Pro (Flat)"), "one-dark-pro-flat");
    }
}
