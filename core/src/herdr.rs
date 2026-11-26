// Claude sessions in herdr-core (`hc`) terminals come back after the computer restarts. hc's recovery (`hc keep`)
// replaces a lost program with a fresh shell and never reruns it, so Hangar keeps a note on each terminal, in hc labels:
// the session running in it (hangar.session) and the terminal's pid at the time (hangar.pid). A recovered terminal has
// a new pid; one whose claude just exited keeps its pid, and its note is dropped. A recovered terminal whose shell sits
// at its prompt gets the session's resume line typed into it, in the same pane: on every tick (so after a reboot, once
// Hangar is up), from the global button and `Hangar --restore`, and from the session's own Resume.
// Settings (in meta): the integration on or off (off drops the notes and leaves Resume opening a tab), restoring on
// the tick or only when asked, and the hc to call.
use crate::{db, proc};
use crate::{ApiError, ApiResult, Hangar};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const SESSION: &str = "hangar.session";
const PID: &str = "hangar.pid";
const TICK: Duration = Duration::from_secs(15);
const HC_WAIT: Duration = Duration::from_secs(10);
const ON: &str = "herdr_on";
const AUTO: &str = "herdr_auto";
const HC_PATH: &str = "herdr_hc";

/// The notes were dropped since the integration went off; the tick drops them once, then leaves hc alone.
static FORGOTTEN: AtomicBool = AtomicBool::new(false);

pub(crate) struct Term {
    pub addr: String,
    pub pid: u32,
    /// The terminal's foreground process; equal to `pid` when its own shell sits at the prompt.
    pub fg_pid: Option<u32>,
    pub fg_name: String,
    labels: HashMap<String, String>,
}

impl Term {
    fn label(&self, k: &str) -> Option<&str> {
        self.labels.get(k).map(String::as_str).filter(|v| !v.is_empty())
    }
    fn noted_session(&self) -> Option<&str> {
        self.label(SESSION)
    }
    /// Its noted claude was lost with the terminal's program and the new shell is at its prompt.
    fn recovered(&self) -> bool {
        self.noted_session().is_some() && self.label(PID) != Some(&self.pid.to_string()) && self.fg_pid == Some(self.pid)
    }
}

/// hc to call: HANGAR_HC (empty: off), else the path set in Settings, else where hc installs itself (a GUI app's PATH
/// doesn't reach ~/.local/bin), else the PATH. A test world (no discovery) leaves the user's hc alone unless one is named.
fn hc(discover: bool, custom: Option<String>) -> Option<String> {
    if let Some(v) = std::env::var_os("HANGAR_HC") {
        return Some(v.to_string_lossy().into_owned()).filter(|s| !s.is_empty());
    }
    if let Some(p) = custom.filter(|p| !p.is_empty()) {
        return Some(p);
    }
    if !discover {
        return None;
    }
    let installed = crate::home().join(".local/bin/hc");
    Some(if installed.exists() { installed.to_string_lossy().into_owned() } else { "hc".into() })
}

/// hc as the user, not as the terminal Hangar may have been started from: with that terminal's identity, `send` wraps
/// the text in an <hc from=…> tag (which the shell can't parse) and listings follow its scope.
fn run(bin: &str, args: &[&str], timeout: Duration) -> proc::Output {
    let mut c = proc::command(bin);
    for k in ["HC_TERMINAL_ID", "HC_SCOPE", "HC_TERMINAL_SOCKET"] {
        c.env_remove(k);
    }
    proc::run_with(c.args(args), None, timeout)
}

fn json_of(bin: &str, args: &[&str]) -> Option<Value> {
    let o = run(bin, args, HC_WAIT);
    if !o.ok {
        return None;
    }
    serde_json::from_str(&o.out).ok()
}

/// One live terminal, as hc sees it now.
fn term(bin: &str, addr: &str) -> Option<Term> {
    let g = json_of(bin, &["get", addr, "--json"]).filter(|g| g["state"] == "live")?;
    let labels = g["labels"].as_object().map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect()).unwrap_or_default();
    Some(Term {
        addr: g["address"].as_str()?.to_string(),
        pid: g["pid"].as_u64()? as u32,
        fg_pid: g["foreground"]["pid"].as_u64().map(|p| p as u32),
        fg_name: g["foreground"]["name"].as_str().unwrap_or("").to_string(),
        labels,
    })
}

