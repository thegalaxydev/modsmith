use crate::harness::{prepare_test_world, server_test_world, Targets, TestWorld};
use crate::js;
use crate::launch::find_profile;
use crate::logs::Query;
use crate::manifest::{self, schemas};
use crate::ops::OpCtx;
use crate::rt::{s, Runtime};
use crate::schema;
use crate::workspace;
use base64::Engine;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::collections::HashMap;
use std::time::Instant;

fn scenario_dir(ws: &Path) -> PathBuf {
    ws.join("scenarios")
}

fn safe_name(s: &str) -> String {
    Regex::new(r"[^\w-]").expect("name regex").replace_all(s, "_").to_string()
}

pub fn list(workspace: &str) -> Result<Value, String> {
    let d = scenario_dir(&workspace::normalize(workspace));
    let Ok(entries) = fs::read_dir(&d) else { return Ok(json!([])) };
    let mut out = Vec::new();
    for f in entries.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|f| f.ends_with(".json")) {
        let text = fs::read_to_string(d.join(&f)).map_err(|e| js::fs_error(&e, "open", &d.join(&f)))?;
        let raw: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        out.push(match schema::parse(&schemas()["scenario"], &raw) {
            Ok(sc) => json!({ "file": f, "valid": true, "scenario": sc, "errors": [] }),
            Err(issues) => json!({ "file": f, "valid": false, "scenario": null, "errors": issues.iter().map(|i| format!("{}: {}", i.path.iter().map(js::string).collect::<Vec<_>>().join("."), i.message)).collect::<Vec<_>>() }),
        });
    }
    Ok(Value::Array(out))
}

pub fn results(workspace: &str) -> Value {
    let d = manifest::state_dir(&workspace::normalize(workspace)).join("results");
    let Ok(entries) = fs::read_dir(&d) else { return json!([]) };
    let mut files: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|f| f.ends_with(".json")).collect();
    files.sort();
    files.reverse();
    Value::Array(files.into_iter().take(50).filter_map(|f| fs::read_to_string(d.join(f)).ok().and_then(|t| serde_json::from_str(&t).ok())).collect())
}

fn scenario_file_name(file: &str) -> Result<String, String> {
    let name = file.strip_suffix(".json").unwrap_or(file);
    if name.is_empty() || name.len() > 64 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("Scenario file names may only use letters, digits, - and _ (up to 64 characters)".into());
    }
    Ok(format!("{name}.json"))
}

pub fn save(workspace: &str, file: &str, input: &Value) -> Result<Value, String> {
    let dir = scenario_dir(&workspace::normalize(workspace));
    let name = scenario_file_name(file)?;
    let data = schema::parse(&schemas()["scenario"], input).map_err(|issues| {
        format!("Invalid scenario: {}", issues.iter().map(|i| format!("{}: {}", i.path.iter().map(js::string).collect::<Vec<_>>().join("."), i.message)).collect::<Vec<_>>().join("; "))
    })?;
    fs::create_dir_all(&dir).map_err(|e| js::fs_error(&e, "mkdir", &dir))?;
    let target = dir.join(&name);
    fs::write(&target, format!("{}\n", js::pretty(&data))).map_err(|e| js::fs_error(&e, "open", &target))?;
    Ok(json!({ "file": name, "scenario": data }))
}

pub fn remove(workspace: &str, file: &str, confirm: bool) -> Result<Value, String> {
    if !confirm {
        return Err("Deleting a scenario is destructive; pass confirm: true".into());
    }
    let dir = scenario_dir(&workspace::normalize(workspace));
    let name = scenario_file_name(file)?;
    let target = dir.join(&name);
    if !target.exists() {
        return Err(format!("Scenario not found: {file}"));
    }
    fs::remove_file(&target).map_err(|e| js::fs_error(&e, "unlink", &target))?;
    Ok(json!({ "removed": name }))
}

pub const TEST_WORLD: &str = "modsmith-test";

