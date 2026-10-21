use crate::js;
use crate::proc::exec_capture;
use crate::store::Store;
use regex::Regex;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[cfg(windows)]
const EXE: &str = "java.exe";
#[cfg(not(windows))]
const EXE: &str = "java";
#[cfg(windows)]
const JAVAC: &str = "javac.exe";
#[cfg(not(windows))]
const JAVAC: &str = "javac";

const KV_LIST: &str = "java.installations";
const KV_EXTRA: &str = "java.extraHomes";

fn child_dirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    entries.flatten().map(|e| dir.join(e.file_name())).filter(|p| p.is_dir()).collect()
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default()
}

pub fn candidate_homes(jdks: &Path) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut add = |home: &Path, source: &str| out.push((js::absolute(&home.to_string_lossy()).to_string_lossy().to_string(), source.to_string()));
    if let Some(h) = std::env::var_os("JAVA_HOME").filter(|v| !v.is_empty()) {
        add(Path::new(&h), "JAVA_HOME");
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    for p in std::env::split_paths(&path) {
        if !p.as_os_str().is_empty() && p.join(EXE).exists() {
            let abs = js::absolute(&p.to_string_lossy());
            if let Some(parent) = abs.parent() {
                add(parent, "PATH");
            } else {
                add(&abs, "PATH");
            }
        }
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        let pf = std::env::var("ProgramFiles").ok().filter(|p| !p.is_empty());
        let fallback = if pf.is_none() { Some("C:\\Program Files".to_string()) } else { None };
        let pfs = [pf, std::env::var("ProgramFiles(x86)").ok(), fallback];
        for pf in pfs.into_iter().flatten().filter(|p| !p.is_empty()) {
            for vendor in ["Java", "Eclipse Adoptium", "Eclipse Foundation", "Microsoft", "Zulu", "BellSoft", "Amazon Corretto", "Semeru", "GraalVM", "Temurin"] {
                roots.push(Path::new(&pf).join(vendor));
            }
        }
    } else if cfg!(target_os = "macos") {
        roots.push("/Library/Java/JavaVirtualMachines".into());
    } else {
        roots.push("/usr/lib/jvm".into());
    }
    roots.push(home_dir().join(".jdks"));
    roots.push(home_dir().join(".gradle").join("jdks"));
    roots.push(jdks.to_path_buf());
    for r in roots {
        let label = r.to_string_lossy().to_string();
        for d in child_dirs(&r) {
            add(&d, &label);
            if cfg!(target_os = "macos") {
                add(&d.join("Contents").join("Home"), &label);
            }
        }
    }
    out
}

pub fn install_hint(major: i64, jdk: bool) -> String {
    let image = if jdk { "" } else { ",\"imageType\":\"jre\"" };
    format!("Download Eclipse Temurin {major} with java_install {{\"major\":{major}{image}}}")
}

pub fn parse_java_settings(text: &str) -> Option<(String, String, String, String)> {
    let get = |k: &str| -> String {
        let re = Regex::new(&format!(r"(?m)^\s*{} = (.*)$", regex::escape(k))).expect("valid property regex");
        re.captures(text).map(|c| c[1].trim().to_string()).unwrap_or_default()
    };
    let version = get("java.version");
    if version.is_empty() {
        return None;
    }
    Some((version, get("java.vendor"), get("os.arch"), get("java.home")))
}

pub fn major_of(version: &str) -> f64 {
    let parts: Vec<&str> = version.split(['.', '+', '-']).collect();
    let parse = |s: Option<&&str>| -> f64 {
        let s = s.copied().unwrap_or("");
        let digits: String = s.trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            f64::NAN
        } else {
            digits.parse().unwrap_or(f64::NAN)
        }
    };
    let first = parse(parts.first());
    if first == 1.0 {
        return parse(parts.get(1));
    }
    first
}

pub fn probe_java(home: &str) -> Option<Value> {
    let bin = Path::new(home).join("bin").join(EXE);
    if !bin.exists() {
        return None;
    }
    let res = exec_capture(&bin.to_string_lossy(), &["-XshowSettings:properties", "-version"], 15000, None);
    let (version, vendor, arch, jhome) = parse_java_settings(&format!("{}\n{}", res.stderr, res.stdout))?;
    let real = if jhome.is_empty() { js::absolute(home) } else { js::absolute(&jhome) };
    let major = major_of(&version);
    Some(json!({
        "home": real.to_string_lossy(),
        "executable": real.join("bin").join(EXE).to_string_lossy(),
        "version": version,
        "major": if major.is_nan() { Value::Null } else { json!(major as i64) },
        "vendor": vendor,
        "arch": arch,
        "isJdk": real.join("bin").join(JAVAC).exists()
    }))
}

pub struct Java {
    store: Arc<Store>,
    jdks: PathBuf,
    cache: Mutex<Option<Vec<Value>>>,
}

fn major(j: &Value) -> i64 {
    j["major"].as_i64().unwrap_or(0)
}

