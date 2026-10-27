use crate::js;
use regex::{Captures, Regex, RegexBuilder};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

const SKIPPED_DIRS: [&str; 10] = [".git", ".gradle", "build", "node_modules", "out", "bin", ".idea", ".vscode", "run", ".modsmith"];
const MAX_FILE: u64 = 1024 * 1024;
const LONG_LINE: usize = 300;

#[derive(Clone, Copy)]
pub struct Query<'a> {
    pub query: &'a str,
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub include: &'a str,
    pub exclude: &'a str,
}

impl<'a> Query<'a> {
    pub fn from(p: &'a Value) -> Query<'a> {
        Query {
            query: p["query"].as_str().unwrap_or_default(),
            regex: p["regex"] == true,
            case_sensitive: p["caseSensitive"] == true,
            whole_word: p["wholeWord"] == true,
            include: p["include"].as_str().unwrap_or_default(),
            exclude: p["exclude"].as_str().unwrap_or_default(),
        }
    }
}

fn ascii_classes(pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::new();
    let mut in_class = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && i + 1 < chars.len() {
            let n = chars[i + 1];
            let mapped = match (n, in_class) {
                ('w', false) => Some("[0-9A-Za-z_]"),
                ('W', false) => Some("[^0-9A-Za-z_]"),
                ('d', false) => Some("[0-9]"),
                ('D', false) => Some("[^0-9]"),
                ('b', false) => Some("(?-u:\\b)"),
                ('B', false) => Some("(?-u:\\B)"),
                ('w', true) => Some("0-9A-Za-z_"),
                ('d', true) => Some("0-9"),
                _ => None,
            };
            match mapped {
                Some(m) => out.push_str(m),
                None => {
                    out.push(c);
                    out.push(n);
                }
            }
            i += 2;
            continue;
        }
        if c == '[' && !in_class {
            in_class = true;
            out.push(c);
        } else if c == ']' && in_class {
            in_class = false;
            out.push(c);
        } else {
            out.push(c);
        }
        i += 1;
    }
    out
}

pub fn compile_query(q: &Query) -> Result<Regex, String> {
    if q.query.is_empty() {
        return Err("Enter text to search for".into());
    }
    let mut source = if q.regex { ascii_classes(q.query) } else { regex::escape(q.query) };
    if q.whole_word {
        source = format!("(?-u:\\b)(?:{source})(?-u:\\b)");
    }
    RegexBuilder::new(&source).case_insensitive(!q.case_sensitive).build().map_err(|e| format!("Invalid regular expression: {}", e.to_string().lines().last().unwrap_or_default().trim_start_matches("error: ")))
}

fn glob_source(glob: &str) -> String {
    let chars: Vec<char> = glob.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '*' && chars.get(i + 1) == Some(&'*') {
            out.push_str(".*");
            i += 1;
            if chars.get(i + 1) == Some(&'/') {
                i += 1;
            }
        } else if c == '*' {
            out.push_str("[^/]*");
        } else if c == '?' {
            out.push_str("[^/]");
        } else {
            out.push_str(&regex::escape(&c.to_string()));
        }
        i += 1;
    }
    out
}

pub fn compile_globs(list: &str) -> Vec<Regex> {
    list.split(',')
        .map(|g| {
            let g = g.trim().replace('\\', "/");
            let g = g.strip_prefix("./").or_else(|| g.strip_prefix('/')).unwrap_or(&g).trim_end_matches('/').to_string();
            g
        })
        .filter(|g| !g.is_empty())
        .filter_map(|g| Regex::new(&format!("(?i)(^|/){}(/.*)?$", glob_source(&g))).ok())
        .collect()
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let Ok(t) = e.file_type() else { continue };
        let name = e.file_name().to_string_lossy().to_string();
        if t.is_dir() {
            if !SKIPPED_DIRS.contains(&name.as_str()) {
                walk(root, &e.path(), out);
            }
        } else if t.is_file() {
            out.push(rel(root, &e.path()));
        }
    }
}

fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default()
}

fn candidate_files(root: &Path, q: &Query, only: Option<&[String]>) -> Result<Vec<String>, String> {
    let include = compile_globs(q.include);
    let exclude = compile_globs(q.exclude);
    let mut files = Vec::new();
    match only {
        Some(list) => {
            for f in list {
                files.push(rel(root, &js::resolve_within(root, f)?));
            }
        }
        None => walk(root, root, &mut files),
    }
    files.retain(|f| (include.is_empty() || include.iter().any(|r| r.is_match(f))) && !exclude.iter().any(|r| r.is_match(f)));
    files.sort();
    Ok(files)
}

fn read_text(file: &Path) -> Option<String> {
    let st = fs::metadata(file).ok()?;
    if !st.is_file() || st.len() > MAX_FILE {
        return None;
    }
    let buf = fs::read(file).ok()?;
    if buf.iter().take(8000).any(|b| *b == 0) {
        return None;
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn preview(line: &str, column: usize, length: usize) -> (String, usize) {
    let units: Vec<u16> = line.encode_utf16().collect();
    if units.len() <= LONG_LINE {
        return (line.to_string(), 0);
    }
    let start = column.saturating_sub(100);
    let end = (column + length + 150).min(units.len());
    (String::from_utf16_lossy(&units[start..end]), start)
}

fn lines(text: &str) -> Vec<(&str, bool)> {
    text.split('\n').map(|l| match l.strip_suffix('\r') {
        Some(t) => (t, true),
        None => (l, false),
    }).collect()
}

pub fn search(root: &Path, p: &Value) -> Result<Value, String> {
    let q = Query::from(p);
    let re = compile_query(&q)?;
    let max = p["maxResults"].as_u64().unwrap_or(5000) as usize;
    let mut files = Vec::new();
    let mut match_count = 0usize;
    let mut searched = 0usize;
    let mut truncated = false;
    for f in candidate_files(root, &q, None)? {
        let Some(text) = read_text(&root.join(&f)) else { continue };
        searched += 1;
        let mut matches = Vec::new();
        'lines: for (i, (line, _)) in lines(&text).into_iter().enumerate() {
            for m in re.find_iter(line).filter(|m| !m.as_str().is_empty()) {
                if match_count >= max {
                    truncated = true;
                    break 'lines;
                }
                let column = utf16_len(&line[..m.start()]);
                let length = utf16_len(m.as_str());
                let (text, offset) = preview(line, column, length);
                matches.push(json!({ "line": i + 1, "column": column, "length": length, "text": text, "offset": offset }));
                match_count += 1;
            }
        }
        if !matches.is_empty() {
            files.push(json!({ "file": f, "matches": matches }));
        }
        if truncated {
            break;
        }
    }
    Ok(json!({ "fileCount": files.len(), "files": files, "matchCount": match_count, "searchedFiles": searched, "truncated": truncated }))
}

fn group<'a>(caps: &'a Captures, i: usize) -> &'a str {
    caps.get(i).map(|m| m.as_str()).unwrap_or_default()
}