fn steps_of(scenario: &Value, key: &str) -> Vec<Value> {
    scenario[key].as_array().cloned().unwrap_or_default()
}

fn has_server(scenario: &Value) -> bool {
    scenario["server"].as_str().is_some_and(|s| !s.is_empty())
}

pub fn players_of(scenario: &Value) -> Vec<String> {
    match scenario["players"].as_array() {
        Some(a) => a.iter().map(js::string).collect(),
        None if has_server(scenario) => vec!["Player1".into(), "Player2".into()],
        None => vec![],
    }
}

pub fn check_players(scenario: &Value) -> Result<(), String> {
    let players = players_of(scenario);
    if scenario["players"].is_array() && !has_server(scenario) {
        return Err("A scenario with players needs a server run configuration (\"server\")".into());
    }
    let mut lower: Vec<String> = players.iter().map(|p| p.to_lowercase()).collect();
    lower.sort();
    lower.dedup();
    if lower.len() != players.len() {
        return Err("Each player in a scenario needs a different name".into());
    }
    for phase in ["setup", "steps", "cleanup"] {
        for (i, st) in steps_of(scenario, phase).iter().enumerate() {
            let Some(p) = st["player"].as_str().filter(|p| !p.is_empty()) else { continue };
            if !has_server(scenario) {
                return Err(format!("{phase}[{i}] names player {p}, but only multiplayer scenarios (with \"server\" and \"players\") can name players"));
            }
            if !players.iter().any(|x| x == p) {
                return Err(format!("{phase}[{i}] names player {p}, who is not one of the scenario's players ({})", players.join(", ")));
            }
        }
    }
    Ok(())
}

pub fn as_player(command: &str, player: Option<&str>) -> String {
    let c = command.strip_prefix('/').unwrap_or(command);
    match player {
        Some(p) => format!("execute as {p} at {p} run {c}"),
        None => c.to_string(),
    }
}

impl Runtime {
    pub fn load_scenario(dir: &Path, file: &str) -> Result<Value, String> {
        let name = if file.ends_with(".json") { file.to_string() } else { format!("{file}.json") };
        let path = scenario_dir(dir).join(name);
        if !path.exists() {
            return Err(format!("Scenario not found: {file}"));
        }
        let text = fs::read_to_string(&path).map_err(|e| js::fs_error(&e, "open", &path))?;
        let raw: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        schema::parse(&schemas()["scenario"], &raw).map_err(|e| schema::zod_error_message(&e))
    }

    pub fn scenario_run(self: &Arc<Self>, workspace: &str, file: &str, instance: Option<String>, keep: bool) -> Result<Value, String> {
        let dir = workspace::normalize(workspace);
        let scenario = Self::load_scenario(&dir, file)?;
        check_players(&scenario)?;
        let title = format!("Scenario {}", js::string(&scenario["name"]));
        let world = TestWorld { name: TEST_WORLD.into(), seed: scenario["world"]["seed"].as_i64().unwrap_or(4242), flat: scenario["world"]["flat"].as_bool().unwrap_or(true) };
        if has_server(&scenario) {
            return self.scenario_run_multiplayer(dir, scenario, world, keep, &title);
        }
        let me = self.clone();
        let ws = s(&dir);
        if let Some(i) = instance {
            return Ok(self.ops.start("scenario.run", &title, Some(ws), move |ctx| me.execute_scenario(&dir, &scenario, &Targets::single(&i), ctx, false).map(Some)));
        }
        let profile = js::string(&scenario["profile"]);
        let running = self.instances.list().into_iter().find(|i| i["workspace"] == ws.as_str() && i["profileId"] == profile.as_str() && (i["status"] == "running" || i["status"] == "starting"));
        if let Some(r) = running {
            let id = js::string(&r["id"]);
            return Ok(self.ops.start("scenario.run", &title, Some(ws), move |ctx| {
                me.ensure_world(&id, &world, ctx)?;
                me.execute_scenario(&dir, &scenario, &Targets::single(&id), ctx, false).map(Some)
            }));
        }
        let prepared = self.prepare_launch(&ws, &profile, None, None)?;
        if prepared.profile["bridge"] != true {
            return Err(format!("Scenarios run their steps through the development bridge. Turn on \"Development bridge\" for {profile}."));
        }
        Ok(self.ops.start("scenario.run", &title, Some(ws), move |ctx| {
            let restore = prepare_test_world(&prepared, &world, &[])?;
            let mut launched: Option<String> = None;
            let result = (|| -> Result<Value, String> {
                ctx.progress(Some(0.02), Some(&format!("Starting {}", js::string(&prepared.profile["name"]))));
                let info = me.run_prepared(&prepared, None, ctx)?;
                let id = js::string(&info["id"]);
                launched = Some(id.clone());
                if prepared.side == "server" {
                    me.wait_server_done(ctx, &id)?;
                    me.wait_bridge(ctx, &id)?;
                } else {
                    me.wait_title_screen(ctx, &id)?;
                    ctx.progress(Some(0.1), Some("Creating a test world"));
                    me.enter_world(ctx, &id, &world)?;
                }
                me.execute_scenario(&dir, &scenario, &Targets::single(&id), ctx, true)
            })();
            if let Some(id) = launched.filter(|_| !keep) {
                let _ = me.stop_instance(&id, false);
            }
            restore.run();
            result.map(Some)
        }))
    }

