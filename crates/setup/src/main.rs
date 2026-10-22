#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
mod install;
#[cfg(windows)]
mod system;
#[cfg(windows)]
mod ui;

#[cfg(windows)]
pub const PAYLOAD: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/payload.zip"));
#[cfg(windows)]
pub const VERSION: &str = env!("MODSMITH_SETUP_VERSION");

#[cfg(windows)]
pub struct Args {
    pub uninstall: bool,
    pub silent: bool,
    pub dir: Option<std::path::PathBuf>,
    pub no_desktop: bool,
    pub uninstall_from: Option<std::path::PathBuf>,
    pub test_root: Option<std::path::PathBuf>,
}

#[cfg(windows)]
fn parse_args() -> Args {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let value = |name: &str| raw.iter().position(|a| a == name).and_then(|i| raw.get(i + 1)).map(std::path::PathBuf::from);
    let has = |names: &[&str]| raw.iter().any(|a| names.iter().any(|n| a.eq_ignore_ascii_case(n)));
    let nsis_dir = raw.iter().find_map(|a| a.strip_prefix("/D=")).map(std::path::PathBuf::from);
    Args {
        uninstall: has(&["--uninstall"]),
        silent: has(&["--silent", "/S"]),
        dir: value("--dir").or(nsis_dir),
        no_desktop: has(&["--no-desktop-shortcut"]),
        uninstall_from: value("--uninstall-from"),
        test_root: value("--test-root"),
    }
}

#[cfg(windows)]
fn relaunch_from_temp(args: &Args, dir: &std::path::Path) -> Result<(), String> {
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let copy = std::env::temp_dir().join(format!("modsmith-uninstall-{}.exe", std::process::id()));
    std::fs::copy(&me, &copy).map_err(|e| format!("Could not prepare the uninstaller: {e}"))?;
    let mut cmd = std::process::Command::new(&copy);
    cmd.arg("--uninstall").arg("--uninstall-from").arg(dir);
    if args.silent {
        cmd.arg("--silent");
    }
    if let Some(root) = &args.test_root {
        cmd.arg("--test-root").arg(root);
    }
    let status = if args.silent { cmd.status().map(|s| s.success()).map_err(|e| e.to_string())? } else { cmd.spawn().map(|_| true).map_err(|e| e.to_string())? };
    if status {
        Ok(())
    } else {
        Err("Uninstall failed".into())
    }
}

#[cfg(windows)]
pub fn delete_self_later() {
    if let Ok(me) = std::env::current_exe() {
        system::delete_later(&[me], None);
    }
}

#[cfg(windows)]
fn run() -> i32 {
    system::init_com();
    let args = parse_args();
    let env = match &args.test_root {
        Some(root) => install::Env::test(root),
        None => install::Env::real(),
    };
    if args.uninstall {
        let Some(dir) = args.uninstall_from.clone() else {
            let here = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf()));
            let dir = here.unwrap_or_else(|| env.default_dir.clone());
            return match relaunch_from_temp(&args, &dir) {
                Ok(()) => 0,
                Err(e) => {
                    if !args.silent {
                        ui::message(&e);
                    }
                    1
                }
            };
        };
        if args.silent {
            let ok = matches!(install::stop_running(&env, &dir, true), install::Stop::Stopped) && install::uninstall(&env, &dir, false, &|_, _| {}).is_ok();
            delete_self_later();
            return if ok { 0 } else { 1 };
        }
        return ui::run(ui::Mode::Uninstall, dir, false, None, env);
    }
    let existing = install::existing(&env);
    let dir = args.dir.clone().or_else(|| existing.as_ref().map(|e| e.dir.clone())).unwrap_or_else(|| env.default_dir.clone());
    let desktop = if existing.is_some() { env.desktop_link().is_some_and(|l| l.exists()) } else { !args.no_desktop };
    if args.silent {
        if !matches!(install::stop_running(&env, &dir, true), install::Stop::Stopped) {
            return 2;
        }
        let opts = install::Options { dir, desktop: desktop && !args.no_desktop };
        return match install::install(&env, &opts, PAYLOAD, VERSION, &|_, _| {}) {
            Ok(()) => 0,
            Err(_) => 1,
        };
    }
    ui::run(ui::Mode::Install, dir, desktop, existing, env)
}

fn main() {
    #[cfg(windows)]
    std::process::exit(run());
    #[cfg(not(windows))]
    {
        eprintln!("Modsmith Setup only runs on Windows");
        std::process::exit(1);
    }
}
