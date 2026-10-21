use crate::js;
use crate::launch::{find_profile, Prepared, Seat};
use crate::logs::Query;
use crate::manifest;
use crate::ops::OpCtx;
use crate::rt::{s, Runtime};
use crate::workspace;
use regex::Regex;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const DONE_TIMEOUT: Duration = Duration::from_secs(600);
const ENDED: [&str; 3] = ["exited", "crashed", "failed"];

pub fn property(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|l| {
        let t = l.trim_start();
        if t.starts_with('#') || t.starts_with('!') {
            return None;
        }
        let (k, v) = t.split_once(['=', ':'])?;
        (k.trim() == key).then(|| v.trim().to_string())
    })
}

pub fn set_properties(text: &str, pairs: &[(&str, String)]) -> String {
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = if text.is_empty() { vec![] } else { text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect() };
    if lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    for (key, value) in pairs {
        let hit = lines.iter_mut().find(|l| {
            let t = l.trim_start();
            !t.starts_with('#') && !t.starts_with('!') && t.split_once(['=', ':']).is_some_and(|(k, _)| k.trim() == *key)
        });
        match hit {
            Some(l) => *l = format!("{key}={value}"),
            None => lines.push(format!("{key}={value}")),
        }
    }
    let mut out = lines.join(eol);
    out.push_str(eol);
    out
}

pub fn set_option(text: &str, key: &str, value: &str) -> String {
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let prefix = format!("{key}:");
    match lines.iter_mut().find(|l| l.starts_with(&prefix)) {
        Some(l) => *l = format!("{key}:{value}"),
        None => lines.push(format!("{key}:{value}")),
    }
    let mut out = lines.join(eol);
    out.push_str(eol);
    out
}

fn skip_onboarding(game_dir: &std::path::Path) -> Result<(), String> {
    let file = game_dir.join("options.txt");
    let text = fs::read_to_string(&file).unwrap_or_default();
    let next = set_option(&text, "onboardAccessibility", "false");
    if next != text {
        fs::create_dir_all(game_dir).map_err(|e| js::fs_error(&e, "mkdir", game_dir))?;
        fs::write(&file, next).map_err(|e| js::fs_error(&e, "open", &file))?;
    }
    Ok(())
}

fn port_free(p: u16) -> bool {
    std::net::TcpListener::bind(("0.0.0.0", p)).is_ok() && std::net::TcpListener::bind(("127.0.0.1", p)).is_ok()
}

fn server_port(preferred: u16) -> Result<u16, String> {
    (preferred..preferred.saturating_add(50)).find(|p| port_free(*p)).ok_or_else(|| format!("No free server port near {preferred}"))
}

pub fn player_names(count: u64, names: &Value) -> Result<Vec<String>, String> {
    if !(1..=4).contains(&count) {
        return Err("A session needs between 1 and 4 clients".into());
    }
    let given: Vec<String> = names.as_array().map(|a| a.iter().map(js::string).map(|n| n.trim().to_string()).collect()).unwrap_or_default();
    let valid = Regex::new(r"^[A-Za-z0-9_]{3,16}$").expect("name regex");
    let mut out: Vec<String> = Vec::new();
    for i in 0..count as usize {
        let name = given.get(i).filter(|n| !n.is_empty()).cloned().unwrap_or_else(|| format!("Player{}", i + 1));
        if !valid.is_match(&name) {
            return Err(format!("Player name \"{name}\" must be 3 to 16 letters, digits or underscores"));
        }
        if out.iter().any(|o| o.eq_ignore_ascii_case(&name)) {
            return Err(format!("Player name \"{name}\" is used twice"));
        }
        out.push(name);
    }
    Ok(out)
}

fn short_id() -> String {
    crate::ops::uuid_v4()[..8].to_string()
}

pub struct SessionPlan {
    pub id: String,
    pub dir: PathBuf,
    pub server: Prepared,
    pub server_seat: Seat,
    pub seats: Vec<(Seat, Prepared)>,
    pub names: Vec<String>,
}

impl Runtime {
    fn session_update(&self, id: &str, f: impl FnOnce(&mut Value)) {
        let mut all = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(rec) = all.iter_mut().find(|r| r["id"] == id) {
            f(rec);
        }
    }

    fn session_instances(rec: &Value) -> Vec<String> {
        let mut ids: Vec<String> = rec["clients"].as_array().into_iter().flatten().filter_map(|c| c["instance"].as_str().map(str::to_string)).collect();
        if let Some(sv) = rec["server"]["instance"].as_str() {
            ids.push(sv.to_string());
        }
        ids
    }

    fn live(&self, id: &str) -> bool {
        self.instances.get(id).is_some_and(|i| !ENDED.contains(&i["status"].as_str().unwrap_or("")))
    }

