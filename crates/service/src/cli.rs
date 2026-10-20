use crate::client::{connect, read_service_file, RpcClient};
use crate::js;
use serde_json::{json, Map, Value};
use std::io::Write;
use std::path::Path;

macro_rules! say {
    ($($t:tt)*) => {{
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, $($t)*);
    }};
}

macro_rules! warn {
    ($($t:tt)*) => {{
        let mut err = std::io::stderr().lock();
        let _ = writeln!(err, $($t)*);
    }};
}

const HELP: &str = "Modsmith CLI

Usage:
  modsmith service start|stop|status
  modsmith call <method> [json-params]        Call any service method (see \"methods\")
  modsmith methods                           List service methods
  modsmith java                              List Java installations
  modsmith create <dir> --name <n> [--modid <id>] [--package <pkg>] [--starters a,b] [--no-build] [--git]
  modsmith open <dir>                        Inspect a workspace (no Gradle execution)
  modsmith trust <dir>                       Trust a workspace so Gradle may run
  modsmith build <dir> [--clean]
  modsmith launch <dir> [--profile dev-client] [--mode development|production]
  modsmith stop <instance-id> [--force]
  modsmith instances
  modsmith logs <instance-id> [--tail 100]
  modsmith search <query> [--mc 1.21.1] [--loader fabric]
  modsmith add-mod <dir> <modrinth-slug> [--profile dev-client] [--compile]
  modsmith mcp config                        Print MCP client configuration
";

#[derive(Clone)]
enum Flag {
    Str(String),
    Bool(bool),
}

impl Flag {
    fn text(&self) -> String {
        match self {
            Flag::Str(s) => s.clone(),
            Flag::Bool(b) => b.to_string(),
        }
    }

    fn truthy(&self) -> bool {
        match self {
            Flag::Str(s) => !s.is_empty(),
            Flag::Bool(b) => *b,
        }
    }

    fn json(&self) -> Value {
        match self {
            Flag::Str(s) => json!(s),
            Flag::Bool(b) => json!(b),
        }
    }
}

struct Args {
    pos: Vec<String>,
    flags: Vec<(String, Flag)>,
}

impl Args {
    fn get(&self, k: &str) -> Option<Flag> {
        self.flags.iter().rev().find(|(key, _)| key == k).map(|(_, v)| v.clone())
    }

    fn truthy(&self, k: &str) -> bool {
        self.get(k).is_some_and(|f| f.truthy())
    }

    fn is_false(&self, k: &str) -> bool {
        matches!(self.get(k), Some(Flag::Bool(false)))
    }

    fn text_or(&self, k: &str, d: &str) -> String {
        self.get(k).map(|f| f.text()).unwrap_or_else(|| d.to_string())
    }
}

fn parse(argv: &[String]) -> Args {
    let mut pos = Vec::new();
    let mut flags: Vec<(String, Flag)> = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        if let Some(key) = a.strip_prefix("--") {
            if let Some(k) = key.strip_prefix("no-") {
                flags.push((k.to_string(), Flag::Bool(false)));
            } else if i + 1 < argv.len() && !argv[i + 1].starts_with("--") {
                i += 1;
                flags.push((key.to_string(), Flag::Str(argv[i].clone())));
            } else {
                flags.push((key.to_string(), Flag::Bool(true)));
            }
        } else {
            pos.push(a.clone());
        }
        i += 1;
    }
    Args { pos, flags }
}

fn out(v: &Value) {
    match v {
        Value::String(s) => say!("{s}"),
        other => say!("{}", js::pretty(other)),
    }
}

fn resolve(p: &str) -> String {
    js::absolute(p).to_string_lossy().to_string()
}

fn pad(s: &str, n: usize) -> String {
    let len = s.encode_utf16().count();
    if len >= n {
        s.to_string()
    } else {
        format!("{s}{}", " ".repeat(n - len))
    }
}

fn wait_op(c: &RpcClient, op: &Value) -> Result<Value, String> {
    let mut shown = 0;
    let id = op["id"].clone();
    loop {
        let cur = c.call("operation.wait", &json!({ "id": id, "timeoutMs": 1000 }))?;
        let log = c.call("operation.log", &json!({ "id": id }))?;
        let lines = log["lines"].as_array().cloned().unwrap_or_default();
        for l in lines.iter().skip(shown) {
            say!("{}", js::string(l));
        }
        shown = lines.len();
        if cur["status"] != "running" {
            if cur["status"] == "failed" {
                warn!("FAILED: {}", cur.get("error").map(js::string).unwrap_or_else(|| "undefined".into()));
            }
            return Ok(cur);
        }
    }
}

