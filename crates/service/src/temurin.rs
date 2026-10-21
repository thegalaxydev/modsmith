use crate::http::{download_verified, fetch_with_retry, js_slice, query, Expected, USER_AGENT};
use crate::js;
use crate::manifest;
use crate::ops::OpCtx;
use crate::rt::{s, Runtime};
use crate::workspace;
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub fn adoptium_api() -> String {
    std::env::var("MODSMITH_ADOPTIUM_API").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "https://api.adoptium.net/v3".to_string())
}

pub fn platform() -> (&'static str, &'static str) {
    let os = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else {
        "linux"
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "aarch64",
        "x86" => "x32",
        "arm" => "arm",
        "powerpc64" => "ppc64le",
        other => other,
    };
    (os, arch)
}

pub fn jdks_dir(data: &Path) -> PathBuf {
    data.join("jdks")
}

fn mb(n: u64) -> u64 {
    n / 1048576
}

fn safe_rel(name: &str) -> Result<Option<PathBuf>, String> {
    let mut out = PathBuf::new();
    for part in name.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains(':') {
            return Err(format!("Refusing to unpack unsafe archive entry {name}"));
        }
        out.push(part);
    }
    Ok(if out.as_os_str().is_empty() { None } else { Some(out) })
}

fn mkdirs(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| js::fs_error(&e, "mkdir", dir))
}

#[cfg(unix)]
fn set_mode(file: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(file, fs::Permissions::from_mode(mode & 0o777));
}

#[cfg(not(unix))]
fn set_mode(_file: &Path, _mode: u32) {}

#[cfg(unix)]
fn symlink(link: &str, target: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(link, target).map_err(|e| js::fs_error(&e, "symlink", target))
}

#[cfg(not(unix))]
fn symlink(_link: &str, _target: &Path) -> Result<(), String> {
    Ok(())
}

fn unzip(archive: &Path, out: &Path) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| js::fs_error(&e, "open", archive))?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().map_err(|e| e.to_string())?.to_string();
        let Some(rel) = safe_rel(&name)? else { continue };
        let target = out.join(rel);
        if entry.is_dir() {
            mkdirs(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            mkdirs(parent)?;
        }
        let mut f = fs::File::create(&target).map_err(|e| js::fs_error(&e, "open", &target))?;
        std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
        if let Some(mode) = entry.unix_mode() {
            set_mode(&target, mode);
        }
    }
    Ok(())
}

fn cstr(b: &[u8]) -> String {
    let end = b.iter().position(|c| *c == 0).unwrap_or(b.len());
    String::from_utf8_lossy(&b[..end]).to_string()
}

fn octal(b: &[u8]) -> u64 {
    let t = cstr(b);
    u64::from_str_radix(t.trim().trim_end_matches('\0'), 8).unwrap_or(0)
}

fn pax(data: &[u8]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = data;
    while !rest.is_empty() {
        let Some(sp) = rest.iter().position(|c| *c == b' ') else { break };
        let Ok(len) = String::from_utf8_lossy(&rest[..sp]).parse::<usize>() else { break };
        if len == 0 || len > rest.len() || len <= sp + 1 {
            break;
        }
        let record = String::from_utf8_lossy(&rest[sp + 1..len - 1]).to_string();
        if let Some((k, v)) = record.split_once('=') {
            out.push((k.to_string(), v.to_string()));
        }
        rest = &rest[len..];
    }
    out
}

