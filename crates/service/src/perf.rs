use crate::js;
use crate::launch::Prepared;
use crate::logs::Query;
use crate::manifest;
use crate::ops::OpCtx;
use crate::rt::{s, Runtime};
use crate::sessions::{set_option, set_properties};
use crate::workspace;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const WORLD: &str = "modsmith-benchmark";
const READY_TIMEOUT: Duration = Duration::from_secs(600);
const ENDED: [&str; 3] = ["exited", "crashed", "failed"];

pub const METRICS: [(&str, &str, &str, &str); 7] = [
    ("startupMs", "Startup", "ms", "lower"),
    ("worldMs", "World load", "ms", "lower"),
    ("msptMean", "Tick time", "ms", "lower"),
    ("msptP95", "Tick time, 95th percentile", "ms", "lower"),
    ("fpsMean", "Frame rate", "fps", "higher"),
    ("memoryMeanMb", "Memory used", "MB", "lower"),
    ("memoryMaxMb", "Peak memory", "MB", "lower"),
];

pub fn round3(x: f64) -> f64 {
    if x == 0.0 {
        return 0.0;
    }
    x.signum() * (x.abs() * 1000.0).round() / 1000.0
}

pub fn stats(values: &[f64]) -> Option<Value> {
    if values.is_empty() {
        return None;
    }
    let n = values.len() as f64;
    let mean = values.iter().sum::<f64>() / n;
    let variance = if values.len() > 1 { values.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / (n - 1.0) } else { 0.0 };
    let min = values.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    Some(json!({ "mean": round3(mean), "stdev": round3(variance.sqrt()), "min": round3(min), "max": round3(max), "n": values.len() }))
}

pub fn percentile(values: &[f64], p: f64) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = ((p * sorted.len() as f64).ceil() as usize).saturating_sub(1);
    sorted[idx.min(sorted.len() - 1)]
}

pub fn summarize_runs(runs: &[Value]) -> Value {
    let mut out = Map::new();
    for (key, ..) in METRICS {
        let vals: Vec<f64> = runs.iter().filter_map(|r| r.get(key).and_then(Value::as_f64)).collect();
        if let Some(st) = stats(&vals) {
            out.insert(key.into(), st);
        }
    }
    Value::Object(out)
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

pub fn compare_benchmarks(a: &Value, b: &Value) -> Value {
    let mut metrics = Vec::new();
    for (key, label, unit, better) in METRICS {
        let (sa, sb) = (&a["summary"][key], &b["summary"][key]);
        if !sa.is_object() || !sb.is_object() {
            continue;
        }
        let (ma, mb) = (num(&sa["mean"]), num(&sb["mean"]));
        let (da, db) = (num(&sa["stdev"]), num(&sb["stdev"]));
        let (na, nb) = (num(&sa["n"]), num(&sb["n"]));
        let delta = mb - ma;
        let noise = (2.0 * ((da * da) / na + (db * db) / nb).sqrt()).max(0.02 * ma.abs().max(mb.abs()));
        let improved = if better == "lower" { delta < 0.0 } else { delta > 0.0 };
        let verdict = if delta.abs() <= noise {
            "same"
        } else if improved {
            "better"
        } else {
            "worse"
        };
        let pct = if ma != 0.0 { json!(round3((delta / ma) * 100.0)) } else { Value::Null };
        metrics.push(json!({ "key": key, "label": label, "unit": unit, "better": better, "a": sa["mean"], "b": sb["mean"], "delta": round3(delta), "deltaPct": pct, "noise": round3(noise), "verdict": verdict }));
    }
    let mut warnings: Vec<String> = Vec::new();
    if a["side"] != b["side"] {
        warnings.push("The two results are from different sides (client and server).".into());
    }
    for k in ["runs", "warmupSeconds", "sampleSeconds", "seed", "flat", "scenario"] {
        if a["settings"].get(k).unwrap_or(&Value::Null) != b["settings"].get(k).unwrap_or(&Value::Null) {
            warnings.push(format!("The benchmark settings differ ({k})."));
        }
    }
    if a["environment"] != b["environment"] {
        warnings.push("The Minecraft or loader versions differ.".into());
    }
    let runs = |x: &Value| x["settings"]["runs"].as_f64().unwrap_or(1.0);
    if runs(a).min(runs(b)) < 2.0 {
        warnings.push("With a single run there is no measure of run-to-run noise; small differences may not be real.".into());
    }
    let head = |x: &Value| json!({ "id": x["id"], "label": x["label"], "profile": x["profile"], "createdAt": x["createdAt"], "commit": x["commit"] });
    json!({ "a": head(a), "b": head(b), "metrics": metrics, "warnings": warnings })
}

pub fn git_commit(dir: &Path) -> Option<String> {
    let head = fs::read_to_string(dir.join(".git").join("HEAD")).ok()?.trim().to_string();
    let Some(r) = head.strip_prefix("ref: ") else {
        return (head.len() == 40 && head.chars().all(|c| c.is_ascii_hexdigit())).then_some(head);
    };
    let mut loose = dir.join(".git");
    for part in r.split('/') {
        loose = loose.join(part);
    }
    if loose.exists() {
        return fs::read_to_string(loose).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    }
    let packed = fs::read_to_string(dir.join(".git").join("packed-refs")).ok()?;
    packed.lines().find(|l| l.ends_with(&format!(" {r}"))).and_then(|l| l.split(' ').next()).map(str::to_string)
}

fn benchmarks_dir(dir: &Path) -> PathBuf {
    manifest::state_dir(dir).join("benchmarks")
}

fn read_all(dir: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = fs::read_dir(benchmarks_dir(dir))
        .map(|rd| rd.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "json")).filter_map(|e| fs::read_to_string(e.path()).ok()).filter_map(|t| serde_json::from_str::<Value>(&t).ok()).collect())
        .unwrap_or_default();
    out.sort_by(|x, y| js::string(&y["createdAt"]).cmp(&js::string(&x["createdAt"])));
    out
}

