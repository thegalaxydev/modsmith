use crate::activity::redact_text;
use crate::instances::find_crash_report;
use crate::js;
use crate::logs::Query;
use crate::manifest;
use crate::proc::exec_capture;
use crate::rt::{s, Runtime};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::fs;
use std::io::Write;
use std::path::Path;

fn first(re: &str, text: &str) -> Option<String> {
    Regex::new(re).ok()?.captures(text).map(|c| c[1].to_string())
}

pub fn parse_crash_report(text: &str) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(d) = first(r"(?m)^Description: (.*)$", text) {
        out.insert("description".into(), json!(d));
    }
    let lines: Vec<&str> = Regex::new(r"\r?\n").expect("eol").split(text).collect();
    let mut exception = None;
    let mut stack: Vec<String> = Vec::new();
    if let Some(desc) = lines.iter().position(|l| l.starts_with("Description:")) {
        for i in desc + 1..lines.len() {
            if lines[i].trim().is_empty() {
                continue;
            }
            exception = Some(lines[i].trim().to_string());
            let mut j = i + 1;
            while j < lines.len() && stack.len() < 15 && lines[j].starts_with('\t') {
                stack.push(lines[j].trim().to_string());
                j += 1;
            }
            break;
        }
    }
    if let Some(e) = exception {
        out.insert("exception".into(), json!(e));
    }
    out.insert("stackHead".into(), json!(stack));
    let mut suspects = Vec::new();
    if let Some(i) = text.find("Suspected Mods:") {
        let rest = &text[i + "Suspected Mods:".len()..];
        let re = Regex::new(r"^\s+([^(]+) \(([^)]+)\)").expect("suspect regex");
        for l in Regex::new(r"\r?\n").expect("eol").split(rest).take(20) {
            if let Some(m) = re.captures(l) {
                suspects.push(format!("{} ({})", m[1].trim(), &m[2]));
            } else if !l.trim().is_empty() && !l.starts_with('\t') && !l.starts_with(' ') {
                break;
            }
        }
    }
    out.insert("suspectedModsFromReport".into(), json!(suspects));
    if let Some(v) = first(r"(?m)Java Version: (.*)$", text) {
        out.insert("javaVersion".into(), json!(v));
    }
    if let Some(v) = first(r"(?m)Minecraft Version: (.*)$", text) {
        out.insert("minecraftVersion".into(), json!(v));
    }
    if let Some(block) = Regex::new(r"Fabric Mods:\s*\n([\s\S]*?)\n\s*\n").expect("mods regex").captures(text) {
        let tab = Regex::new(r"^\t\t\S").expect("tab regex");
        out.insert("loadedModsCount".into(), json!(block[1].split('\n').filter(|l| tab.is_match(l)).count()));
    }
    out
}

pub fn hypothesize(text: &str) -> Vec<Value> {
    let rules: [(&str, &str); 10] = [
        (r"Mixin apply (?:for mod (\S+) )?failed|InvalidInjectionException|InjectionError", "A mixin failed to apply; a mod targets code that differs in this Minecraft or mod version."),
        (r"Incompatible mods? found|Mod resolution encountered an incompatible mod set", "Fabric Loader rejected the mod set because of missing or incompatible dependencies."),
        (r"requires (?:any version|version [^ ]+) of ([\w-]+), which is missing", "A declared dependency is missing from the instance."),
        (
            r"NoSuchMethodError|NoSuchFieldError|NoClassDefFoundError|ClassNotFoundException",
            "A class or member is missing at runtime: likely a version mismatch or a development-only dependency that is absent in production.",
        ),
        (r"OutOfMemoryError", "The JVM ran out of memory; increase the profile memory or look for leaks."),
        (r"(?i)Registry is already frozen|Duplicate registration|already registered", "A registry entry was registered twice or too late."),
        (
            r"Failed to remap mods|ClassNotFoundException: net\.minecraft\.class_\d+|Found a remappable @Shadow annotation",
            "A released mod cannot run in the development environment (it relies on production class names). Turn on Release build for this profile to test with the built JAR in a normal game.",
        ),
        (r"(?i)Could not find any mod with id|refmap", "Mapping or refmap problem; development and production namespaces may differ."),
        (r"UnsupportedClassVersionError", "A class was compiled for a newer Java version than the runtime."),
        (r"(?i)GLFW error|OpenGL|Pixel format not accelerated", "Graphics driver or OpenGL context problem."),
    ];
    let mut out = Vec::new();
    for (re, msg) in rules {
        if let Some(m) = Regex::new(re).ok().and_then(|r| r.find(text)) {
            out.push(json!({ "text": msg, "basis": format!("matched \"{}\"", js::slice_utf16(m.as_str(), 120)) }));
        }
    }
    out
}