    pub fn session_prepare(&self, p: &Value) -> Result<SessionPlan, String> {
        let root = js::string(&p["path"]);
        let server_id = js::string(&p["server"]);
        let client_id = js::string(&p["client"]);
        let count = match p["clients"].as_u64() {
            Some(n) => n,
            None if p["clients"].is_null() => p["names"].as_array().map_or(2, |a| a.len() as u64),
            None => 0,
        };
        let names = player_names(count, &p["names"])?;
        let dir = workspace::normalize(&root);
        let m = manifest::require_manifest(&dir, &root)?;
        for (id, side) in [(&server_id, "server"), (&client_id, "client")] {
            let profile = find_profile(&m, id).ok_or_else(|| format!("Unknown profile {id}"))?;
            if profile["side"] != side {
                return Err(format!("Profile {id} is not a {side} profile"));
            }
        }
        let session = short_id();
        let server_seat = Seat { session: session.clone(), slot: 0, player: None, join: None };
        let server = self.prepare_launch(&root, &server_id, None, Some(&server_seat))?;
        let mut seats: Vec<(Seat, Prepared)> = Vec::new();
        for (i, name) in names.iter().enumerate() {
            let seat = Seat { session: session.clone(), slot: i as u32 + 1, player: Some(name.clone()), join: None };
            let prepared = self.prepare_launch(&root, &client_id, None, Some(&seat))?;
            seats.push((seat, prepared));
        }
        let record = json!({
            "id": session,
            "workspace": s(&dir),
            "status": "starting",
            "port": null,
            "startedAt": crate::support::now_ms(),
            "server": { "profile": server_id, "instance": null },
            "clients": names.iter().enumerate().map(|(i, n)| json!({ "profile": client_id, "slot": i + 1, "player": n, "instance": null })).collect::<Vec<_>>(),
        });
        self.sessions.lock().unwrap_or_else(|e| e.into_inner()).push(record);
        Ok(SessionPlan { id: session, dir, server, server_seat, seats, names })
    }

    pub fn session_launch(&self, plan: &SessionPlan, ctx: &OpCtx) -> Result<Value, String> {
        let op_id = ctx.id.clone();
        self.session_update(&plan.id, |r| r["operationId"] = json!(op_id));
        let started: Mutex<Vec<String>> = Mutex::new(Vec::new());
        let out = self.run_session(&plan.id, &plan.server, &plan.server_seat, &plan.seats, &started, ctx);
        match &out {
            Ok(_) => self.session_update(&plan.id, |r| r["status"] = json!("running")),
            Err(e) => {
                ctx.log(&format!("Session failed: {e}"));
                let ids = started.lock().unwrap_or_else(|e| e.into_inner()).clone();
                for id in ids.iter().rev() {
                    let _ = self.stop_instance(id, false);
                }
                self.session_update(&plan.id, |r| r["status"] = json!("failed"));
            }
        }
        out
    }

    pub fn session_release(&self, id: &str) {
        self.session_update(id, |r| {
            if let Some(o) = r.as_object_mut() {
                o.shift_remove("operationId");
            }
        });
    }

    pub fn session_start(self: &Arc<Self>, p: &Value) -> Result<Value, String> {
        let plan = self.session_prepare(p)?;
        let me = self.clone();
        let title = format!("Multiplayer test: {} + {} {}", js::string(&plan.server.profile["name"]), plan.names.len(), if plan.names.len() == 1 { "client" } else { "clients" });
        let dir = s(&plan.dir);
        Ok(self.ops.start("session.start", &title, Some(dir), move |ctx| me.session_launch(&plan, ctx).map(Some)))
    }

    fn run_session(&self, sid: &str, server: &Prepared, server_seat: &Seat, seats: &[(Seat, Prepared)], started: &Mutex<Vec<String>>, ctx: &OpCtx) -> Result<Value, String> {
        let props = server.idir.join("server.properties");
        let text = fs::read_to_string(&props).unwrap_or_default();
        let preferred = property(&text, "server-port").and_then(|v| v.parse::<u16>().ok()).unwrap_or(25565);
        let port = server_port(preferred)?;
        fs::create_dir_all(&server.idir).map_err(|e| js::fs_error(&e, "mkdir", &server.idir))?;
        fs::write(&props, set_properties(&text, &[("online-mode", "false".into()), ("server-port", port.to_string())])).map_err(|e| js::fs_error(&e, "open", &props))?;
        ctx.log(&format!("server.properties: online-mode=false, server-port={port}"));
        self.session_update(sid, |r| r["port"] = json!(port));
        ctx.progress(Some(0.05), Some("Starting the server"));
        let info = self.run_prepared(server, Some(server_seat), ctx)?;
        let server_instance = js::string(&info["id"]);
        started.lock().unwrap_or_else(|e| e.into_inner()).push(server_instance.clone());
        self.session_update(sid, |r| r["server"]["instance"] = json!(server_instance));
        ctx.progress(Some(0.3), Some("Waiting for the server to finish starting"));
        self.wait_until_done(&server_instance, ctx)?;
        ctx.log(&format!("Server is ready on port {port}"));
        let total = seats.len();
        let mut clients = Vec::new();
        for (i, (seat, prepared)) in seats.iter().enumerate() {
            ctx.check()?;
            let mut seat = seat.clone();
            let player = seat.player.clone().unwrap_or_default();
            ctx.progress(Some(0.4 + 0.6 * i as f64 / total as f64), Some(&format!("Starting client {} ({player})", seat.slot)));
            seat.join = Some(format!("127.0.0.1:{port}"));
            skip_onboarding(&prepared.idir)?;
            let info = self.run_prepared(prepared, Some(&seat), ctx)?;
            let instance = js::string(&info["id"]);
            started.lock().unwrap_or_else(|e| e.into_inner()).push(instance.clone());
            let slot = seat.slot as usize;
            self.session_update(sid, |r| r["clients"][slot - 1]["instance"] = json!(instance));
            clients.push(json!({ "instance": instance, "player": player, "slot": seat.slot }));
        }
        Ok(json!({ "id": sid, "port": port, "server": { "instance": server_instance }, "clients": clients }))
    }

