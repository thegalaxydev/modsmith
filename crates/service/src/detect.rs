use regex::Regex;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::Path;

fn read_text(file: &Path) -> String {
    fs::read_to_string(file).unwrap_or_default()
}

fn relative(base: &Path, full: &Path) -> String {
    full.strip_prefix(base).map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| full.to_string_lossy().to_string())
}

const SKIP: [&str; 8] = ["build", ".gradle", "run", "node_modules", ".git", ".modsmith", "out", "bin"];

fn walk(root: &Path, d: &Path, depth: usize, resources: &Regex, mod_id: &Regex, out: &mut Vec<Value>) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = fs::read_dir(d) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if SKIP.contains(&name.as_str()) {
                continue;
            }
            walk(root, &e.path(), depth + 1, resources, mod_id, out);
        } else if name == "fabric.mod.json" || name == "neoforge.mods.toml" || name == "mods.toml" {
            let full = e.path();
            if !resources.is_match(&full.to_string_lossy()) {
                continue;
            }
            let text = read_text(&full);
            let mut entry = Map::new();
            entry.insert("file".into(), Value::String(relative(root, &full)));
            if name == "fabric.mod.json" {
                if let Ok(j) = serde_json::from_str::<Value>(&text) {
                    if let Some(id) = j.get("id") {
                        entry.insert("id".into(), id.clone());
                    }
                    if let Some(mc) = j.get("depends").and_then(|d| d.get("minecraft")) {
                        entry.insert("minecraft".into(), mc.clone());
                    }
                }
            } else if let Some(c) = mod_id.captures(&text) {
                entry.insert("id".into(), Value::String(c[1].to_string()));
            }
            out.push(Value::Object(entry));
        }
    }
}

fn prop(props: &str, key: &str) -> Option<String> {
    let re = Regex::new(&format!(r"(?m)^\s*{key}\s*=\s*(.+)$")).ok()?;
    re.captures(props).map(|c| c[1].trim().to_string())
}

pub fn detect_gradle_project(dir: &Path) -> Value {
    let build_files: Vec<&str> = ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradle.properties"].into_iter().filter(|f| dir.join(f).exists()).collect();
    let has_gradle = build_files.iter().any(|f| f.starts_with("build.gradle") || f.starts_with("settings.gradle"));
    let props = read_text(&dir.join("gradle.properties"));
    let build_text = build_files.iter().filter(|f| f.starts_with("build") || f.starts_with("settings")).map(|f| read_text(&dir.join(f))).collect::<Vec<_>>().join("\n");
    static PATTERNS: std::sync::OnceLock<Vec<(Regex, &'static str)>> = std::sync::OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            (r"net\.fabricmc\.fabric-loom-remap", "net.fabricmc.fabric-loom-remap"),
            (r#"['"]net\.fabricmc\.fabric-loom['"]"#, "net.fabricmc.fabric-loom"),
            (r#"['"]fabric-loom['"]"#, "fabric-loom"),
            (r"dev\.architectury\.loom", "dev.architectury.loom"),
            (r#"net\.neoforged\.moddev['"]"#, "net.neoforged.moddev"),
            (r"net\.neoforged\.moddev\.legacyforge", "net.neoforged.moddev.legacyforge"),
            (r"net\.neoforged\.gradle", "net.neoforged.gradle"),
            (r"net\.minecraftforge\.gradle", "net.minecraftforge.gradle"),
            (r"org\.quiltmc\.loom", "org.quiltmc.loom"),
        ]
        .into_iter()
        .map(|(re, id)| (Regex::new(re).expect("valid plugin pattern"), id))
        .collect()
    });
    let plugins: Vec<&str> = patterns.iter().filter(|(re, _)| re.is_match(&build_text)).map(|(_, id)| *id).collect();
    let mut metadata = Vec::new();
    let resources = Regex::new(r"[\\/]resources[\\/]").unwrap();
    let mod_id = Regex::new(r#"modId\s*=\s*"([^"$]+)""#).unwrap();
    walk(dir, dir, 0, &resources, &mod_id, &mut metadata);
    if !has_gradle && metadata.is_empty() {
        return Value::Null;
    }
    let has = |id: &str| plugins.contains(&id);
    let fabricish = plugins.iter().any(|p| p.contains("fabric-loom"));
    let legacy = has("net.neoforged.moddev.legacyforge");
    let neo = plugins.iter().any(|p| p.starts_with("net.neoforged") && *p != "net.neoforged.moddev.legacyforge");
    let forge = legacy || has("net.minecraftforge.gradle");
    let kinds = [fabricish, neo, forge, has("dev.architectury.loom"), has("org.quiltmc.loom")].iter().filter(|b| **b).count();
    let loader = if fabricish {
        "fabric"
    } else if neo {
        "neoforge"
    } else if forge {
        "forge"
    } else {
        "unknown"
    };
    let mut notes: Vec<&str> = Vec::new();
    if has("dev.architectury.loom") {
        notes.push("Architectury Loom detected. Multi-loader layouts are not supported yet; subprojects must be inspected manually.");
    }
    if has("org.quiltmc.loom") {
        notes.push("Quilt Loom detected. Quilt is not a supported loader.");
    }
    if plugins.is_empty() && has_gradle {
        notes.push("No known loader Gradle plugin was found in the root build files. Plugins may be declared in subprojects, version catalogs or convention plugins.");
    }
    if dir.join("gradle").join("libs.versions.toml").exists() {
        notes.push("A Gradle version catalog is present; versions may be declared there.");
    }
    if !dir.join(if cfg!(windows) { "gradlew.bat" } else { "gradlew" }).exists() {
        notes.push("No Gradle wrapper script found. Builds require a Gradle wrapper.");
    }
    if loader == "forge" && !legacy {
        notes.push("ForgeGradle projects are not supported. Modsmith builds and launches Forge projects that use ModDevGradle Legacy (net.neoforged.moddev.legacyforge); this one can only be browsed and edited.");
    }
    if has("net.neoforged.gradle") {
        notes.push("NeoGradle detected. Build and launch are implemented for ModDevGradle (net.neoforged.moddev) projects only.");
    }
    let minecraft_hint = prop(&props, "minecraft_version").map(Value::String).or_else(|| metadata.iter().find_map(|m| m.get("minecraft").filter(|v| crate::js::truthy(Some(v))).cloned()));
    let loader_version_hint = prop(&props, "loader_version").or_else(|| prop(&props, "neo_version")).or_else(|| prop(&props, "forge_version"));
    let mut out = Map::new();
    out.insert("loader".into(), json!(loader));
    out.insert("buildSystem".into(), json!(if has_gradle { "gradle" } else { "none" }));
    out.insert("gradleWrapper".into(), json!(dir.join("gradlew.bat").exists() || dir.join("gradlew").exists()));
    out.insert("buildFiles".into(), json!(build_files));
    out.insert("modMetadata".into(), Value::Array(metadata));
    out.insert("loaderPlugins".into(), json!(plugins));
    if let Some(m) = minecraft_hint {
        out.insert("minecraftHint".into(), m);
    }
    if let Some(l) = loader_version_hint {
        out.insert("loaderVersionHint".into(), json!(l));
    }
    out.insert("notes".into(), json!(notes));
    out.insert("ambiguous".into(), json!(kinds > 1 || (has_gradle && loader == "unknown")));
    Value::Object(out)
}