fn recent_changes(workspace: &str) -> Vec<String> {
    let ws = Path::new(workspace);
    if ws.join(".git").exists() {
        let st = exec_capture("git", &["-C", workspace, "status", "--porcelain"], 10000, None);
        let log = exec_capture("git", &["-C", workspace, "log", "-5", "--pretty=%h %ad %s", "--date=iso"], 10000, None);
        let mut out: Vec<String> = st.stdout.split('\n').filter(|l| !l.is_empty()).map(|l| format!("uncommitted: {}", l.trim())).collect();
        out.extend(log.stdout.split('\n').filter(|l| !l.is_empty()).map(|l| format!("commit: {l}")));
        out.truncate(60);
        return out;
    }
    let mut found: Vec<(String, f64)> = Vec::new();
    let cutoff = crate::support::now_ms() as f64 - 24.0 * 3600.0 * 1000.0;
    fn walk(root: &Path, d: &Path, depth: usize, cutoff: f64, out: &mut Vec<(String, f64)>) {
        if depth > 8 {
            return;
        }
        let Ok(entries) = fs::read_dir(d) else { return };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if ["build", ".gradle", ".git", ".modsmith", "run", "node_modules"].contains(&name.as_str()) {
                continue;
            }
            let full = d.join(&name);
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                walk(root, &full, depth + 1, cutoff, out);
            } else if let Ok(m) = fs::metadata(&full) {
                let t = js::mtime_ms(&m);
                if t > cutoff {
                    out.push((full.strip_prefix(root).map(s).unwrap_or_else(|_| s(&full)), t));
                }
            }
        }
    }
    if ws.exists() {
        walk(ws, ws, 0, cutoff, &mut found);
    }
    found.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    found.into_iter().take(40).map(|(f, t)| format!("modified {}: {f}", js::iso(t as i64))).collect()
}

impl Runtime {
    pub fn crash_inspect(&self, id: &str) -> Result<Value, String> {
        let info = self.instance_or_err(id)?;
        let report = info["crashReport"].as_str().map(str::to_string).or_else(|| find_crash_report(Path::new(info["instanceDir"].as_str().unwrap_or("")), info["startedAt"].as_f64().unwrap_or(0.0)));
        let report_text = report.as_ref().filter(|r| Path::new(r).exists()).and_then(|r| fs::read(r).ok()).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
        let lines = self.instances.logs(id, &Query { limit: Some(50000), ..Default::default() })?["lines"].as_array().cloned().unwrap_or_default();
        let errors: Vec<Value> = lines.iter().filter(|l| l["level"] == "ERROR" || l["level"] == "FATAL").map(|l| l["text"].clone()).collect();
        let error_lines: Vec<Value> = errors[errors.len().saturating_sub(60)..].to_vec();
        let log_text = lines[lines.len().saturating_sub(4000)..].iter().map(|l| js::string(&l["text"])).collect::<Vec<_>>().join("\n");
        let mut observed = if report_text.is_empty() {
            let mut m = Map::new();
            m.insert("stackHead".into(), json!([]));
            m.insert("suspectedModsFromReport".into(), json!([]));
            m
        } else {
            parse_crash_report(&report_text)
        };
        observed.insert("errorLines".into(), Value::Array(error_lines));
        if let Some(c) = info.get("exitCode") {
            observed.insert("exitCode".into(), c.clone());
        }
        let mut inst = Map::new();
        for k in ["id", "profileId", "side", "mode", "status", "exitCode", "startedAt", "endedAt", "javaExecutable"] {
            if let Some(v) = info.get(k) {
                inst.insert(k.into(), v.clone());
            }
        }
        Ok(json!({
            "instance": inst,
            "crashReport": report,
            "observed": observed,
            "hypotheses": hypothesize(&format!("{report_text}\n{log_text}")),
            "recentChanges": recent_changes(info["workspace"].as_str().unwrap_or("")),
            "note": "Observed facts come from the crash report, the process exit code and the captured log. Hypotheses are automated pattern matches and may be wrong; \"Suspected Mods\" is Minecraft's own stack-based heuristic."
        }))
    }