impl Java {
    pub fn new(store: Arc<Store>, jdks: PathBuf) -> Java {
        Java { store, jdks, cache: Mutex::new(None) }
    }

    pub fn list(&self, refresh: bool) -> Vec<Value> {
        if !refresh {
            if let Some(c) = self.cache.lock().unwrap_or_else(|e| e.into_inner()).clone() {
                return c;
            }
            if let Some(stored) = self.store.get_kv(KV_LIST) {
                let at = stored["at"].as_f64().unwrap_or(0.0);
                let list = stored["list"].as_array().cloned().unwrap_or_default();
                let fresh = (crate::support::now_ms() as f64) - at < 6.0 * 3600.0 * 1000.0;
                if fresh && list.iter().all(|j| Path::new(j["executable"].as_str().unwrap_or("")).exists()) {
                    *self.cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(list.clone());
                    return list;
                }
            }
        }
        let extra: Vec<String> = self.store.get_kv(KV_EXTRA).and_then(|v| v.as_array().cloned()).unwrap_or_default().iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
        let mut candidates = candidate_homes(&self.jdks);
        candidates.extend(extra.into_iter().map(|h| (h, "user".to_string())));
        let handles: Vec<_> = candidates.into_iter().map(|(home, source)| std::thread::spawn(move || (source, probe_java(&home)))).collect();
        let mut seen: Vec<(String, Value)> = Vec::new();
        for h in handles {
            let Ok((source, Some(info))) = h.join() else { continue };
            let key = info["home"].as_str().unwrap_or_default().to_lowercase();
            match seen.iter_mut().find(|(k, _)| *k == key) {
                Some((_, existing)) => {
                    let sources = existing["sources"].as_array_mut().expect("sources array");
                    if !sources.iter().any(|s| s == &json!(source)) {
                        sources.push(json!(source));
                    }
                }
                None => {
                    let mut o = info.as_object().cloned().unwrap_or_default();
                    o.insert("sources".into(), json!([source]));
                    seen.push((key, Value::Object(o)));
                }
            }
        }
        let mut list: Vec<Value> = seen.into_iter().map(|(_, v)| v).collect();
        list.sort_by(|a, b| major(b).cmp(&major(a)).then_with(|| js::locale_compare(a["home"].as_str().unwrap_or(""), b["home"].as_str().unwrap_or(""))));
        *self.cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(list.clone());
        let _ = self.store.set_kv(KV_LIST, &json!({ "at": crate::support::now_ms() as u64, "list": list }));
        list
    }

    pub fn add_home(&self, home: &str) -> Result<Value, String> {
        let info = probe_java(home).ok_or_else(|| format!("No Java runtime found at {home}"))?;
        let mut extra: Vec<Value> = self.store.get_kv(KV_EXTRA).and_then(|v| v.as_array().cloned()).unwrap_or_default();
        if !extra.contains(&info["home"]) {
            extra.push(info["home"].clone());
        }
        self.store.set_kv(KV_EXTRA, &Value::Array(extra)).map_err(|e| e.to_string())?;
        self.list(true);
        let mut o = info.as_object().cloned().unwrap_or_default();
        o.insert("sources".into(), json!(["user"]));
        Ok(Value::Object(o))
    }

    pub fn select(&self, min_major: i64, max_major: Option<i64>, require_jdk: bool, prefer_home: Option<&str>) -> Option<Value> {
        let list = self.list(false);
        let fits = |j: &Value| major(j) >= min_major && max_major.is_none_or(|m| m == 0 || major(j) <= m) && (!require_jdk || j["isJdk"] == true);
        if let Some(pref) = prefer_home {
            let want = js::absolute(pref).to_string_lossy().to_lowercase();
            if let Some(p) = list.iter().find(|j| j["home"].as_str().unwrap_or("").to_lowercase() == want) {
                if fits(p) {
                    return Some(p.clone());
                }
            }
        }
        let mut ok: Vec<&Value> = list.iter().filter(|j| fits(j) && (j["arch"].as_str().unwrap_or("").contains("64") || j["arch"] == "")).collect();
        ok.sort_by_key(|j| major(j));
        ok.first().map(|v| (*v).clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn majors() {
        assert_eq!(major_of("1.8.0_392"), 8.0);
        assert_eq!(major_of("21.0.2"), 21.0);
        assert_eq!(major_of("17"), 17.0);
        assert_eq!(major_of("25-ea"), 25.0);
    }

    #[test]
    fn settings() {
        let text = "Property settings:\n    java.home = C:\\jdk\n    java.vendor = Eclipse Adoptium\n    java.version = 21.0.2\n    os.arch = amd64\n";
        let (v, vendor, arch, home) = parse_java_settings(text).unwrap();
        assert_eq!((v.as_str(), vendor.as_str(), arch.as_str(), home.as_str()), ("21.0.2", "Eclipse Adoptium", "amd64", "C:\\jdk"));
    }
}
