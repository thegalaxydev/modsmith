use crate::store::Store;
use serde_json::Value;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

pub const USER_AGENT: &str = "modsmith/0.1.8 (local development workbench)";
const FETCH_FAILED: &str = "fetch failed";

pub struct Cached {
    pub data: Value,
    pub fetched_at: i64,
    pub stale: bool,
    pub error: Option<String>,
}

pub struct Response {
    pub status: u16,
    pub body: String,
    retry_after: f64,
}

impl Response {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

pub struct Http {
    store: Arc<Store>,
}

fn client() -> &'static reqwest::blocking::Client {
    static C: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    C.get_or_init(|| reqwest::blocking::Client::builder().connect_timeout(Duration::from_secs(30)).build().expect("HTTP client"))
}

pub fn js_slice(text: &str, max: usize) -> String {
    crate::activity::js_slice(text, max)
}

pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        let c = *b as char;
        if c.is_ascii_alphanumeric() || "-_.!~*'()".contains(c) {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn query(pairs: &[(&str, String)]) -> String {
    let mut s = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in pairs {
        s.append_pair(k, v);
    }
    s.finish()
}

fn now() -> i64 {
    crate::support::now_ms() as i64
}

pub fn request(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&str>) -> Result<Response, String> {
    let url = url.strip_suffix('?').unwrap_or(url);
    let mut req = match method {
        "POST" => client().post(url),
        _ => client().get(url),
    };
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    if let Some(b) = body {
        req = req.body(b.to_string());
    }
    let res = req.send().map_err(|_| FETCH_FAILED.to_string())?;
    let status = res.status().as_u16();
    let retry_after = res.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<f64>().ok()).filter(|v| v.is_finite()).unwrap_or(0.0);
    let body = res.text().map_err(|_| FETCH_FAILED.to_string())?;
    Ok(Response { status, body, retry_after })
}

pub fn fetch_with_retry(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&str>) -> Result<Response, String> {
    let mut last = String::new();
    for attempt in 0..=3u32 {
        let backoff = 500.0 * 2f64.powi(attempt as i32);
        match request(method, url, headers, body) {
            Ok(res) if res.status == 429 || res.status >= 500 => {
                last = format!("HTTP {}", res.status);
                std::thread::sleep(Duration::from_millis((res.retry_after * 1000.0).max(backoff) as u64));
            }
            Ok(res) => return Ok(res),
            Err(e) => {
                last = e;
                std::thread::sleep(Duration::from_millis(backoff as u64));
            }
        }
    }
    Err(last)
}

impl Http {
    pub fn new(store: Arc<Store>) -> Http {
        Http { store }
    }

    pub fn get_json(&self, url: &str, max_age_ms: i64, extra: &[(&str, &str)]) -> Result<Cached, String> {
        let cached = self.store.get_http_cache(url).ok().flatten();
        if let Some((fetched_at, body)) = &cached {
            if now() - fetched_at < max_age_ms {
                return Ok(Cached { data: serde_json::from_str(body).map_err(|e| e.to_string())?, fetched_at: *fetched_at, stale: false, error: None });
            }
        }
        let mut headers: Vec<(&str, &str)> = vec![("User-Agent", USER_AGENT), ("Accept", "application/json")];
        headers.extend_from_slice(extra);
        let attempt = fetch_with_retry("GET", url, &headers, None).and_then(|res| {
            if !res.ok() {
                return Err(format!("HTTP {} for {url}: {}", res.status, js_slice(&res.body, 200)));
            }
            let data: Value = serde_json::from_str(&res.body).map_err(|e| e.to_string())?;
            let _ = self.store.set_http_cache(url, &res.body);
            Ok(data)
        });
        match attempt {
            Ok(data) => Ok(Cached { data, fetched_at: now(), stale: false, error: None }),
            Err(e) => match cached {
                Some((fetched_at, body)) => Ok(Cached { data: serde_json::from_str(&body).map_err(|e| e.to_string())?, fetched_at, stale: true, error: Some(e) }),
                None => Err(e),
            },
        }
    }
}

pub fn hash_file(path: &std::path::Path, algo: &str) -> Result<String, String> {
    use sha1::Digest;
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| crate::js::fs_error(&e, "open", path))?;
    let mut buf = vec![0u8; 1 << 16];
    match algo {
        "sha1" => {
            let mut h = sha1::Sha1::new();
            loop {
                let n = f.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                h.update(&buf[..n]);
            }
            Ok(hex::encode(h.finalize()))
        }
        "sha256" => {
            let mut h = sha2::Sha256::new();
            loop {
                let n = f.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                h.update(&buf[..n]);
            }
            Ok(hex::encode(h.finalize()))
        }
        _ => {
            let mut h = sha2::Sha512::new();
            loop {
                let n = f.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                h.update(&buf[..n]);
            }
            Ok(hex::encode(h.finalize()))
        }
    }
}