    pub fn crash_bundle(&self, id: &str, notes: Option<&str>) -> Result<Value, String> {
        let a = self.crash_inspect(id)?;
        let info = self.instance_or_err(id)?;
        let mut files: Vec<(String, String)> = Vec::new();
        let mut add = |name: String, text: String| files.push((name, redact_text(&text)));
        let read = |p: &Path| fs::read(p).ok().map(|b| String::from_utf8_lossy(&b).into_owned());
        add("analysis.json".into(), js::pretty(&a));
        if let Some(r) = a["crashReport"].as_str() {
            if let Some(t) = read(Path::new(r)) {
                add(format!("crash-report/{}", Path::new(r).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()), t);
            }
        }
        if let Some(t) = info["logFile"].as_str().and_then(|f| read(Path::new(f))) {
            add("logs/session.log".into(), t);
        }
        let idir = Path::new(info["instanceDir"].as_str().unwrap_or(""));
        if let Some(t) = read(&idir.join("logs").join("latest.log")) {
            add("logs/latest.log".into(), t);
        }
        let ws = Path::new(info["workspace"].as_str().unwrap_or(""));
        if let Ok(lock) = manifest::read_lock(ws) {
            let pid = js::string(&info["profileId"]);
            let key = if info["mode"] == "production" { format!("{pid}@production") } else { pid };
            add("profile/resolved.json".into(), js::pretty(lock["profiles"].get(&key).unwrap_or(&Value::Null)));
        }
        if let Some(t) = read(&manifest::manifest_path(ws)) {
            add("profile/manifest.json".into(), t);
        }
        let os = if cfg!(windows) { "win32" } else { "linux" };
        add(
            "environment.txt".into(),
            format!(
                "java: {}\nside: {}\nmode: {}\nos: {os} {}\nModsmith: {}\nbridge game: {}\n",
                js::string(&info["javaExecutable"]),
                js::string(&info["side"]),
                js::string(&info["mode"]),
                crate::clientinstall::current_platform().arch,
                crate::api::api().version,
                info["bridge"].get("game").cloned().unwrap_or(Value::Null)
            ),
        );
        add("recent-changes.txt".into(), a["recentChanges"].as_array().map(|l| l.iter().map(js::string).collect::<Vec<_>>().join("\n")).unwrap_or_default());
        let o = &a["observed"];
        let hyps = a["hypotheses"].as_array().map(|h| h.iter().map(|x| format!("- {} ({})", js::string(&x["text"]), js::string(&x["basis"]))).collect::<Vec<_>>().join("\n")).unwrap_or_default();
        add(
            "reproduction-notes.md".into(),
            format!(
                "# Reproduction notes\n\n{}\n\n## Observed\n\n- Exit code: {}\n- Description: {}\n- Exception: {}\n\n## Automated hypotheses (unverified)\n\n{}\n",
                notes.unwrap_or("(none provided)"),
                o.get("exitCode").map(|c| if c.is_null() { "null".to_string() } else { js::string(c) }).unwrap_or_else(|| "undefined".into()),
                o["description"].as_str().unwrap_or("n/a"),
                o["exception"].as_str().unwrap_or("n/a"),
                if hyps.is_empty() { "- none".to_string() } else { hyps }
            ),
        );
        let dir = manifest::state_dir(ws).join("crash-bundles");
        fs::create_dir_all(&dir).map_err(|e| js::fs_error(&e, "mkdir", &dir))?;
        let file = dir.join(format!("crash-{}-{}.zip", js::string(&info["profileId"]), js::stamp(&js::iso_now())));
        let out = fs::File::create(&file).map_err(|e| js::fs_error(&e, "open", &file))?;
        let mut zip = zip::ZipWriter::new(out);
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, text) in files {
            zip.start_file(name, options).map_err(|e| e.to_string())?;
            zip.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        }
        zip.finish().map_err(|e| e.to_string())?;
        Ok(json!({ "file": s(&file) }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crash_report_fields() {
        let text = "---- Minecraft Crash Report ----\nDescription: Mod loading error\n\njava.lang.RuntimeException: boom\n\tat a.B.c(B.java:1)\n\tat d.E.f(E.java:2)\n\nA detailed walkthrough\n\tJava Version: 21.0.2, Eclipse Adoptium\n\tMinecraft Version: 1.21.1\n";
        let p = parse_crash_report(text);
        assert_eq!(p["description"], "Mod loading error");
        assert_eq!(p["exception"], "java.lang.RuntimeException: boom");
        assert_eq!(p["stackHead"], json!(["at a.B.c(B.java:1)", "at d.E.f(E.java:2)"]));
        assert_eq!(p["javaVersion"], "21.0.2, Eclipse Adoptium");
        assert_eq!(hypothesize("java.lang.OutOfMemoryError: Java heap space")[0]["basis"], "matched \"OutOfMemoryError\"");
    }
}
