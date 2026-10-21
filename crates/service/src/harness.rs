use crate::js;
use crate::launch::Prepared;
use crate::logs::Query;
use crate::ops::OpCtx;
use crate::rt::Runtime;
use crate::sessions::{set_option, set_properties};
use regex::Regex;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const ENDED: [&str; 3] = ["exited", "crashed", "failed"];
const READY_TIMEOUT: Duration = Duration::from_secs(600);

pub struct TestWorld {
    pub name: String,
    pub seed: i64,
    pub flat: bool,
}

pub struct Restore(Vec<(PathBuf, Option<String>)>);

impl Restore {
    pub fn run(self) {
        for (file, original) in self.0 {
            match original {
                Some(t) => {
                    let _ = fs::write(&file, t);
                }
                None => {
                    let _ = fs::remove_file(&file);
                }
            }
        }
    }
}

fn swap(file: &Path, next: impl FnOnce(&str) -> String) -> Result<Restore, String> {
    let original = fs::read_to_string(file).ok();
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| js::fs_error(&e, "mkdir", parent))?;
    }
    fs::write(file, next(original.as_deref().unwrap_or(""))).map_err(|e| js::fs_error(&e, "open", file))?;
    Ok(Restore(vec![(file.to_path_buf(), original)]))
}

pub fn server_test_world(dir: &Path, world: &TestWorld) -> Result<Restore, String> {
    let _ = fs::remove_dir_all(dir.join(&world.name));
    let level_type = if world.flat { "minecraft\\:flat" } else { "minecraft\\:normal" };
    swap(&dir.join("server.properties"), |t| set_properties(t, &[("level-name", world.name.clone()), ("level-seed", world.seed.to_string()), ("level-type", level_type.into())]))
}

pub fn client_test_options(dir: &Path, extra: &[(&str, &str)]) -> Result<Restore, String> {
    swap(&dir.join("options.txt"), |t| {
        let mut text = t.to_string();
        for (k, v) in [("onboardAccessibility", "false"), ("pauseOnLostFocus", "false")].iter().chain(extra.iter()) {
            text = set_option(&text, k, v);
        }
        text
    })
}

pub fn prepare_test_world(p: &Prepared, world: &TestWorld, client_extra: &[(&str, &str)]) -> Result<Restore, String> {
    if p.side == "server" {
        return server_test_world(&p.idir, world);
    }
    let _ = fs::remove_dir_all(p.idir.join("saves").join(&world.name));
    client_test_options(&p.idir, client_extra)
}

impl Runtime {
    pub fn wait_for_game<T>(&self, ctx: &OpCtx, id: &str, what: &str, mut check: impl FnMut() -> Option<T>) -> Result<T, String> {
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

    pub fn wait_server_done(&self, ctx: &OpCtx, id: &str) -> Result<Value, String> {
        let done = Regex::new(r"Done \(\d").expect("done regex");
        self.wait_for_game(ctx, id, "the server to start", || {
            let q = Query { search: Some("Done (".into()), ..Default::default() };
            self.instances.logs(id, &q).ok()?["lines"].as_array()?.iter().find(|l| done.is_match(l["text"].as_str().unwrap_or(""))).cloned()
        })
    }

    pub fn wait_bridge(&self, ctx: &OpCtx, id: &str) -> Result<(), String> {
        self.wait_for_game(ctx, id, "the development bridge", || (self.bridge.status(id)["connected"] == true).then_some(()))
    }

    pub fn wait_title_screen(&self, ctx: &OpCtx, id: &str) -> Result<(), String> {
        self.wait_for_game(ctx, id, "the title screen", || {
            if self.bridge.status(id)["connected"] != true {
                return None;
            }
            (self.bridge.call(id, "client.status", json!({}), 5000).ok()?["loading"] == false).then_some(())
        })
    }

    pub fn enter_world(&self, ctx: &OpCtx, id: &str, world: &TestWorld) -> Result<f64, String> {
        let t0 = Instant::now();
        self.bridge.call(id, "world.open", json!({ "name": world.name, "create": true, "flat": world.flat, "seed": world.seed }), 120000)?;
        self.wait_for_game(ctx, id, "the world", || (self.bridge.call(id, "client.status", json!({}), 5000).ok()?["inWorld"] == true).then_some(()))?;
        Ok(t0.elapsed().as_millis() as f64)
    }

    pub fn wait_players_joined(&self, ctx: &OpCtx, server: &str, players: &[String]) -> Result<(), String> {
        self.wait_for_game(ctx, server, &format!("{} to join", players.join(", ")), || {
            let q = Query { search: Some("joined the game".into()), ..Default::default() };
            let lines: Vec<String> = self.instances.logs(server, &q).ok()?["lines"].as_array()?.iter().map(|l| js::string(&l["text"])).collect();
            players.iter().all(|p| lines.iter().any(|t| t.contains(&format!("{p} joined the game")))).then_some(())
        })
    }
}

pub struct Targets {
    pub main: String,
    pub clients: Vec<(String, String)>,
    pub players: Vec<String>,
}

impl Targets {
    pub fn single(id: &str) -> Self {
        Targets { main: id.to_string(), clients: vec![], players: vec![] }
    }

    pub fn client(&self, player: &str) -> Option<&str> {
        self.clients.iter().find(|(p, _)| p == player).map(|(_, id)| id.as_str())
    }
}
