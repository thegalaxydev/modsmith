use crate::js;
use crate::ops::OpCtx;
use crate::proc::{run_process, RunOptions};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Instant;

pub fn wrapper_path(dir: &Path) -> Option<PathBuf> {
    let p = dir.join(if cfg!(windows) { "gradlew.bat" } else { "gradlew" });
    p.exists().then_some(p)
}

pub fn wrapper_version(dir: &Path) -> Option<String> {
    let props = dir.join("gradle").join("wrapper").join("gradle-wrapper.properties");
    let text = std::fs::read_to_string(props).ok()?;
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"gradle-([\d.]+(?:-[a-z0-9-]+)?)-(?:bin|all)\.zip").expect("valid wrapper regex"));
    re.captures(&text).map(|c| c[1].to_string())
}

fn diag(severity: &str, message: &str, file: Option<String>, line: Option<i64>, column: Option<i64>, source: &str) -> Value {
    let mut o = Map::new();
    o.insert("severity".into(), json!(severity));
    o.insert("message".into(), json!(message));
    if let Some(f) = file {
        o.insert("file".into(), json!(f));
    }
    if let Some(l) = line {
        o.insert("line".into(), json!(l));
    }
    if let Some(c) = column {
        o.insert("column".into(), json!(c));
    }
    o.insert("source".into(), json!(source));
    Value::Object(o)
}

pub fn parse_diagnostics(lines: &[String], project_dir: &Path) -> Vec<Value> {
    static RES: OnceLock<(Regex, Regex, Regex)> = OnceLock::new();
    let (javac, kotlin, build_file) = RES.get_or_init(|| {
        (
            Regex::new(r"^(?:e: )?(.+\.(?:java|kt|groovy)):(\d+)(?::(\d+))?: (error|warning): (.*)$").expect("javac regex"),
            Regex::new(r"^([ew]): file:///?(.+\.kts?):(\d+):(\d+) (.*)$").expect("kotlin regex"),
            Regex::new(r"^Build file '(.+)' line: (\d+)").expect("build file regex"),
        )
    });
    let num = |s: &str| s.parse::<i64>().ok();
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if let Some(m) = javac.captures(line) {
            let file = js::absolute_from(project_dir, &m[1]).to_string_lossy().to_string();
            out.push(diag(if &m[4] == "error" { "error" } else { "warning" }, &m[5], Some(file), num(&m[2]), m.get(3).and_then(|c| num(c.as_str())), "javac"));
            continue;
        }
        if let Some(m) = kotlin.captures(line) {
            out.push(diag(if &m[1] == "e" { "error" } else { "warning" }, &m[5], Some(m[2].to_string()), num(&m[3]), num(&m[4]), "kotlinc"));
            continue;
        }
        if line.starts_with("* What went wrong:") {
            let mut msg: Vec<&str> = Vec::new();
            for l in &lines[i + 1..] {
                if l.starts_with("* Try:") || l.starts_with("* Exception is:") {
                    break;
                }
                if !l.trim().is_empty() {
                    msg.push(l.trim());
                }
            }
            out.push(diag("error", &js::slice_utf16(&msg.join(" "), 2000), None, None, None, "gradle"));
        }
        if let Some(m) = build_file.captures(line) {
            out.push(diag("error", "Build script error", Some(m[1].to_string()), num(&m[2]), None, "gradle"));
        }
    }
    out
}

pub struct GradleResult {
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub diagnostics: Vec<Value>,
    pub duration_ms: u64,
}

pub struct GradleRun<'a> {
    pub project_dir: &'a Path,
    pub tasks: Vec<String>,
    pub java: &'a Value,
    pub init_script: Option<PathBuf>,
    pub system_props: Vec<(String, String)>,
    pub ctx: &'a OpCtx,
}

pub fn run_gradle(opts: GradleRun) -> Result<GradleResult, String> {
    let dir = opts.project_dir;
    let wrapper = wrapper_path(dir);
    let wrapper_jar = dir.join("gradle").join("wrapper").join("gradle-wrapper.jar");
    let Some(wrapper) = wrapper.filter(|_| wrapper_jar.exists()) else {
        return Err(format!("No Gradle wrapper found in {}. Modsmith only runs builds through the project's own wrapper.", dir.display()));
    };
    let mut args: Vec<String> = vec!["--console=plain".into(), "--no-configuration-cache".into()];
    if let Some(init) = &opts.init_script {
        args.push("-I".into());
        args.push(init.to_string_lossy().to_string());
    }
    for (k, v) in &opts.system_props {
        args.push(format!("-D{k}={v}"));
    }
    args.extend(opts.tasks.iter().cloned());
    let home = opts.java["home"].as_str().unwrap_or_default();
    let exe = opts.java["executable"].as_str().unwrap_or_default();
    let path = std::env::var("PATH").unwrap_or_default();
    let sep = if cfg!(windows) { ";" } else { ":" };
    let env = vec![("JAVA_HOME".to_string(), home.to_string()), ("PATH".to_string(), format!("{}{sep}{path}", Path::new(home).join("bin").display()))];
    let ctx = opts.ctx;
    ctx.log(&format!("> {} {}", wrapper.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), args.join(" ")));
    ctx.log(&format!("> JAVA_HOME={home} (Java {})", js::string(&opts.java["version"])));
    let started = Instant::now();
    let mut output: Vec<String> = Vec::new();
    let mut task_count = 0;
    let mut full: Vec<String> =
        vec!["-Xmx64m".into(), "-Xms64m".into(), "-Dorg.gradle.appname=gradlew".into(), "-classpath".into(), wrapper_jar.to_string_lossy().to_string(), "org.gradle.wrapper.GradleWrapperMain".into()];
    full.extend(args);
    static TASK: OnceLock<Regex> = OnceLock::new();
    let task_re = TASK.get_or_init(|| Regex::new(r"^> Task (\S+)").expect("task regex"));
    let mut on_line = |line: &str, _: crate::proc::Stream| {
        output.push(line.to_string());
        ctx.log(line);
        if let Some(t) = task_re.captures(line) {
            task_count += 1;
            ctx.progress(None, Some(&format!("Gradle {} ({task_count} tasks)", &t[1])));
        }
    };
    let cancelled = || ctx.cancelled();
    let code = run_process(Path::new(exe), &full, RunOptions { cwd: Some(dir), env, env_remove: vec!["JAVA_TOOL_OPTIONS".into()], cancelled: &cancelled, on_line: &mut on_line })?;
    let diagnostics = parse_diagnostics(&output, dir);
    Ok(GradleResult { ok: code == Some(0), exit_code: code, diagnostics, duration_ms: started.elapsed().as_millis() as u64 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_javac_and_gradle_failures() {
        let lines: Vec<String> =
            ["C:\\p\\src\\main\\java\\a\\B.java:12: error: cannot find symbol", "* What went wrong:", "Execution failed for task ':compileJava'.", "> Compilation failed", "", "* Try:"]
                .iter()
                .map(|s| s.to_string())
                .collect();
        let d = parse_diagnostics(&lines, Path::new("C:\\p"));
        assert_eq!(d.len(), 2);
        assert_eq!(d[0]["line"], 12);
        assert_eq!(d[1]["message"], "Execution failed for task ':compileJava'. > Compilation failed");
    }
}