    fn wait_until_done(&self, id: &str, ctx: &OpCtx) -> Result<(), String> {
        let done = Regex::new(r"Done \(\d").expect("done regex");
        let begin = Instant::now();
        loop {
            ctx.check()?;
            let info = self.instance_or_err(id)?;
            let status = js::string(&info["status"]);
            if ENDED.contains(&status.as_str()) {
                return Err(format!("The server stopped before it finished starting ({status})"));
            }
            let q = Query { search: Some("Done (".into()), ..Default::default() };
            let logs = self.instances.logs(id, &q)?;
            if logs["lines"].as_array().into_iter().flatten().any(|l| done.is_match(l["text"].as_str().unwrap_or(""))) {
                return Ok(());
            }
            if begin.elapsed() > DONE_TIMEOUT {
                return Err("The server did not finish starting within 10 minutes".into());
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    pub fn session_list(&self, root: Option<&str>) -> Vec<Value> {
        let ws = root.map(|r| s(&workspace::normalize(r)));
        let all = self.sessions.lock().unwrap_or_else(|e| e.into_inner()).clone();
        all.into_iter()
            .filter(|r| ws.as_ref().is_none_or(|w| r["workspace"] == w.as_str()))
            .map(|mut r| {
                if r["status"] == "running" && !Self::session_instances(&r).iter().any(|i| self.live(i)) {
                    r["status"] = json!("stopped");
                }
                r
            })
            .rev()
            .collect()
    }

    pub fn session_stop(&self, id: &str) -> Result<Value, String> {
        let rec = self.sessions.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|r| r["id"] == id).cloned().ok_or_else(|| format!("Unknown session {id}"))?;
        if let Some(op) = rec["operationId"].as_str() {
            self.ops.cancel(op);
        }
        let clients: Vec<String> = rec["clients"].as_array().into_iter().flatten().filter_map(|c| c["instance"].as_str().map(str::to_string)).collect();
        std::thread::scope(|scope| {
            for c in &clients {
                scope.spawn(move || {
                    if self.live(c) {
                        let _ = self.stop_instance(c, false);
                    }
                });
            }
        });
        if let Some(sv) = rec["server"]["instance"].as_str().filter(|i| self.live(i)) {
            self.stop_instance(sv, false)?;
        }
        self.session_update(id, |r| r["status"] = json!("stopped"));
        self.sessions.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|r| r["id"] == id).cloned().ok_or_else(|| format!("Unknown session {id}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sets_properties_in_place() {
        let text = "#Minecraft server properties\r\nonline-mode=true\r\nmotd=Hi\r\n";
        assert_eq!(set_properties(text, &[("online-mode", "false".into()), ("server-port", "25566".into())]), "#Minecraft server properties\r\nonline-mode=false\r\nmotd=Hi\r\nserver-port=25566\r\n");
        assert_eq!(set_properties("", &[("online-mode", "false".into())]), "online-mode=false\n");
        assert_eq!(property("# server-port=1\nserver-port = 25570\n", "server-port").as_deref(), Some("25570"));
        assert_eq!(set_option("", "onboardAccessibility", "false"), "onboardAccessibility:false\n");
        assert_eq!(set_option("version:3955\r\nonboardAccessibility:true\r\n", "onboardAccessibility", "false"), "version:3955\r\nonboardAccessibility:false\r\n");
    }

    #[test]
    fn checks_player_names() {
        assert_eq!(player_names(2, &Value::Null).unwrap(), vec!["Player1", "Player2"]);
        assert_eq!(player_names(2, &json!(["Steve", ""])).unwrap(), vec!["Steve", "Player2"]);
        assert!(player_names(0, &Value::Null).is_err());
        assert!(player_names(5, &Value::Null).is_err());
        assert_eq!(player_names(1, &json!(["no spaces"])).unwrap_err(), "Player name \"no spaces\" must be 3 to 16 letters, digits or underscores");
        assert_eq!(player_names(2, &json!(["Alex", "alex"])).unwrap_err(), "Player name \"alex\" is used twice");
    }
}
