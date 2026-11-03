// macOS: Terminal.app through AppleScript, memory from `footprint`.
use super::{Caps, Platform, Tab};
use crate::proc::run;
use std::collections::{BTreeMap, HashMap};
use std::ffi::{CString, OsStr, OsString};
use std::fs::File;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

pub struct MacOs;

// Overridable so tests can stand in for Terminal.
static OSASCRIPT: LazyLock<String> = LazyLock::new(|| std::env::var("HANGAR_OSASCRIPT").unwrap_or_else(|_| "osascript".into()));
const T: Duration = Duration::from_secs(8);

// Inside a Terminal tell block `tab` means Terminal's tab class, so the separator is spelled out.
const TABS_SCRIPT: &str = r#"set out to ""
set sep to ASCII character 9
tell application "Terminal" to repeat with w in windows
repeat with t in tabs of w
set out to out & (tty of t) & sep & (busy of t) & sep & (custom title of t) & linefeed
end repeat
end repeat
return out"#;

fn as_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n"))
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn tab_script(tty: &str, body: &str) -> String {
    format!(
        "tell application \"Terminal\"\nrepeat with w in windows\nrepeat with t in tabs of w\nif tty of t is {} then\n{body}\nreturn \"ok\"\nend if\nend repeat\nend repeat\nend tell\nreturn \"missing\"",
        as_string(&format!("/dev/{tty}"))
    )
}

fn osascript(script: &str) -> String {
    run(&OSASCRIPT, &["-e", script], T).out
}

impl Platform for MacOs {
    fn caps(&self) -> Caps {
        Caps { tabs: true, focus: true }
    }

    fn data_dir(&self, home: &Path) -> PathBuf {
        home.join("Library/Application Support/Hangar")
    }

    fn claude_candidates(&self, home: &Path) -> Vec<PathBuf> {
        vec![home.join(".local/bin/claude"), home.join(".claude/local/claude"), "/opt/homebrew/bin/claude".into(), "/usr/local/bin/claude".into()]
    }

    fn which_claude(&self) -> (String, Vec<String>) {
        (std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()), vec!["-lc".into(), "command -v claude".into()])
    }

    fn tabs(&self) -> HashMap<String, Tab> {
        let lead = regex::Regex::new(r"^[^\p{L}\p{N}]+").unwrap();
        osascript(TABS_SCRIPT)
            .lines()
            .filter_map(|line| {
                let mut f = line.split('\t');
                let tty = f.next().filter(|t| !t.is_empty())?;
                let busy = f.next() == Some("true");
                let title = lead.replace(f.next().unwrap_or(""), "").trim().to_string();
                Some((tty.trim_start_matches("/dev/").to_string(), Tab { busy, title }))
            })
            .collect()
    }

    fn ttys(&self, pids: &[u32]) -> HashMap<u32, String> {
        let list = pids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        run("ps", &["-o", "pid=,tty=", "-p", &list], T)
            .out
            .lines()
            .filter_map(|l| {
                let mut f = l.split_whitespace();
                Some((f.next()?.parse().ok()?, f.next()?.to_string()))
            })
            .collect()
    }

    fn focus(&self, tty: &str) -> bool {
        osascript(&tab_script(tty, "set selected of t to true\nset index of w to 1\nactivate")).trim() == "ok"
    }

    fn open(&self, cwd: &str, id: &str, config: Option<&Path>) -> Result<(), String> {
        let env = match config {
            Some(dir) => format!("CLAUDE_CONFIG_DIR={} ", sh_quote(&dir.to_string_lossy())),
            None => "unset CLAUDE_CONFIG_DIR && ".into(),
        };
        // Terminal's shell may carry a Claude Code session's environment; see proc::SESSION_ENV.
        // Terminal learns a tab's directory (what a new tab inherits) from the OSC 7 the shell prints at each prompt, so
        // the cd needs a prompt of its own before claude takes the tab. It repeats on the second line to keep the guard.
        let dir = sh_quote(cwd);
        let cmd = format!("cd {dir}\ncd {dir} && unset {} && {env}claude --resume {id}", crate::proc::SESSION_ENV.join(" "));
        osascript(&format!("tell application \"Terminal\"\ndo script {}\nactivate\nend tell", as_string(&cmd)));
        Ok(())
    }

    // The tab is back at its shell prompt; exiting the shell lets Terminal close it.
    fn exit_tab(&self, tty: &str, only_if_idle: bool) {
        let body = if only_if_idle { "if busy of t is false then do script \"exit\" in t" } else { "do script \"exit\" in t" };
        osascript(&tab_script(tty, body));
    }

    // Footprint (not RSS) because most of these processes live in the compressor/swap.
    fn memory_mb(&self, pids: &[u32]) -> HashMap<u32, f64> {
        if pids.is_empty() {
            return HashMap::new();
        }
        let args: Vec<String> = pids.iter().flat_map(|p| ["-p".to_string(), p.to_string()]).collect();
        let out = run("footprint", &args.iter().map(String::as_str).collect::<Vec<_>>(), T).out;
        let re = regex::Regex::new(r"\[(\d+)\]:.*?Footprint: ([\d.]+) (KB|MB|GB)").unwrap();
        re.captures_iter(&out)
            .filter_map(|m| {
                let unit = match &m[3] { "KB" => 1.0 / 1024.0, "MB" => 1.0, _ => 1024.0 };
                Some((m[1].parse().ok()?, m[2].parse::<f64>().ok()? * unit))
            })
            .collect()
    }
}

