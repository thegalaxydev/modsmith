use crate::js;
use crate::manifest::Catalog;
use crate::scaffold::{to_class_name, GeneratedFile};
use regex::Regex;
use serde_json::Value;

pub const ROOT_ONLY: [&str; 5] = ["settings.gradle", "gradle/wrapper/gradle-wrapper.properties", ".gitignore", "README.md", "LICENSE"];

pub struct Part<'a> {
    pub entry: &'a Value,
    pub files: Vec<GeneratedFile>,
}

pub struct MultiOptions<'a> {
    pub project_name: &'a str,
    pub mod_id: &'a str,
    pub package_name: &'a str,
    pub description: &'a str,
}

fn loader_name(loader: &str) -> &str {
    match loader {
        "fabric" => "Fabric Loader",
        "neoforge" => "NeoForge",
        "forge" => "Forge",
        other => other,
    }
}

pub fn target_folder(entry: &Value) -> String {
    format!("{}-{}", js::string(&entry["loader"]), js::string(&entry["minecraft"]))
}

pub fn plugin_conflict(entries: &[&Value]) -> Option<String> {
    let mut seen: Vec<&Value> = Vec::new();
    for e in entries {
        let pid = js::string(&e["plugin"]["id"]);
        match seen.iter().find(|p| js::string(&p["plugin"]["id"]) == pid) {
            Some(prev) if prev["plugin"]["version"] != e["plugin"]["version"] => {
                return Some(format!(
                    "{} and {} need different versions of {pid} ({} and {}), so they cannot share one Gradle build",
                    js::string(&prev["id"]),
                    js::string(&e["id"]),
                    js::string(&prev["plugin"]["version"]),
                    js::string(&e["plugin"]["version"])
                ))
            }
            Some(_) => {}
            None => seen.push(e),
        }
    }
    None
}

pub fn target_java_min(catalog: &Catalog, targets: &[Value]) -> i64 {
    targets.iter().filter_map(|t| catalog.entries.iter().find(|e| e["loader"] == t["loader"] && e["minecraft"] == t["minecraft"])).filter_map(|e| e["gradleJavaMin"].as_i64()).max().unwrap_or(0)
}

pub fn workspace_java_min(catalog: &Catalog, dir: &std::path::Path, manifest: &Value) -> i64 {
    if manifest["source"]["project"].as_str().is_none() {
        return 0;
    }
    let detected = crate::detect::detect_gradle_project(dir);
    target_java_min(catalog, detected["targets"].as_array().map(Vec::as_slice).unwrap_or(&[]))
}

pub fn unpinned(dep: &Value) -> Value {
    let mut d = dep.clone();
    if let Some(o) = d.as_object_mut() {
        match o.get("source").and_then(Value::as_str) {
            Some("modrinth") => {
                o.remove("versionId");
            }
            Some("curseforge") => {
                o.remove("fileId");
            }
            _ => {}
        }
    }
    d
}

pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let pa: Vec<i64> = a.split('.').map(|x| x.parse().unwrap_or(0)).collect();
    let pb: Vec<i64> = b.split('.').map(|x| x.parse().unwrap_or(0)).collect();
    for i in 0..pa.len().max(pb.len()) {
        let d = pa.get(i).unwrap_or(&0).cmp(pb.get(i).unwrap_or(&0));
        if d != std::cmp::Ordering::Equal {
            return d;
        }
    }
    std::cmp::Ordering::Equal
}

pub fn newest_gradle(entries: &[&Value]) -> String {
    let mut sorted: Vec<&&Value> = entries.iter().collect();
    sorted.sort_by(|a, b| compare_versions(&js::string(&b["gradleVersion"]), &js::string(&a["gradleVersion"])));
    sorted.first().map(|e| js::string(&e["gradleVersion"])).unwrap_or_default()
}

pub fn text(f: &GeneratedFile) -> String {
    String::from_utf8_lossy(&f.content).into_owned()
}

