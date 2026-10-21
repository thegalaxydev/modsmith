use crate::clientinstall::{build_client_launch, current_platform, fetch_sha1, ClientInstaller, LaunchPaths};
use crate::gradle::{run_gradle, GradleRun};
use crate::hotswap;
use crate::http::{download_verified, hash_file, Expected};
use crate::instances::LaunchSpec;
use crate::jarmeta::read_jar_metadata;
use crate::js;
use crate::manifest;
use crate::ops::OpCtx;
use crate::proc::{run_process, RunOptions};
use crate::profiles::classpath_mod_ids;
use crate::resolver::all_mod_ids;
use crate::rt::{basename, s, Runtime};
use crate::workspace::{self, instance_dir_for};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn classpath_args(java: &Value, arg_file: &Path, classpath: &str) -> Result<Vec<String>, String> {
    if java["major"].as_i64().unwrap_or(0) < 9 {
        return Ok(vec!["-cp".into(), classpath.to_string()]);
    }
    fs::write(arg_file, format!("-cp {}\n", quote_arg_file(classpath))).map_err(|e| js::fs_error(&e, "open", arg_file))?;
    Ok(vec![format!("@{}", s(arg_file))])
}

fn quote_arg_file(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn free_port(start: u16) -> Result<u16, String> {
    for p in start..start.saturating_add(50) {
        if std::net::TcpListener::bind(("127.0.0.1", p)).is_ok() {
            return Ok(p);
        }
    }
    Err(format!("No free debug port near {start}"))
}

pub fn disable_early_window_toml(text: &str) -> String {
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = if text.is_empty() { vec![] } else { Regex::new(r"\r?\n").expect("eol regex").split(text).map(str::to_string).collect() };
    let key = Regex::new(r"^[ \t]*earlyWindowControl[ \t]*=").expect("toml key regex");
    match lines.iter().position(|l| key.is_match(l)) {
        Some(i) => lines[i] = "earlyWindowControl = false".into(),
        None => {
            if lines.last().is_some_and(|l| l.is_empty()) {
                lines.pop();
            }
            lines.push("earlyWindowControl = false".into());
            lines.push(String::new());
        }
    }
    lines.join(eol)
}

pub fn eula_accepted(instance_dir: &Path) -> bool {
    fs::read_to_string(instance_dir.join("eula.txt")).map(|t| Regex::new(r"(?m)^\s*eula\s*=\s*true\s*$").expect("eula regex").is_match(&t)).unwrap_or(false)
}

#[derive(Clone)]
pub struct Seat {
    pub session: String,
    pub slot: u32,
    pub player: Option<String>,
    pub join: Option<String>,
}

impl Seat {
    pub fn suffix(&self) -> String {
        if self.slot > 1 {
            format!("-{}", self.slot)
        } else {
            String::new()
        }
    }

    fn json(&self) -> Value {
        let mut o = Map::new();
        o.insert("session".into(), json!(self.session));
        o.insert("slot".into(), json!(self.slot));
        if let Some(p) = &self.player {
            o.insert("player".into(), json!(p));
        }
        Value::Object(o)
    }
}

fn seat_suffix(seat: Option<&Seat>) -> String {
    seat.map(Seat::suffix).unwrap_or_default()
}

pub fn identity_args(player: &str) -> Vec<String> {
    vec!["--username".into(), player.into(), "--uuid".into(), crate::clientinstall::offline_uuid(player).replace('-', ""), "--accessToken".into(), "0".into()]
}

pub fn join_args(minecraft: &str, host: &str, port: u16) -> Vec<String> {
    if crate::versionrange::compare_versions(minecraft, "1.20") >= 0.0 {
        vec!["--quickPlayMultiplayer".into(), format!("{host}:{port}")]
    } else {
        vec!["--server".into(), host.into(), "--port".into(), port.to_string()]
    }
}

fn seat_args(m: &Value, seat: Option<&Seat>) -> Vec<String> {
    let Some(seat) = seat else { return vec![] };
    let mut out = Vec::new();
    if let Some(p) = &seat.player {
        out.extend(identity_args(p));
    }
    if let Some(j) = &seat.join {
        let (host, port) = j.rsplit_once(':').unwrap_or((j.as_str(), "25565"));
        out.extend(join_args(&js::string(&m["platform"]["minecraft"]), host, port.parse().unwrap_or(25565)));
    }
    out
}

pub struct Prepared {
    pub dir: PathBuf,
    pub m: Value,
    pub profile: Value,
    pub mode: String,
    pub side: String,
    pub idir: PathBuf,
}

fn arr(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}

fn strings(v: &Value) -> Vec<String> {
    arr(v).iter().map(js::string).collect()
}

pub fn find_profile(m: &Value, id: &str) -> Option<Value> {
    arr(&m["profiles"]).into_iter().find(|p| p["id"] == id)
}

fn code_text(c: Option<i32>) -> String {
    c.map(|c| c.to_string()).unwrap_or_else(|| "null".into())
}

fn zip_dir(root: &Path, file: &Path) -> Result<(), String> {
    use std::io::Write;
    fn walk(base: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
        let mut entries: Vec<PathBuf> = fs::read_dir(dir).map_err(|e| js::fs_error(&e, "opendir", dir))?.flatten().map(|e| e.path()).collect();
        entries.sort();
        for p in entries {
            if p.is_dir() {
                walk(base, &p, out)?;
            } else {
                out.push(p);
            }
        }
        Ok(())
    }
    let mut paths = Vec::new();
    walk(root, root, &mut paths)?;
    let tmp = PathBuf::from(format!("{}.tmp", file.display()));
    let f = fs::File::create(&tmp).map_err(|e| js::fs_error(&e, "open", &tmp))?;
    let mut zip = zip::ZipWriter::new(f);
    let now = {
        use chrono::{Datelike, Timelike};
        let n = chrono::Local::now();
        zip::DateTime::from_date_and_time(n.year() as u16, n.month() as u8, n.day() as u8, n.hour() as u8, n.minute() as u8, n.second() as u8).unwrap_or_default()
    };
    for p in paths {
        let rel = p.strip_prefix(root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
        let mode = if rel.ends_with(".sh") { 0o755 } else { 0o644 };
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).system(zip::System::Unix).unix_permissions(mode).last_modified_time(now).large_file(true);
        zip.start_file(rel, options).map_err(|e| e.to_string())?;
        let bytes = fs::read(&p).map_err(|e| js::fs_error(&e, "open", &p))?;
        zip.write_all(&bytes).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    fs::rename(&tmp, file).map_err(|e| js::fs_error(&e, "rename", &tmp))
}

struct Spec {
    environment: Vec<(String, String)>,
    main_class: String,
    jvm_args: Vec<String>,
    args: Vec<String>,
    classpath: Vec<String>,
    provided: Vec<String>,
}

impl Runtime {
    fn bridge_jar(&self, m: &Value) -> Option<(PathBuf, Value)> {
        let cat = self.catalog_entry(m)?;
        if cat["bridge"]["available"] != true {
            return None;
        }
        let jar = cat["bridge"]["jar"].as_str().filter(|j| !j.is_empty())?;
        let p = self.resources.join("bridge").join(jar);
        if !p.exists() {
            return None;
        }
        Some((p, json!({ "key": "bridge", "provider": "bridge", "title": "Modsmith bridge", "fileName": jar, "modIds": ["modsmith_bridge"], "reason": "development bridge", "required": false })))
    }

    pub fn accept_eula(&self, root: &str, profile_id: &str, mode: &str, accept: bool) -> Result<Value, String> {
        if !accept {
            return Err("Accepting the Minecraft EULA requires accept: true after the user has read https://aka.ms/MinecraftEULA".into());
        }
        let dir = workspace::normalize(root);
        let m = manifest::require_manifest(&dir, root)?;
        let profile = find_profile(&m, profile_id).ok_or_else(|| format!("Unknown profile {profile_id}"))?;
        if profile["side"] != "server" {
            return Err("EULA acceptance is only needed for server profiles".into());
        }
        let idir = instance_dir_for(&dir, profile_id, mode, "server");
        fs::create_dir_all(&idir).map_err(|e| js::fs_error(&e, "mkdir", &idir))?;
        fs::write(idir.join("eula.txt"), format!("#Accepted by the user through Modsmith on {} (https://aka.ms/MinecraftEULA)\neula=true\n", js::iso_now()))
            .map_err(|e| js::fs_error(&e, "open", &idir.join("eula.txt")))?;
        Ok(json!({ "instanceDir": s(&idir), "accepted": true }))
    }

    pub fn eula_status(&self, root: &str, profile_id: &str, mode: &str) -> Value {
        let dir = workspace::normalize(root);
        let idir = instance_dir_for(&dir, profile_id, mode, "server");
        json!({ "instanceDir": s(&idir), "accepted": eula_accepted(&idir) })
    }

    fn runtime_java(&self, m: &Value, profile: &Value) -> Result<Value, String> {
        let cat = self.catalog_entry(m);
        let min = profile["java"]["minMajor"].as_i64().or_else(|| cat.as_ref().and_then(|c| c["runtimeJavaMin"].as_i64())).unwrap_or(21);
        let home = profile["java"]["home"].as_str().filter(|h| !h.is_empty());
        let pid = js::string(&profile["id"]);
        let j = self
            .java
            .select(min, None, false, home)
            .ok_or_else(|| format!("No Java {min}+ runtime found for profile {pid}. {}, or install Java {min} and refresh Java detection.", crate::java::install_hint(min, false)))?;
        if let Some(h) = home {
            if js::absolute(j["home"].as_str().unwrap_or("")).to_string_lossy().to_lowercase() != js::absolute(h).to_string_lossy().to_lowercase() {
                return Err(format!("Configured Java {h} for profile {pid} is missing or older than Java {min}"));
            }
        }
        Ok(j)
    }

    fn harness_dir(&self, root: &Path, m: &Value) -> Result<PathBuf, String> {
        let cat = self.catalog_entry(m).filter(|c| crate::manifest::generatable(c)).ok_or("Modpack launch requires a verified catalog entry for the pack platform")?;
        let dir = manifest::state_dir(root).join("harness");
        let wrapper = self.wrapper_template();
        for f in ["gradlew", "gradlew.bat", "gradle/wrapper/gradle-wrapper.jar"] {
            let target = dir.join(f);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| js::fs_error(&e, "mkdir", parent))?;
            }
            fs::copy(wrapper.join(f), &target).map_err(|e| js::fs_error(&e, "copyfile", &wrapper.join(f)))?;
        }
        let w = |f: &Path, text: String| fs::write(f, text).map_err(|e| js::fs_error(&e, "open", f));
        w(&dir.join("gradle").join("wrapper").join("gradle-wrapper.properties"), crate::scaffold::wrapper_properties(&js::string(&cat["gradleVersion"])))?;
        w(&dir.join("settings.gradle"), "pluginManagement {\n\trepositories {\n\t\tmaven {\n\t\t\tname = 'Fabric'\n\t\t\turl = 'https://maven.fabricmc.net/'\n\t\t}\n\t\tmavenCentral()\n\t\tgradlePluginPortal()\n\t}\n}\n\nrootProject.name = 'modsmith-harness'\n".into())?;
        let implementation = if cat["remap"] == true { "modImplementation" } else { "implementation" };
        let mappings = if cat["mappings"] == "mojang" { "\tmappings loom.officialMojangMappings()\n" } else { "" };
        w(
            &dir.join("build.gradle"),
            format!(
                "plugins {{\n\tid '{}' version '{}'\n}}\n\ndependencies {{\n\tminecraft \"com.mojang:minecraft:{}\"\n{mappings}\t{implementation} \"net.fabricmc:fabric-loader:{}\"\n}}\n",
                js::string(&cat["plugin"]["id"]),
                js::string(&cat["plugin"]["version"]),
                js::string(&cat["minecraft"]),
                js::string(&m["platform"]["loaderVersion"])
            ),
        )?;
        Ok(dir)
    }

    fn extract_spec(&self, project: &Path, out_dir: &Path, run_name: &str, java: &Value, ctx: &OpCtx) -> Result<Spec, String> {
        fs::create_dir_all(out_dir).map_err(|e| js::fs_error(&e, "mkdir", out_dir))?;
        let spec_file = out_dir.join(format!("{run_name}.json"));
        let res = run_gradle(GradleRun {
            project_dir: project,
            tasks: vec!["mwbLaunchSpec".into()],
            java,
            init_script: Some(self.resources.join("gradle").join("modsmith-init.gradle")),
            system_props: vec![("mwb.runs".into(), run_name.into()), ("mwb.specOut".into(), s(&spec_file))],
            ctx,
        })?;
        if !res.ok {
            let d = project.join(".modsmith");
            let _ = fs::create_dir_all(&d);
            let _ = fs::write(d.join("diagnostics.json"), js::pretty(&Value::Array(res.diagnostics.clone())));
            self.emit("diagnostics.updated", json!({ "workspace": s(project), "diagnostics": res.diagnostics }));
            let errors = res.diagnostics.iter().filter(|x| x["severity"] == "error").count();
            return Err(format!("Gradle failed while preparing {run_name} (exit {}); {errors} errors", code_text(res.exit_code)));
        }
        if !spec_file.exists() {
            return Err("Gradle did not produce a launch specification. The project may not apply Fabric Loom or NeoForge ModDevGradle in its root project.".into());
        }
        let text = fs::read_to_string(&spec_file).map_err(|e| js::fs_error(&e, "open", &spec_file))?;
        let spec: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let run = spec["runs"].get(run_name).filter(|r| r.is_object()).ok_or_else(|| format!("The project has no {run_name} task (missing: {})", strings(&spec["missing"]).join(", ")))?;
        let classpath = strings(&run["classpath"]);
        let environment = run["environment"].as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), js::string(v))).collect()).unwrap_or_default();
        Ok(Spec { environment, main_class: js::string(&run["mainClass"]), jvm_args: strings(&run["jvmArgs"]), args: strings(&run["args"]), provided: classpath_mod_ids(&classpath), classpath })
    }

    pub fn launch(self: &Arc<Self>, root: &str, profile_id: &str, mode: Option<&str>) -> Result<Value, String> {
        let p = self.prepare_launch(root, profile_id, mode, None)?;
        let me = self.clone();
        let title = format!("Launch {} ({})", js::string(&p.profile["name"]), p.mode);
        let dir = s(&p.dir);
        Ok(self.ops.start("instance.launch", &title, Some(dir), move |ctx| me.run_prepared(&p, None, ctx).map(Some)))
    }

    pub fn prepare_launch(&self, root: &str, profile_id: &str, mode: Option<&str>, seat: Option<&Seat>) -> Result<Prepared, String> {
        let dir = workspace::normalize(root);
        let m = manifest::require_manifest(&dir, root)?;
        let profile = find_profile(&m, profile_id).ok_or_else(|| format!("Unknown profile {profile_id}"))?;
        let loader = js::string(&m["platform"]["loader"]);
        if !crate::scaffold::implemented(&loader) {
            return Err(format!("{loader} launch is not implemented"));
        }
        let mode = mode.map(str::to_string).unwrap_or_else(|| js::string(&profile["mode"]));
        if m["source"]["kind"] == "gradle" || mode == "development" {
            workspace::require_trusted(&self.store, &s(&dir))?;
        }
        let side = js::string(&profile["side"]);
        let base = instance_dir_for(&dir, profile_id, &mode, &side);
        let idir = match seat_suffix(seat) {
            sfx if sfx.is_empty() => base,
            sfx => base.with_file_name(format!("{}{sfx}", base.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())),
        };
        if let Some(busy) = self.instances.active_for_dir(&idir) {
            return Err(format!("Profile {profile_id} already has a running {side} (instance {}). Stop it or clone the profile to run another copy.", js::string(&busy["id"])));
        }
        if side == "server" && !eula_accepted(&idir) {
            return Err(format!(
                "The Minecraft EULA has not been accepted for {}. Read https://aka.ms/MinecraftEULA and accept it explicitly (instance_accept_eula) before starting a server.",
                idir.display()
            ));
        }
        Ok(Prepared { dir, m, profile, mode, side, idir })
    }

    pub fn run_prepared(&self, p: &Prepared, seat: Option<&Seat>, ctx: &OpCtx) -> Result<Value, String> {
        let java = self.runtime_java(&p.m, &p.profile)?;
        ctx.log(&format!("Runtime Java: {} {} ({})", js::string(&java["vendor"]), js::string(&java["version"]), js::string(&java["home"])));
        if p.mode == "development" {
            self.launch_dev(&p.dir, &p.m, &p.profile, &p.idir, &java, seat, ctx)
        } else if p.side == "client" {
            self.launch_prod_client(&p.dir, &p.m, &p.profile, &p.idir, &java, seat, ctx)
        } else {
            self.launch_prod_server(&p.dir, &p.m, &p.profile, &p.idir, &java, seat, ctx)
        }
    }

    fn resolve_for_launch(&self, dir: &Path, profile: &Value, mode: &str, provided: Option<Vec<String>>, extra: Vec<Value>, ctx: &OpCtx) -> Result<Vec<(String, String)>, String> {
        let (res, _) = self.profiles.resolve_with(&s(dir), &js::string(&profile["id"]), Some(ctx), Some(mode), provided, extra, &crate::profiles::Plan::default())?;
        let errors: Vec<String> = res.issues.iter().filter(|i| i["severity"] == "error").map(|i| js::string(&i["message"])).collect();
        if !errors.is_empty() {
            return Err(format!("Profile resolution has errors: {}", errors.join("; ")));
        }
        Ok(res
            .files
            .iter()
            .map(|(key, source)| {
                let source = js::string(source);
                let name = res.entries.iter().find(|e| e["key"] == key.as_str()).and_then(|e| e["fileName"].as_str()).map(str::to_string).unwrap_or_else(|| basename(Path::new(&source)));
                (name, source)
            })
            .collect())
    }

    fn debug_arg(profile: &Value) -> Result<Option<(u16, String)>, String> {
        if profile["debug"]["enabled"] != true {
            return Ok(None);
        }
        let port = free_port(profile["debug"]["port"].as_u64().unwrap_or(5005) as u16)?;
        let suspend = if profile["debug"]["suspend"] == true { "y" } else { "n" };
        Ok(Some((port, format!("-agentlib:jdwp=transport=dt_socket,server=y,suspend={suspend},address=127.0.0.1:{port}"))))
    }

    fn launch_dev(&self, dir: &Path, m: &Value, profile: &Value, idir: &Path, java: &Value, seat: Option<&Seat>, ctx: &OpCtx) -> Result<Value, String> {
        let side = js::string(&profile["side"]);
        let loader = js::string(&m["platform"]["loader"]);
        let run_name = if side == "client" { "runClient" } else { "runServer" };
        let use_source = m["source"]["kind"] == "gradle" && profile["includeSourceMod"] == true;
        if !use_source && loader != "fabric" {
            return Err(format!("Launching a {loader} profile without the source mod needs a development harness, which is only implemented for Fabric"));
        }
        let source = if use_source { dir.to_path_buf() } else { self.harness_dir(dir, m)? };
        ctx.progress(Some(0.05), Some(if source == dir { "Compiling and preparing the launch configuration" } else { "Preparing development harness" }));
        let (gradle_java, note) = self.resolve_gradle_java(dir)?;
        ctx.log(&format!("Gradle JVM: {} ({note})", js::string(&gradle_java["version"])));
        let spec = self.extract_spec(&source, &manifest::state_dir(dir).join("launch"), run_name, &gradle_java, ctx)?;
        ctx.progress(Some(0.6), Some("Resolving profile mods"));
        let bridge = if profile["bridge"] == true { self.bridge_jar(m) } else { None };
        if profile["bridge"] == true && bridge.is_none() {
            ctx.log("[warning] Bridge requested but no bridge JAR is available for this platform; launching without it");
        }
        let extra = bridge.as_ref().map(|(_, e)| vec![e.clone()]).unwrap_or_default();
        let mut files = self.resolve_for_launch(dir, profile, "development", Some(spec.provided.clone()), extra, ctx)?;
        ctx.progress(Some(0.75), Some("Syncing isolated instance"));
        if let Some((path, e)) = &bridge {
            files.push((js::string(&e["fileName"]), s(path)));
        }
        self.profiles.sync_instance(idir, &files, Some(ctx))?;
        self.profiles.overlay(dir, profile, idir, Some(ctx));
        if loader == "neoforge" && side == "client" {
            self.disable_early_window(dir, profile, idir, ctx);
        }
        let pid = js::string(&profile["id"]);
        let arg_file = manifest::state_dir(dir).join("launch").join(format!("{pid}-{side}{}.classpath.args", seat_suffix(seat)));
        let sep = if cfg!(windows) { ";" } else { ":" };
        let cp_args = classpath_args(java, &arg_file, &spec.classpath.join(sep))?;
        let mut jvm: Vec<String> = spec.jvm_args.iter().filter(|a| !a.starts_with("-Duser.") && !a.starts_with("-Xmx") && !a.starts_with("-Xms")).cloned().collect();
        jvm.push(format!("-Xmx{}M", js::string(&profile["jvm"]["memoryMb"])));
        jvm.extend(strings(&profile["jvm"]["args"]));
        let debug = Self::debug_arg(profile)?;
        if let Some((_, a)) = &debug {
            jvm.push(a.clone());
        }
        let mut args = jvm;
        args.extend(cp_args);
        args.push(spec.main_class.clone());
        args.extend(spec.args.iter().cloned());
        if side == "client" {
            args.extend(seat_args(m, seat));
        }
        args.extend(strings(&profile["programArgs"]));
        if side == "server" && loader == "fabric" && !args.iter().any(|a| a == "nogui") {
            args.push("nogui".into());
        }
        let hot = debug.is_some() && use_source;
        ctx.progress(Some(0.9), Some("Starting Java process"));
        let info = self.instances.launch(LaunchSpec {
            workspace: s(dir),
            profile_id: pid.clone(),
            side: side.clone(),
            mode: "development".into(),
            instance_dir: idir.to_path_buf(),
            java: js::string(&java["executable"]),
            args,
            env: spec.environment,
            bridge: bridge.is_some(),
            debug_port: debug.map(|d| d.0),
            operation_id: Some(ctx.id.clone()),
            seat: seat.map(Seat::json),
        })?;
        ctx.log(&format!("Started {side} pid {} in {}", info.get("pid").map(js::string).unwrap_or_else(|| "undefined".into()), idir.display()));
        if let (true, Some(id)) = (hot, info.get("id").and_then(|v| v.as_str())) {
            let dirs = hotswap::class_dirs(dir, &spec.classpath);
            match hotswap::snapshot(&hotswap::state_path(dir, &pid, &format!("{side}{}", seat_suffix(seat))), id, &dirs) {
                Ok(n) => ctx.log(&format!("Hot reload ready: {n} compiled classes recorded")),
                Err(e) => ctx.log(&format!("[warning] Hot reload is unavailable for this run: {e}")),
            }
        }
        Ok(info)
    }

    fn disable_early_window(&self, dir: &Path, profile: &Value, idir: &Path, ctx: &OpCtx) {
        if let Some(c) = profile["configDir"].as_str().filter(|c| !c.is_empty()) {
            if dir.join(c).join("fml.toml").exists() {
                ctx.log("Keeping the profile-supplied config/fml.toml (early loading window settings unchanged)");
                return;
            }
        }
        let file = idir.join("config").join("fml.toml");
        let _ = fs::create_dir_all(idir.join("config"));
        let text = fs::read_to_string(&file).unwrap_or_default();
        let next = disable_early_window_toml(&text);
        if next != text {
            let _ = fs::write(&file, next);
        }
        ctx.log("NeoForge early loading window disabled for this development instance (config/fml.toml earlyWindowControl = false) to avoid an intermittent early-display startup failure");
    }

    fn marker_matches(marker: &Path, want: &Value) -> bool {
        fs::read_to_string(marker).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).is_some_and(|v| v == *want)
    }

    fn installer_jar(&self, url: &str, dest: PathBuf, sha_error: &str, ctx: &OpCtx) -> Result<(PathBuf, bool), String> {
        let sha1 = fetch_sha1(url, sha_error)?;
        let cancelled = || ctx.cancelled();
        download_verified(url, &dest, &Expected { sha1: Some(&sha1), sha256: None, sha512: None, size: None }, &cancelled, &|_, _| {})
    }

    fn run_installer(&self, java: &Value, args: Vec<String>, cwd: &Path, ctx: &OpCtx) -> Result<Option<i32>, String> {
        let cancelled = || ctx.cancelled();
        let mut on_line = |l: &str, _: crate::proc::Stream| ctx.log(l);
        run_process(Path::new(java["executable"].as_str().unwrap_or("java")), &args, RunOptions { cwd: Some(cwd), env: vec![], env_remove: vec![], cancelled: &cancelled, on_line: &mut on_line })
    }

    fn install_fabric_server(&self, idir: &Path, m: &Value, java: &Value, ctx: &OpCtx) -> Result<PathBuf, String> {
        let launcher = idir.join("fabric-server-launch.jar");
        let marker = idir.join(".modsmith-server.json");
        let want = json!({ "minecraft": m["platform"]["minecraft"], "loader": m["platform"]["loaderVersion"] });
        if launcher.exists() && Self::marker_matches(&marker, &want) {
            return Ok(launcher);
        }
        let installers = self.providers.http().get_json("https://meta.fabricmc.net/v2/versions/installer", 24 * 3600 * 1000, &[])?;
        let list = arr(&installers.data);
        let inst = list.iter().find(|i| i["stable"] == true).or(list.first()).ok_or("Fabric meta returned no installer versions")?;
        let v = js::string(&inst["version"]);
        let url = format!("https://maven.fabricmc.net/net/fabricmc/fabric-installer/{v}/fabric-installer-{v}.jar");
        let (jar, cached) = self.installer_jar(&url, self.downloads().join("fabric-installer").join(&v).join(format!("fabric-installer-{v}.jar")), "Could not fetch installer checksum", ctx)?;
        ctx.log(&format!("Fabric installer {v} {} and verified", if cached { "(cached)" } else { "downloaded" }));
        let args = vec![
            "-jar".into(),
            s(&jar),
            "server".into(),
            "-dir".into(),
            s(idir),
            "-mcversion".into(),
            js::string(&m["platform"]["minecraft"]),
            "-loader".into(),
            js::string(&m["platform"]["loaderVersion"]),
            "-downloadMinecraft".into(),
        ];
        let code = self.run_installer(java, args, idir, ctx)?;
        if code != Some(0) || !launcher.exists() {
            return Err(format!("Fabric server installation failed (exit {})", code_text(code)));
        }
        fs::write(&marker, want.to_string()).map_err(|e| js::fs_error(&e, "open", &marker))?;
        Ok(launcher)
    }

    fn install_neoforge_server(&self, idir: &Path, m: &Value, java: &Value, ctx: &OpCtx) -> Result<Vec<String>, String> {
        let v = js::string(&m["platform"]["loaderVersion"]);
        let args_file = idir.join("libraries").join("net").join("neoforged").join("neoforge").join(&v).join(if cfg!(windows) { "win_args.txt" } else { "unix_args.txt" });
        let marker = idir.join(".modsmith-server.json");
        let want = json!({ "minecraft": m["platform"]["minecraft"], "loader": format!("neoforge-{v}") });
        if !(args_file.exists() && Self::marker_matches(&marker, &want)) {
            let url = format!("https://maven.neoforged.net/releases/net/neoforged/neoforge/{v}/neoforge-{v}-installer.jar");
            let (jar, cached) =
                self.installer_jar(&url, self.downloads().join("neoforge-installer").join(&v).join(format!("neoforge-{v}-installer.jar")), "Could not fetch NeoForge installer checksum", ctx)?;
            ctx.log(&format!("NeoForge installer {v} {} and verified", if cached { "(cached)" } else { "downloaded" }));
            fs::create_dir_all(idir).map_err(|e| js::fs_error(&e, "mkdir", idir))?;
            let code = self.run_installer(java, vec!["-jar".into(), s(&jar), "--install-server".into(), s(idir)], idir, ctx)?;
            if code != Some(0) || !args_file.exists() {
                return Err(format!("NeoForge server installation failed (exit {})", code_text(code)));
            }
            fs::write(&marker, want.to_string()).map_err(|e| js::fs_error(&e, "open", &marker))?;
        }
        let user_args = idir.join("user_jvm_args.txt");
        let mut out = Vec::new();
        if user_args.exists() {
            out.push(format!("@{}", s(&user_args)));
        }
        out.push(format!("@{}", s(&args_file)));
        Ok(out)
    }

    fn project_artifact(&self, dir: &Path, ctx: &OpCtx) -> Option<PathBuf> {
        let libs = dir.join("build").join("libs");
        let skip = Regex::new(r"-(sources|dev|javadoc)\.jar$").expect("artifact regex");
        let mut candidates: Vec<(f64, PathBuf)> = fs::read_dir(&libs)
            .ok()?
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|f| f.ends_with(".jar") && !skip.is_match(f))
            .map(|f| {
                let p = libs.join(&f);
                (fs::metadata(&p).map(|m| js::mtime_ms(&m)).unwrap_or(0.0), p)
            })
            .collect();
        candidates.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        if candidates.len() > 1 {
            ctx.log(&format!("Multiple JARs in build/libs; using newest {}", basename(&candidates[0].1)));
        }
        candidates.into_iter().next().map(|(_, p)| p)
    }

    fn release_extras(&self, dir: &Path, m: &Value, profile: &Value, ctx: &OpCtx, label: (&str, &str)) -> Result<(Vec<Value>, Vec<(String, String)>), String> {
        let mut extra = Vec::new();
        let mut files = Vec::new();
        if m["source"]["kind"] == "gradle" && profile["includeSourceMod"] == true {
            ctx.progress(Some(0.05), Some(label.0));
            let build = self.run_build(dir, false, &[], ctx)?;
            let Some(info) = self.project_artifact(dir, ctx) else {
                return Err(format!("Build produced no mod JAR; artifacts: {}", strings(&build["artifacts"]).join(", ")));
            };
            let meta = read_jar_metadata(&s(&info))?;
            let metas = meta.as_array().cloned().unwrap_or_default();
            let name = basename(&info);
            if metas.is_empty() {
                return Err(format!("{name} has no {}; packaging is broken", if m["platform"]["loader"] == "fabric" { "fabric.mod.json" } else { "META-INF/neoforge.mods.toml" }));
            }
            let mut e = Map::new();
            e.insert("key".into(), json!("source"));
            e.insert("provider".into(), json!("local"));
            e.insert("title".into(), json!(format!("{} (built)", js::string(&m["name"]))));
            e.insert("fileName".into(), json!(name));
            e.insert("sha1".into(), json!(hash_file(&info, "sha1")?));
            e.insert("size".into(), json!(fs::metadata(&info).map(|x| x.len()).unwrap_or(0)));
            e.insert("modIds".into(), json!(all_mod_ids(&metas)));
            e.insert("reason".into(), json!("source mod production JAR"));
            e.insert("required".into(), json!(true));
            extra.push(Value::Object(e));
            files.push((name, s(&info)));
            ctx.log(&format!("{}: {} (mod {} {})", label.1, info.display(), js::string(&metas[0]["id"]), js::string(&metas[0]["version"])));
        }
        if profile["bridge"] == true {
            if let Some((path, e)) = self.bridge_jar(m) {
                files.push((js::string(&e["fileName"]), s(&path)));
                extra.push(e);
            }
        }
        Ok((extra, files))
    }

    fn launch_prod_client(&self, dir: &Path, m: &Value, profile: &Value, idir: &Path, java: &Value, seat: Option<&Seat>, ctx: &OpCtx) -> Result<Value, String> {
        let loader = js::string(&m["platform"]["loader"]);
        if loader != "fabric" && loader != "neoforge" {
            return Err(format!("Release client launch is not implemented for {loader}"));
        }
        let (extra, extra_files) = self.release_extras(dir, m, profile, ctx, ("Building the release JAR", "Release JAR"))?;
        let has_bridge = extra.iter().any(|e| e["provider"] == "bridge");
        ctx.progress(Some(0.3), Some("Resolving the release profile"));
        let mut files = self.resolve_for_launch(dir, profile, "production", Some(vec![]), extra, ctx)?;
        let minecraft = js::string(&m["platform"]["minecraft"]);
        let installer = ClientInstaller { http: self.providers.http(), root: self.cache.join("minecraft") };
        let client = installer.install(&loader, &minecraft, &js::string(&m["platform"]["loaderVersion"]), &js::string(&java["executable"]), ctx)?;
        if let Some(need) = client.version["javaVersion"]["majorVersion"].as_i64() {
            if need > java["major"].as_i64().unwrap_or(0) {
                return Err(format!("Minecraft {minecraft} needs Java {need}; the selected runtime is Java {}", js::string(&java["major"])));
            }
        }
        ctx.progress(Some(0.88), Some("Syncing isolated instance"));
        files.extend(extra_files);
        self.profiles.sync_instance(idir, &files, Some(ctx))?;
        self.profiles.overlay(dir, profile, idir, Some(ctx));
        if loader == "neoforge" {
            self.disable_early_window(dir, profile, idir, ctx);
        }
        let natives = idir.join("natives");
        fs::create_dir_all(&natives).map_err(|e| js::fs_error(&e, "mkdir", &natives))?;
        let player = seat.and_then(|x| x.player.clone()).unwrap_or_else(|| "Player".to_string());
        let spec = build_client_launch(
            &client.version,
            &LaunchPaths { libraries_dir: &client.libraries_dir, client_jar: &client.client_jar, game_dir: idir, assets_dir: &client.assets_dir, natives_dir: &natives, username: &player },
            &current_platform(),
        );
        let pid = js::string(&profile["id"]);
        let arg_file = manifest::state_dir(dir).join("launch").join(format!("{pid}-release-client{}.args", seat_suffix(seat)));
        if let Some(parent) = arg_file.parent() {
            fs::create_dir_all(parent).map_err(|e| js::fs_error(&e, "mkdir", parent))?;
        }
        let mut jvm = Vec::new();
        let mut i = 0;
        while i < spec.jvm_args.len() {
            let a = &spec.jvm_args[i];
            if (a == "-cp" || a == "-classpath") && i + 1 < spec.jvm_args.len() {
                jvm.extend(classpath_args(java, &arg_file, &spec.jvm_args[i + 1])?);
                i += 2;
            } else {
                jvm.push(a.clone());
                i += 1;
            }
        }
        let mut args = vec![format!("-Xmx{}M", js::string(&profile["jvm"]["memoryMb"]))];
        args.extend(strings(&profile["jvm"]["args"]));
        let debug = Self::debug_arg(profile)?;
        if let Some((_, a)) = &debug {
            args.push(a.clone());
        }
        args.extend(jvm);
        args.push(spec.main_class);
        args.extend(spec.game_args);
        if let Some(j) = seat.and_then(|x| x.join.as_ref()) {
            let (host, port) = j.rsplit_once(':').unwrap_or((j.as_str(), "25565"));
            args.extend(join_args(&minecraft, host, port.parse().unwrap_or(25565)));
        }
        args.extend(strings(&profile["programArgs"]));
        ctx.log(&format!(
            "Release client: Minecraft {minecraft}, {loader} {}, offline player \"{player}\" (no account sign-in; online-mode servers will refuse the connection)",
            js::string(&m["platform"]["loaderVersion"])
        ));
        ctx.progress(Some(0.95), Some("Starting Java process"));
        let info = self.instances.launch(LaunchSpec {
            workspace: s(dir),
            profile_id: pid,
            side: "client".into(),
            mode: "production".into(),
            instance_dir: idir.to_path_buf(),
            java: js::string(&java["executable"]),
            args,
            env: vec![],
            bridge: has_bridge,
            debug_port: debug.map(|d| d.0),
            operation_id: Some(ctx.id.clone()),
            seat: seat.map(Seat::json),
        })?;
        ctx.log(&format!("Started release client pid {} in {}", info.get("pid").map(js::string).unwrap_or_else(|| "undefined".into()), idir.display()));
        Ok(info)
    }

    fn launch_prod_server(&self, dir: &Path, m: &Value, profile: &Value, idir: &Path, java: &Value, seat: Option<&Seat>, ctx: &OpCtx) -> Result<Value, String> {
        let (extra, extra_files) = self.release_extras(dir, m, profile, ctx, ("Building distributable JAR", "Production JAR"))?;
        let has_bridge = extra.iter().any(|e| e["provider"] == "bridge");
        ctx.progress(Some(0.4), Some("Resolving production profile"));
        let mut files = self.resolve_for_launch(dir, profile, "production", Some(vec![]), extra, ctx)?;
        let fabric = m["platform"]["loader"] == "fabric";
        ctx.progress(Some(0.6), Some(&format!("Installing {} server", if fabric { "Fabric" } else { "NeoForge" })));
        let server_args = if fabric { vec!["-jar".into(), s(&self.install_fabric_server(idir, m, java, ctx)?)] } else { self.install_neoforge_server(idir, m, java, ctx)? };
        files.extend(extra_files);
        self.profiles.sync_instance(idir, &files, Some(ctx))?;
        self.profiles.overlay(dir, profile, idir, Some(ctx));
        let mut args = vec![format!("-Xmx{}M", js::string(&profile["jvm"]["memoryMb"]))];
        args.extend(strings(&profile["jvm"]["args"]));
        let debug = Self::debug_arg(profile)?;
        if let Some((_, a)) = &debug {
            args.push(a.clone());
        }
        args.extend(server_args);
        args.push("nogui".into());
        args.extend(strings(&profile["programArgs"]));
        let info = self.instances.launch(LaunchSpec {
            workspace: s(dir),
            profile_id: js::string(&profile["id"]),
            side: "server".into(),
            mode: "production".into(),
            instance_dir: idir.to_path_buf(),
            java: js::string(&java["executable"]),
            args,
            env: vec![],
            bridge: has_bridge,
            debug_port: debug.map(|d| d.0),
            operation_id: Some(ctx.id.clone()),
            seat: seat.map(Seat::json),
        })?;
        ctx.log(&format!("Started production server pid {}", info.get("pid").map(js::string).unwrap_or_else(|| "undefined".into())));
        Ok(info)
    }

    pub fn export_server_pack(self: &Arc<Self>, root: &str, profile_id: &str, output: &str, zip: bool) -> Result<Value, String> {
        let dir = workspace::normalize(root);
        let m = manifest::require_manifest(&dir, root)?;
        let profile = find_profile(&m, profile_id).ok_or_else(|| format!("Unknown profile {profile_id}"))?;
        let loader = js::string(&m["platform"]["loader"]);
        if loader != "fabric" && loader != "neoforge" {
            return Err(format!("Server pack export is not implemented for {loader}"));
        }
        if profile["side"] != "server" {
            return Err(format!("Profile {profile_id} is not a server profile"));
        }
        if m["source"]["kind"] == "gradle" {
            workspace::require_trusted(&self.store, &s(&dir))?;
        }
        if output.trim().is_empty() {
            return Err("Choose an output folder for the server pack".into());
        }
        let out = js::absolute(output);
        if out.exists() && fs::read_dir(&out).map(|mut d| d.next().is_some()).unwrap_or(true) {
            return Err(format!("{} is not empty; choose a new or empty folder", out.display()));
        }
        let me = self.clone();
        let title = format!("Export server pack ({})", js::string(&profile["name"]));
        Ok(self.ops.start("server.export_pack", &title, Some(s(&dir)), move |ctx| {
            let result = me.export_server_pack_into(&dir, &m, &profile, &out, zip, ctx);
            if result.is_err() {
                let _ = fs::remove_dir_all(&out);
            }
            result.map(Some)
        }))
    }

    fn export_server_pack_into(&self, dir: &Path, m: &Value, profile: &Value, out: &Path, zip: bool, ctx: &OpCtx) -> Result<Value, String> {
        let java = self.runtime_java(m, profile)?;
        let mut profile = profile.clone();
        profile["bridge"] = json!(false);
        let (extra, extra_files) = self.release_extras(dir, m, &profile, ctx, ("Building the release JAR", "Release JAR"))?;
        ctx.progress(Some(0.3), Some("Resolving the server profile"));
        let mut files = self.resolve_for_launch(dir, &profile, "production", Some(vec![]), extra, ctx)?;
        fs::create_dir_all(out).map_err(|e| js::fs_error(&e, "mkdir", out))?;
        let fabric = m["platform"]["loader"] == "fabric";
        ctx.progress(Some(0.5), Some(&format!("Installing the {} server", if fabric { "Fabric" } else { "NeoForge" })));
        let loader_version = js::string(&m["platform"]["loaderVersion"]);
        if fabric {
            self.install_fabric_server(out, m, &java, ctx)?;
        } else {
            self.install_neoforge_server(out, m, &java, ctx)?;
        }
        ctx.progress(Some(0.8), Some("Copying mods and configs"));
        files.extend(extra_files);
        self.profiles.sync_instance(out, &files, Some(ctx))?;
        self.profiles.overlay(dir, &profile, out, Some(ctx));
        if let Some(world) = profile["world"]["name"].as_str().filter(|w| !w.is_empty()) {
            let saved = out.join("saves").join(world);
            if saved.exists() {
                js::copy_recursive(&saved, &out.join("world"), &|_| false)?;
                let _ = fs::remove_dir_all(out.join("saves"));
            }
        }
        for marker in [out.join(".modsmith-server.json"), out.join("mods").join(".modsmith-managed.json")] {
            let _ = fs::remove_file(marker);
        }
        for entry in fs::read_dir(out).map_err(|e| js::fs_error(&e, "opendir", out))?.flatten() {
            if entry.file_name().to_string_lossy().ends_with("-installer.jar.log") {
                let _ = fs::remove_file(entry.path());
            }
        }
        let memory = js::string(&profile["jvm"]["memoryMb"]);
        let quote = |a: &String| if a.contains(' ') { format!("\"{a}\"") } else { a.clone() };
        let jvm: Vec<String> = strings(&profile["jvm"]["args"]).iter().map(quote).collect();
        let program: Vec<String> = strings(&profile["programArgs"]).iter().map(quote).collect();
        let (unix_cmd, win_cmd) = if fabric {
            let base = [vec![format!("-Xmx{memory}M")], jvm, vec!["-jar".into(), "fabric-server-launch.jar".into(), "nogui".into()], program].concat().join(" ");
            (format!("java {base}"), format!("java {base}"))
        } else {
            let user_args = out.join("user_jvm_args.txt");
            let mut text = fs::read_to_string(&user_args).unwrap_or_default();
            if !text.is_empty() && !text.ends_with('\n') {
                text.push('\n');
            }
            text.push_str(&format!("-Xmx{memory}M\n"));
            for a in &jvm {
                text.push_str(&format!("{a}\n"));
            }
            fs::write(&user_args, text).map_err(|e| js::fs_error(&e, "open", &user_args))?;
            let libs = format!("libraries/net/neoforged/neoforge/{loader_version}");
            let tail = [vec!["nogui".to_string()], program].concat().join(" ");
            (format!("java @user_jvm_args.txt @{libs}/unix_args.txt {tail}"), format!("java @user_jvm_args.txt @{}\\win_args.txt {tail}", libs.replace('/', "\\")))
        };
        let start_sh = out.join("start.sh");
        fs::write(&start_sh, format!("#!/usr/bin/env sh\ncd \"$(dirname \"$0\")\"\nexec {unix_cmd} \"$@\"\n")).map_err(|e| js::fs_error(&e, "open", &start_sh))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&start_sh, fs::Permissions::from_mode(0o755));
        }
        let start_bat = out.join("start.bat");
        fs::write(&start_bat, format!("@echo off\r\ncd /d \"%~dp0\"\r\n{win_cmd} %*\r\npause\r\n")).map_err(|e| js::fs_error(&e, "open", &start_bat))?;
        let cat = self.catalog_entry(m);
        let java_min = profile["java"]["minMajor"].as_i64().or_else(|| cat.as_ref().and_then(|c| c["runtimeJavaMin"].as_i64())).unwrap_or(21);
        let mut mods: Vec<String> = files.iter().map(|(n, _)| n.clone()).collect();
        mods.sort_by(|a, b| js::locale_compare(a, b));
        mods.dedup();
        let minecraft = js::string(&m["platform"]["minecraft"]);
        let loader_name = if fabric { "Fabric Loader" } else { "NeoForge" };
        let readme = format!(
            "{name} server\n\nMinecraft {minecraft}, {loader_name} {loader_version}\nJava {java_min} or newer\nMemory: {memory} MB (change -Xmx in {mem_file})\n\nStart\n  Linux and macOS: ./start.sh\n  Windows: start.bat\n\nThe first start stops after creating eula.txt. Read https://aka.ms/MinecraftEULA, set eula=true in eula.txt if you agree, and start again.\n\nMods ({count})\n{list}\n\nExported by Modsmith on {date}.\n",
            name = js::string(&m["name"]),
            mem_file = if fabric { "start.sh and start.bat" } else { "user_jvm_args.txt" },
            count = mods.len(),
            list = mods.iter().map(|n| format!("  {n}")).collect::<Vec<_>>().join("\n"),
            date = js::iso_now(),
        );
        fs::write(out.join("README.txt"), readme).map_err(|e| js::fs_error(&e, "open", &out.join("README.txt")))?;
        ctx.log(&format!("Server pack written to {} ({} mods)", out.display(), mods.len()));
        let zip_file = if zip {
            ctx.progress(Some(0.92), Some("Writing the zip"));
            let file = PathBuf::from(format!("{}.zip", out.display()));
            zip_dir(out, &file)?;
            ctx.log(&format!("Zipped to {}", file.display()));
            Value::String(s(&file))
        } else {
            Value::Null
        };
        Ok(json!({ "output": s(out), "zip": zip_file, "mods": mods, "minecraft": minecraft, "loader": m["platform"]["loader"], "loaderVersion": loader_version, "javaMin": java_min }))
    }

    pub fn stop_instance(&self, id: &str, force: bool) -> Result<Value, String> {
        let info = self.instance_or_err(id)?;
        let connected = info["bridge"]["connected"] == true;
        let graceful = || -> Result<bool, String> {
            if !connected {
                return Ok(false);
            }
            self.bridge.call(id, "game.shutdown", json!({}), 5000)?;
            Ok(true)
        };
        self.instances.stop(id, force, 30000, Some(&graceful))
    }

    pub fn stop_all(&self) {
        let ids = self.instances.running_ids();
        std::thread::scope(|scope| {
            for id in &ids {
                scope.spawn(move || {
                    let _ = self.instances.stop(id, false, 15000, None);
                });
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seat_identity_and_join_args() {
        assert_eq!(identity_args("Player"), vec!["--username", "Player", "--uuid", "a01e3843e5213998958af459800e4d11", "--accessToken", "0"]);
        assert_eq!(join_args("1.21.1", "127.0.0.1", 25566), vec!["--quickPlayMultiplayer", "127.0.0.1:25566"]);
        assert_eq!(join_args("1.20", "127.0.0.1", 25565), vec!["--quickPlayMultiplayer", "127.0.0.1:25565"]);
        assert_eq!(join_args("1.19.4", "127.0.0.1", 25565), vec!["--server", "127.0.0.1", "--port", "25565"]);
        let seat = Seat { session: "s".into(), slot: 2, player: Some("Alex".into()), join: Some("127.0.0.1:25570".into()) };
        assert_eq!(seat.suffix(), "-2");
        let args = seat_args(&json!({ "platform": { "minecraft": "1.21.1" } }), Some(&seat));
        assert_eq!(&args[..2], ["--username", "Alex"]);
        assert_eq!(&args[6..], ["--quickPlayMultiplayer", "127.0.0.1:25570"]);
    }

    #[test]
    fn early_window_toml() {
        assert_eq!(disable_early_window_toml(""), "earlyWindowControl = false\n");
        assert_eq!(disable_early_window_toml("a = 1\n"), "a = 1\nearlyWindowControl = false\n");
        assert_eq!(disable_early_window_toml("a = 1\r\nearlyWindowControl = true\r\n"), "a = 1\r\nearlyWindowControl = false\r\n");
    }

    #[test]
    fn arg_file_quoting() {
        assert_eq!(quote_arg_file(r"C:\a b\c.jar"), r#""C:\\a b\\c.jar""#);
    }
}
