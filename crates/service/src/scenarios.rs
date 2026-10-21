use crate::js;
use crate::logs::Query;
use crate::manifest::{self, schemas};
use crate::ops::OpCtx;
use crate::rt::{s, Runtime};
use crate::schema;
use crate::workspace;
use base64::Engine;
use regex::Regex;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
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

    pub fn scenario_run(self: &Arc<Self>, workspace: &str, file: &str, instance: Option<String>) -> Result<Value, String> {
        let dir = workspace::normalize(workspace);
        let scenario = Self::load_scenario(&dir, file)?;
        let me = self.clone();
        let title = format!("Scenario {}", js::string(&scenario["name"]));
        Ok(self.ops.start("scenario.run", &title, Some(s(&dir)), move |ctx| me.execute_scenario(&dir, &scenario, instance.as_deref(), ctx).map(Some)))
    }

    pub fn execute_scenario(&self, dir: &Path, scenario: &Value, instance: Option<&str>, ctx: &OpCtx) -> Result<Value, String> {
        let started = crate::support::now_ms() as i64;
        let timeout = scenario["timeoutMs"].as_i64().unwrap_or(120000);
        let deadline = started + timeout;
        let profile = js::string(&scenario["profile"]);
        let ws = s(dir);
        let inst = match instance {
            Some(i) => self.instances.get(i),
            None => self.instances.list().into_iter().find(|i| i["workspace"] == ws.as_str() && i["profileId"] == profile.as_str() && (i["status"] == "running" || i["status"] == "starting")),
        };
        let inst = inst.ok_or_else(|| format!("No running instance of profile {profile}. Launch it first and enter a world."))?;
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
        let log_start = self.instances.logs(&id, &Query { limit: Some(1), ..Default::default() })?["lastSeq"].as_u64().unwrap_or(0);
        let mut results: Vec<Value> = Vec::new();
        let mut artifacts: Vec<String> = Vec::new();
        let run_step = |phase: &str, index: usize, step: &Value, results: &mut Vec<Value>, artifacts: &mut Vec<String>| -> Result<bool, String> {
            if crate::support::now_ms() as i64 > deadline {
                return Err(format!("Scenario timed out after {timeout} ms"));
            }
            ctx.check()?;
            let t0 = Instant::now();
            let action = js::string(&step["action"]);
            let outcome = (|| -> Result<(bool, String), String> {
                match action.as_str() {
                    "command" => {
                        let r = self.bridge.call(&id, "world.run_command", json!({ "command": step["command"] }), 20000)?;
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
                        let r = self.bridge.call(&id, "world.give_item", json!({ "item": step["item"], "count": step["count"] }), 20000)?;
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
                        let r = self.bridge.call(&id, "player.inventory", json!({}), 20000)?;
                        let item = js::string(&step["item"]);
                        let count: f64 = r["items"].as_array().into_iter().flatten().filter(|i| i["item"] == item.as_str()).map(|i| i["count"].as_f64().unwrap_or(0.0)).sum();
                        Ok((count >= step["minCount"].as_f64().unwrap_or(1.0), format!("{item} x{}", js::number_string(count))))
                    }
                    "assert_log" => {
                        let re = Regex::new(step["pattern"].as_str().unwrap_or("")).map_err(|e| e.to_string())?;
                        let lines = self.instances.logs(&id, &Query { since: Some(log_start), limit: Some(50000), ..Default::default() })?;
                        let hit = lines["lines"].as_array().into_iter().flatten().find(|l| re.is_match(l["text"].as_str().unwrap_or(""))).map(|l| js::string(&l["text"]));
                        let absent = step["absent"] == true;
                        Ok((if absent { hit.is_none() } else { hit.is_some() }, hit.map(|h| format!("matched: {}", js::slice_utf16(&h, 200))).unwrap_or_else(|| "no match".into())))
                    }
                    "screenshot" => {
                        let r = self.bridge.call(&id, "client.screenshot", json!({}), 30000)?;
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
        main?;
        let passed = !failed && results.iter().all(|r| r["ok"] == true || r["phase"] == "cleanup");
        let name = js::string(&scenario["name"]);
        let result = json!({
            "scenario": name,
            "profile": profile,
            "instance": id,
            "startedAt": js::iso(started),
            "durationMs": crate::support::now_ms() as i64 - started,
            "passed": passed,
            "steps": results,
            "artifacts": artifacts
        });
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
