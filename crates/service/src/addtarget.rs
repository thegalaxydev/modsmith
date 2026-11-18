use crate::detect::prop;
use crate::gradle::wrapper_version;
use crate::js;
use crate::multitarget::{compare_versions, memory_mb, target_build, target_folder, target_properties, text, COMMON_SOURCES, ROOT_ONLY};
use crate::scaffold::GeneratedFile;
use regex::{NoExpand, Regex};
use serde_json::{json, Map, Value};
use std::cmp::Ordering;
use std::fs;
use std::path::Path;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum GitState {
    None,
    Clean,
    Dirty,
}

pub struct Plan {
    pub catalog_entry: String,
    pub folder: String,
    pub convert: bool,
    pub current_folder: Option<String>,
    pub current_plugin: Option<(String, String)>,
    pub moves: Vec<String>,
    pub backup: &'static str,
    pub gradle: Option<(String, String)>,
    pub issues: Vec<String>,
}

impl Plan {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("catalogEntry".into(), json!(self.catalog_entry));
        m.insert("folder".into(), json!(self.folder));
        m.insert("project".into(), json!(format!(":{}", self.folder)));
        m.insert("convert".into(), json!(self.convert));
        m.insert("moves".into(), json!(self.moves));
        m.insert("backup".into(), json!(self.backup));
        m.insert("issues".into(), json!(self.issues));
        if let Some((from, to)) = &self.gradle {
            m.insert("gradle".into(), json!({ "from": from, "to": to }));
        }
        if let Some(f) = &self.current_folder {
            m.insert("currentFolder".into(), json!(f));
        }
        if let Some((id, version)) = &self.current_plugin {
            m.insert("currentPlugin".into(), json!({ "id": id, "version": version }));
        }
        Value::Object(m)
    }
}

pub struct ScaffoldInfo {
    pub mod_id: Option<String>,
    pub package_name: String,
    pub author: String,
    pub description: String,
    pub license: String,
}

const KEEP: [&str; 7] = ["gradlew", "gradlew.bat", "gradle", "settings.gradle", "common", "modsmith.json", "modsmith.lock.json"];
const HEAVY: [&str; 8] = ["build", ".gradle", "run", "runs", "run-data", "out", "bin", "node_modules"];
const FABRIC_REPO: &str = "\t\tmaven {\n\t\t\tname = 'Fabric'\n\t\t\turl = 'https://maven.fabricmc.net/'\n\t\t}\n";
const FOOJAY: &str = "\tid 'org.gradle.toolchains.foojay-resolver-convention' version '1.0.0'\n";
const ROOT_WRAPPER: &str = "tasks.named('wrapper', Wrapper).configure {\n\tdistributionType = Wrapper.DistributionType.BIN\n}\n";

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("valid regex")
}

fn read_text(file: &Path) -> String {
    fs::read_to_string(file).unwrap_or_default()
}

fn lf(text: &str) -> String {
    text.replace("\r\n", "\n")
}

