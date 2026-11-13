//! Resuming a session in a terminal. Every terminal integration (Terminal.app, Windows Terminal, and whatever comes
//! next, herdr and the like) only puts one command line in a new tab, in the session's folder: the hangar-resume
//! helper (src/bin/hangar-resume.rs). The helper, not the terminal's shell or environment, sets the session's
//! account and leaves out what Hangar may have inherited, so no integration speaks a shell or passes environment.
use crate::proc::{command, SESSION_ENV};
use std::path::{Path, PathBuf};
use std::process::Command;

const HELPER: &str = if cfg!(windows) { "hangar-resume.exe" } else { "hangar-resume" };

/// The helper beside the running executable: Hangar.app/Contents/MacOS, the install folder on Windows, target/<profile>
/// for hangar-server. None when that can't be told: a bare name would be looked up by the tab, in the session's folder.
pub fn helper() -> Option<PathBuf> {
    Some(std::env::current_exe().ok()?.parent()?.join(HELPER))
}

/// The command line a tab runs, in the session's folder, to resume session `id` under the account in `config`
/// (None: the default account).
pub fn argv(id: &str, config: Option<&Path>) -> Option<Vec<String>> {
    let mut v = vec![helper()?.to_string_lossy().into_owned(), id.to_string()];
    if let Some(d) = config {
        v.extend(["--config".to_string(), d.to_string_lossy().into_owned()]);
    }
    Some(v)
}

/// Session ids are UUIDs; anything else isn't passed to claude.
pub fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.chars().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() })
}

/// For the helper: `claude --resume <id>` under the account in `config` (None: the default account, so a
/// CLAUDE_CONFIG_DIR the tab carries goes), without the variables that would make it a Claude Code session's child.
/// claude is looked up away from the session's folder (see classify::find_claude), and one found inside it anyway
/// (a PATH that lists "." or the folder) is refused: the repository being resumed doesn't get to pick the binary.
pub fn claude_command(id: &str, config: Option<&str>) -> Result<Command, String> {
    let bin = crate::classify::claude_path().ok_or("claude not found")?;
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    if Path::new(&bin).starts_with(&cwd) {
        return Err(format!("refusing {bin}, inside the session's folder"));
    }
    let mut c = command(&bin);
    for k in SESSION_ENV {
        c.env_remove(k);
    }
    match config {
        Some(d) => c.env("CLAUDE_CONFIG_DIR", d),
        None => c.env_remove("CLAUDE_CONFIG_DIR"),
    };
    c.args(["--resume", id]);
    Ok(c)
}
