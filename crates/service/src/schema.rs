use serde_json::{Map, Value};

const MAX_SAFE: f64 = 9007199254740991.0;

type Detail = Vec<(&'static str, Value)>;

pub struct Issue {
    pub path: Vec<Value>,
    pub message: String,
    abort: bool,
    detail: Detail,
}

impl Issue {
    pub fn text(&self) -> String {
        let path = self.path.iter().map(|p| p.as_str().map(str::to_string).unwrap_or_else(|| p.to_string())).collect::<Vec<_>>().join(".");
        format!("{}: {}", if path.is_empty() { "(root)".to_string() } else { path }, self.message)
    }

    fn json(&self, base: usize) -> Value {
        let mut m = Map::new();
        for (k, v) in &self.detail {
            m.insert((*k).to_string(), v.clone());
        }
        m.insert("path".into(), Value::Array(self.path[base.min(self.path.len())..].to_vec()));
        m.insert("message".into(), Value::String(self.message.clone()));
        Value::Object(m)
    }
}

pub fn zod_error_message(issues: &[Issue]) -> String {
    serde_json::to_string_pretty(&Value::Array(issues.iter().map(|i| i.json(0)).collect())).unwrap_or_default()
}

pub fn received(v: Option<&Value>) -> &'static str {
    match v {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

pub fn js_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e21 {
        format!("{}", n as i128)
    } else {
        format!("{n}")
    }
}

fn num(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9007199254740992.0 {
        Value::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map(Value::Number).unwrap_or(Value::Null)
    }
}

fn code(c: &str) -> (&'static str, Value) {
    ("code", Value::String(c.to_string()))
}

fn types(schema: &Value) -> Vec<&str> {
    match &schema["type"] {
        Value::String(s) => vec![s.as_str()],
        Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
        _ => vec![],
    }
}

fn expected_name(schema: &Value) -> &'static str {
    let t = types(schema);
    match t.iter().copied().find(|t| *t != "null").unwrap_or("") {
        "string" => "string",
        "number" | "integer" => "number",
        "boolean" => "boolean",
        "array" => "array",
        "object" if schema.get("propertyNames").is_some() => "record",
        "object" => "object",
        "null" => "null",
        _ => "unknown",
    }
}

struct Ctx {
    path: Vec<Value>,
    issues: Vec<Issue>,
}

impl Ctx {
    fn issue(&mut self, message: String, abort: bool, detail: Detail) {
        self.issues.push(Issue { path: self.path.clone(), message, abort, detail });
    }

    fn type_issue(&mut self, schema: &Value, value: Option<&Value>) {
        let name = expected_name(schema);
        self.issue(format!("Invalid input: expected {name}, received {}", received(value)), true, vec![("expected", name.into()), code("invalid_type")]);
    }
}

fn is_null_branch(b: &Value) -> bool {
    types(b) == ["null"]
}

fn discriminator(branches: &[Value]) -> Option<String> {
    let first = branches.first()?.get("properties")?.as_object()?;
    first.iter().find(|(k, _)| branches.iter().all(|b| b["properties"][k.as_str()].get("const").is_some())).map(|(k, _)| k.clone())
}

fn check_one_of(branches: &[Value], value: Option<&Value>, ctx: &mut Ctx) -> Option<Value> {
    let Some(key) = discriminator(branches) else { return check_union(branches, value, ctx) };
    let Some(obj) = value.and_then(Value::as_object) else {
        ctx.issue(format!("Invalid input: expected object, received {}", received(value)), true, vec![("expected", "object".into()), code("invalid_type")]);
        return None;
    };
    let tag = obj.get(&key);
    match branches.iter().find(|b| tag.is_some_and(|t| &b["properties"][key.as_str()]["const"] == t)) {
        Some(branch) => check(branch, value, ctx),
        None => {
            let values: Vec<Value> = branches.iter().map(|b| b["properties"][key.as_str()]["const"].clone()).collect();
            let options = values.iter().map(|v| format!("'{}'", v.as_str().unwrap_or_default())).collect::<Vec<_>>().join(" | ");
            ctx.path.push(Value::String(key.clone()));
            ctx.issue(
                format!("Invalid discriminator value. Expected {options}"),
                true,
                vec![code("invalid_union"), ("errors", Value::Array(vec![])), ("note", "No matching discriminator".into()), ("discriminator", Value::String(key)), ("options", Value::Array(values))],
            );
            ctx.path.pop();
            None
        }
    }
}

