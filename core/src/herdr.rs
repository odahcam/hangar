// Claude sessions in herdr-core (`hc`) terminals come back after the computer restarts. hc's recovery (`hc keep`)
// replaces a lost program with a fresh shell and never reruns it, so Hangar keeps a note on each terminal, in hc labels:
// the session running in it (hangar.session) and the terminal's pid at the time (hangar.pid). A recovered terminal has
// a new pid; one whose claude just exited keeps its pid, and its note is dropped. A recovered terminal whose shell sits
// at its prompt gets the session's resume line typed into it, in the same pane: on every tick (so after a reboot, once
// Hangar is up), from the global button and `Hangar --restore`, and from the session's own Resume.
use crate::proc;
use crate::{ApiError, ApiResult, Hangar};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

const SESSION: &str = "hangar.session";
const PID: &str = "hangar.pid";
const TICK: Duration = Duration::from_secs(15);
const HC_WAIT: Duration = Duration::from_secs(10);

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

/// hc to call: HANGAR_HC (empty: off), else where hc installs itself (a GUI app's PATH doesn't reach ~/.local/bin), else
/// the PATH. A test world (no discovery) leaves the user's hc alone unless HANGAR_HC names one.
fn hc(discover: bool) -> Option<String> {
    if let Some(v) = std::env::var_os("HANGAR_HC") {
        return Some(v.to_string_lossy().into_owned()).filter(|s| !s.is_empty());
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

/// This machine's live terminals. Another machine's (`machine/t7`) aren't restored here.
fn terminals(bin: &str) -> Option<Vec<Term>> {
    let ls = json_of(bin, &["ls", "--json"])?;
    let addrs: Vec<String> = ls["terminals"].as_array()?.iter().filter_map(|t| t["address"].as_str()).filter(|a| !a.contains('/')).map(String::from).collect();
    Some(
        addrs
            .iter()
            .filter_map(|a| json_of(bin, &["get", a, "--json"]))
            .filter(|g| g["state"] == "live")
            .filter_map(|g| {
                let labels = g["labels"].as_object().map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect()).unwrap_or_default();
                Some(Term {
                    addr: g["address"].as_str()?.to_string(),
                    pid: g["pid"].as_u64()? as u32,
                    fg_pid: g["foreground"]["pid"].as_u64().map(|p| p as u32),
                    fg_name: g["foreground"]["name"].as_str().unwrap_or("").to_string(),
                    labels,
                })
            })
            .collect(),
    )
}

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
            let q = |s: &str| format!("'{}'", s.replace('\'', r"'\''"));
            Some(format!("cd {} && {}", q(cwd), argv.iter().map(|a| q(a)).collect::<Vec<_>>().join(" ")))
        }
        "pwsh" | "powershell" => {
            let q = |s: &str| format!("'{}'", s.replace('\'', "''"));
            Some(format!("Set-Location -LiteralPath {}; & {}", q(cwd), argv.iter().map(|a| q(a)).collect::<Vec<_>>().join(" ")))
        }
        _ => None,
    }
}

impl Hangar {
    fn hc(&self) -> Option<String> {
        hc(self.discover)
    }

    /// Notes which session runs in which terminal, drops the notes of claudes that exited, restores recovered terminals.
    pub(crate) fn herdr_tick(&self) {
        let Some(bin) = self.hc() else { return };
        let Some(terms) = terminals(&bin) else { return };
        let live: Vec<(String, u32)> = self.live_sessions().into_iter().map(|(id, l)| (id, l.pid)).collect();
        let running = claude_terminals(&live, &terms.iter().map(|t| t.pid).collect::<Vec<_>>());
        for t in &terms {
            let pid = t.pid.to_string();
            if let Some(id) = running.get(&t.pid) {
                if t.noted_session() != Some(id) || t.label(PID) != Some(&pid) {
                    run(&bin, &["label", &t.addr, &format!("{SESSION}={id}"), &format!("{PID}={pid}")], HC_WAIT);
                }
            } else if t.recovered() {
                if let Err(e) = self.restore_in(&bin, t) {
                    eprintln!("herdr: {}: {e}", t.addr);
                }
            } else if t.noted_session().is_some() && t.label(PID) == Some(&pid) {
                run(&bin, &["label", &t.addr, &format!("{SESSION}="), &format!("{PID}=")], HC_WAIT);
            }
        }
    }

    pub fn spawn_herdr(self: &Arc<Self>) {
        if self.hc().is_none() {
            return;
        }
        let h = Arc::clone(self);
        std::thread::spawn(move || loop {
            h.herdr_tick();
            std::thread::sleep(TICK);
        });
    }

    /// Types the noted session's resume line into the recovered terminal's shell. The note's pid becomes the terminal's
    /// either way: a resume that fails leaves a shell whose note the next tick drops instead of typing again.
    fn restore_in(&self, bin: &str, t: &Term) -> Result<(), String> {
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
        let o = run(bin, &["send", &t.addr, &line], Duration::from_secs(90));
        if o.ok { Ok(()) } else { Err(o.err.trim().to_string()) }
    }

    /// The recovered terminal noted for session `id`, restored; None when there is none.
    pub(crate) fn herdr_resume(&self, id: &str) -> Option<ApiResult> {
        let bin = self.hc()?;
        let t = terminals(&bin)?.into_iter().find(|t| t.recovered() && t.noted_session() == Some(id))?;
        Some(self.restore_in(&bin, &t).map(|_| json!({ "restored": t.addr })).map_err(|e| ApiError(500, e)))
    }

    /// GET /api/herdr: whether hc is there and the sessions waiting in recovered terminals.
    pub(crate) fn herdr_status(&self) -> Value {
        let terms = self.hc().and_then(|b| terminals(&b));
        let restorable: Vec<Value> = terms.iter().flatten().filter(|t| t.recovered()).map(|t| json!({ "terminal": t.addr, "session": t.noted_session() })).collect();
        json!({ "available": terms.is_some(), "restorable": restorable })
    }

    /// POST /api/restore-herdr: every recovered terminal, now.
    pub(crate) fn herdr_restore_all(&self) -> ApiResult {
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
        assert!(shell_line("fish", "/w", &argv).is_none());
    }
}