    fn scenario_run_multiplayer(self: &Arc<Self>, dir: PathBuf, scenario: Value, world: TestWorld, keep: bool, title: &str) -> Result<Value, String> {
        let players = players_of(&scenario);
        let server_id = js::string(&scenario["server"]);
        let m = manifest::require_manifest(&dir, &s(&dir))?;
        if let Some(sp) = find_profile(&m, &server_id) {
            if sp["bridge"] != true {
                return Err(format!("Multiplayer scenarios run their steps through the server's development bridge. Turn on \"Development bridge\" for {server_id}."));
            }
        }
        let plan = self.session_prepare(&json!({ "path": s(&dir), "server": server_id, "client": scenario["profile"], "names": players }))?;
        let me = self.clone();
        let ws = s(&dir);
        Ok(self.ops.start("scenario.run", title, Some(ws), move |ctx| {
            let restore = server_test_world(&plan.server.idir, &world)?;
            let result = (|| -> Result<Value, String> {
                ctx.progress(Some(0.02), Some(&format!("Starting the server and {}", players.join(", "))));
                let launched = me.session_launch(&plan, ctx)?;
                let server = js::string(&launched["server"]["instance"]);
                me.wait_bridge(ctx, &server)?;
                ctx.progress(Some(0.1), Some(&format!("Waiting for {} to join", players.join(", "))));
                me.wait_players_joined(ctx, &server, &players)?;
                let clients = launched["clients"].as_array().into_iter().flatten().map(|c| (js::string(&c["player"]), js::string(&c["instance"]))).collect();
                me.execute_scenario(&dir, &scenario, &Targets { main: server, clients, players: players.clone() }, ctx, true)
            })();
            me.session_release(&plan.id);
            if !keep {
                let _ = me.session_stop(&plan.id);
            }
            restore.run();
            result.map(Some)
        }))
    }

    fn ensure_world(&self, id: &str, world: &TestWorld, ctx: &OpCtx) -> Result<(), String> {
        let Some(inst) = self.instances.get(id) else { return Ok(()) };
        if inst["side"] != "client" {
            return Ok(());
        }
        let _ = self.wait_title_screen(ctx, id);
        let Ok(st) = self.bridge.call(id, "client.status", json!({}), 5000) else { return Ok(()) };
        if st["inWorld"] == true {
            return Ok(());
        }
        ctx.progress(Some(0.05), Some("Creating a test world"));
        let _ = fs::remove_dir_all(PathBuf::from(js::string(&inst["instanceDir"])).join("saves").join(&world.name));
        self.enter_world(ctx, id, world)?;
        Ok(())
    }

