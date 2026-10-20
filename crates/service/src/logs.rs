use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::sync::OnceLock;

fn patterns() -> &'static (Vec<Regex>, Regex, Regex, Regex) {
    static P: OnceLock<(Vec<Regex>, Regex, Regex, Regex)> = OnceLock::new();
    P.get_or_init(|| {
        (
            vec![
                Regex::new(r"^\[(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\] \[([^\]]+?)/([A-Z]+)\] \(([^)]*)\) (.*)$").expect("log pattern"),
                Regex::new(r"^\[(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\] \[([^\]]+?)/([A-Z]+)\]: (?:\[([^\]]*)\] )?(.*)$").expect("log pattern"),
                Regex::new(r"^\[(\d{2}[A-Za-z]{3}\d{4} \d{2}:\d{2}:\d{2}\.\d+)\] \[([^\]]+?)/([A-Z]+)\] \[([^\]]*)\]: (.*)$").expect("log pattern"),
            ],
            Regex::new(r"^\s+at [\w$.]+\(.*\)$").expect("trace pattern"),
            Regex::new(r"^Caused by: ").expect("cause pattern"),
            Regex::new(r"^\s*\.\.\. \d+ more$").expect("more pattern"),
        )
    })
}

pub fn parse_log_line(text: &str) -> Map<String, Value> {
    let (pats, at, caused, more) = patterns();
    let mut o = Map::new();
    for re in pats {
        if let Some(m) = re.captures(text) {
            o.insert("time".into(), json!(&m[1]));
            o.insert("thread".into(), json!(&m[2]));
            o.insert("level".into(), json!(&m[3]));
            if let Some(l) = m.get(4).filter(|l| !l.as_str().is_empty()) {
                o.insert("logger".into(), json!(l.as_str()));
            }
            o.insert("message".into(), json!(&m[5]));
            return o;
        }
    }
    if at.is_match(text) || caused.is_match(text) || more.is_match(text) {
        o.insert("level".into(), json!("TRACE"));
    }
    o.insert("message".into(), json!(text));
    o
}

pub struct LogBuffer {
    lines: VecDeque<Value>,
    seq: u64,
    last_level: Option<String>,
    capacity: usize,
}

#[derive(Default)]
pub struct Query {
    pub since: Option<u64>,
    pub limit: Option<usize>,
    pub levels: Vec<String>,
    pub search: Option<String>,
    pub logger: Option<String>,
    pub thread: Option<String>,
}

impl Default for LogBuffer {
    fn default() -> Self {
        LogBuffer { lines: VecDeque::new(), seq: 0, last_level: None, capacity: 50000 }
    }
}

impl LogBuffer {
    pub fn push(&mut self, stream: &str, text: &str) -> Value {
        let mut parsed = parse_log_line(text);
        match parsed.get("level").and_then(Value::as_str) {
            Some("TRACE") => {
                parsed.insert("level".into(), json!(self.last_level.clone().unwrap_or_else(|| "ERROR".into())));
            }
            Some(l) => self.last_level = Some(l.to_string()),
            None => {}
        }
        self.seq += 1;
        let mut line = Map::new();
        line.insert("seq".into(), json!(self.seq));
        line.insert("ts".into(), json!(crate::support::now_ms() as u64));
        line.insert("stream".into(), json!(stream));
        line.insert("text".into(), json!(text));
        line.extend(parsed);
        if !line.contains_key("level") && stream == "stderr" {
            line.insert("level".into(), json!("STDERR"));
        }
        let v = Value::Object(line);
        self.lines.push_back(v.clone());
        while self.lines.len() > self.capacity {
            self.lines.pop_front();
        }
        v
    }

    pub fn query(&self, q: &Query) -> Vec<Value> {
        let search = q.search.as_ref().map(|s| s.to_lowercase());
        let out: Vec<&Value> = self
            .lines
            .iter()
            .filter(|l| q.since.is_none_or(|s| s == 0 || l["seq"].as_u64().unwrap_or(0) > s))
            .filter(|l| q.levels.is_empty() || l["level"].as_str().is_some_and(|lv| q.levels.iter().any(|x| x == lv)))
            .filter(|l| q.logger.as_ref().is_none_or(|lg| l["logger"].as_str() == Some(lg)))
            .filter(|l| q.thread.as_ref().is_none_or(|t| l["thread"].as_str() == Some(t)))
            .filter(|l| search.as_ref().is_none_or(|s| l["text"].as_str().unwrap_or("").to_lowercase().contains(s)))
            .collect();
        let limit = q.limit.unwrap_or(1000);
        let limit = if limit == 0 { out.len() } else { limit };
        out[out.len().saturating_sub(limit)..].iter().map(|v| (*v).clone()).collect()
    }

    pub fn last_seq(&self) -> u64 {
        self.seq
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_inherits_levels() {
        let mut b = LogBuffer::default();
        let a = b.push("stdout", "[12:00:01] [Render thread/WARN] (Minecraft) Something odd");
        assert_eq!(a["logger"], "Minecraft");
        let t = b.push("stdout", "\tat a.b.C.d(C.java:1)");
        assert_eq!(t["level"], "WARN");
        let e = b.push("stderr", "plain");
        assert_eq!(e["level"], "STDERR");
        assert_eq!(serde_json::to_string(&e).unwrap().find("\"message\"").unwrap() < serde_json::to_string(&e).unwrap().find("\"level\"").unwrap(), true);
        assert_eq!(b.query(&Query { since: Some(1), ..Default::default() }).len(), 2);
    }
}
