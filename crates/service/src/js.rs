use serde_json::Value;
use std::cmp::Ordering;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

pub fn number_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if n == 0.0 {
        return "0".into();
    }
    let abs = n.abs();
    if !(1e-6..1e21).contains(&abs) {
        let s = format!("{n:e}");
        return match s.split_once('e') {
            Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
            _ => s,
        };
    }
    if n.fract() == 0.0 {
        return format!("{}", n as i128);
    }
    format!("{n}")
}

pub fn string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => match (n.as_i64(), n.as_u64(), n.as_f64()) {
            (Some(i), _, _) => i.to_string(),
            (_, Some(u), _) => u.to_string(),
            (_, _, Some(f)) => number_string(f),
            _ => n.to_string(),
        },
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
        Value::Array(items) => items.iter().map(|i| if i.is_null() { String::new() } else { string(i) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn punctuation_rank(c: char) -> Option<u32> {
    "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$".find(c).map(|i| i as u32)
}

fn primary(c: char) -> (u32, u32) {
    if c.is_whitespace() {
        return (0, c as u32);
    }
    if let Some(r) = punctuation_rank(c) {
        return (1, r);
    }
    if c.is_ascii_digit() {
        return (3, c as u32);
    }
    if c.is_alphabetic() {
        use unicode_normalization::UnicodeNormalization;
        let base = std::iter::once(c).nfd().next().unwrap_or(c);
        let lower = base.to_lowercase().next().unwrap_or(base);
        return (4, lower as u32);
    }
    (2, c as u32)
}

pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let pa: Vec<(u32, u32)> = a.chars().map(primary).collect();
    let pb: Vec<(u32, u32)> = b.chars().map(primary).collect();
    match pa.cmp(&pb) {
        Ordering::Equal => {}
        other => return other,
    }
    for (x, y) in a.chars().zip(b.chars()) {
        if x != y {
            let (xl, yl) = (x.is_lowercase(), y.is_lowercase());
            if xl != yl {
                return if xl { Ordering::Less } else { Ordering::Greater };
            }
            return x.cmp(&y);
        }
    }
    a.len().cmp(&b.len())
}

pub fn fs_error(e: &io::Error, syscall: &str, path: &Path) -> String {
    let (code, text) = match e.kind() {
        io::ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        io::ErrorKind::PermissionDenied => ("EPERM", "operation not permitted"),
        io::ErrorKind::AlreadyExists => ("EEXIST", "file already exists"),
        io::ErrorKind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        io::ErrorKind::NotADirectory => ("ENOTDIR", "not a directory"),
        io::ErrorKind::DirectoryNotEmpty => ("ENOTEMPTY", "directory not empty"),
        _ => ("EIO", "i/o error"),
    };
    format!("{code}: {text}, {syscall} '{}'", path.display())
}

pub fn absolute(p: &str) -> PathBuf {
    let path = std::path::absolute(p).unwrap_or_else(|_| PathBuf::from(p));
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    let s = out.to_string_lossy().to_string();
    if s.len() > 3 && s.ends_with(['\\', '/']) {
        return PathBuf::from(s.trim_end_matches(['\\', '/']));
    }
    out
}

pub fn absolute_from(base: &Path, p: &str) -> PathBuf {
    if Path::new(p).is_absolute() {
        absolute(p)
    } else {
        absolute(&base.join(p).to_string_lossy())
    }
}

pub fn slice_utf16(text: &str, max: usize) -> String {
    crate::activity::js_slice(text, max)
}

pub fn iso_now() -> String {
    humantime::format_rfc3339_millis(SystemTime::now()).to_string()
}

pub fn iso(ms: i64) -> String {
    humantime::format_rfc3339_millis(SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(ms.max(0) as u64)).to_string()
}

pub fn stamp(iso: &str) -> String {
    iso.replace([':', '.'], "-")
}

pub fn pretty_tab(v: &Value) -> String {
    let mut v = v.clone();
    normalize_numbers(&mut v);
    let mut buf = Vec::new();
    let fmt = serde_json::ser::PrettyFormatter::with_indent(b"\t");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, fmt);
    serde::Serialize::serialize(&v, &mut ser).ok();
    String::from_utf8(buf).unwrap_or_default()
}

