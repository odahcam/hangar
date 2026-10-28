// macOS: Terminal.app through AppleScript, memory from `footprint`.
use super::{Caps, Platform, Tab};
use crate::proc::run;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

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
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
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
        let cmd = format!("cd {} && unset {} && {env}claude --resume {id}", sh_quote(cwd), crate::proc::SESSION_ENV.join(" "));
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
