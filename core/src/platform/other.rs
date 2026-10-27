// Other Unix systems (Linux): builds and runs the catalog, but no terminal integration yet (#2 leaves the terminal open).
use super::{Caps, Platform, Tab};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

pub struct Other;

impl Platform for Other {
    fn caps(&self) -> Caps {
        Caps { tabs: false, focus: false }
    }

    fn data_dir(&self, home: &Path) -> PathBuf {
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local/share")).join("hangar")
    }

    fn claude_candidates(&self, home: &Path) -> Vec<PathBuf> {
        vec![home.join(".local/bin/claude"), home.join(".claude/local/claude"), "/usr/local/bin/claude".into()]
    }

    fn which_claude(&self) -> (String, Vec<String>) {
        (std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()), vec!["-lc".into(), "command -v claude".into()])
    }

    fn tabs(&self) -> HashMap<String, Tab> {
        HashMap::new()
    }

    fn ttys(&self, _: &[u32]) -> HashMap<u32, String> {
        HashMap::new()
    }

    fn focus(&self, _: &str) -> bool {
        false
    }

    fn open(&self, _: &str, _: &str, _: Option<&Path>) -> Result<(), String> {
        Err("unsupported_terminal".into())
    }

    fn exit_tab(&self, _: &str, _: bool) {}

    fn memory_mb(&self, pids: &[u32]) -> HashMap<u32, f64> {
        let want: Vec<Pid> = pids.iter().map(|p| Pid::from_u32(*p)).collect();
        let mut sys = System::new();
        sys.refresh_processes_specifics(ProcessesToUpdate::Some(&want), true, ProcessRefreshKind::new().with_memory());
        want.iter().filter_map(|p| Some((p.as_u32(), sys.process(*p)?.memory() as f64 / 1048576.0))).collect()
    }
}