fn untar(archive: &Path, out: &Path) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| js::fs_error(&e, "open", archive))?;
    let mut r = flate2::read::GzDecoder::new(std::io::BufReader::new(file));
    let mut long_name: Option<String> = None;
    let mut long_link: Option<String> = None;
    let mut links: Vec<(PathBuf, PathBuf)> = Vec::new();
    loop {
        let mut h = [0u8; 512];
        if r.read_exact(&mut h).is_err() || h.iter().all(|b| *b == 0) {
            break;
        }
        let size = octal(&h[124..136]);
        let padded = size.div_ceil(512) * 512;
        let kind = h[156];
        let read_all = |r: &mut dyn Read| -> Result<Vec<u8>, String> {
            let mut buf = vec![0u8; padded as usize];
            r.read_exact(&mut buf).map_err(|_| "Truncated archive".to_string())?;
            buf.truncate(size as usize);
            Ok(buf)
        };
        match kind {
            b'L' => {
                long_name = Some(cstr(&read_all(&mut r)?));
                continue;
            }
            b'K' => {
                long_link = Some(cstr(&read_all(&mut r)?));
                continue;
            }
            b'x' => {
                for (k, v) in pax(&read_all(&mut r)?) {
                    match k.as_str() {
                        "path" => long_name = Some(v),
                        "linkpath" => long_link = Some(v),
                        _ => {}
                    }
                }
                continue;
            }
            b'g' => {
                read_all(&mut r)?;
                continue;
            }
            _ => {}
        }
        let mut name = cstr(&h[0..100]);
        if &h[257..262] == b"ustar" {
            let prefix = cstr(&h[345..500]);
            if !prefix.is_empty() {
                name = format!("{prefix}/{name}");
            }
        }
        let name = long_name.take().unwrap_or(name);
        let link = long_link.take().unwrap_or_else(|| cstr(&h[157..257]));
        let mode = octal(&h[100..108]) as u32;
        let rel = safe_rel(&name)?;
        let target = rel.as_ref().map(|p| out.join(p));
        match (kind, target) {
            (b'5', Some(t)) => {
                mkdirs(&t)?;
                std::io::copy(&mut (&mut r).take(padded), &mut std::io::sink()).map_err(|e| e.to_string())?;
            }
            (b'0' | 0 | b'7', Some(t)) => {
                if let Some(parent) = t.parent() {
                    mkdirs(parent)?;
                }
                let mut f = fs::File::create(&t).map_err(|e| js::fs_error(&e, "open", &t))?;
                let copied = std::io::copy(&mut (&mut r).take(size), &mut f).map_err(|e| e.to_string())?;
                if copied != size {
                    return Err("Truncated archive".into());
                }
                f.flush().map_err(|e| e.to_string())?;
                std::io::copy(&mut (&mut r).take(padded - size), &mut std::io::sink()).map_err(|e| e.to_string())?;
                set_mode(&t, mode);
            }
            (b'2', Some(t)) => {
                std::io::copy(&mut (&mut r).take(padded), &mut std::io::sink()).map_err(|e| e.to_string())?;
                let base = rel.as_ref().and_then(|p| p.parent()).map(Path::to_path_buf).unwrap_or_default();
                let mut depth: i64 = base.components().count() as i64;
                if link.starts_with('/') {
                    return Err(format!("Refusing to unpack unsafe archive entry {name}"));
                }
                for part in link.split('/') {
                    match part {
                        "" | "." => {}
                        ".." => depth -= 1,
                        _ => depth += 1,
                    }
                    if depth < 0 {
                        return Err(format!("Refusing to unpack unsafe archive entry {name}"));
                    }
                }
                if let Some(parent) = t.parent() {
                    mkdirs(parent)?;
                }
                symlink(&link, &t)?;
            }
            (b'1', Some(t)) => {
                std::io::copy(&mut (&mut r).take(padded), &mut std::io::sink()).map_err(|e| e.to_string())?;
                if let Some(src) = safe_rel(&link)? {
                    links.push((out.join(src), t));
                }
            }
            _ => {
                std::io::copy(&mut (&mut r).take(padded), &mut std::io::sink()).map_err(|e| e.to_string())?;
            }
        }
    }
    for (src, t) in links {
        if let Some(parent) = t.parent() {
            mkdirs(parent)?;
        }
        fs::copy(&src, &t).map_err(|e| js::fs_error(&e, "copyfile", &src))?;
    }
    Ok(())
}

pub fn unpack(archive: &Path, out: &Path) -> Result<(), String> {
    let name = archive.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if name.ends_with(".zip") {
        unzip(archive, out)
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        untar(archive, out)
    } else {
        Err(format!("Unsupported archive {name}"))
    }
}

fn same_path(a: &str, b: &Path) -> bool {
    js::absolute(a).to_string_lossy().to_lowercase() == js::absolute(&s(b)).to_string_lossy().to_lowercase()
}

