use crate::ops::CANCELLED;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn hide(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd
}

pub fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = hide(Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())).status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-9", &format!("-{pid}")]).status();
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
    }
}

pub fn spawn_error(command: &str, e: &std::io::Error) -> String {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => "ENOENT".to_string(),
        std::io::ErrorKind::PermissionDenied => "EACCES".to_string(),
        _ => e.raw_os_error().map(|c| format!("UNKNOWN ({c})")).unwrap_or_else(|| "UNKNOWN".into()),
    };
    format!("spawn {command} {code}")
}

pub struct Capture {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

fn drain<R: Read + Send + 'static>(r: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut r) = r {
            let _ = r.read_to_end(&mut buf);
        }
        buf
    })
}

pub fn exec_capture(command: &str, args: &[&str], timeout_ms: u64, cwd: Option<&Path>) -> Capture {
    let mut cmd = Command::new(command);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    let mut child = match hide(&mut cmd).spawn() {
        Ok(c) => c,
        Err(_) => return Capture { code: 1, stdout: String::new(), stderr: String::new() },
    };
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut code = 1;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                code = status.code().unwrap_or(1);
                break;
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    let stdout = String::from_utf8_lossy(&out.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&err.join().unwrap_or_default()).into_owned();
    Capture { code, stdout, stderr }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

impl Stream {
    pub fn name(self) -> &'static str {
        match self {
            Stream::Stdout => "stdout",
            Stream::Stderr => "stderr",
        }
    }
}

pub fn split_lines(chunk: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(chunk);
    let text = text.strip_suffix('\n').unwrap_or(&text);
    let text = text.strip_suffix('\r').unwrap_or(text);
    text.split('\r').map(str::to_string).collect()
}

pub fn pump<R: Read + Send + 'static>(r: Option<R>, stream: Stream, tx: mpsc::Sender<(Stream, String)>) -> Option<std::thread::JoinHandle<()>> {
    let r = r?;
    Some(std::thread::spawn(move || {
        let mut reader = BufReader::new(r);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    for line in split_lines(&buf) {
                        if tx.send((stream, line)).is_err() {
                            return;
                        }
                    }
                }
            }
        }
    }))
}

pub struct RunOptions<'a> {
    pub cwd: Option<&'a Path>,
    pub env: Vec<(String, String)>,
    pub env_remove: Vec<String>,
    pub cancelled: &'a dyn Fn() -> bool,
    pub on_line: &'a mut dyn FnMut(&str, Stream),
}

pub fn run_process(command: &Path, args: &[String], opts: RunOptions) -> Result<Option<i32>, String> {
    if (opts.cancelled)() {
        return Err(CANCELLED.into());
    }
    let mut cmd = Command::new(command);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(d) = opts.cwd {
        cmd.current_dir(d);
    }
    for k in &opts.env_remove {
        cmd.env_remove(k);
    }
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }
    let mut child: Child = hide(&mut cmd).spawn().map_err(|e| spawn_error(&command.to_string_lossy(), &e))?;
    let (tx, rx) = mpsc::channel();
    let a = pump(child.stdout.take(), Stream::Stdout, tx.clone());
    let b = pump(child.stderr.take(), Stream::Stderr, tx);
    let mut cancelled = false;
    let mut status = None;
    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok((stream, line)) => (opts.on_line)(&line, stream),
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if !cancelled && (opts.cancelled)() {
            cancelled = true;
            kill_tree(child.id());
        }
    }
    for h in [a, b].into_iter().flatten() {
        let _ = h.join();
    }
    if let Ok(s) = child.wait() {
        status = s.code();
    }
    if cancelled {
        return Err(CANCELLED.into());
    }
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_like_readline() {
        assert_eq!(split_lines(b"a\r\n"), vec!["a"]);
        assert_eq!(split_lines(b"a\n"), vec!["a"]);
        assert_eq!(split_lines(b"a\rb\n"), vec!["a", "b"]);
        assert_eq!(split_lines(b"tail"), vec!["tail"]);
    }
}
