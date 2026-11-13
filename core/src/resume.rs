//! Resuming a session in a terminal. Every terminal integration (Terminal.app, Windows Terminal, and whatever comes
//! next, herdr and the like) only puts one command line in a new tab, in the session's folder: the hangar-resume
//! helper (src/bin/hangar-resume.rs). The helper, not the terminal's shell or environment, sets the session's
//! account and leaves out what Hangar may have inherited, so no integration speaks a shell or passes environment.
use crate::proc::{command, SESSION_ENV};
use std::path::{Path, PathBuf};
use std::process::Command;

const HELPER: &str = if cfg!(windows) { "hangar-resume.exe" } else { "hangar-resume" };

/// The helper beside the running executable: Hangar.app/Contents/MacOS, the install folder on Windows, target/<profile>
/// for hangar-server.
pub fn helper() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    exe.parent().map(|d| d.join(HELPER)).unwrap_or_else(|| PathBuf::from(HELPER))
}

/// The command line a tab runs, in the session's folder, to resume session `id` under the account in `config`
/// (None: the default account).
pub fn argv(id: &str, config: Option<&Path>) -> Vec<String> {
    let mut v = vec![helper().to_string_lossy().into_owned(), id.to_string()];
    if let Some(d) = config {
        v.extend(["--config".to_string(), d.to_string_lossy().into_owned()]);
    }
    v
}

/// Session ids are UUIDs; anything else isn't passed to claude.
pub fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.chars().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() })
}

/// For the helper: `claude --resume <id>` under the account in `config` (None: the default account, so a
/// CLAUDE_CONFIG_DIR the tab carries goes), without the variables that would make it a Claude Code session's child.
pub fn claude_command(id: &str, config: Option<&str>) -> Command {
    let mut c = command(&crate::classify::claude_path().unwrap_or_else(|| "claude".into()));
    for k in SESSION_ENV {
        c.env_remove(k);
    }
    match config {
        Some(d) => c.env("CLAUDE_CONFIG_DIR", d),
        None => c.env_remove("CLAUDE_CONFIG_DIR"),
    };
    c.args(["--resume", id]);
    c
}
