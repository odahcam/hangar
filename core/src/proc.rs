// Child processes and the process table, the same on every OS.
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::Duration;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use wait_timeout::ChildExt;

pub struct Output {
    pub ok: bool,
    pub out: String,
    pub err: String,
    /// The binary could not be started at all (not installed).
    pub missing: bool,
}

/// What Claude Code sets for the processes it runs. Hangar inherits them when it was started from a Claude Code
/// session, and a `claude` that sees them takes itself for that session's child: it writes no transcript of its own.
/// Only these go; the user's own CLAUDE_CODE_* settings (CLAUDE_CODE_GIT_BASH_PATH and the like) stay.
pub const SESSION_ENV: &[&str] = &[
    "CLAUDECODE", "CLAUDE_PID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_BRIDGE_SESSION_ID", "CLAUDE_CODE_BRIDGE_MCP_CARRIER",
    "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
];

/// A command for `bin`, without the environment of a Claude Code session Hangar may have been started from.
/// A `.js` path runs under `node`, so the test fakes in test/bin work on every OS (Windows can't exec a shebang script).
pub fn command(bin: &str) -> Command {
    let mut c = if bin.ends_with(".js") {
        let mut c = Command::new("node");
        c.arg(bin);
        c
    } else {
        Command::new(bin)
    };
    for k in SESSION_ENV {
        c.env_remove(k);
    }
    c
}

/// Runs a helper binary to completion; never fails: callers read ok/out/err.
pub fn run(bin: &str, args: &[&str], timeout: Duration) -> Output {
    run_with(command(bin).args(args), None, timeout)
}

pub fn run_with(cmd: &mut Command, stdin: Option<&str>, timeout: Duration) -> Output {
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Output { ok: false, out: String::new(), err: e.to_string(), missing: e.kind() == std::io::ErrorKind::NotFound },
    };
    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        let text = text.to_owned();
        std::thread::spawn(move || {
            use std::io::Write;
            let _ = pipe.write_all(text.as_bytes());
        });
    }
    // Pipes are drained on threads so a chatty child can't fill them and stall before the timeout.
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut s = String::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_string(&mut s);
            }
            s
        })
    };
    let out = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let status = match child.wait_timeout(timeout) {
        Ok(Some(s)) => Some(s),
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    };
    let (out, mut err) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());
    match status {
        Some(s) if !s.success() => err = format!("exit {}: {}", s.code().unwrap_or(-1), err.trim()),
        None => err = format!("timeout/killed: {}", err.trim()),
        _ => {}
    }
    Output { ok: status.is_some_and(|s| s.success()), out, err, missing: false }
}

/// Helpers run from a GUI app must not flash a console window on Windows.
#[cfg(windows)]
pub fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
pub fn no_window(_: &mut Command) {}

pub fn alive(pid: u32) -> bool {
    let mut sys = System::new();
    let p = Pid::from_u32(pid);
    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[p]), true, ProcessRefreshKind::new());
    sys.process(p).is_some_and(|p| !matches!(p.status(), sysinfo::ProcessStatus::Zombie | sysinfo::ProcessStatus::Dead))
}

/// SIGTERM where there are signals, so Claude Code can finish its writes; TerminateProcess on Windows.
pub fn terminate(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    #[cfg(not(unix))]
    {
        let mut sys = System::new();
        let p = Pid::from_u32(pid);
        sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[p]), true, ProcessRefreshKind::new());
        if let Some(p) = sys.process(p) {
            p.kill();
        }
    }
}

/// (pid, parent pid) for every process.
pub fn parents() -> Vec<(u32, u32)> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::new());
    sys.processes().iter().filter_map(|(pid, p)| Some((pid.as_u32(), p.parent()?.as_u32()))).collect()
}

/// (total RAM, swap in use), in MB.
pub fn memory_totals() -> (f64, f64) {
    let mut sys = System::new();
    sys.refresh_memory();
    (sys.total_memory() as f64 / 1048576.0, sys.used_swap() as f64 / 1048576.0)
}
