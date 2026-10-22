use serde_json::Value;
use std::path::{Component, Path, PathBuf};
use tauri::http::{Request, Response};

pub const SCHEME: &str = "modsmithext";
const FRAME: &str = "__frame__.html";
const SDK: &str = include_str!("extension_sdk.js");
const BASE_CSS: &str = "*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:var(--text,13px);line-height:1.45}
#root{height:100%;overflow:auto}
button{font:inherit;color:var(--fg);background:var(--raised);border:1px solid var(--line-2);border-radius:var(--radius,5px);padding:4px 10px;cursor:pointer}
button:hover{background:var(--hover)}
button.primary{background:var(--accent-strong);border-color:var(--accent-border);color:var(--accent-fg)}
button:disabled{opacity:.5;cursor:default}
input,select,textarea{font:inherit;color:var(--fg);background:var(--input);border:1px solid var(--line-2);border-radius:var(--radius,5px);padding:4px 8px}
code,pre,kbd{font-family:var(--mono);font-size:var(--text-mono,12.5px)}
a{color:var(--accent)}
::selection{background:var(--selection);color:var(--selection-fg)}";

fn valid_id(id: &str) -> bool {
    let Some((publisher, name)) = id.split_once('.') else { return false };
    let part = |s: &str, max: usize| !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && !s.starts_with('-');
    part(publisher, 39) && part(name, 64)
}

fn decode(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    let mut out = root.to_path_buf();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(p) => out.push(p),
            _ => return None,
        }
    }
    Some(out)
}

fn content_type(file: &str) -> &'static str {
    match file.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn script_safe(code: &str) -> String {
    code.replace("</script", "<\\/script").replace("</SCRIPT", "<\\/SCRIPT")
}

fn respond(status: u16, ctype: &str, csp: Option<&str>, body: Vec<u8>) -> Response<Vec<u8>> {
    let mut b = Response::builder().status(status).header("Content-Type", ctype).header("X-Content-Type-Options", "nosniff").header("Cache-Control", "no-store");
    if let Some(csp) = csp {
        b = b.header("Content-Security-Policy", csp);
    }
    b.body(body).unwrap_or_else(|_| Response::new(Vec::new()))
}

fn not_found() -> Response<Vec<u8>> {
    respond(404, "text/plain; charset=utf-8", None, b"Not found".to_vec())
}

fn frame(dir: &Path, install: &Value) -> Response<Vec<u8>> {
    let files = dir.join("files");
    let read = |key: &str| -> Option<String> {
        let rel = install["manifest"][key].as_str()?;
        std::fs::read_to_string(safe_join(&files, rel)?).ok()
    };
    let main = read("main").unwrap_or_default();
    let style = read("style").map(|s| s.replace("</style", "<\\/style")).unwrap_or_default();
    let network = install["manifest"]["permissions"].as_array().is_some_and(|p| p.iter().any(|x| x == "network"));
    let own = "http://modsmithext.localhost https://modsmithext.localhost modsmithext:";
    let csp = format!(
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src {own} data: blob:; font-src {own} data:; media-src {own} data: blob:; connect-src {}; frame-ancestors http://tauri.localhost https://tauri.localhost tauri://localhost",
        if network { "https:" } else { "'none'" }
    );
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><style>{BASE_CSS}</style><style>{style}</style></head><body><div id=\"root\"></div><script>{}</script><script>{}</script></body></html>",
        script_safe(SDK),
        script_safe(&main)
    );
    respond(200, "text/html; charset=utf-8", Some(&csp), html.into_bytes())
}

pub fn handle(data_dir: &Path, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(path) = decode(req.uri().path()) else { return not_found() };
    let path = path.trim_start_matches('/');
    let Some((id, rest)) = path.split_once('/') else { return not_found() };
    if !valid_id(id) || rest.is_empty() {
        return not_found();
    }
    let dir = data_dir.join("extensions").join(id);
    let Some(install) = std::fs::read_to_string(dir.join("install.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
        return not_found();
    };
    if install["id"].as_str() != Some(id) || install["enabled"] == false {
        return not_found();
    }
    if rest == FRAME {
        return frame(&dir, &install);
    }
    let Some(file) = safe_join(&dir.join("files"), rest) else { return not_found() };
    match std::fs::read(&file) {
        Ok(bytes) if file.is_file() => respond(200, content_type(rest), Some("default-src 'none'; style-src 'unsafe-inline'"), bytes),
        _ => not_found(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_paths() {
        let root = Path::new("/data");
        assert!(safe_join(root, "a/b.png").is_some());
        assert!(safe_join(root, "../x").is_none());
        assert!(safe_join(root, "/etc/passwd").is_none());
        assert!(valid_id("galaxy.nbt-viewer"));
        assert!(!valid_id("Galaxy.x"));
        assert!(!valid_id("..x"));
        assert_eq!(decode("/a%2Fb").as_deref(), Some("/a/b"));
    }
}