fn plugin_re(id: &str) -> Regex {
    re(&format!(r#"\bid\s*\(?\s*['"]{}['"]\s*\)?\s+version\s+['"]([^'"\n]+)['"]"#, regex::escape(id)))
}

pub fn plugin_version(script: &str, id: &str) -> Option<String> {
    plugin_re(id).captures(script).map(|c| c[1].to_string())
}

fn declares(script: &str, id: &str) -> bool {
    re(&format!(r#"\bid\s*\(?\s*['"]{}['"]"#, regex::escape(id))).is_match(script)
}

fn block(text: &str, pattern: &Regex) -> Option<(usize, usize, usize)> {
    let m = pattern.find(text)?;
    let open = m.end() - 1;
    let bytes = text.as_bytes();
    let mut depth = 0i64;
    for (i, b) in bytes.iter().enumerate().skip(open) {
        match b {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some((m.start(), open, i));
                }
            }
            _ => {}
        }
    }
    None
}

fn after_brace(text: &str, open: usize) -> usize {
    if text.as_bytes().get(open + 1) == Some(&b'\n') {
        open + 2
    } else {
        open + 1
    }
}

fn trailing_newline(text: &str) -> String {
    format!("{}\n", text.trim_end_matches('\n'))
}

pub fn remove_wrapper(text: &str) -> String {
    let Some((start, _, close)) = block(text, &re(r#"(?m)^[ \t]*(?:tasks\.named\(\s*['"]wrapper['"][^)\n]*\)\.configure|wrapper)\s*\{"#)) else {
        return text.to_string();
    };
    let rest = text[close + 1..].trim_start_matches('\n');
    format!("{}{rest}", &text[..start])
}

pub fn converted_build(text: &str, plugin_id: &str) -> String {
    let replaced = plugin_re(plugin_id).replacen(text, 1, NoExpand(&format!("id '{plugin_id}'"))).into_owned();
    let replaced = re(r#"from\(\s*['"]LICENSE['"]\s*\)"#).replacen(&replaced, 1, NoExpand("from(rootProject.file(\"LICENSE\"))")).into_owned();
    format!("{}{COMMON_SOURCES}", trailing_newline(&remove_wrapper(&replaced)))
}

pub fn with_fabric_repos(text: &str) -> String {
    if text.contains("maven.fabricmc.net") {
        return text.to_string();
    }
    let Some((_, open, close)) = block(text, &re(r"(?m)^pluginManagement\s*\{")) else {
        return format!("pluginManagement {{\n\trepositories {{\n{FABRIC_REPO}\t\tmavenCentral()\n\t\tgradlePluginPortal()\n\t}}\n}}\n\n{text}");
    };
    let inner = &text[open..close];
    match block(inner, &re(r"repositories\s*\{")) {
        None => {
            let at = after_brace(text, open);
            format!("{}\trepositories {{\n{FABRIC_REPO}\t\tmavenCentral()\n\t\tgradlePluginPortal()\n\t}}\n{}", &text[..at], &text[at..])
        }
        Some((_, ropen, _)) => {
            let at = after_brace(text, open + ropen);
            let central = if inner.contains("mavenCentral()") { "" } else { "\t\tmavenCentral()\n" };
            format!("{}{FABRIC_REPO}{central}{}", &text[..at], &text[at..])
        }
    }
}

pub fn with_foojay(text: &str) -> String {
    if text.contains("foojay-resolver") {
        return text.to_string();
    }
    if let Some((_, open, _)) = block(text, &re(r"(?m)^plugins\s*\{")) {
        let at = after_brace(text, open);
        return format!("{}{FOOJAY}{}", &text[..at], &text[at..]);
    }
    let plugins = format!("plugins {{\n{FOOJAY}}}\n");
    match block(text, &re(r"(?m)^pluginManagement\s*\{")) {
        None => format!("{plugins}\n{text}"),
        Some((_, _, close)) => format!("{}\n\n{plugins}\n{}", &text[..close + 1], text[close + 1..].trim_start_matches('\n')),
    }
}

pub fn with_include(text: &str, name: &str) -> String {
    let base = if text.trim().is_empty() { String::new() } else { trailing_newline(text) };
    let last = base.trim_end().rsplit('\n').next().unwrap_or("").to_string();
    let gap = if base.is_empty() || re(r"^\s*include\b").is_match(&last) { "" } else { "\n" };
    format!("{base}{gap}include '{name}'\n")
}

pub fn with_root_plugin(text: &str, id: &str, version: &str) -> String {
    if declares(text, id) {
        return text.to_string();
    }
    let line = format!("\tid '{id}' version '{version}' apply false\n");
    match block(text, &re(r"(?m)^plugins\s*\{")) {
        None => format!("plugins {{\n{line}}}\n{}", if text.trim().is_empty() { format!("\n{ROOT_WRAPPER}") } else { format!("\n{text}") }),
        Some((_, _, close)) => {
            let head = &text[..close];
            format!("{head}{}{line}{}", if head.ends_with('\n') { "" } else { "\n" }, &text[close..])
        }
    }
}

pub fn merge_root_properties(root: &str, target: &str) -> String {
    let want: Vec<&str> = target.split('\n').filter(|l| l.starts_with("org.gradle.")).collect();
    let jvm = want.iter().find(|l| l.starts_with("org.gradle.jvmargs=")).copied();
    let lines: Vec<&str> = if root.is_empty() { vec![] } else { root.strip_suffix('\n').unwrap_or(root).split('\n').collect() };
    let flag = re(r"^(org\.gradle\.[^=\s]+)\s*=\s*true\s*$");
    let mut out: Vec<String> = Vec::new();
    let mut had_jvm = false;
    for l in lines {
        if l.starts_with("org.gradle.jvmargs=") {
            had_jvm = true;
            out.push(match jvm {
                Some(j) if memory_mb(j) > memory_mb(l) => j.to_string(),
                _ => l.to_string(),
            });
            continue;
        }
        if let Some(c) = flag.captures(l) {
            if !want.contains(&format!("{}=true", &c[1]).as_str()) {
                continue;
            }
        }
        out.push(l.to_string());
    }
    if let (false, Some(j)) = (had_jvm, jvm) {
        out.insert(0, j.to_string());
    }
    if out.is_empty() {
        String::new()
    } else {
        format!("{}\n", out.join("\n"))
    }
}

pub fn with_ignored(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').map(str::trim).collect();
    let missing: Vec<&str> = ["build", "run"].into_iter().filter(|x| ![x.to_string(), format!("{x}/"), format!("**/{x}"), format!("**/{x}/")].iter().any(|v| lines.contains(&v.as_str()))).collect();
    if missing.is_empty() {
        return text.to_string();
    }
    format!("{}{}", trailing_newline(text), missing.iter().map(|x| format!("{x}/\n")).collect::<String>())
}

fn config_dirs(manifest: Option<&Value>) -> Vec<String> {
    manifest
        .and_then(|m| m["profiles"].as_array())
        .map(|ps| ps.iter().filter_map(|p| p["configDir"].as_str()).filter_map(|d| d.split(['/', '\\']).next()).filter(|d| !d.is_empty()).map(str::to_string).collect())
        .unwrap_or_default()
}

pub fn movable(root: &Path, manifest: Option<&Value>) -> Vec<String> {
    let dirs = config_dirs(manifest);
    let doc = re(r"(?i)^(license|readme)(\.[a-z0-9]+)?$");
    let mut names: Vec<String> = fs::read_dir(root)
        .map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect::<Vec<String>>())
        .unwrap_or_default()
        .into_iter()
        .filter(|n: &String| !(n.starts_with('.') || KEEP.contains(&n.as_str()) || doc.is_match(n) || dirs.contains(n)))
        .collect();
    names.sort();
    names
}

fn current_target(root: &Path, detected: &Value, plugin_ids: &[String]) -> Result<(String, (String, String)), String> {
    let loader = detected["loader"].as_str().unwrap_or("unknown");
    if detected.is_null() || loader == "unknown" {
        return Err("Modsmith can't tell which loader this project uses, so it can't add a target.".into());
    }
    let minecraft = prop(&read_text(&root.join("gradle.properties")), "minecraft_version").filter(|m| re(r"^[A-Za-z0-9._-]+$").is_match(m));
    let Some(minecraft) = minecraft else {
        return Err("gradle.properties does not declare minecraft_version, so Modsmith has no name for the current target.".into());
    };
    let build = read_text(&root.join("build.gradle"));
    if build.is_empty() {
        return Err("The project has no build.gradle in its root folder.".into());
    }
    if re(r"(?m)^\s*include\b").is_match(&read_text(&root.join("settings.gradle"))) {
        return Err("settings.gradle already includes subprojects. Modsmith can only convert a project that is a single Gradle project.".into());
    }
    for id in plugin_ids {
        if let Some(version) = plugin_version(&build, id) {
            return Ok((format!("{loader}-{minecraft}"), (id.clone(), version)));
        }
    }
    Err("build.gradle doesn't declare the loader plugin with a version (it may come from a version catalog), so Modsmith can't move it into a subproject.".into())
}

pub fn plan_add_target(root: &Path, manifest: Option<&Value>, detected: &Value, entry: &Value, plugin_ids: &[String], git: GitState) -> Plan {
    let folder = target_folder(entry);
    let targets: Vec<Value> = detected["targets"].as_array().cloned().unwrap_or_default();
    let convert = targets.is_empty();
    let eid = js::string(&entry["id"]);
    let pid = js::string(&entry["plugin"]["id"]);
    let pversion = js::string(&entry["plugin"]["version"]);
    let mut plan = Plan {
        catalog_entry: eid.clone(),
        folder: folder.clone(),
        convert,
        current_folder: None,
        current_plugin: None,
        moves: vec![],
        backup: if git == GitState::None { "copy" } else { "git" },
        gradle: None,
        issues: vec![],
    };
    if manifest.is_none() {
        plan.issues.push("This folder has no modsmith.json. Open it as a project in Modsmith first.".into());
    }
    if ["build.gradle.kts", "settings.gradle.kts"].iter().any(|f| root.join(f).exists()) {
        plan.issues.push("Projects with Kotlin build scripts (build.gradle.kts) are not supported yet.".into());
    }
    let gradle_version = js::string(&entry["gradleVersion"]);
    match wrapper_version(root) {
        None => plan.issues.push("The project has no Gradle wrapper.".into()),
        Some(w) if compare_versions(&gradle_version, &w) == Ordering::Greater => plan.gradle = Some((w, gradle_version.clone())),
        Some(_) => {}
    }
    let mut taken = false;
    if convert {
        match current_target(root, detected, plugin_ids) {
            Err(e) => plan.issues.push(e),
            Ok((cur, (cid, cversion))) => {
                plan.moves = movable(root, manifest);
                if cur == folder {
                    taken = true;
                    plan.issues.push(format!("The project already targets {} {}.", js::string(&entry["loader"]), js::string(&entry["minecraft"])));
                } else if cid == pid && cversion != pversion {
                    plan.issues.push(format!("{eid} needs {pid} {pversion}, but the project uses {cversion}, so they cannot share one Gradle build."));
                }
                if root.join(&cur).exists() {
                    plan.issues.push(format!("A folder named {cur} already exists in the project."));
                }
                plan.current_folder = Some(cur);
                plan.current_plugin = Some((cid, cversion));
            }
        }
        if git == GitState::Dirty {
            plan.issues.push("The project has uncommitted changes. Commit or stash them first, so Git can undo the move if you need to.".into());
        }
    } else if targets.iter().any(|t| js::string(&t["dir"]).contains("/versions/")) {
        plan.issues.push("This is a Stonecutter project. Add Minecraft versions in its settings.gradle instead.".into());
    } else {
        if targets.iter().any(|t| t["dir"] == folder.as_str()) {
            taken = true;
            plan.issues.push(format!("The project already has the target {folder}."));
        }
        for t in &targets {
            let dir = js::string(&t["dir"]);
            if plugin_version(&read_text(&root.join(&dir).join("build.gradle")), &pid).is_some() {
                plan.issues.push(format!("{dir}/build.gradle sets its own version of {pid}, so another target cannot share that plugin."));
            }
        }
        let root_build = read_text(&root.join("build.gradle"));
        if let Some(declared) = plugin_version(&root_build, &pid).filter(|v| *v != pversion) {
            plan.issues.push(format!("{eid} needs {pid} {pversion}, but the project uses {declared}, so they cannot share one Gradle build."));
        }
        if block(&root_build, &re(r"(?m)^plugins\s*\{")).is_none() && re(r"(?m)^buildscript\s*\{").is_match(&root_build) {
            plan.issues.push("The root build.gradle uses a buildscript block, so Modsmith cannot add a plugin to it.".into());
        }
    }
    if !taken && root.join(&folder).exists() {
        plan.issues.push(format!("A folder named {folder} already exists in the project."));
    }
    plan
}

pub fn scaffold_info(root: &Path, plan: &Plan, detected: &Value, manifest: Option<&Value>) -> ScaffoldInfo {
    let dir = if plan.convert { root.to_path_buf() } else { root.join(detected["targets"][0]["dir"].as_str().unwrap_or(".")) };
    let props = read_text(&dir.join("gradle.properties"));
    let mod_id = manifest
        .and_then(|m| m["modId"].as_str().map(str::to_string))
        .or_else(|| detected["modMetadata"].as_array().and_then(|a| a.iter().find_map(|m| m["id"].as_str().map(str::to_string))))
        .or_else(|| prop(&props, "mod_id"));
    let package_name = main_package(&[dir.join("src").join("main").join("java"), root.join("common").join("src").join("main").join("java")])
        .or_else(|| prop(&props, "mod_group_id"))
        .or_else(|| prop(&props, "maven_group"))
        .unwrap_or_else(|| format!("com.example.{}", mod_id.clone().unwrap_or_else(|| "mod".into())));
    ScaffoldInfo {
        mod_id,
        package_name,
        author: prop(&props, "mod_authors").unwrap_or_default(),
        description: prop(&props, "mod_description").or_else(|| manifest.and_then(|m| m["name"].as_str().map(str::to_string))).unwrap_or_default(),
        license: prop(&props, "mod_license").unwrap_or_else(|| "All Rights Reserved".into()),
    }
}

fn main_package(dirs: &[std::path::PathBuf]) -> Option<String> {
    let pkg_re = re(r"(?m)^\s*package\s+([\w.]+)\s*;");
    let main_re = re(r"@Mod\s*\(|implements\s+(?:Client)?ModInitializer|\bMOD_ID\b");
    let mut best: Option<(String, i32, usize)> = None;
    fn walk(d: &Path, level: usize, pkg_re: &Regex, main_re: &Regex, best: &mut Option<(String, i32, usize)>) {
        if level > 12 {
            return;
        }
        let Ok(rd) = fs::read_dir(d) else { return };
        let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        names.sort();
        for n in names {
            let full = d.join(&n);
            let Ok(meta) = fs::metadata(&full) else { continue };
            if meta.is_dir() {
                walk(&full, level + 1, pkg_re, main_re, best);
            } else if n.ends_with(".java") {
                let text = read_text(&full);
                let Some(pkg) = pkg_re.captures(&text).map(|c| c[1].to_string()) else { continue };
                let score = if main_re.is_match(&text) { 2 } else { 1 };
                let depth = pkg.split('.').count();
                let better = match best {
                    None => true,
                    Some((_, s, dp)) => score > *s || (score == *s && depth < *dp),
                };
                if better {
                    *best = Some((pkg, score, depth));
                }
            }
        }
    }
    for d in dirs {
        walk(d, 0, &pkg_re, &main_re, &mut best);
    }
    best.map(|b| b.0)
}

fn copy_tree(src: &Path, dest: &Path) -> Result<(), String> {
    let Ok(meta) = fs::metadata(src) else { return Ok(()) };
    if !meta.is_dir() {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| js::fs_error(&e, "mkdir", parent))?;
        }
        fs::copy(src, dest).map_err(|e| js::fs_error(&e, "copyfile", src))?;
        return Ok(());
    }
    let mut names: Vec<String> = fs::read_dir(src).map_err(|e| js::fs_error(&e, "scandir", src))?.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
    names.sort();
    for n in names {
        if !HEAVY.contains(&n.as_str()) {
            copy_tree(&src.join(&n), &dest.join(&n))?;
        }
    }
    Ok(())
}

pub fn backup_files(root: &Path, plan: &Plan, stamp: u128) -> Result<String, String> {
    let rel = format!(".modsmith/backups/add-target-{stamp}");
    let dest = root.join(&rel);
    let names: Vec<String> = if plan.convert {
        plan.moves.iter().cloned().chain(["settings.gradle".to_string(), "modsmith.json".to_string()]).collect()
    } else {
        ["settings.gradle", "build.gradle", "gradle.properties", "gradle/wrapper/gradle-wrapper.properties", ".gitignore", "modsmith.json"].iter().map(|s| s.to_string()).collect()
    };
    for n in names {
        if !HEAVY.contains(&n.as_str()) {
            copy_tree(&root.join(&n), &dest.join(&n))?;
        }
    }
    fs::create_dir_all(&dest).map_err(|e| js::fs_error(&e, "mkdir", &dest))?;
    Ok(rel)
}

fn move_all(root: &Path, names: &[String], folder: &str) -> Result<(), String> {
    let target = root.join(folder);
    fs::create_dir(&target).map_err(|e| js::fs_error(&e, "mkdir", &target))?;
    let mut done: Vec<&String> = Vec::new();
    for n in names {
        if let Err(e) = fs::rename(root.join(n), target.join(n)) {
            for m in done.iter().rev() {
                let _ = fs::rename(target.join(m), root.join(m));
            }
            let _ = fs::remove_dir(&target);
            return Err(format!(
                "Could not move {n} into {folder}: {}. Nothing was changed. Close programs that have project files open, such as an IDE, and try again.",
                js::fs_error(&e, "rename", &root.join(n))
            ));
        }
        done.push(n);
    }
    Ok(())
}

fn edit(root: &Path, rel: &str, f: impl FnOnce(&str) -> String) -> Result<(), String> {
    let full = root.join(rel);
    let exists = full.exists();
    let before = if exists { fs::read_to_string(&full).map_err(|e| js::fs_error(&e, "open", &full))? } else { String::new() };
    let crlf = before.contains("\r\n");
    let out = f(&lf(&before));
    if !exists && out.is_empty() {
        return Ok(());
    }
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| js::fs_error(&e, "mkdir", parent))?;
    }
    fs::write(&full, if crlf { out.replace('\n', "\r\n") } else { out }).map_err(|e| js::fs_error(&e, "open", &full))
}