fn check_union(branches: &[Value], value: Option<&Value>, ctx: &mut Ctx) -> Option<Value> {
    let mut candidates: Vec<Vec<Issue>> = Vec::new();
    let mut all: Vec<Vec<Issue>> = Vec::new();
    for b in branches {
        let mut sub = Ctx { path: ctx.path.clone(), issues: Vec::new() };
        let out = check(b, value, &mut sub);
        if sub.issues.is_empty() {
            return out;
        }
        if sub.issues.iter().any(|i| i.abort) {
            all.push(sub.issues);
        } else {
            candidates.push(sub.issues);
        }
    }
    if candidates.len() == 1 {
        ctx.issues.extend(candidates.pop().unwrap_or_default());
    } else {
        let base = ctx.path.len();
        let errors = Value::Array(candidates.iter().chain(all.iter()).map(|is| Value::Array(is.iter().map(|i| i.json(base)).collect())).collect());
        ctx.issue("Invalid input".into(), true, vec![code("invalid_union"), ("errors", errors)]);
    }
    None
}

fn enum_message(values: &[Value]) -> String {
    if values.len() == 1 {
        return format!("Invalid input: expected {}", values[0]);
    }
    format!("Invalid option: expected one of {}", values.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("|"))
}

fn transform(schema: &Value, out: Option<Value>) -> Option<Value> {
    match (schema.get("x-transform").and_then(Value::as_str), out) {
        (Some("String"), Some(Value::Number(n))) => Some(Value::String(n.as_f64().map(js_number).unwrap_or_else(|| n.to_string()))),
        (_, out) => out,
    }
}

fn length_checks(schema: &Value, len: f64, origin: &'static str, unit: &str, ctx: &mut Ctx) {
    if let Some(min) = schema["minLength"].as_f64().filter(|m| len < *m) {
        ctx.issue(
            format!("Too small: expected {origin} to have >={} {unit}", js_number(min)),
            false,
            vec![("origin", origin.into()), code("too_small"), ("minimum", num(min)), ("inclusive", true.into())],
        );
    }
    if let Some(max) = schema["maxLength"].as_f64().filter(|m| len > *m) {
        ctx.issue(
            format!("Too big: expected {origin} to have <={} {unit}", js_number(max)),
            false,
            vec![("origin", origin.into()), code("too_big"), ("maximum", num(max)), ("inclusive", true.into())],
        );
    }
}

fn bound_issue(ctx: &mut Ctx, small: bool, bound: f64, int_safe: bool) {
    let (label, key, word, op) = if small { ("too_small", "minimum", "Too small", ">=") } else { ("too_big", "maximum", "Too big", "<=") };
    let detail = if int_safe {
        vec![code(label), (key, num(bound)), ("note", "Integers must be within the safe integer range.".into()), ("origin", "int".into()), ("inclusive", true.into())]
    } else {
        vec![("origin", "number".into()), code(label), (key, num(bound)), ("inclusive", true.into())]
    };
    ctx.issue(format!("{word}: expected {} to be {op}{}", if int_safe { "int" } else { "number" }, js_number(bound)), false, detail);
}