/// This machine's live terminals. Another machine's (`machine/t7`) aren't restored here.
fn terminals(bin: &str) -> Option<Vec<Term>> {
    let ls = json_of(bin, &["ls", "--json"])?;
    let addrs = ls["terminals"].as_array()?.iter().filter_map(|t| t["address"].as_str()).filter(|a| !a.contains('/'));
    Some(addrs.filter_map(|a| term(bin, a)).collect())
}

/// One restore at a time: the background pass, Resume and the global button would otherwise each find the same
/// terminal recovered and type into it twice.
static RESTORING: Mutex<()> = Mutex::new(());

/// The terminal pid each running claude descends from. The foreground process won't do: while a tool runs it is the
/// tool, and the note would come and go with it.
fn claude_terminals(claude_pids: &[(String, u32)], term_pids: &[u32]) -> HashMap<u32, String> {
    let parent: HashMap<u32, u32> = proc::parents().into_iter().collect();
    let mut out = HashMap::new();
    for (id, pid) in claude_pids {
        let mut p = *pid;
        for _ in 0..64 {
            if term_pids.contains(&p) {
                out.insert(p, id.clone());
                break;
            }
            match parent.get(&p) {
                Some(&q) if q != p && q != 0 => p = q,
                _ => break,
            }
        }
    }
    out
}

/// POSIX shells and PowerShell; anything else isn't typed into.
fn shell_line(shell: &str, cwd: &str, argv: &[String]) -> Option<String> {
    let name = shell.rsplit(['/', '\\']).next().unwrap_or(shell).trim_start_matches('-').trim_end_matches(".exe").to_ascii_lowercase();
    match name.as_str() {
        "zsh" | "bash" | "sh" | "dash" | "ksh" => {
            let q = crate::open::posix_quote;
            Some(format!("cd {} && {}", q(cwd), argv.iter().map(|a| q(a)).collect::<Vec<_>>().join(" ")))
        }
        "pwsh" | "powershell" => {
            let q = crate::open::pwsh_quote;
            Some(format!("Set-Location -LiteralPath {}; & {}", q(cwd), argv.iter().map(|a| q(a)).collect::<Vec<_>>().join(" ")))
        }
        _ => None,
    }
}

impl Hangar {
    fn herdr_meta(&self, k: &str) -> Option<String> {
        db::get_meta(&self.db(), k).ok().flatten()
    }
    fn herdr_on(&self) -> bool {
        self.herdr_meta(ON).as_deref() != Some("0")
    }
    fn herdr_auto(&self) -> bool {
        self.herdr_meta(AUTO).as_deref() != Some("0")
    }
    /// hc whether or not the integration is on.
    fn hc_bin(&self) -> Option<String> {
        hc(self.discover, self.herdr_meta(HC_PATH))
    }
    /// hc, with the integration on.
    fn hc(&self) -> Option<String> {
        self.herdr_on().then(|| self.hc_bin()).flatten()
    }

    /// Drops Hangar's notes from this machine's terminals.
    fn herdr_forget(&self) {
        let Some(terms) = self.hc_bin().and_then(|b| terminals(&b).map(|t| (b, t))) else { return };
        let (bin, terms) = terms;
        for t in terms.iter().filter(|t| t.labels.contains_key(SESSION) || t.labels.contains_key(PID)) {
            run(&bin, &["label", &t.addr, &format!("{SESSION}="), &format!("{PID}=")], HC_WAIT);
        }
    }