fn write(full: &Path, content: &[u8]) -> Result<(), String> {
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| js::fs_error(&e, "mkdir", parent))?;
    }
    fs::write(full, content).map_err(|e| js::fs_error(&e, "open", full))
}

pub fn apply_add_target(root: &Path, plan: &Plan, entry: &Value, files: &[GeneratedFile], mod_id: &str) -> Result<(), String> {
    if plan.convert {
        let cur = plan.current_folder.clone().unwrap_or_default();
        let (cid, cversion) = plan.current_plugin.clone().unwrap_or_default();
        move_all(root, &plan.moves, &cur)?;
        edit(root, &format!("{cur}/build.gradle"), |t| converted_build(t, &cid))?;
        let props = root.join(&cur).join("gradle.properties");
        if props.exists() {
            let own = fs::read_to_string(&props).map_err(|e| js::fs_error(&e, "open", &props))?;
            let lines: Vec<String> = lf(&own).split('\n').filter(|l| l.starts_with("org.gradle.")).map(str::to_string).collect();
            edit(root, &format!("{cur}/gradle.properties"), target_properties)?;
            if !lines.is_empty() {
                let eol = if own.contains("\r\n") { "\r\n" } else { "\n" };
                write(&root.join("gradle.properties"), format!("{}{eol}", lines.join(eol)).as_bytes())?;
            }
        }
        write(&root.join("build.gradle"), format!("plugins {{\n\tid '{cid}' version '{cversion}' apply false\n}}\n\n{ROOT_WRAPPER}").as_bytes())?;
        edit(root, "settings.gradle", |t| with_include(t, &cur))?;
    }
    let fabric = entry["loader"] == "fabric";
    edit(root, "settings.gradle", |t| with_include(&if fabric { with_fabric_repos(t) } else { with_foojay(t) }, &plan.folder))?;
    edit(root, "build.gradle", |t| with_root_plugin(t, &js::string(&entry["plugin"]["id"]), &js::string(&entry["plugin"]["version"])))?;
    let own = files.iter().find(|f| f.path == "gradle.properties").map(text).unwrap_or_default();
    edit(root, "gradle.properties", |t| merge_root_properties(t, &own))?;
    if let Some((_, to)) = &plan.gradle {
        edit(root, "gradle/wrapper/gradle-wrapper.properties", |t| {
            let t = re(r"gradle-[\d.]+(?:-[a-z0-9-]+)?-(bin|all)\.zip").replacen(t, 1, format!("gradle-{to}-${{1}}.zip").as_str()).into_owned();
            re(r"(?m)^distributionSha256Sum=.*\n?").replacen(&t, 1, "").into_owned()
        })?;
    }
    for f in files {
        if ROOT_ONLY.contains(&f.path.as_str()) {
            continue;
        }
        let content = match f.path.as_str() {
            "gradle.properties" => target_properties(&text(f)).into_bytes(),
            "build.gradle" => target_build(&text(f), entry, mod_id).into_bytes(),
            _ => f.content.clone(),
        };
        write(&root.join(&plan.folder).join(&f.path), &content)?;
    }
    if root.join(".gitignore").exists() {
        edit(root, ".gitignore", with_ignored)?;
    }
    Ok(())
}
