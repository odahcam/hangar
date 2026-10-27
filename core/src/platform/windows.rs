// Windows: sessions open as Windows Terminal tabs. Windows Terminal can't list its tabs or select one from outside,
// so there is no tab focus or idle-tab cleanup here.
use super::{Caps, Platform, Tab};
use crate::proc::run;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::LazyLock;
use std::time::Duration;

pub struct Windows;

// Overridable so tests can stand in for Windows Terminal.
static WT: LazyLock<String> = LazyLock::new(|| std::env::var("HANGAR_WT").unwrap_or_else(|_| "wt.exe".into()));

impl Platform for Windows {
    fn caps(&self) -> Caps {
        Caps { tabs: false, focus: false }
    }

    fn data_dir(&self, home: &Path) -> PathBuf {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData/Roaming")).join("Hangar")
    }

    fn claude_candidates(&self, home: &Path) -> Vec<PathBuf> {
        vec![home.join(".local/bin/claude.exe"), home.join(".claude/local/claude.exe")]
    }

    fn which_claude(&self) -> (String, Vec<String>) {
        ("where.exe".into(), vec!["claude".into()])
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

    // A new tab in the most recent Windows Terminal window; without Windows Terminal, a console window of its own.
    // wt splits its command line on ";", so one in the path is escaped. The tab gets the environment of the window
    // it lands in, not ours, so the account is set by cmd inside the tab: `set X=` with nothing after it clears X.
    // Unquoted, so a folder with a cmd metacharacter in its path can't be passed through.
    fn open(&self, cwd: &str, id: &str, config: Option<&Path>) -> Result<(), String> {
        let config_s = config.map(|d| d.to_string_lossy().to_string());
        if config_s.as_deref().is_some_and(|d| d.contains(['&', '|', '<', '>', '^', '"', '%'])) {
            return Err("unsupported_path".into());
        }
        let dir = cwd.replace(';', "\\;");
        let cmd = format!("set CLAUDE_CONFIG_DIR={}&& claude --resume {id}", config_s.as_deref().unwrap_or("")).replace(';', "\\;");
        let r = run(&WT, &["-w", "0", "new-tab", "--startingDirectory", &dir, "cmd", "/c", &cmd], Duration::from_secs(8));
        if !r.missing {
            return Ok(());
        }
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x10;
        let mut c = Command::new("claude");
        match config {
            Some(d) => c.env("CLAUDE_CONFIG_DIR", d),
            None => c.env_remove("CLAUDE_CONFIG_DIR"),
        };
        c.args(["--resume", id]).current_dir(cwd).creation_flags(CREATE_NEW_CONSOLE).spawn().map(drop).map_err(|e| e.to_string())
    }

    fn exit_tab(&self, _: &str, _: bool) {}

    // Private (committed) bytes: the closest Windows analogue to the macOS footprint.
    fn memory_mb(&self, pids: &[u32]) -> HashMap<u32, f64> {
        pids.iter().filter_map(|&pid| Some((pid, win::private_bytes(pid)? as f64 / 1048576.0))).collect()
    }

    // What Task Manager and Win32_PageFileUsage call page file "current usage".
    fn swap_used_mb(&self) -> f64 {
        win::pagefile_in_use_bytes().map_or(0.0, |b| b as f64 / 1048576.0)
    }
}

// The few Win32/NT calls needed, declared directly.
mod win {
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Default)]
    struct ProcessMemoryCountersEx {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
        private_usage: usize,
    }

    #[repr(C)]
    struct PagefileInfo {
        next_entry_offset: u32,
        total_size: u32,
        total_in_use: u32,
        peak_usage: u32,
        name_len: u16,
        name_max: u16,
        name: *const u16,
    }

    #[repr(C)]
    struct SystemInfo {
        oem_id: u32,
        page_size: u32,
        rest: [u8; 40],
    }

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const SYSTEM_PAGEFILE_INFORMATION: u32 = 18;

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn CloseHandle(h: *mut c_void) -> i32;
        fn K32GetProcessMemoryInfo(h: *mut c_void, counters: *mut ProcessMemoryCountersEx, cb: u32) -> i32;
        fn GetSystemInfo(info: *mut SystemInfo);
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn NtQuerySystemInformation(class: u32, info: *mut c_void, len: u32, ret: *mut u32) -> i32;
    }

    pub fn private_bytes(pid: u32) -> Option<usize> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            let mut c = ProcessMemoryCountersEx { cb: std::mem::size_of::<ProcessMemoryCountersEx>() as u32, ..Default::default() };
            let ok = K32GetProcessMemoryInfo(h, &mut c, c.cb) != 0;
            CloseHandle(h);
            ok.then_some(c.private_usage)
        }
    }

    pub fn pagefile_in_use_bytes() -> Option<u64> {
        unsafe {
            let mut sys = std::mem::zeroed::<SystemInfo>();
            GetSystemInfo(&mut sys);
            let mut buf = vec![0u64; 512];
            let mut ret = 0u32;
            if NtQuerySystemInformation(SYSTEM_PAGEFILE_INFORMATION, buf.as_mut_ptr().cast(), (buf.len() * 8) as u32, &mut ret) != 0 {
                return None;
            }
            // A chain of entries, one per page file; sizes are in pages.
            let (mut at, mut pages) = (buf.as_ptr() as *const u8, 0u64);
            if ret == 0 {
                return Some(0);
            }
            loop {
                let e = &*(at as *const PagefileInfo);
                pages += e.total_in_use as u64;
                if e.next_entry_offset == 0 {
                    break;
                }
                at = at.add(e.next_entry_offset as usize);
            }
            Some(pages * sys.page_size as u64)
        }
    }
}