fn rand_hex() -> String {
    let mut b = [0u8; 4];
    let _ = getrandom::fill(&mut b);
    hex::encode(b)
}

impl Runtime {
    pub fn java_install(self: &Arc<Self>, major: i64, image: &str) -> Value {
        let me = self.clone();
        let image = if image == "jre" { "jre" } else { "jdk" }.to_string();
        let title = format!("Download Java {major} ({})", image.to_uppercase());
        self.ops.start("java.install", &title, None, move |ctx| me.install_steps(major, &image, ctx).map(Some))
    }

    fn install_steps(&self, major: i64, image: &str, ctx: &OpCtx) -> Result<Value, String> {
        let api = adoptium_api();
        let (os, arch) = platform();
        let unavailable = || format!("Eclipse Temurin {major} ({image}) is not available for {os} {arch}");
        ctx.progress(Some(0.0), Some(&format!("Looking up Eclipse Temurin {major}")));
        let url = format!(
            "{api}/assets/latest/{major}/hotspot?{}",
            query(&[("architecture", arch.to_string()), ("image_type", image.to_string()), ("os", os.to_string()), ("vendor", "eclipse".to_string())])
        );
        let res = fetch_with_retry("GET", &url, &[("User-Agent", USER_AGENT), ("Accept", "application/json")], None)?;
        if res.status == 404 {
            return Err(unavailable());
        }
        if !res.ok() {
            return Err(format!("HTTP {} for {url}: {}", res.status, js_slice(&res.body, 200)));
        }
        let data: Value = serde_json::from_str(&res.body).map_err(|_| format!("Unexpected response from {url}"))?;
        let asset = data.as_array().and_then(|a| a.iter().find(|x| x["binary"]["package"]["checksum"].is_string() && x["binary"]["package"]["name"].is_string())).ok_or_else(unavailable)?;
        let pkg = &asset["binary"]["package"];
        let name = js::string(&pkg["name"]);
        if name.contains(['/', '\\']) || name.starts_with('.') {
            return Err(format!("Unexpected package name {name}"));
        }
        let checksum = js::string(&pkg["checksum"]);
        let size = pkg["size"].as_u64();
        let release = asset["release_name"].as_str().map(str::to_string).unwrap_or_else(|| name.clone());
        ctx.log(&format!("Eclipse Temurin {release} ({image}, {os} {arch}): {name}"));
        let bin = format!("{api}/binary/latest/{major}/ga/{os}/{arch}/{image}/hotspot/normal/eclipse");
        let archive = self.downloads().join("temurin").join(&name);
        let cancelled = || ctx.cancelled();
        let progress = |received: u64, total: Option<u64>| {
            let total = total.or(size).unwrap_or(0);
            let fraction = if total > 0 { 0.02 + 0.83 * (received as f64 / total as f64).min(1.0) } else { 0.02 };
            ctx.progress(Some(fraction), Some(&format!("Downloading {name} ({} of {} MB)", mb(received), mb(total))));
        };
        let (archive, cached) = download_verified(&bin, &archive, &Expected { sha1: None, sha256: Some(&checksum), sha512: None, size }, &cancelled, &progress)?;
        ctx.log(if cached { "Using the verified download from the cache" } else { "Downloaded and verified the SHA-256 checksum" });
        ctx.check()?;
        ctx.progress(Some(0.88), Some(&format!("Unpacking {name}")));
        let root = jdks_dir(&self.data);
        mkdirs(&root)?;
        let tmp = root.join(format!(".tmp-{}-{}", std::process::id(), rand_hex()));
        let placed = (|| -> Result<PathBuf, String> {
            unpack(&archive, &tmp)?;
            let tops: Vec<PathBuf> = fs::read_dir(&tmp).map_err(|e| js::fs_error(&e, "scandir", &tmp))?.flatten().map(|e| e.path()).collect();
            let top = match tops.as_slice() {
                [only] if only.is_dir() => only.clone(),
                _ => return Err(format!("Unexpected archive layout in {name}")),
            };
            let target = root.join(top.file_name().unwrap_or_default());
            if target.exists() {
                fs::remove_dir_all(&target).map_err(|e| js::fs_error(&e, "rm", &target))?;
            }
            fs::rename(&top, &target).map_err(|e| js::fs_error(&e, "rename", &top))?;
            Ok(target)
        })();
        let _ = fs::remove_dir_all(&tmp);
        let target = placed?;
        let _ = fs::remove_file(&archive);
        ctx.progress(Some(0.96), Some("Detecting Java"));
        let mac_home = target.join("Contents").join("Home");
        let home = if mac_home.is_dir() { mac_home } else { target.clone() };
        let found = self.java.list(true).into_iter().find(|j| same_path(j["home"].as_str().unwrap_or(""), &home));
        let found = found.ok_or_else(|| format!("Eclipse Temurin {release} was unpacked to {} but its Java runtime did not start", s(&home)))?;
        ctx.log(&format!("Installed Eclipse Temurin {} at {}", js::string(&found["version"]), s(&home)));
        Ok(found)
    }