pub struct Expected<'a> {
    pub sha1: Option<&'a str>,
    pub sha256: Option<&'a str>,
    pub sha512: Option<&'a str>,
    pub size: Option<u64>,
}

pub fn verify_file(file: &std::path::Path, e: &Expected) -> Result<Option<String>, String> {
    if !file.exists() {
        return Ok(Some("missing".into()));
    }
    let len = std::fs::metadata(file).map(|m| m.len()).unwrap_or(0);
    if let Some(size) = e.size {
        if len != size {
            return Ok(Some(format!("size mismatch (expected {size}, got {len})")));
        }
    }
    if let Some(sha512) = e.sha512.filter(|s| !s.is_empty()) {
        if hash_file(file, "sha512")?.to_lowercase() != sha512.to_lowercase() {
            return Ok(Some("sha512 mismatch".into()));
        }
    } else if let Some(sha256) = e.sha256.filter(|s| !s.is_empty()) {
        if hash_file(file, "sha256")?.to_lowercase() != sha256.to_lowercase() {
            return Ok(Some("sha256 mismatch".into()));
        }
    } else if let Some(sha1) = e.sha1.filter(|s| !s.is_empty()) {
        if hash_file(file, "sha1")?.to_lowercase() != sha1.to_lowercase() {
            return Ok(Some("sha1 mismatch".into()));
        }
    }
    Ok(None)
}

pub fn stream_to(url: &str, tmp: &std::path::Path, cancelled: &dyn Fn() -> bool, progress: &dyn Fn(u64, Option<u64>)) -> Result<(), String> {
    use std::io::{Read, Write};
    let mut last = String::new();
    for attempt in 0..=3u32 {
        if cancelled() {
            return Err(crate::ops::CANCELLED.into());
        }
        let backoff = 500.0 * 2f64.powi(attempt as i32);
        match client().get(url.strip_suffix('?').unwrap_or(url)).header("User-Agent", USER_AGENT).send() {
            Ok(res) if res.status().as_u16() == 429 || res.status().as_u16() >= 500 => {
                let ra = res.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<f64>().ok()).filter(|v| v.is_finite()).unwrap_or(0.0);
                last = format!("HTTP {}", res.status().as_u16());
                std::thread::sleep(Duration::from_millis((ra * 1000.0).max(backoff) as u64));
            }
            Ok(mut res) => {
                if !res.status().is_success() {
                    return Err(format!("HTTP {} downloading {url}", res.status().as_u16()));
                }
                let total = res.content_length().filter(|n| *n > 0);
                let mut out = std::fs::File::create(tmp).map_err(|e| crate::js::fs_error(&e, "open", tmp))?;
                let mut buf = vec![0u8; 1 << 16];
                let mut received = 0u64;
                loop {
                    if cancelled() {
                        return Err(crate::ops::CANCELLED.into());
                    }
                    let n = res.read(&mut buf).map_err(|_| "terminated".to_string())?;
                    if n == 0 {
                        break;
                    }
                    out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                    received += n as u64;
                    progress(received, total);
                }
                return Ok(());
            }
            Err(_) => {
                last = FETCH_FAILED.into();
                std::thread::sleep(Duration::from_millis(backoff as u64));
            }
        }
    }
    Err(last)
}

pub fn download_verified(url: &str, dest: &std::path::Path, e: &Expected, cancelled: &dyn Fn() -> bool, progress: &dyn Fn(u64, Option<u64>)) -> Result<(std::path::PathBuf, bool), String> {
    if e.sha1.is_none_or(str::is_empty) && e.sha256.is_none_or(str::is_empty) && e.sha512.is_none_or(str::is_empty) {
        return Err(format!("Refusing to download without a published hash: {url}"));
    }
    if dest.exists() {
        if verify_file(dest, e)?.is_none() {
            return Ok((dest.to_path_buf(), true));
        }
        let _ = std::fs::remove_file(dest);
    }
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|err| crate::js::fs_error(&err, "mkdir", dir))?;
    }
    let mut rnd = [0u8; 4];
    getrandom::fill(&mut rnd).map_err(|err| err.to_string())?;
    let tmp = std::path::PathBuf::from(format!("{}.{}.{}.part", dest.display(), std::process::id(), hex::encode(rnd)));
    let mut last = String::new();
    for _ in 0..3 {
        let attempt = stream_to(url, &tmp, cancelled, progress).and_then(|_| match verify_file(&tmp, e)? {
            Some(reason) => Err(format!("Hash verification failed for {url}: {reason}")),
            None => std::fs::rename(&tmp, dest).map_err(|err| crate::js::fs_error(&err, "rename", &tmp)),
        });
        match attempt {
            Ok(()) => return Ok((dest.to_path_buf(), false)),
            Err(err) => {
                let _ = std::fs::remove_file(&tmp);
                if cancelled() || err == crate::ops::CANCELLED {
                    return Err(crate::ops::CANCELLED.into());
                }
                last = err;
            }
        }
    }
    Err(last)
}