fn exit_for(done: &Value) -> i32 {
    if done["status"] == "succeeded" {
        0
    } else {
        1
    }
}

fn api_methods() -> Vec<(String, String)> {
    let root: Value = serde_json::from_str(include_str!("../../../resources/api.json")).unwrap_or(Value::Null);
    root["methods"].as_object().map(|m| m.iter().map(|(k, d)| (k.clone(), js::string(&d["description"]))).collect()).unwrap_or_default()
}

fn run_command(c: &RpcClient, a: &Args) -> Result<i32, String> {
    let pos = |i: usize| a.pos.get(i).cloned().unwrap_or_default();
    let cmd = pos(0);
    match cmd.as_str() {
        "service" => {
            if pos(1) == "stop" {
                out(&c.call("service.shutdown", &json!({ "stopInstances": a.truthy("stop-instances") }))?);
            } else {
                out(&c.server_info);
            }
        }
        "call" => {
            let params: Value = match a.pos.get(2) {
                Some(p) => serde_json::from_str(p).map_err(|e| e.to_string())?,
                None => json!({}),
            };
            let r = c.call(&pos(1), &params)?;
            if r.is_object() && r.get("kind").is_some() && r.get("status").is_some() && r["status"] == "running" && !a.is_false("wait") {
                out(&wait_op(c, &r)?);
            } else {
                out(&r);
            }
        }
        "java" => {
            let list = c.call("java.list", &json!({ "refresh": a.truthy("refresh") }))?;
            for j in list.as_array().cloned().unwrap_or_default() {
                say!("{} {} {} {}", if j["isJdk"] == true { "JDK" } else { "JRE" }, pad(&js::string(&j["version"]), 12), pad(&js::string(&j["vendor"]), 24), js::string(&j["home"]));
            }
        }
        "create" => {
            let dest = resolve(&pos(1));
            let name = a.get("name").map(|f| f.text()).unwrap_or_else(|| Path::new(&dest).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
            let default_id = {
                let lower = name.to_lowercase();
                let re = regex::Regex::new(r"[^a-z0-9]+").expect("id regex");
                re.replace_all(&lower, "_").trim_matches('_').to_string()
            };
            let mod_id = a.get("modid").map(|f| f.text()).unwrap_or(default_id);
            let op = c.call(
                "project.create",
                &json!({
                    "projectName": name,
                    "destination": dest,
                    "modId": mod_id,
                    "packageName": a.text_or("package", &format!("com.example.{mod_id}")),
                    "author": a.text_or("author", ""),
                    "description": a.text_or("description", ""),
                    "license": a.text_or("license", "MIT"),
                    "git": a.truthy("git"),
                    "catalogEntryId": a.text_or("entry", "fabric-1.21.1"),
                    "starters": a.text_or("starters", "empty,bridge,profiles").split(',').collect::<Vec<_>>(),
                    "runInitialBuild": !a.is_false("build")
                }),
            )?;
            return Ok(exit_for(&wait_op(c, &op)?));
        }
        "open" => out(&c.call("workspace.open", &json!({ "path": resolve(&pos(1)) }))?),
        "trust" => out(&c.call("workspace.trust", &json!({ "path": resolve(&pos(1)), "trusted": !a.truthy("revoke") }))?),
        "build" => {
            let op = c.call("project.build", &json!({ "path": resolve(&pos(1)), "clean": a.truthy("clean") }))?;
            return Ok(exit_for(&wait_op(c, &op)?));
        }
        "launch" => {
            let mut params = json!({ "path": resolve(&pos(1)), "profile": a.text_or("profile", "dev-client") });
            if let Some(m) = a.get("mode") {
                params["mode"] = m.json();
            }
            let done = wait_op(c, &c.call("instance.launch", &params)?)?;
            out(done.get("result").filter(|r| !r.is_null()).or_else(|| done.get("error")).unwrap_or(&Value::Null));
            return Ok(exit_for(&done));
        }
        "stop" => out(&c.call("instance.stop", &json!({ "id": pos(1), "force": a.truthy("force") }))?),
        "instances" => out(&c.call("instance.list", &json!({}))?),
        "logs" => {
            let limit = match a.get("tail") {
                None => json!(100),
                Some(Flag::Bool(b)) => json!(if b { 1 } else { 0 }),
                Some(Flag::Str(s)) => s.trim().parse::<f64>().map(|n| json!(n)).unwrap_or(Value::Null),
            };
            let r = c.call("logs.read", &json!({ "id": pos(1), "limit": limit }))?;
            for l in r["lines"].as_array().cloned().unwrap_or_default() {
                say!("{}", js::string(&l["text"]));
            }
        }
        "search" => {
            let mut params = json!({ "query": a.pos[1..].join(" "), "loader": a.get("loader").map(|f| f.json()).unwrap_or(json!("fabric")), "limit": 15 });
            if let Some(mc) = a.get("mc") {
                params["minecraft"] = mc.json();
            }
            let r = c.call("dependency.search", &params)?;
            for h in r["hits"].as_array().cloned().unwrap_or_default() {
                let pid = h.get("project_id").map(js::string).unwrap_or_else(|| "undefined".into());
                say!("{pid}  {} {} ({} downloads)", pad(&js::string(&h["slug"]), 28), js::string(&h["title"]), js::string(&h["downloads"]));
            }
        }
        "add-mod" => {
            let mut params = json!({ "path": resolve(&pos(1)), "ref": { "source": "modrinth", "projectId": pos(2), "usage": if a.truthy("compile") { "compile" } else { "runtime" } } });
            if !a.truthy("project") {
                params["profile"] = json!(a.text_or("profile", "dev-client"));
            }
            out(&c.call("dependency.add", &params)?);
        }
        "mcp" => {
            if pos(1) == "config" {
                let cfg = c.call("mcp.config", &json!({}))?;
                out(&cfg["config"]);
                say!("\nClaude Code:\n{}", js::string(&cfg["claudeCodeCommand"]));
                if let Some(file) = a.get("write").filter(|f| f.truthy()) {
                    let file = file.text();
                    std::fs::write(&file, js::pretty(&cfg["config"])).map_err(|e| js::fs_error(&e, "open", Path::new(&file)))?;
                    say!("\nWritten to {file}");
                }
            }
        }
        _ => {
            warn!("Unknown command {cmd}\n");
            say!("{HELP}");
            return Ok(2);
        }
    }
    Ok(0)
}

pub fn run(argv: &[String]) -> i32 {
    let a = parse(argv);
    let cmd = a.pos.first().cloned().unwrap_or_default();
    if cmd.is_empty() || cmd == "help" || a.truthy("help") {
        say!("{HELP}");
        return 0;
    }
    if cmd == "service" && a.pos.get(1).map(String::as_str) == Some("status") {
        match read_service_file() {
            Some(sf) => {
                let mut o = Map::new();
                o.insert("running".into(), json!(true));
                for (k, v) in sf.as_object().cloned().unwrap_or_default() {
                    o.insert(k, v);
                }
                o.insert("token".into(), json!("[redacted]"));
                out(&Value::Object(o));
            }
            None => out(&json!({ "running": false })),
        }
        return 0;
    }
    if cmd == "methods" {
        for (k, d) in api_methods() {
            say!("{} {d}", pad(&k, 28));
        }
        return 0;
    }
    let auto_start = !(cmd == "service" && a.pos.get(1).map(String::as_str) == Some("stop"));
    let c = match connect("cli", false, auto_start) {
        Ok(c) => c,
        Err(e) => {
            warn!("{e}");
            return 1;
        }
    };
    let code = match run_command(&c, &a) {
        Ok(code) => code,
        Err(e) => {
            warn!("{e}");
            1
        }
    };
    c.close();
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_flags_like_the_node_cli() {
        let argv: Vec<String> = ["create", "dir", "--name", "My Mod", "--no-build", "--git", "--starters", "empty,item"].iter().map(|s| s.to_string()).collect();
        let a = parse(&argv);
        assert_eq!(a.pos, vec!["create", "dir"]);
        assert!(a.is_false("build"));
        assert!(a.truthy("git"));
        assert_eq!(a.text_or("starters", ""), "empty,item");
        assert_eq!(pad("ab", 4), "ab  ");
    }
}