/// A child that answers for its own privacy permissions, with piped stdout and stderr.
pub(crate) struct Disclaimed {
    pub pid: libc::pid_t,
    pub stdin: Option<File>,
    pub stdout: File,
    pub stderr: File,
}

extern "C" {
    // Public since macOS 10.15, missing from the libc crate.
    fn posix_spawn_file_actions_addchdir_np(actions: *mut libc::posix_spawn_file_actions_t, path: *const libc::c_char) -> libc::c_int;
}

fn cstring(s: &OsStr) -> Option<CString> {
    CString::new(s.as_bytes()).ok()
}

/// (read end, write end), neither inherited by default.
fn pipe() -> Option<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return None;
    }
    let ends = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    for fd in fds {
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    }
    Some(ends)
}

/// Spawns `cmd` (program, args, environment changes and directory) as its own responsible process. None when that can't
/// be done, the private call included: it is looked up at runtime so a macOS without it costs only the attribution.
/// Command can't carry the attribute, so this is posix_spawn by hand, with the same signal setup Command gives a child.
pub(crate) fn spawn_disclaimed(cmd: &Command, piped_stdin: bool) -> Option<Disclaimed> {
    let sym = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"responsibility_spawnattrs_setdisclaim".as_ptr()) };
    if sym.is_null() {
        return None;
    }
    let set_disclaim: unsafe extern "C" fn(*mut libc::posix_spawnattr_t, libc::c_int) -> libc::c_int = unsafe { std::mem::transmute(sym) };

    let argv = std::iter::once(cmd.get_program()).chain(cmd.get_args()).map(cstring).collect::<Option<Vec<_>>>()?;
    let mut vars: BTreeMap<OsString, OsString> = std::env::vars_os().collect();
    for (k, v) in cmd.get_envs() {
        match v {
            Some(v) => vars.insert(k.to_owned(), v.to_owned()),
            None => vars.remove(k),
        };
    }
    let envp = vars.iter().map(|(k, v)| cstring(&[k.as_os_str(), v.as_os_str()].join(OsStr::new("=")))).collect::<Option<Vec<_>>>()?;
    let dir = match cmd.get_current_dir() {
        Some(d) => Some(cstring(d.as_os_str())?),
        None => None,
    };
    let as_ptrs = |v: &[CString]| v.iter().map(|s| s.as_ptr() as *mut libc::c_char).chain([std::ptr::null_mut()]).collect::<Vec<_>>();
    let (c_argv, c_envp) = (as_ptrs(&argv), as_ptrs(&envp));

    let child_in = if piped_stdin { Some(pipe()?) } else { None };
    let (out_r, out_w) = pipe()?;
    let (err_r, err_w) = pipe()?;

    let mut pid = 0;
    let spawned = unsafe {
        let mut attr: libc::posix_spawnattr_t = std::ptr::null_mut();
        let mut actions: libc::posix_spawn_file_actions_t = std::ptr::null_mut();
        if libc::posix_spawnattr_init(&mut attr) != 0 {
            return None;
        }
        if libc::posix_spawn_file_actions_init(&mut actions) != 0 {
            libc::posix_spawnattr_destroy(&mut attr);
            return None;
        }
        let spawned = (|| {
            let ok = |rc: libc::c_int| (rc == 0).then_some(());
            let (mut no_signals, mut sigpipe) = (0, 0);
            libc::sigemptyset(&mut no_signals);
            libc::sigemptyset(&mut sigpipe);
            libc::sigaddset(&mut sigpipe, libc::SIGPIPE);
            ok(libc::posix_spawnattr_setsigmask(&mut attr, &no_signals))?;
            ok(libc::posix_spawnattr_setsigdefault(&mut attr, &sigpipe))?;
            let flags = libc::POSIX_SPAWN_SETSIGMASK | libc::POSIX_SPAWN_SETSIGDEF | libc::POSIX_SPAWN_CLOEXEC_DEFAULT;
            ok(libc::posix_spawnattr_setflags(&mut attr, flags as libc::c_short))?;
            ok(set_disclaim(&mut attr, 1))?;
            if let Some(d) = &dir {
                ok(posix_spawn_file_actions_addchdir_np(&mut actions, d.as_ptr()))?;
            }
            match &child_in {
                Some((r, _)) => ok(libc::posix_spawn_file_actions_adddup2(&mut actions, r.as_raw_fd(), 0))?,
                None => ok(libc::posix_spawn_file_actions_addopen(&mut actions, 0, c"/dev/null".as_ptr(), libc::O_RDONLY, 0))?,
            }
            ok(libc::posix_spawn_file_actions_adddup2(&mut actions, out_w.as_raw_fd(), 1))?;
            ok(libc::posix_spawn_file_actions_adddup2(&mut actions, err_w.as_raw_fd(), 2))?;
            ok(libc::posix_spawnp(&mut pid, c_argv[0], &actions, &attr, c_argv.as_ptr(), c_envp.as_ptr()))
        })();
        libc::posix_spawn_file_actions_destroy(&mut actions);
        libc::posix_spawnattr_destroy(&mut attr);
        spawned
    };
    spawned?;
    Some(Disclaimed { pid, stdin: child_in.map(|(_, w)| File::from(w)), stdout: File::from(out_r), stderr: File::from(err_r) })
}