    /// Notes which session runs in which terminal, drops the notes of claudes that exited, restores recovered terminals
    /// (unless restoring waits to be asked for).
    pub(crate) fn herdr_tick(&self) {
        if !self.herdr_on() {
            if !FORGOTTEN.swap(true, Ordering::SeqCst) {
                self.herdr_forget();
            }
            return;
        }
        FORGOTTEN.store(false, Ordering::SeqCst);
        let Some(bin) = self.hc() else { return };
        let Some(terms) = terminals(&bin) else { return };
        let auto = self.herdr_auto();
        let live: Vec<(String, u32)> = self.live_sessions().into_iter().map(|(id, l)| (id, l.pid)).collect();
        let running = claude_terminals(&live, &terms.iter().map(|t| t.pid).collect::<Vec<_>>());
        for t in &terms {
            let pid = t.pid.to_string();
            if let Some(id) = running.get(&t.pid) {
                if t.noted_session() != Some(id) || t.label(PID) != Some(&pid) {
                    run(&bin, &["label", &t.addr, &format!("{SESSION}={id}"), &format!("{PID}={pid}")], HC_WAIT);
                }
            } else if t.recovered() {
                if !auto {
                    continue;
                }
                if let Err(e) = self.restore_in(&bin, t) {
                    eprintln!("herdr: {}: {e}", t.addr);
                }
            } else if t.noted_session().is_some() && t.label(PID) == Some(&pid) {
                run(&bin, &["label", &t.addr, &format!("{SESSION}="), &format!("{PID}=")], HC_WAIT);
            }
        }
        // Turned off during this pass, which may have written a note after they were dropped: the next tick drops them.
        if !self.herdr_on() {
            FORGOTTEN.store(false, Ordering::SeqCst);
        }
    }

    /// The tick runs whatever the settings say now: each pass reads them, so a change applies without a restart.
    pub fn spawn_herdr(self: &Arc<Self>) {
        let h = Arc::clone(self);
        std::thread::spawn(move || loop {
            h.herdr_tick();
            std::thread::sleep(TICK);
        });
    }

    /// Types the noted session's resume line into the recovered terminal's shell. The note's pid becomes the terminal's
    /// either way: a resume that fails leaves a shell whose note the next tick drops instead of typing again.
    /// The terminal is looked at again under the lock: one no longer recovered was just restored by another caller.
    fn restore_in(&self, bin: &str, seen: &Term) -> Result<(), String> {
        let _one = RESTORING.lock().unwrap_or_else(|e| e.into_inner());
        let Some(t) = term(bin, &seen.addr).filter(Term::recovered) else { return Ok(()) };
        let t = &t;
        let id = t.noted_session().unwrap_or_default().to_string();
        run(bin, &["label", &t.addr, &format!("{PID}={}", t.pid)], HC_WAIT);
        // A session that started after the last scan isn't in the catalog yet.
        // The scan's lock goes before resume_line takes it again: a guard kept to the end of one expression deadlocks.
        let line = match self.resume_line(&id) {
            Err(ApiError(404, _)) => {
                let scanned = self.scan_all(&self.db()).map_err(ApiError::from);
                scanned.and_then(|_| self.resume_line(&id))
            }
            r => r,
        };
        let (cwd, argv) = line.map_err(|ApiError(_, e)| e)?;
        let line = shell_line(&t.fg_name, &cwd, &argv).ok_or_else(|| format!("unsupported shell {}", t.fg_name))?;
        // The lookups above take a while: a program the person opened in that shell meanwhile (ssh, an editor, a
        // password prompt) must not get the line.
        if !term(bin, &t.addr).is_some_and(|n| n.pid == t.pid && n.fg_pid == Some(t.pid)) {
            return Err("the shell is no longer at its prompt".into());
        }
        let o = run(bin, &["send", &t.addr, &line], Duration::from_secs(90));
        if o.ok { Ok(()) } else { Err(o.err.trim().to_string()) }
    }