pub fn expand_replacement(template: &str, caps: &Captures) -> String {
    let t: Vec<char> = template.chars().collect();
    let count = caps.len();
    let mut out = String::new();
    let mut i = 0;
    while i < t.len() {
        let c = t[i];
        let next = t.get(i + 1).copied();
        match (c, next) {
            ('\\', Some(n)) => {
                match n {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    '\\' => out.push('\\'),
                    _ => {
                        out.push(c);
                        out.push(n);
                    }
                }
                i += 1;
            }
            ('$', Some('$')) => {
                out.push('$');
                i += 1;
            }
            ('$', Some('&')) => {
                out.push_str(group(caps, 0));
                i += 1;
            }
            ('$', Some(n)) if n.is_ascii_digit() => {
                let two: String = t.iter().skip(i + 1).take(2).collect();
                let pick = if two.len() == 2 && two.chars().all(|c| c.is_ascii_digit()) && two.parse::<usize>().unwrap_or(usize::MAX) < count { two } else { n.to_string() };
                let idx = pick.parse::<usize>().unwrap_or(usize::MAX);
                if idx < count {
                    out.push_str(group(caps, idx));
                    i += pick.len();
                } else {
                    out.push(c);
                }
            }
            ('$', Some(open)) if open == '<' || open == '{' => {
                let closer = if open == '<' { '>' } else { '}' };
                let close = t.iter().enumerate().skip(i + 2).find(|(_, ch)| **ch == closer).map(|(k, _)| k);
                let name: String = close.map(|k| t[i + 2..k].iter().collect()).unwrap_or_default();
                if let (Some(k), true) = (close, !name.is_empty() && name.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_')) {
                    if name.chars().all(|ch| ch.is_ascii_digit()) {
                        out.push_str(name.parse::<usize>().ok().map(|n| group(caps, n)).unwrap_or_default());
                    } else {
                        out.push_str(caps.name(&name).map(|m| m.as_str()).unwrap_or_default());
                    }
                    i = k;
                } else {
                    out.push(c);
                }
            }
            _ => out.push(c),
        }
        i += 1;
    }
    out
}

pub fn replace(root: &Path, p: &Value) -> Result<(Value, Vec<String>), String> {
    let q = Query::from(p);
    let re = compile_query(&q)?;
    let replacement = p["replacement"].as_str().unwrap_or_default();
    let single = p["match"].as_object().map(|m| (js::string(&m["file"]), m["line"].as_u64().unwrap_or(0) as usize, m["column"].as_u64().unwrap_or(0) as usize));
    let targets = match &single {
        Some((file, _, _)) => candidate_files(root, &Query { include: "", exclude: "", ..q }, Some(std::slice::from_ref(file)))?,
        None => {
            let only: Option<Vec<String>> = p["files"].as_array().map(|a| a.iter().map(js::string).collect());
            candidate_files(root, &q, only.as_deref())?
        }
    };
    let mut changed = Vec::new();
    let mut names = Vec::new();
    let mut total = 0usize;
    for f in targets {
        let abs = root.join(&f);
        let Some(text) = read_text(&abs) else { continue };
        let mut count = 0usize;
        let out: Vec<String> = lines(&text)
            .into_iter()
            .enumerate()
            .map(|(i, (line, cr))| {
                let suffix = if cr { "\r" } else { "" };
                if matches!(single, Some((_, l, _)) if l != i + 1) {
                    return format!("{line}{suffix}");
                }
                let mut res = String::new();
                let mut last = 0;
                for caps in re.captures_iter(line) {
                    let m = caps.get(0).expect("whole match");
                    if m.as_str().is_empty() {
                        continue;
                    }
                    if let Some((_, _, col)) = single {
                        if utf16_len(&line[..m.start()]) != col {
                            continue;
                        }
                    }
                    res.push_str(&line[last..m.start()]);
                    if q.regex {
                        res.push_str(&expand_replacement(replacement, &caps));
                    } else {
                        res.push_str(replacement);
                    }
                    last = m.end();
                    count += 1;
                }
                res.push_str(&line[last..]);
                res.push_str(suffix);
                res
            })
            .collect();
        if count == 0 {
            continue;
        }
        js::write_file_atomic(&abs, out.join("\n").as_bytes())?;
        total += count;
        changed.push(json!({ "file": f, "replacements": count }));
        names.push(f);
    }
    if let (Some((file, line, _)), true) = (&single, changed.is_empty()) {
        return Err(format!("The match in {file} on line {line} is no longer there; search again"));
    }
    Ok((json!({ "files": changed, "replacements": total }), names))
}