    pub fn execute_scenario(&self, dir: &Path, scenario: &Value, t: &Targets, ctx: &OpCtx, launched: bool) -> Result<Value, String> {
        let started = crate::support::now_ms() as i64;
        let timeout = scenario["timeoutMs"].as_i64().unwrap_or(120000);
        let deadline = started + timeout;
        let profile = js::string(&scenario["profile"]);
        let inst = self.instances.get(&t.main).ok_or_else(|| format!("No running instance of profile {profile}. Launch it first and enter a world."))?;
        let id = js::string(&inst["id"]);
        let status = self.bridge.status(&id);
        if status["connected"] != true {
            return Err("Bridge is not connected for the instance".into());
        }
        let caps: Vec<String> = status["game"]["capabilities"].as_array().map(|a| a.iter().map(js::string).collect()).unwrap_or_default();
        let missing: Vec<String> = scenario["requires"].as_array().into_iter().flatten().map(js::string).filter(|r| !caps.contains(r)).collect();
        if !missing.is_empty() {
            return Err(format!("Instance bridge lacks required capabilities: {}", missing.join(", ")));
        }
        let gs = self.bridge.call(&id, "game.status", json!({}), 20000)?;
        if !js::truthy(gs.get("worldLoaded")) {
            return Err("No world is loaded in the instance; enter a world before running scenarios".into());
        }
        let local_player = inst["side"] == "client" && t.players.is_empty();
        let keep_running = local_player && caps.iter().any(|c| c == "client.keep_running");
        if keep_running {
            let _ = self.bridge.call(&id, "client.keep_running", json!({ "enabled": true }), 5000);
        }
        let mut log_start: HashMap<String, u64> = HashMap::new();
        for iid in std::iter::once(id.clone()).chain(t.clients.iter().map(|(_, c)| c.clone())) {
            let seq = self.instances.logs(&iid, &Query { limit: Some(1), ..Default::default() })?["lastSeq"].as_u64().unwrap_or(0);
            log_start.insert(iid, seq);
        }
        let client_of = |player: Option<&str>| -> String {
            match player {
                Some(p) => t.client(p).unwrap_or(&id).to_string(),
                None => t.players.first().and_then(|p| t.client(p)).unwrap_or(&id).to_string(),
            }
        };
        let mut results: Vec<Value> = Vec::new();
        let mut artifacts: Vec<String> = Vec::new();
        let run_step = |phase: &str, index: usize, step: &Value, results: &mut Vec<Value>, artifacts: &mut Vec<String>| -> Result<bool, String> {
            if crate::support::now_ms() as i64 > deadline {
                return Err(format!("Scenario timed out after {timeout} ms"));
            }
            ctx.check()?;
            let t0 = Instant::now();
            let action = js::string(&step["action"]);
            let player = step["player"].as_str().filter(|p| !p.is_empty());
            let outcome = (|| -> Result<(bool, String), String> {
                match action.as_str() {
                    "command" => {
                        let command = as_player(step["command"].as_str().unwrap_or(""), player.or(if local_player { Some("@p") } else { None }));
                        let r = self.bridge.call(&id, "world.run_command", json!({ "command": command }), 20000)?;
                        let output: Vec<String> = r["output"].as_array().map(|a| a.iter().map(js::string).collect()).unwrap_or_default();
                        let detail = format!("result {}; {}", js::string(&r["result"]), js::slice_utf16(&output.join(" | "), 300));
                        if let Some(expect) = step["expectOutputContains"].as_str().filter(|e| !e.is_empty()) {
                            if !output.join("\n").contains(expect) {
                                return Ok((false, format!("expected output containing \"{expect}\", got: {detail}")));
                            }
                        }
                        Ok((true, detail))
                    }
                    "give" => {
                        let mut params = json!({ "item": step["item"], "count": step["count"] });
                        if let Some(p) = player {
                            params["player"] = json!(p);
                        }
                        let r = self.bridge.call(&id, "world.give_item", params, 20000)?;
                        Ok((true, if r.is_null() { "null".into() } else { r.to_string() }))
                    }
                    "wait_ticks" => {
                        let ticks = step["ticks"].as_u64().unwrap_or(1);
                        self.bridge.call(&id, "game.wait_ticks", json!({ "ticks": ticks }), ticks * 100 + 10000)?;
                        Ok((true, format!("waited {ticks} ticks")))
                    }
                    "assert_registry" => {
                        let target = js::string(&step["id"]);
                        let r = self.bridge.call(&id, "registry.search", json!({ "registry": step["registry"], "query": target, "limit": 50 }), 20000)?;
                        let ok = r["entries"].as_array().is_some_and(|e| e.iter().any(|x| x["id"] == target.as_str()));
                        Ok((ok, if ok { format!("{target} is registered") } else { format!("{target} not found in {}", js::string(&step["registry"])) }))
                    }
                    "assert_block" => {
                        let r = self.bridge.call(&id, "world.block_at", json!({ "x": step["x"], "y": step["y"], "z": step["z"] }), 20000)?;
                        let props_ok = step["properties"].as_object().is_none_or(|p| p.iter().all(|(k, v)| r["properties"][k] == *v));
                        Ok((r["block"] == step["block"] && props_ok, format!("found {} {}", js::string(&r["block"]), r["properties"])))
                    }
                    "assert_inventory" => {
                        let r = self.bridge.call(&id, "player.inventory", player.map(|p| json!({ "player": p })).unwrap_or_else(|| json!({})), 20000)?;
                        let item = js::string(&step["item"]);
                        let count: f64 = r["items"].as_array().into_iter().flatten().filter(|i| i["item"] == item.as_str()).map(|i| i["count"].as_f64().unwrap_or(0.0)).sum();
                        Ok((count >= step["minCount"].as_f64().unwrap_or(1.0), format!("{item} x{}", js::number_string(count))))
                    }
                    "assert_log" => {
                        let re = Regex::new(step["pattern"].as_str().unwrap_or("")).map_err(|e| e.to_string())?;
                        let from = player.and_then(|p| t.client(p)).unwrap_or(&id).to_string();
                        let lines = self.instances.logs(&from, &Query { since: log_start.get(&from).copied(), limit: Some(50000), ..Default::default() })?;
                        let hit = lines["lines"].as_array().into_iter().flatten().find(|l| re.is_match(l["text"].as_str().unwrap_or(""))).map(|l| js::string(&l["text"]));
                        let absent = step["absent"] == true;
                        Ok((if absent { hit.is_none() } else { hit.is_some() }, hit.map(|h| format!("matched: {}", js::slice_utf16(&h, 200))).unwrap_or_else(|| "no match".into())))
                    }
                    "screenshot" => {
                        let r = self.bridge.call(&client_of(player), "client.screenshot", json!({}), 30000)?;
                        let label = safe_name(step["label"].as_str().unwrap_or("screenshot"));
                        let out = manifest::state_dir(dir).join("results").join("artifacts").join(format!("{}-{label}.png", crate::support::now_ms()));
                        if let Some(parent) = out.parent() {
                            fs::create_dir_all(parent).map_err(|e| js::fs_error(&e, "mkdir", parent))?;
                        }
                        let png = base64::engine::general_purpose::STANDARD.decode(r["png"].as_str().unwrap_or("")).map_err(|e| e.to_string())?;
                        fs::write(&out, png).map_err(|e| js::fs_error(&e, "open", &out))?;
                        artifacts.push(s(&out));
                        Ok((true, s(&out)))
                    }
                    _ => Ok((true, String::new())),
                }
            })();
            let (ok, detail) = outcome.unwrap_or_else(|e| (false, e));
            results.push(json!({ "phase": phase, "index": index, "action": action, "ok": ok, "detail": detail, "durationMs": t0.elapsed().as_millis() as u64 }));
            ctx.log(&format!("{} {phase}[{index}] {action}: {detail}", if ok { "PASS" } else { "FAIL" }));
            Ok(ok)
        };
        let arr = |k: &str| scenario[k].as_array().cloned().unwrap_or_default();
        let mut failed = false;
        let main = (|| -> Result<(), String> {
            for (i, st) in arr("setup").iter().enumerate() {
                if !run_step("setup", i, st, &mut results, &mut artifacts)? {
                    failed = true;
                    return Ok(());
                }
            }
            let steps = arr("steps");
            for (i, st) in steps.iter().enumerate() {
                ctx.progress(Some((i + 1) as f64 / steps.len() as f64), Some(&format!("Step {}/{}", i + 1, steps.len())));
                if !run_step("steps", i, st, &mut results, &mut artifacts)? {
                    failed = true;
                    return Ok(());
                }
            }
            Ok(())
        })();
        for (i, st) in arr("cleanup").iter().enumerate() {
            let _ = run_step("cleanup", i, st, &mut results, &mut artifacts);
        }
        if keep_running {
            let _ = self.bridge.call(&id, "client.keep_running", json!({ "enabled": false }), 5000);
        }
        main?;
        let passed = !failed && results.iter().all(|r| r["ok"] == true || r["phase"] == "cleanup");
        let name = js::string(&scenario["name"]);
        let mut out = Map::new();
        out.insert("scenario".into(), json!(name));
        out.insert("profile".into(), json!(profile));
        out.insert("instance".into(), json!(id));
        out.insert("startedAt".into(), json!(js::iso(started)));
        out.insert("durationMs".into(), json!(crate::support::now_ms() as i64 - started));
        out.insert("passed".into(), json!(passed));
        out.insert("launched".into(), json!(launched));
        if !t.players.is_empty() {
            out.insert("players".into(), json!(t.players));
        }
        out.insert("steps".into(), json!(results));
        out.insert("artifacts".into(), json!(artifacts));
        let result = Value::Object(out);
        let out_dir = manifest::state_dir(dir).join("results");
        fs::create_dir_all(&out_dir).map_err(|e| js::fs_error(&e, "mkdir", &out_dir))?;
        let _ = fs::write(out_dir.join(format!("{}-{}.json", crate::support::now_ms(), safe_name(&name))), js::pretty(&result));
        if !passed {
            let first = result["steps"].as_array().and_then(|s| s.iter().find(|r| r["ok"] != true)).map(|r| js::string(&r["detail"])).unwrap_or_else(|| "unknown".into());
            return Err(format!("Scenario failed: {first}"));
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn players_and_commands() {
        assert_eq!(as_player("/give @s minecraft:stone", Some("Alex")), "execute as Alex at Alex run give @s minecraft:stone");
        assert_eq!(as_player("time set day", None), "time set day");
        assert_eq!(players_of(&json!({ "server": "dev-server" })), vec!["Player1", "Player2"]);
        assert!(players_of(&json!({})).is_empty());
        assert!(check_players(&json!({ "server": "s", "players": ["Alex", "Steve"], "steps": [{ "action": "give", "player": "Steve" }] })).is_ok());
        assert_eq!(check_players(&json!({ "players": ["Alex"] })).unwrap_err(), "A scenario with players needs a server run configuration (\"server\")");
        assert_eq!(check_players(&json!({ "server": "s", "players": ["Alex", "alex"] })).unwrap_err(), "Each player in a scenario needs a different name");
        assert_eq!(check_players(&json!({ "server": "s", "players": ["Alex"], "cleanup": [{ "action": "screenshot", "player": "Bob" }] })).unwrap_err(), "cleanup[0] names player Bob, who is not one of the scenario's players (Alex)");
        assert_eq!(check_players(&json!({ "steps": [{ "action": "assert_log", "player": "Alex" }] })).unwrap_err(), "steps[0] names player Alex, but only multiplayer scenarios (with \"server\" and \"players\") can name players");
    }
}