/// Waits for a spawned child and kills it past the timeout (then None, as `run_with` does).
pub(crate) fn wait(pid: libc::pid_t, timeout: Duration) -> Option<ExitStatus> {
    let end = Instant::now() + timeout;
    let mut status = 0;
    loop {
        match unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) } {
            0 if Instant::now() < end => std::thread::sleep(Duration::from_millis(50)),
            0 => break,
            -1 if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted => {}
            -1 => return None,
            _ => return Some(ExitStatus::from_raw(status)),
        }
    }
    unsafe {
        libc::kill(pid, libc::SIGKILL);
        while libc::waitpid(pid, &mut status, 0) == -1 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {}
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proc::{command, run_disclaimed};

    fn responsible_for(pid: libc::pid_t) -> libc::pid_t {
        let sym = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"responsibility_get_pid_responsible_for_pid".as_ptr()) };
        assert!(!sym.is_null());
        let f: unsafe extern "C" fn(libc::pid_t) -> libc::pid_t = unsafe { std::mem::transmute(sym) };
        unsafe { f(pid) }
    }

    #[test]
    fn a_disclaimed_child_answers_for_itself_and_a_plain_one_does_not() {
        let mut sleep = Command::new("/bin/sleep");
        sleep.arg("5");
        let d = spawn_disclaimed(&sleep, false).expect("spawned");
        assert_eq!(responsible_for(d.pid), d.pid);
        assert!(wait(d.pid, Duration::from_millis(1)).is_none(), "killed at the timeout");

        let mut plain = sleep.spawn().unwrap();
        assert_ne!(responsible_for(plain.id() as libc::pid_t), plain.id() as libc::pid_t);
        plain.kill().unwrap();
        plain.wait().unwrap();
    }

    #[test]
    fn a_disclaimed_run_keeps_stdin_stdout_stderr_cwd_env_and_exit_code() {
        let dir = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        std::env::set_var("HANGAR_TEST_GONE", "still here");
        let mut cmd = command("/bin/sh");
        cmd.args(["-c", "cat; pwd; echo \"$KEPT[$HANGAR_TEST_GONE]\"; echo oops >&2; exit 3"]).current_dir(&dir).env("KEPT", "kept").env_remove("HANGAR_TEST_GONE");
        let out = run_disclaimed(&mut cmd, Some("typed\n"), Duration::from_secs(10));
        assert_eq!(out.out, format!("typed\n{}\nkept[]\n", dir.display()));
        assert_eq!(out.err, "exit 3: oops");
        assert!(!out.ok);
    }

    #[test]
    fn a_program_that_cannot_start_falls_back_and_reports_missing() {
        let out = run_disclaimed(&mut command("/nonexistent/claude"), None, Duration::from_secs(5));
        assert!(out.missing);
    }
}