pub fn memory_mb(line: &str) -> i64 {
    let re = Regex::new(r"-Xmx(\d+)([gGmM])").unwrap();
    re.captures(line).map(|c| c[1].parse::<i64>().unwrap_or(0) * if c[2].eq_ignore_ascii_case("g") { 1024 } else { 1 }).unwrap_or(0)
}

fn root_properties(parts: &[Part]) -> String {
    let per_part: Vec<Vec<String>> = parts
        .iter()
        .map(|p| p.files.iter().find(|f| f.path == "gradle.properties").map(text).unwrap_or_default().split('\n').filter(|l| l.starts_with("org.gradle.")).map(str::to_string).collect())
        .collect();
    let mut jvms: Vec<String> = per_part.iter().map(|lines| lines.iter().find(|l| l.starts_with("org.gradle.jvmargs=")).cloned().unwrap_or_default()).collect();
    jvms.sort_by_key(|l| std::cmp::Reverse(memory_mb(l)));
    let mut keys: Vec<String> = Vec::new();
    for lines in &per_part {
        for l in lines {
            let key = l.split('=').next().unwrap_or("").to_string();
            if key != "org.gradle.jvmargs" && !keys.contains(&key) {
                keys.push(key);
            }
        }
    }
    let mut out: Vec<String> = Vec::new();
    if let Some(j) = jvms.first().filter(|j| !j.is_empty()) {
        out.push(j.clone());
    }
    for k in keys {
        let line = format!("{k}=true");
        if per_part.iter().all(|lines| lines.contains(&line)) {
            out.push(line);
        }
    }
    out.join("\n") + "\n"
}

pub fn target_properties(content: &str) -> String {
    let kept = content.split('\n').filter(|l| !l.starts_with("org.gradle.")).collect::<Vec<_>>().join("\n");
    kept.trim_start_matches('\n').to_string()
}

