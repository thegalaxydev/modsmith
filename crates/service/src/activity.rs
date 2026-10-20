use regex::Regex;
use serde_json::{Map, Value};
use std::sync::OnceLock;

const QUIET: [&str; 7] = ["operation.status", "operation.wait", "logs.read", "instance.status", "instance.list", "operation.list", "activity.list"];

pub fn should_record(method: &str, source: &str, ok: bool, mutating: bool) -> bool {
    if !mutating && source != "mcp" && ok {
        return false;
    }
    !(QUIET.contains(&method) && ok && source != "mcp")
}

struct Patterns {
    secret_key: Regex,
    access_token: Regex,
    assignment: Regex,
    bearer: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| Patterns {
        secret_key: Regex::new(r"(?i)(token|secret|password|passwd|apikey|api_key|authorization|accessToken|clientSecret)").unwrap(),
        access_token: Regex::new(r"(?i)(--accessToken\s+)(\S+)").unwrap(),
        assignment: Regex::new(r#"(?i)((?:token|secret|password|apikey|api_key)["']?\s*[:=]\s*["']?)([^"'\s,}]{6,})"#).unwrap(),
        bearer: Regex::new(r"(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}").unwrap(),
    })
}

pub fn redact_text(text: &str) -> String {
    let p = patterns();
    let t = p.access_token.replace_all(text, "${1}[redacted]");
    let t = p.assignment.replace_all(&t, "${1}[redacted]");
    p.bearer.replace_all(&t, "${1}[redacted]").into_owned()
}

pub fn redact_value(value: &Value, depth: usize) -> Value {
    if depth > 6 {
        return Value::String("[depth]".into());
    }
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|v| redact_value(v, depth + 1)).collect()),
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                let redacted = if patterns().secret_key.is_match(k) { Value::String("[redacted]".into()) } else { redact_value(v, depth + 1) };
                out.insert(k.clone(), redacted);
            }
            Value::Object(out)
        }
        Value::String(s) => Value::String(redact_text(s)),
        other => other.clone(),
    }
}

pub fn js_slice(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= max {
        return text.to_string();
    }
    String::from_utf16_lossy(&units[..max])
}

fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e21 => format!("{}", f as i128),
            Some(f) => format!("{f}"),
            None => n.to_string(),
        },
        other => other.to_string(),
    }
}

pub fn summarize(result: Option<&Value>) -> String {
    match result {
        None | Some(Value::Null) => "ok".into(),
        Some(Value::Array(a)) => format!("{} items", a.len()),
        Some(Value::Object(o)) => {
            if let (Some(Value::String(_)), Some(Value::String(id)), Some(Value::String(status))) = (o.get("kind"), o.get("id"), o.get("status")) {
                return format!("operation {id} {status}");
            }
            format!("{{{}}}", o.keys().take(6).cloned().collect::<Vec<_>>().join(", "))
        }
        Some(v) => js_slice(&js_string(v), 200),
    }
}

pub fn params_text(params: &Value) -> String {
    let p = if params.is_null() { Value::Object(Map::new()) } else { params.clone() };
    let text = serde_json::to_string(&redact_value(&p, 0)).unwrap_or_default();
    if text.encode_utf16().count() > 2000 {
        format!("{}...", js_slice(&text, 2000))
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_like_the_node_service() {
        let v = json!({ "preset": { "id": "p", "password": "hunter2", "note": "Bearer abcdefghijk", "cmd": "--accessToken abc123 x", "cfg": "apiKey: 'secretvalue'" } });
        assert_eq!(
            serde_json::to_string(&redact_value(&v, 0)).unwrap(),
            r#"{"preset":{"id":"p","password":"[redacted]","note":"Bearer [redacted]","cmd":"--accessToken [redacted] x","cfg":"apiKey: '[redacted]'"}}"#
        );
    }

    #[test]
    fn summarizes_results() {
        assert_eq!(summarize(None), "ok");
        assert_eq!(summarize(Some(&json!([1, 2]))), "2 items");
        assert_eq!(summarize(Some(&json!({ "kind": "build", "id": "x", "status": "running" }))), "operation x running");
        assert_eq!(summarize(Some(&json!({ "a": 1, "b": 2 }))), "{a, b}");
        assert_eq!(summarize(Some(&json!(true))), "true");
        assert_eq!(summarize(Some(&json!(5))), "5");
    }

    #[test]
    fn records_like_the_node_service() {
        assert!(!should_record("workspace.inspect", "ui", true, false));
        assert!(should_record("workspace.inspect", "mcp", true, false));
        assert!(!should_record("operation.wait", "ui", true, false));
        assert!(should_record("operation.wait", "ui", false, false));
        assert!(should_record("workspace.trust", "ui", true, true));
    }
}