    pub fn java_requirements(&self, p: &Value) -> Result<Value, String> {
        let mut reqs: Vec<(&str, i64, bool, Option<String>)> = Vec::new();
        let str_of = |k: &str| p[k].as_str().filter(|v| !v.is_empty()).map(str::to_string);
        if let Some(id) = str_of("catalogEntryId") {
            let e = self.catalog.get(&id).ok_or_else(|| format!("Unknown catalog entry {id}"))?;
            reqs.push(("gradle", e["gradleJavaMin"].as_i64().unwrap_or(21), true, None));
        } else if let Some(path) = str_of("path") {
            let dir = workspace::normalize(&path);
            let m = manifest::require_manifest(&dir, &path)?;
            let cat = self.catalog_entry(&m);
            let gradle = cat.as_ref().and_then(|c| c["gradleJavaMin"].as_i64()).unwrap_or(21);
            match str_of("profile") {
                None => reqs.push(("gradle", gradle, true, None)),
                Some(pid) => {
                    let profile = m["profiles"].as_array().and_then(|a| a.iter().find(|x| x["id"] == json!(pid))).cloned().ok_or_else(|| format!("Unknown profile {pid}"))?;
                    let mode = str_of("mode").unwrap_or_else(|| js::string(&profile["mode"]));
                    if m["source"]["kind"] == "gradle" || mode == "development" {
                        reqs.push(("gradle", gradle, true, None));
                    }
                    let min = profile["java"]["minMajor"].as_i64().or_else(|| cat.as_ref().and_then(|c| c["runtimeJavaMin"].as_i64())).unwrap_or(21);
                    reqs.push(("runtime", min, false, profile["java"]["home"].as_str().filter(|h| !h.is_empty()).map(str::to_string)));
                }
            }
        } else {
            return Err("Give a catalogEntryId or a workspace path".into());
        }
        let mut requirements = Vec::new();
        let mut install: Vec<(i64, bool)> = Vec::new();
        for (purpose, major, jdk, prefer) in reqs {
            let found = self.java.select(major, None, jdk, prefer.as_deref());
            if found.is_none() {
                match install.iter_mut().find(|(m, _)| *m == major) {
                    Some(entry) => entry.1 |= jdk,
                    None => install.push((major, jdk)),
                }
            }
            requirements.push(json!({ "purpose": purpose, "major": major, "jdk": jdk, "java": found }));
        }
        let install: Vec<Value> = install.into_iter().map(|(major, jdk)| json!({ "major": major, "imageType": if jdk { "jdk" } else { "jre" } })).collect();
        Ok(json!({ "requirements": requirements, "install": install }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_entries() {
        assert_eq!(safe_rel("jdk/bin/java").unwrap(), Some(PathBuf::from("jdk").join("bin").join("java")));
        assert_eq!(safe_rel("./").unwrap(), None);
        assert!(safe_rel("jdk/../../evil").is_err());
        assert!(safe_rel("C:/evil").is_err());
    }

    #[test]
    fn reads_pax_records() {
        assert_eq!(pax(b"20 path=a/long/name\n11 size=10\n"), vec![("path".to_string(), "a/long/name".to_string()), ("size".to_string(), "10".to_string())]);
    }

    #[test]
    fn maps_the_platform() {
        let (os, arch) = platform();
        assert!(["windows", "mac", "linux"].contains(&os));
        assert!(!arch.is_empty());
    }
}
