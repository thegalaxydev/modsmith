use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

const API_JSON: &str = include_str!("../../../resources/api.json");

pub struct Method {
    pub mutating: bool,
    pub params: Value,
}

pub struct Api {
    pub product: String,
    pub version: String,
    pub methods: HashMap<String, Method>,
}

pub fn api() -> &'static Api {
    static API: OnceLock<Api> = OnceLock::new();
    API.get_or_init(|| {
        let root: Value = serde_json::from_str(API_JSON).expect("resources/api.json is valid JSON");
        let methods = root["methods"].as_object().map(|m| m.iter().map(|(k, v)| (k.clone(), Method { mutating: v["mutating"] == true, params: v["params"].clone() })).collect()).unwrap_or_default();
        Api { product: root["product"]["name"].as_str().unwrap_or("Modsmith").to_string(), version: root["product"]["version"].as_str().unwrap_or("0.0.0").to_string(), methods }
    })
}

pub fn validate(method: &str, params: &Value) -> Result<Value, String> {
    let def = api().methods.get(method).ok_or_else(|| format!("Unknown method {method}"))?;
    let input = if params.is_null() { Value::Object(Map::new()) } else { params.clone() };
    crate::schema::parse(&def.params, &input).map_err(|issues| format!("Invalid parameters for {method}: {}", issues.iter().map(crate::schema::Issue::text).collect::<Vec<_>>().join("; ")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn loads_every_method() {
        assert!(api().methods.len() > 100);
        assert!(api().methods.contains_key("workspace.inspect"));
    }

    #[test]
    fn reports_missing_and_unknown() {
        assert_eq!(validate("workspace.inspect", &json!({})).unwrap_err(), "Invalid parameters for workspace.inspect: path: Invalid input: expected string, received undefined");
        assert_eq!(validate("nope.method", &json!({})).unwrap_err(), "Unknown method nope.method");
    }

    #[test]
    fn applies_defaults_and_strips_unknown_keys() {
        let out = validate("project.create", &json!({ "projectName": "A", "destination": "D", "modId": "a", "packageName": "a.b", "extra": 1 })).unwrap();
        assert_eq!(out["license"], "MIT");
        assert_eq!(out["starters"], json!(["empty", "bridge", "profiles"]));
        assert!(out.get("extra").is_none());
    }
}
