// Everything that depends on the OS: where state lives, where `claude` is installed, the terminal sessions resume
// into, and per-process memory. Process trees, liveness, RAM and swap are the same everywhere (see proc.rs).
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod other;

/// What the terminal integration can do; the UI hides what a platform can't offer.
#[derive(Clone, Copy)]
pub struct Caps {
    /// The terminal can list its tabs (titles, idle tabs).
    pub tabs: bool,
    /// A running session's own tab can be brought forward.
    pub focus: bool,
}

pub struct Tab {
    pub busy: bool,
    pub title: String,
}

pub trait Platform: Send + Sync {
    fn caps(&self) -> Caps;
    /// Default state directory, e.g. ~/Library/Application Support/Hangar.
    fn data_dir(&self, home: &Path) -> PathBuf;
    /// Usual install spots for `claude`, checked before asking a shell: GUI apps get a minimal PATH.
    fn claude_candidates(&self, home: &Path) -> Vec<PathBuf>;
    /// A command that prints the path of `claude` as the user's shell resolves it.
    fn which_claude(&self) -> (String, Vec<String>);
    /// Terminal tabs by tty.
    fn tabs(&self) -> HashMap<String, Tab>;
    /// tty of each pid that has one.
    fn ttys(&self, pids: &[u32]) -> HashMap<u32, String>;
    /// Brings the tab on `tty` forward; false if there is no such tab.
    fn focus(&self, tty: &str) -> bool;
    /// Opens `claude --resume <id>` in `cwd`, in a new terminal tab or window, under the account whose config dir is
    /// `config` (CLAUDE_CONFIG_DIR), or the default ~/.claude when None: then CLAUDE_CONFIG_DIR is cleared, since the
    /// user's shell may export one and setting it to ~/.claude would move .claude.json (see accounts.rs).
    fn open(&self, cwd: &str, id: &str, config: Option<&Path>) -> Result<(), String>;
    /// Exits the shell left in the tab on `tty`, which lets the terminal close it.
    fn exit_tab(&self, tty: &str, only_if_idle: bool);
    /// Memory each pid holds, in MB, measured the way the OS reports what a process costs.
    fn memory_mb(&self, pids: &[u32]) -> HashMap<u32, f64>;
    /// Swap / page file in use, in MB.
    fn swap_used_mb(&self) -> f64 {
        crate::proc::memory_totals().1
    }
}

pub fn current() -> &'static dyn Platform {
    #[cfg(target_os = "macos")]
    return &macos::MacOs;
    #[cfg(target_os = "windows")]
    return &windows::Windows;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return &other::Other;
}