fn mean(l: &[f64]) -> f64 {
    round3(l.iter().sum::<f64>() / l.len() as f64)
}

struct Settings {
    runs: u64,
    warmup: u64,
    sample: u64,
    seed: i64,
    flat: bool,
}

impl Runtime {
    pub fn perf_results(&self, root: &str) -> Value {
        Value::Array(read_all(&workspace::normalize(root)))
    }

    pub fn perf_compare(&self, root: &str, a: &str, b: &str) -> Result<Value, String> {
        let all = read_all(&workspace::normalize(root));
        let find = |id: &str| all.iter().find(|x| x["id"] == id).cloned().ok_or_else(|| format!("Unknown benchmark result {id}"));
        let (ra, rb) = (find(a)?, find(b)?);
        Ok(compare_benchmarks(&ra, &rb))
    }

    pub fn perf_delete(&self, root: &str, id: &str) -> Result<Value, String> {
        let file = benchmarks_dir(&workspace::normalize(root)).join(format!("{id}.json"));
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') || !file.exists() {
            return Err(format!("Unknown benchmark result {id}"));
        }
        fs::remove_file(&file).map_err(|e| js::fs_error(&e, "unlink", &file))?;
        Ok(json!({ "removed": id }))
    }

    pub fn perf_run(self: &Arc<Self>, p: &Value) -> Result<Value, String> {
        let profile_id = js::string(&p["profile"]);
        let prepared = self.prepare_launch(&js::string(&p["path"]), &profile_id, None, None)?;
        if prepared.profile["bridge"] != true {
            return Err(format!("Benchmarks read tick time, frame rate and memory through the development bridge. Turn on \"Development bridge\" for {profile_id}."));
        }
        let scenario = match p["scenario"].as_str() {
            Some(f) => Some(Self::load_scenario(&prepared.dir, f)?),
            None => None,
        };
        let st = Settings {
            runs: p["runs"].as_u64().unwrap_or(3),
            warmup: p["warmupSeconds"].as_u64().unwrap_or(20),
            sample: p["sampleSeconds"].as_u64().unwrap_or(30),
            seed: p["seed"].as_i64().unwrap_or(4242),
            flat: p["flat"] == true,
        };
        let settings = json!({ "runs": st.runs, "warmupSeconds": st.warmup, "sampleSeconds": st.sample, "seed": st.seed, "flat": st.flat, "scenario": p["scenario"].as_str() });
        let label = p["label"].as_str().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string);
        let me = self.clone();
        let title = format!("Benchmark {}", js::string(&prepared.profile["name"]));
        let dir = s(&prepared.dir);
        Ok(self.ops.start("perf.run", &title, Some(dir), move |ctx| {
            let side = prepared.side.clone();
            let file = prepared.idir.join(if side == "server" { "server.properties" } else { "options.txt" });
            let original = fs::read_to_string(&file).ok();
            let mut runs: Vec<Value> = Vec::new();
            let outcome = (|| -> Result<(), String> {
                for i in 0..st.runs {
                    ctx.check()?;
                    let at = |step: f64, msg: &str| ctx.progress(Some((i as f64 + step) / st.runs as f64), Some(&format!("Run {} of {}: {msg}", i + 1, st.runs)));
                    at(0.0, "starting");
                    let run = me.bench_once(&prepared, original.as_deref(), &st, scenario.as_ref(), &at, ctx)?;
                    ctx.log(&format!("Run {}: {}", i + 1, run));
                    runs.push(run);
                }
                Ok(())
            })();
            match &original {
                Some(t) => {
                    let _ = fs::write(&file, t);
                }
                None => {
                    let _ = fs::remove_file(&file);
                }
            }
            outcome?;
            let commit = git_commit(&prepared.dir);
            let name = js::string(&prepared.profile["name"]);
            let label = label.unwrap_or_else(|| match &commit {
                Some(c) => format!("{name} @ {}", &c[..7.min(c.len())]),
                None => name.clone(),
            });
            let id = crate::ops::uuid_v4()[..8].to_string();
            let result = json!({
                "id": id,
                "label": label,
                "profile": prepared.profile["id"],
                "side": side,
                "mode": prepared.mode,
                "createdAt": humantime::format_rfc3339_millis(std::time::SystemTime::now()).to_string(),
                "commit": commit,
                "environment": { "minecraft": prepared.m["platform"]["minecraft"], "loader": prepared.m["platform"]["loader"], "loaderVersion": prepared.m["platform"]["loaderVersion"] },
                "settings": settings,
                "runs": runs,
                "summary": summarize_runs(&runs),
            });
            let out = benchmarks_dir(&prepared.dir);
            fs::create_dir_all(&out).map_err(|e| js::fs_error(&e, "mkdir", &out))?;
            let target = out.join(format!("{id}.json"));
            fs::write(&target, js::pretty(&result)).map_err(|e| js::fs_error(&e, "open", &target))?;
            Ok(Some(result))
        }))
    }

    fn prepare_bench_world(p: &Prepared, original: Option<&str>, st: &Settings) -> Result<(), String> {
        fs::create_dir_all(&p.idir).map_err(|e| js::fs_error(&e, "mkdir", &p.idir))?;
        if p.side == "server" {
            let level_type = if st.flat { "minecraft\\:flat" } else { "minecraft\\:normal" };
            let text = set_properties(original.unwrap_or(""), &[("level-name", WORLD.into()), ("level-seed", st.seed.to_string()), ("level-type", level_type.into())]);
            let file = p.idir.join("server.properties");
            fs::write(&file, text).map_err(|e| js::fs_error(&e, "open", &file))?;
            let _ = fs::remove_dir_all(p.idir.join(WORLD));
        } else {
            let mut text = original.unwrap_or("").to_string();
            for (k, v) in [("onboardAccessibility", "false"), ("pauseOnLostFocus", "false"), ("enableVsync", "false"), ("maxFps", "260"), ("inactivityFpsLimit", "\"minimized\"")] {
                text = set_option(&text, k, v);
            }
            let file = p.idir.join("options.txt");
            fs::write(&file, text).map_err(|e| js::fs_error(&e, "open", &file))?;
            let _ = fs::remove_dir_all(p.idir.join("saves").join(WORLD));
        }
        Ok(())
    }

    fn wait_for<T>(&self, ctx: &OpCtx, id: &str, what: &str, mut check: impl FnMut() -> Option<T>) -> Result<T, String> {
        let begin = Instant::now();
        loop {
            ctx.check()?;
            let status = self.instances.get(id).map(|i| js::string(&i["status"])).unwrap_or_else(|| "gone".into());
            if ENDED.contains(&status.as_str()) || status == "gone" {
                return Err(format!("The game stopped while waiting for {what} ({status})"));
            }
            if let Some(v) = check() {
                return Ok(v);
            }
            if begin.elapsed() > READY_TIMEOUT {
                return Err(format!("Timed out waiting for {what}"));
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    fn bench_once(&self, p: &Prepared, original: Option<&str>, st: &Settings, scenario: Option<&Value>, at: &dyn Fn(f64, &str), ctx: &OpCtx) -> Result<Value, String> {
        Self::prepare_bench_world(p, original, st)?;
        let info = self.run_prepared(p, None, ctx)?;
        let id = js::string(&info["id"]);
        let started = info["startedAt"].as_f64().unwrap_or(0.0);
        let mut run = Map::new();
        let result = (|| -> Result<(), String> {
            if p.side == "server" {
                at(0.2, "waiting for the server");
                let done_re = Regex::new(r"Done \(\d").expect("done regex");
                let done = self.wait_for(ctx, &id, "the server to start", || {
                    let q = Query { search: Some("Done (".into()), ..Default::default() };
                    self.instances.logs(&id, &q).ok()?["lines"].as_array()?.iter().find(|l| done_re.is_match(l["text"].as_str().unwrap_or(""))).cloned()
                })?;
                run.insert("startupMs".into(), json!(num(&done["ts"]) - started));
                if let Some(c) = Regex::new(r"Done \((\d+(?:\.\d+)?)s\)").expect("reported regex").captures(done["text"].as_str().unwrap_or("")) {
                    run.insert("reportedStartupSeconds".into(), json!(c[1].parse::<f64>().unwrap_or(0.0)));
                }
                self.wait_for(ctx, &id, "the bridge", || (self.bridge.status(&id)["connected"] == true).then_some(()))?;
            } else {
                at(0.2, "waiting for the title screen");
                self.wait_for(ctx, &id, "the title screen", || {
                    if self.bridge.status(&id)["connected"] != true {
                        return None;
                    }
                    (self.bridge.call(&id, "client.status", json!({}), 5000).ok()?["loading"] == false).then_some(())
                })?;
                run.insert("startupMs".into(), json!(crate::support::now_ms() as f64 - started));
                at(0.3, "creating the benchmark world");
                let t0 = Instant::now();
                self.bridge.call(&id, "world.open", json!({ "name": WORLD, "create": true, "flat": st.flat, "seed": st.seed }), 120000)?;
                self.wait_for(ctx, &id, "the world", || (self.bridge.call(&id, "client.status", json!({}), 5000).ok()?["inWorld"] == true).then_some(()))?;
                run.insert("worldMs".into(), json!(t0.elapsed().as_millis() as f64));
            }
            if let Some(sc) = scenario {
                at(0.4, &format!("running {}", js::string(&sc["name"])));
                self.execute_scenario(&p.dir, sc, Some(&id), ctx)?;
            }
            for w in 0..st.warmup * 2 {
                at(0.5, &format!("warming up ({} s)", ((st.warmup * 2 - w) as f64 / 2.0).ceil()));
                ctx.check()?;
                std::thread::sleep(Duration::from_millis(500));
            }
            let (mut mspt, mut fps, mut memory) = (Vec::new(), Vec::new(), Vec::new());
            for k in 0..st.sample {
                ctx.check()?;
                at(0.6 + 0.3 * k as f64 / st.sample as f64, &format!("measuring ({} s)", st.sample - k));
                let tick = Instant::now();
                let t = self.bridge.call(&id, "game.telemetry", json!({}), 5000)?;
                if let Some(v) = t["mspt"].as_f64() {
                    mspt.push(v);
                }
                if let Some(v) = t["memory"]["usedMb"].as_f64() {
                    memory.push(v);
                }
                if p.side == "client" {
                    if let Some(v) = self.bridge.call(&id, "client.status", json!({}), 5000)?["fps"].as_f64() {
                        fps.push(v);
                    }
                }
                std::thread::sleep(Duration::from_millis(1000).saturating_sub(tick.elapsed()));
            }
            run.insert("samples".into(), json!(mspt.len().max(memory.len())));
            if !mspt.is_empty() {
                run.insert("msptMean".into(), json!(mean(&mspt)));
                run.insert("msptP95".into(), json!(round3(percentile(&mspt, 0.95))));
            }
            if !fps.is_empty() {
                run.insert("fpsMean".into(), json!(mean(&fps)));
            }
            if !memory.is_empty() {
                run.insert("memoryMeanMb".into(), json!(mean(&memory)));
                run.insert("memoryMaxMb".into(), json!(round3(memory.iter().cloned().fold(f64::NEG_INFINITY, f64::max))));
            }
            Ok(())
        })();
        at(0.95, "stopping");
        let _ = self.stop_instance(&id, false);
        result.map(|_| Value::Object(run))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarizes_and_compares() {
        let st = stats(&[10.0, 12.0, 14.0]).unwrap();
        assert_eq!(st, json!({ "mean": 12.0, "stdev": 2.0, "min": 10.0, "max": 14.0, "n": 3 }));
        assert_eq!(percentile(&[5.0, 1.0, 3.0, 2.0, 4.0], 0.95), 5.0);
        let a = json!({ "id": "a", "side": "server", "settings": { "runs": 3 }, "environment": {}, "summary": { "msptMean": { "mean": 10.0, "stdev": 0.5, "n": 3 }, "memoryMeanMb": { "mean": 1000.0, "stdev": 10.0, "n": 3 } } });
        let b = json!({ "id": "b", "side": "server", "settings": { "runs": 3 }, "environment": {}, "summary": { "msptMean": { "mean": 8.0, "stdev": 0.5, "n": 3 }, "memoryMeanMb": { "mean": 1005.0, "stdev": 10.0, "n": 3 } } });
        let c = compare_benchmarks(&a, &b);
        assert_eq!(c["metrics"][0]["key"], "msptMean");
        assert_eq!(c["metrics"][0]["verdict"], "better");
        assert_eq!(c["metrics"][0]["deltaPct"], -20.0);
        assert_eq!(c["metrics"][1]["verdict"], "same");
        assert_eq!(c["warnings"], json!([]));
    }
}