fn check(schema: &Value, value: Option<&Value>, ctx: &mut Ctx) -> Option<Value> {
    if let Some(branches) = schema.get("oneOf").and_then(Value::as_array) {
        let out = check_one_of(branches, value, ctx);
        return transform(schema, out);
    }
    if let Some(branches) = schema.get("anyOf").and_then(Value::as_array) {
        if branches.iter().any(is_null_branch) {
            if value == Some(&Value::Null) {
                return Some(Value::Null);
            }
            let main = branches.iter().find(|b| !is_null_branch(b)).unwrap_or(&Value::Null);
            return check(main, value, ctx);
        }
        let out = check_union(branches, value, ctx);
        return transform(schema, out);
    }
    if let Some(c) = schema.get("const") {
        if value == Some(c) {
            return Some(c.clone());
        }
        ctx.issue(format!("Invalid input: expected {c}"), true, vec![code("invalid_value"), ("values", Value::Array(vec![c.clone()]))]);
        return None;
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        return match value {
            Some(v) if values.contains(v) => Some(v.clone()),
            _ => {
                ctx.issue(enum_message(values), true, vec![code("invalid_value"), ("values", Value::Array(values.clone()))]);
                None
            }
        };
    }
    let t = types(schema);
    if t.is_empty() {
        return value.cloned();
    }
    let Some(v) = value else {
        ctx.type_issue(schema, None);
        return None;
    };
    if v.is_null() && t.contains(&"null") {
        return Some(Value::Null);
    }
    let main = t.iter().copied().find(|t| *t != "null").unwrap_or("");
    let type_ok = match main {
        "string" => v.is_string(),
        "number" | "integer" => v.is_number(),
        "boolean" => v.is_boolean(),
        "array" => v.is_array(),
        "object" => v.is_object(),
        _ => true,
    };
    if !type_ok {
        ctx.type_issue(schema, Some(v));
        if main == "string" {
            if let Some(items) = v.as_array() {
                length_checks(schema, items.len() as f64, "array", "items", ctx);
            }
        }
        return None;
    }
    match main {
        "string" => {
            let s = v.as_str().unwrap_or_default();
            length_checks(schema, s.encode_utf16().count() as f64, "string", "characters", ctx);
            if let Some(pattern) = schema["pattern"].as_str() {
                if !regex::Regex::new(pattern).map(|r| r.is_match(s)).unwrap_or(true) {
                    let msg = schema.get("x-message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("Invalid string: must match pattern /{pattern}/"));
                    ctx.issue(msg, false, vec![("origin", "string".into()), code("invalid_format"), ("format", "regex".into()), ("pattern", Value::String(format!("/{pattern}/")))]);
                }
            }
            if schema["format"] == "uri" && url::Url::parse(s).is_err() {
                ctx.issue(schema.get("x-message").and_then(Value::as_str).unwrap_or("Invalid URL").to_string(), false, vec![code("invalid_format"), ("format", "url".into())]);
            }
            Some(v.clone())
        }
        "number" | "integer" => {
            let n = v.as_f64().unwrap_or(f64::NAN);
            if main == "integer" && n.fract() != 0.0 {
                ctx.issue("Invalid input: expected int, received number".into(), true, vec![("expected", "int".into()), ("format", "safeint".into()), code("invalid_type")]);
                return None;
            }
            let safe = |bound: f64| main == "integer" && bound.abs() == MAX_SAFE;
            if let Some(min) = schema["minimum"].as_f64().filter(|m| n < *m) {
                bound_issue(ctx, true, min, safe(min));
            }
            if let Some(max) = schema["maximum"].as_f64().filter(|m| n > *m) {
                bound_issue(ctx, false, max, safe(max));
            }
            Some(v.clone())
        }
        "array" => {
            let items = schema.get("items").unwrap_or(&Value::Null);
            let len = v.as_array().map(|a| a.len()).unwrap_or(0) as f64;
            if let Some(min) = schema["minItems"].as_f64().filter(|m| len < *m) {
                ctx.issue(
                    format!("Too small: expected array to have >={} items", js_number(min)),
                    false,
                    vec![("origin", "array".into()), code("too_small"), ("minimum", num(min)), ("inclusive", true.into())],
                );
            }
            if let Some(max) = schema["maxItems"].as_f64().filter(|m| len > *m) {
                ctx.issue(
                    format!("Too big: expected array to have <={} items", js_number(max)),
                    false,
                    vec![("origin", "array".into()), code("too_big"), ("maximum", num(max)), ("inclusive", true.into())],
                );
            }
            let mut out = Vec::new();
            for (i, item) in v.as_array().into_iter().flatten().enumerate() {
                ctx.path.push(Value::from(i));
                if let Some(x) = check(items, Some(item), ctx) {
                    out.push(x);
                }
                ctx.path.pop();
            }
            Some(Value::Array(out))
        }
        "object" => Some(check_object(schema, v.as_object().unwrap_or(&Map::new()), ctx)),
        _ => Some(v.clone()),
    }
}

fn is_unknown(schema: &Value) -> bool {
    ["type", "anyOf", "oneOf", "enum", "const"].iter().all(|k| schema.get(*k).is_none())
}

fn check_object(schema: &Value, obj: &Map<String, Value>, ctx: &mut Ctx) -> Value {
    if schema.get("propertyNames").is_some() {
        let values = schema.get("additionalProperties").unwrap_or(&Value::Null);
        let mut out = Map::new();
        for (k, v) in obj {
            ctx.path.push(Value::String(k.clone()));
            if let Some(x) = check(values, Some(v), ctx) {
                out.insert(k.clone(), x);
            }
            ctx.path.pop();
        }
        return Value::Object(out);
    }
    let required: Vec<&str> = schema["required"].as_array().map(|r| r.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let mut out = Map::new();
    if let Some(props) = schema["properties"].as_object() {
        for (key, prop) in props {
            let present = obj.get(key);
            if present.is_none() {
                if let Some(d) = prop.get("default") {
                    out.insert(key.clone(), d.clone());
                    continue;
                }
                if !required.contains(&key.as_str()) || is_unknown(prop) {
                    continue;
                }
            }
            ctx.path.push(Value::String(key.clone()));
            if let Some(x) = check(prop, present, ctx) {
                out.insert(key.clone(), x);
            }
            ctx.path.pop();
        }
        if schema.get("additionalProperties").is_some_and(Value::is_object) {
            for (k, v) in obj {
                if !props.contains_key(k) {
                    out.insert(k.clone(), v.clone());
                }
            }
        }
    }
    Value::Object(out)
}

pub fn parse(schema: &Value, value: &Value) -> Result<Value, Vec<Issue>> {
    let mut ctx = Ctx { path: Vec::new(), issues: Vec::new() };
    let out = check(schema, Some(value), &mut ctx);
    if ctx.issues.is_empty() {
        Ok(out.unwrap_or(Value::Null))
    } else {
        Err(ctx.issues)
    }
}
