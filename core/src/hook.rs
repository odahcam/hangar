//! The SessionStart hook, optional and per account. Claude Code runs `hangar-resume --session-start` whenever a session
//! starts (after /clear and /resume too), and the helper notes the session on the hc terminal it runs in, the way the
//! tick does (herdr.rs): at once, and with Hangar closed. It sits in the account's settings.json beside the person's
//! own hooks; only Hangar's entry is ever added or removed.
use crate::accounts::edit_settings;
use crate::herdr;
use crate::ApiResult;
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

const FLAG: &str = "--session-start";
/// Claude Code waits for the hook before the session starts.
const WAIT: Duration = Duration::from_secs(5);

/// A hook command of Hangar's, from this install or an earlier one somewhere else.
fn ours(command: &str) -> bool {
    command.contains("hangar-resume") && command.contains(FLAG)
}

fn commands(group: &Value) -> impl Iterator<Item = &str> {
    group["hooks"].as_array().into_iter().flatten().filter_map(|h| h["command"].as_str())
}

pub(crate) fn installed(dir: &Path) -> bool {
    let Ok(text) = fs::read_to_string(dir.join("settings.json")) else { return false };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return false };
    v["hooks"]["SessionStart"].as_array().into_iter().flatten().any(|g| commands(g).any(ours))
}

/// Claude Code runs hook commands in a POSIX shell (Git Bash on Windows). On Windows the path goes in double quotes
/// with forward slashes, which cmd reads the same way.
fn quote(s: &str) -> String {
    if cfg!(windows) {
        let s = s.replace('\\', "/");
        let mut q = String::from('"');
        for c in s.chars() {
            if matches!(c, '"' | '$' | '`' | '\\') {
                q.push('\\');
            }
            q.push(c);
        }
        q + "\""
    } else {
        crate::open::posix_quote(s)
    }
}

fn command(hc: Option<&str>) -> ApiResult<String> {
    let helper = crate::resume::helper().ok_or_else(|| crate::ApiError(500, "no_helper".into()))?;
    let mut c = format!("{} {FLAG}", quote(&helper.to_string_lossy()));
    if let Some(hc) = hc {
        c += &format!(" --hc {}", quote(hc));
    }
    Ok(c)
}

/// Adds or removes Hangar's hook (any earlier one of Hangar's goes either way), hc being the path set in Settings.
pub(crate) fn set(dir: &Path, on: bool, hc: Option<&str>) -> ApiResult<()> {
    let entry = on.then(|| command(hc)).transpose()?;
    edit_settings(dir, |obj| {
        let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
        let Some(hooks) = hooks.as_object_mut() else { return };
        let starts = hooks.entry("SessionStart").or_insert_with(|| json!([]));
        let Some(groups) = starts.as_array_mut() else { return };
        for g in groups.iter_mut() {
            if let Some(list) = g["hooks"].as_array_mut() {
                list.retain(|h| !h["command"].as_str().is_some_and(ours));
            }
        }
        // A group left with no hook was Hangar's alone.
        groups.retain(|g| !g["hooks"].as_array().is_some_and(Vec::is_empty));
        if let Some(c) = entry {
            groups.push(json!({ "hooks": [{ "type": "command", "command": c }] }));
        }
        if groups.is_empty() {
            hooks.remove("SessionStart");
        }
        if hooks.is_empty() {
            obj.remove("hooks");
        }
    })
}

/// `hangar-resume --session-start [--hc <path>]`, run by the hook: notes the session (Claude Code's JSON on stdin) and
/// the terminal's pid on the hc terminal claude runs in, if any. Prints nothing (a SessionStart hook's output goes to
/// the session) and never fails the session.
pub fn session_start(hc: Option<String>) {
    let Some(addr) = std::env::var("HC_TERMINAL_ID").ok().filter(|a| !a.is_empty()) else { return };
    let mut input = String::new();
    let _ = std::io::stdin().take(1 << 20).read_to_string(&mut input);
    let id = serde_json::from_str::<Value>(&input).ok().and_then(|v| v["session_id"].as_str().map(String::from));
    let Some(id) = id.filter(|i| crate::resume::valid_id(i)) else { return };
    let Some(bin) = herdr::hc(true, hc) else { return };
    let Some(t) = herdr::term(&bin, &addr) else { return };
    herdr::run(&bin, &["label", &t.addr, &format!("{}={id}", herdr::SESSION), &format!("{}={}", herdr::PID, t.pid)], WAIT);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_commands_are_told_apart() {
        assert!(ours("'/Applications/Hangar.app/Contents/MacOS/hangar-resume' --session-start"));
        assert!(!ours("'/Applications/Hangar.app/Contents/MacOS/hangar-resume' id"));
        assert!(!ours("my-hook --session-start"));
    }
}