    /// herdr is an opener: the integration is on and hc answers. What hc said is kept a few seconds: every Resume and
    /// openers listing asks, and a hung hc would hold each of them for HC_WAIT.
    pub(crate) fn herdr_available(&self) -> bool {
        static SEEN: Mutex<Option<(std::time::Instant, String, bool)>> = Mutex::new(None);
        let Some(bin) = self.hc() else { return false };
        let mut seen = SEEN.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, b, ok)) = seen.as_ref() {
            if *b == bin && at.elapsed() < Duration::from_secs(10) {
                return *ok;
            }
        }
        let ok = json_of(&bin, &["ls", "--json"]).is_some();
        *seen = Some((std::time::Instant::now(), bin, ok));
        ok
    }

    /// herdr's window app: HANGAR_HERDR_APP (empty: none), else where it installs itself, else the PATH.
    fn herdr_app(&self) -> Option<String> {
        if let Some(v) = std::env::var_os("HANGAR_HERDR_APP") {
            return Some(v.to_string_lossy().into_owned()).filter(|s| !s.is_empty());
        }
        if !self.discover {
            return None;
        }
        let exe = if cfg!(windows) { "herdr-app.exe" } else { "herdr-app" };
        let installed = crate::home().join(".local/bin").join(exe);
        Some(if installed.exists() { installed.to_string_lossy().into_owned() } else { exe.into() })
    }

    /// The executable whose icon herdr shows (a scoop shim points at it in its .shim file).
    #[cfg(windows)]
    pub(crate) fn herdr_app_icon(&self) -> String {
        let Some(bin) = self.herdr_app() else { return String::new() };
        let found = if std::path::Path::new(&bin).is_absolute() {
            Some(std::path::PathBuf::from(&bin))
        } else {
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).map(|d| d.join(&bin)).find(|p| p.is_file())
        };
        let Some(exe) = found else { return String::new() };
        let shim = std::fs::read_to_string(exe.with_extension("shim")).ok();
        let target = shim.as_deref().and_then(|s| s.lines().find_map(|l| l.trim().strip_prefix("path")?.trim().strip_prefix('=')))
            .map(|p| p.trim().trim_matches('"').to_string());
        target.unwrap_or_else(|| exe.to_string_lossy().into_owned())
    }

    /// Brings herdr's window forward (macOS: the app, by bundle).
    fn herdr_front(&self) {
        #[cfg(target_os = "macos")]
        if self.discover {
            let _ = proc::run(&crate::platform::macos::open_bin(), &["-b", "dev.herdr.app"], HC_WAIT);
        }
    }

    /// A new herdr tab running `argv` in `cwd`: through the window app, else as a kept terminal of hc's own.
    pub(crate) fn herdr_open(&self, cwd: &str, argv: &[String]) -> Result<(), String> {
        if let Some(app) = self.herdr_app() {
            let o = run(&app, &["do", "terminal.open", "--argv", &Value::from(argv.to_vec()).to_string(), "--folder", cwd], HC_WAIT);
            if o.ok {
                self.herdr_front();
                return Ok(());
            }
            if !o.missing {
                return Err(o.err.trim().to_string());
            }
        }
        let bin = self.hc().ok_or("no_hc")?;
        let mut args = vec!["run", "--bg", "--keep", "--no-parent", "--cwd", cwd, "--"];
        args.extend(argv.iter().map(String::as_str));
        let o = run(&bin, &args, HC_WAIT);
        if o.ok { Ok(()) } else { Err(o.err.trim().to_string()) }
    }

    /// The herdr terminal session `id` is running in, shown; None when it runs in none.
    pub(crate) fn herdr_focus(&self, id: &str) -> Option<ApiResult> {
        let bin = self.hc()?;
        let t = terminals(&bin)?.into_iter().find(|t| t.noted_session() == Some(id) && t.label(PID) == Some(&t.pid.to_string()))?;
        let app = self.herdr_app()?;
        let o = run(&app, &["do", "agent.focus", "--terminal", &t.addr], HC_WAIT);
        // Without the window app there's no window to show it in.
        if o.missing {
            return None;
        }
        if !o.ok {
            return Some(Err(ApiError(500, o.err.trim().to_string())));
        }
        self.herdr_front();
        Some(Ok(json!({ "focused": t.addr })))
    }

    /// The recovered terminal noted for session `id`, restored; None when there is none.
    pub(crate) fn herdr_resume(&self, id: &str) -> Option<ApiResult> {
        let bin = self.hc()?;
        let t = terminals(&bin)?.into_iter().find(|t| t.recovered() && t.noted_session() == Some(id))?;
        Some(self.restore_in(&bin, &t).map(|_| json!({ "restored": t.addr })).map_err(|e| ApiError(500, e)))
    }

    /// GET /api/herdr: the settings, the hc they lead to, whether it answers (asked only with the integration on) and the
    /// sessions waiting in recovered terminals.
    pub(crate) fn herdr_status(&self) -> Value {
        let (on, bin) = (self.herdr_on(), self.hc_bin());
        let terms = bin.as_deref().filter(|_| on).and_then(terminals);
        let restorable: Vec<Value> = terms.iter().flatten().filter(|t| t.recovered()).map(|t| json!({ "terminal": t.addr, "session": t.noted_session() })).collect();
        json!({ "enabled": on, "auto": self.herdr_auto(), "hcPath": self.herdr_meta(HC_PATH).unwrap_or_default(), "hc": bin,
            "available": terms.is_some(), "restorable": restorable })
    }

    /// PATCH /api/herdr: { enabled?, auto?, hcPath? } ("" goes back to finding hc).
    pub(crate) fn set_herdr(&self, body: &Value) -> ApiResult {
        let flag = |k: &str| match &body[k] {
            Value::Null => Ok(None),
            Value::Bool(b) => Ok(Some(if *b { "1" } else { "0" })),
            _ => Err(ApiError(400, k.into())),
        };
        let (on, auto) = (flag("enabled")?, flag("auto")?);
        let path = match &body["hcPath"] {
            Value::Null => None,
            Value::String(s) => Some(s.trim().to_string()),
            _ => return Err(ApiError(400, "hcPath".into())),
        };
        {
            let db = self.db();
            for (k, v) in [(ON, on.map(str::to_string)), (AUTO, auto.map(str::to_string)), (HC_PATH, path)] {
                if let Some(v) = v {
                    db::set_meta(&db, k, &v)?;
                }
            }
        }
        // Off drops the notes now, not on the next tick (the lock above is released first: hc_bin reads meta).
        if on == Some("0") {
            FORGOTTEN.store(true, Ordering::SeqCst);
            self.herdr_forget();
        }
        Ok(json!({ "ok": true }))
    }

    /// POST /api/restore-herdr: every recovered terminal, now.
    pub(crate) fn herdr_restore_all(&self) -> ApiResult {
        if !self.herdr_on() {
            return Err(ApiError(409, "herdr_off".into()));
        }
        let bin = self.hc().ok_or_else(|| ApiError(409, "no_hc".into()))?;
        let terms = terminals(&bin).ok_or_else(|| ApiError(409, "no_hc".into()))?;
        let (mut restored, mut failed) = (vec![], vec![]);
        for t in terms.iter().filter(|t| t.recovered()) {
            match self.restore_in(&bin, t) {
                Ok(()) => restored.push(json!({ "terminal": t.addr, "session": t.noted_session() })),
                Err(e) => failed.push(json!({ "terminal": t.addr, "session": t.noted_session(), "error": e })),
            }
        }
        Ok(json!({ "restored": restored, "failed": failed }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn term(pid: u32, fg: u32, labels: &[(&str, &str)]) -> Term {
        Term { addr: "t1".into(), pid, fg_pid: Some(fg), fg_name: "zsh".into(), labels: labels.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect() }
    }

    #[test]
    fn recovered_only_with_a_new_pid_at_the_prompt() {
        let id = "0b0e7c1a-1111-4222-8333-944445555666";
        assert!(term(20, 20, &[(SESSION, id), (PID, "10")]).recovered());
        assert!(!term(10, 10, &[(SESSION, id), (PID, "10")]).recovered(), "claude exited; same terminal program");
        assert!(!term(20, 21, &[(SESSION, id), (PID, "10")]).recovered(), "something else runs in the new shell");
        assert!(!term(20, 20, &[(PID, "10")]).recovered());
        assert!(!term(20, 20, &[(SESSION, ""), (PID, "10")]).recovered());
    }

    #[test]
    fn shell_lines() {
        let argv = vec!["/A/hangar-resume".to_string(), "id".to_string(), "--config".to_string(), "/h/.claude-x".to_string()];
        assert_eq!(shell_line("zsh", "/w/it's", &argv).unwrap(), r"cd '/w/it'\''s' && '/A/hangar-resume' 'id' '--config' '/h/.claude-x'");
        assert_eq!(shell_line("-zsh", "/w", &argv[..2]).unwrap(), "cd '/w' && '/A/hangar-resume' 'id'");
        assert_eq!(shell_line(r"C:\x\pwsh.exe", r"C:\it's", &argv[..2]).unwrap(), r"Set-Location -LiteralPath 'C:\it''s'; & '/A/hangar-resume' 'id'");
        assert_eq!(shell_line("pwsh", "C:\\a\u{2018}b\u{2019}c\u{201A}d\u{201B}e", &argv[..1]).unwrap(),
            "Set-Location -LiteralPath 'C:\\a\u{2018}\u{2018}b\u{2019}\u{2019}c\u{201A}\u{201A}d\u{201B}\u{201B}e'; & '/A/hangar-resume'");
        assert!(shell_line("fish", "/w", &argv).is_none());
    }
}
