use crate::http::Http;
use serde_json::{json, Value};

pub const REPOSITORY: &str = "thegalaxydev/modsmith";

fn github_api() -> String {
    std::env::var("MODSMITH_GITHUB_API").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "https://api.github.com".to_string())
}

fn parts(v: &str) -> Vec<u64> {
    v.trim().trim_start_matches(['v', 'V']).split(['-', '+']).next().unwrap_or("").split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect()
}

pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let (pa, pb) = (parts(a), parts(b));
    for i in 0..pa.len().max(pb.len()) {
        let c = pa.get(i).copied().unwrap_or(0).cmp(&pb.get(i).copied().unwrap_or(0));
        if c != std::cmp::Ordering::Equal {
            return c;
        }
    }
    std::cmp::Ordering::Equal
}

fn releases_page() -> String {
    format!("https://github.com/{REPOSITORY}/releases")
}

pub fn check(http: &Http, force: bool) -> Value {
    let current = env!("CARGO_PKG_VERSION");
    let url = format!("{}/repos/{REPOSITORY}/releases/latest", github_api());
    let max_age = if force { 0 } else { 6 * 3600 * 1000 };
    let empty = |error: Option<String>| {
        json!({ "current": current, "latest": null, "available": false, "name": null, "url": releases_page(), "publishedAt": null, "notes": "", "assets": [], "checkedAt": crate::support::now_ms() as i64, "stale": false, "error": error })
    };
    let r = match http.get_json(&url, max_age, &[]) {
        Ok(r) => r,
        Err(e) if e.starts_with("HTTP 404 ") => return empty(None),
        Err(e) => return empty(Some(e)),
    };
    let d = &r.data;
    let tag = d["tag_name"].as_str().unwrap_or("");
    if tag.is_empty() {
        return empty(Some("The latest release has no version tag".into()));
    }
    let latest = tag.trim_start_matches(['v', 'V']).to_string();
    let assets: Vec<Value> = d["assets"]
        .as_array()
        .map(|a| a.iter().map(|x| json!({ "name": x["name"].as_str().unwrap_or(""), "url": x["browser_download_url"].as_str().unwrap_or(""), "size": x["size"].as_u64().unwrap_or(0) })).collect())
        .unwrap_or_default();
    let notes: String = d["body"].as_str().unwrap_or("").chars().take(4000).collect();
    json!({
        "current": current,
        "latest": latest,
        "available": compare_versions(&latest, current) == std::cmp::Ordering::Greater,
        "name": d["name"].as_str().filter(|n| !n.is_empty()).unwrap_or(tag),
        "url": d["html_url"].as_str().map(String::from).unwrap_or_else(releases_page),
        "publishedAt": d["published_at"].clone(),
        "notes": notes,
        "assets": assets,
        "checkedAt": r.fetched_at,
        "stale": r.stale,
        "error": r.error
    })
}

#[cfg(test)]
mod tests {
    use super::compare_versions;
    use std::cmp::Ordering;

    #[test]
    fn compares_release_versions() {
        assert_eq!(compare_versions("0.2.0", "0.1.0"), Ordering::Greater);
        assert_eq!(compare_versions("v0.1.10", "0.1.9"), Ordering::Greater);
        assert_eq!(compare_versions("1.0", "1.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("0.1.0", "0.1.1"), Ordering::Less);
        assert_eq!(compare_versions("1.2.0-beta.1", "1.2.0"), Ordering::Equal);
    }
}