pub fn copy_recursive(src: &Path, dest: &Path, skip: &dyn Fn(&Path) -> bool) -> Result<(), String> {
    if skip(src) {
        return Ok(());
    }
    let meta = fs::metadata(src).map_err(|e| fs_error(&e, "lstat", src))?;
    if meta.is_dir() {
        fs::create_dir_all(dest).map_err(|e| fs_error(&e, "mkdir", dest))?;
        for entry in fs::read_dir(src).map_err(|e| fs_error(&e, "opendir", src))?.flatten() {
            copy_recursive(&src.join(entry.file_name()), &dest.join(entry.file_name()), skip)?;
        }
        Ok(())
    } else {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| fs_error(&e, "mkdir", parent))?;
        }
        fs::copy(src, dest).map(|_| ()).map_err(|e| fs_error(&e, "copyfile", src))
    }
}

pub fn realpath(p: &Path) -> Option<PathBuf> {
    let real = fs::canonicalize(p).ok()?;
    let s = real.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return Some(PathBuf::from(format!(r"\\{rest}")));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return Some(PathBuf::from(rest));
    }
    Some(real)
}

fn parts(p: &Path) -> Vec<String> {
    p.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect()
}

fn same(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.to_lowercase() == b.to_lowercase()
    } else {
        a == b
    }
}

pub fn is_within(root: &Path, target: &Path) -> bool {
    let r = parts(root);
    let t = parts(target);
    if t.len() < r.len() || !r.iter().zip(&t).all(|(a, b)| same(a, b)) {
        return false;
    }
    match t.get(r.len()) {
        None => true,
        Some(first) => !first.starts_with(".."),
    }
}

pub fn resolve_within(root: &Path, rel_or_abs: &str) -> Result<PathBuf, String> {
    let joined = if Path::new(rel_or_abs).is_absolute() { PathBuf::from(rel_or_abs) } else { root.join(rel_or_abs) };
    let resolved = absolute(&joined.to_string_lossy());
    let root_abs = absolute(&root.to_string_lossy());
    if !is_within(&root_abs, &resolved) {
        return Err(format!("Path is outside the workspace: {rel_or_abs}"));
    }
    if resolved.exists() {
        if let (Some(real_root), Some(real)) = (realpath(root), realpath(&resolved)) {
            if !is_within(&real_root, &real) {
                return Err(format!("Path resolves outside the workspace: {rel_or_abs}"));
            }
        }
    }
    Ok(resolved)
}

pub fn mtime_ms(meta: &fs::Metadata) -> f64 {
    let Ok(t) = meta.modified() else { return 0.0 };
    match t.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(d) => d.as_secs() as f64 * 1000.0 + d.subsec_nanos() as f64 / 1e6,
        Err(e) => -(e.duration().as_secs_f64() * 1000.0),
    }
}

pub fn write_file_atomic(file: &Path, content: &[u8]) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| fs_error(&e, "mkdir", dir))?;
    }
    let tmp = PathBuf::from(format!("{}.{}.{}.tmp", file.display(), std::process::id(), crate::support::now_ms()));
    fs::write(&tmp, content).map_err(|e| fs_error(&e, "open", &tmp))?;
    fs::rename(&tmp, file).map_err(|e| fs_error(&e, "rename", &tmp))
}

pub fn normalize_numbers(v: &mut Value) {
    match v {
        Value::Number(n) => {
            if n.as_i64().is_none() && n.as_u64().is_none() {
                if let Some(f) = n.as_f64() {
                    if f.fract() == 0.0 && f.abs() < 9007199254740992.0 {
                        *v = Value::from(f as i64);
                    }
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(normalize_numbers),
        Value::Object(map) => map.values_mut().for_each(normalize_numbers),
        _ => {}
    }
}

pub fn pretty(v: &Value) -> String {
    let mut v = v.clone();
    normalize_numbers(&mut v);
    serde_json::to_string_pretty(&v).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn js_strings() {
        assert_eq!(string(&json!(1.5)), "1.5");
        assert_eq!(string(&json!(10)), "10");
        assert_eq!(string(&json!(["a", 1, null])), "a,1,");
        assert_eq!(string(&json!({})), "[object Object]");
        assert_eq!(number_string(1e21), "1e+21");
    }

    #[test]
    fn locale_order() {
        let mut names = vec!["b.txt", "B.txt", "a.txt", "_x", "10", "2", "A", "a", "Ärger", "zeta"];
        names.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(names, vec!["_x", "10", "2", "a", "A", "a.txt", "Ärger", "b.txt", "B.txt", "zeta"]);
    }

    #[test]
    fn containment() {
        let root = Path::new(r"C:\work\proj");
        assert!(is_within(root, Path::new(r"C:\work\proj\src")));
        assert!(is_within(root, Path::new(r"c:\WORK\proj")));
        assert!(!is_within(root, Path::new(r"C:\work\project")));
        assert!(!is_within(root, Path::new(r"C:\work")));
        assert!(resolve_within(root, r"..\..\etc").is_err());
    }
}