pub fn target_build(content: &str, entry: &Value, id: &str) -> String {
    let pid = regex::escape(&js::string(&entry["plugin"]["id"]));
    let re = Regex::new(&format!(r#"(\bid\s+'{pid}')\s+version\s+(?:"[^"\n]*"|'[^'\n]*')"#)).unwrap();
    let wrapper = Regex::new(r"tasks\.named\('wrapper', Wrapper\)\.configure \{[^}]*\}\n+").unwrap();
    let stripped = re.replacen(content, 1, "$1").replacen("from(\"LICENSE\")", "from(rootProject.file(\"LICENSE\"))", 1);
    let stripped = wrapper.replacen(&stripped, 1, "").into_owned();
    format!("{}\n{COMMON_SOURCES}\nbase {{\n\tarchivesName = '{id}-{}'\n}}\n", stripped.trim_end_matches('\n'), target_folder(entry))
}

pub const COMMON_SOURCES: &str = "\nsourceSets {\n\tmain {\n\t\tjava {\n\t\t\tsrcDir rootProject.file('common/src/main/java')\n\t\t}\n\t\tresources {\n\t\t\tsrcDir rootProject.file('common/src/main/resources')\n\t\t}\n\t}\n}\n\ntasks.named('processResources') {\n\tduplicatesStrategy = DuplicatesStrategy.EXCLUDE\n}\n";

pub fn compose_targets(opts: &MultiOptions, parts: Vec<Part>) -> Result<Vec<GeneratedFile>, String> {
    let entries: Vec<&Value> = parts.iter().map(|p| p.entry).collect();
    if let Some(c) = plugin_conflict(&entries) {
        return Err(c);
    }
    let mut out: Vec<GeneratedFile> = Vec::new();
    let add = |out: &mut Vec<GeneratedFile>, path: &str, content: String| out.push(GeneratedFile { path: path.into(), content: content.into_bytes() });
    let folders: Vec<String> = entries.iter().map(|e| target_folder(e)).collect();
    let fabric = entries.iter().any(|e| e["loader"] == "fabric");
    let modded = entries.iter().any(|e| e["loader"] != "fabric");
    let mut plugins: Vec<(String, String)> = Vec::new();
    for e in &entries {
        let pid = js::string(&e["plugin"]["id"]);
        if !plugins.iter().any(|(id, _)| *id == pid) {
            plugins.push((pid, js::string(&e["plugin"]["version"])));
        }
    }
    let newest = newest_gradle(&entries);
    let newest_idx = entries.iter().position(|e| js::string(&e["gradleVersion"]) == newest).unwrap_or(0);
    let gradle_java = entries.iter().filter_map(|e| e["gradleJavaMin"].as_i64()).max().unwrap_or(21);

    add(
        &mut out,
        "settings.gradle",
        format!(
            "pluginManagement {{\n\trepositories {{\n{}\t\tgradlePluginPortal()\n\t}}\n}}\n{}\nrootProject.name = '{}'\n\ninclude {}\n",
            if fabric { "\t\tmaven {\n\t\t\tname = 'Fabric'\n\t\t\turl = 'https://maven.fabricmc.net/'\n\t\t}\n\t\tmavenCentral()\n" } else { "" },
            if modded { "\nplugins {\n\tid 'org.gradle.toolchains.foojay-resolver-convention' version '1.0.0'\n}\n" } else { "" },
            opts.mod_id,
            folders.iter().map(|f| format!("'{f}'")).collect::<Vec<_>>().join(", ")
        ),
    );
    add(
        &mut out,
        "build.gradle",
        format!(
            "plugins {{\n{}\n}}\n\ntasks.named('wrapper', Wrapper).configure {{\n\tdistributionType = Wrapper.DistributionType.BIN\n}}\n",
            plugins.iter().map(|(id, v)| format!("\tid '{id}' version '{v}' apply false")).collect::<Vec<_>>().join("\n")
        ),
    );
    add(&mut out, "gradle.properties", root_properties(&parts));
    for name in ["gradle/wrapper/gradle-wrapper.properties", ".gitignore", "LICENSE"] {
        let src = if name.starts_with("gradle/") { &parts[newest_idx] } else { &parts[0] };
        if let Some(f) = src.files.iter().find(|f| f.path == name) {
            out.push(GeneratedFile { path: name.into(), content: f.content.clone() });
        }
    }
    let list = entries
        .iter()
        .map(|e| format!("- `{}`: {} {} on Minecraft {}", target_folder(e), loader_name(&js::string(&e["loader"])), js::string(&e["loaderVersion"]), js::string(&e["minecraft"])))
        .collect::<Vec<_>>()
        .join("\n");
    add(
        &mut out,
        "README.md",
        format!(
            "# {}\n\n{}\n\nThis project builds the mod for several loaders and Minecraft versions. Each target is a Gradle subproject:\n\n{list}\n\nCode in `common/src/main/java` and files in `common/src/main/resources` are compiled into every target, so they must work on all of them. A file in a target's own `src/main/resources` replaces the common file at the same path.\n\nGenerated by Modsmith from catalog entries {}.\n\nBuild every target with `./gradlew build`, or one with `./gradlew :{}:build`. Gradle must run on Java {gradle_java} or newer.\n",
            opts.project_name,
            opts.description,
            entries.iter().map(|e| format!("`{}`", js::string(&e["id"]))).collect::<Vec<_>>().join(", "),
            folders[0]
        ),
    );
    let cls = format!("{}Common", to_class_name(opts.project_name));
    add(
        &mut out,
        &format!("common/src/main/java/{}/{cls}.java", opts.package_name.replace('.', "/")),
        format!("package {};\n\npublic final class {cls} {{\n\tpublic static final String MOD_ID = \"{}\";\n\n\tprivate {cls}() {{\n\t}}\n}}\n", opts.package_name, opts.mod_id),
    );
    for p in parts {
        let folder = target_folder(p.entry);
        for f in p.files {
            if ROOT_ONLY.contains(&f.path.as_str()) {
                continue;
            }
            let content = match f.path.as_str() {
                "gradle.properties" => target_properties(&text(&f)).into_bytes(),
                "build.gradle" => target_build(&text(&f), p.entry, opts.mod_id).into_bytes(),
                _ => f.content,
            };
            out.push(GeneratedFile { path: format!("{folder}/{}", f.path), content });
        }
    }
    Ok(out)
}
