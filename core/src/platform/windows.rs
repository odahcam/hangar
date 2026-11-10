// Windows: sessions open as Windows Terminal tabs. Windows Terminal can't list its tabs from outside, so there is no
// idle-tab cleanup here. A running session is still brought forward: its console's window leads to the terminal
// window that hosts it, and UI Automation selects the tab whose title is that console's title.
use super::{Caps, Platform, Tab};
use crate::proc::{command, run, run_with, SESSION_ENV};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

pub struct Windows;

// Overridable so tests can stand in for Windows Terminal.
static WT: LazyLock<String> = LazyLock::new(|| std::env::var("HANGAR_WT").unwrap_or_else(|_| "wt.exe".into()));

impl Platform for Windows {
    fn caps(&self) -> Caps {
        Caps { tabs: false, focus: true }
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

    // There are no ttys; a session that sits in a terminal window gets its own pid as the handle focus() takes.
    fn ttys(&self, pids: &[u32]) -> HashMap<u32, String> {
        let (parents, consoles) = (crate::proc::parents().into_iter().collect(), win::console_windows());
        pids.iter().filter(|&&pid| terminal_window(pid, &parents, &consoles).is_some()).map(|&pid| (pid, pid.to_string())).collect()
    }

    fn focus(&self, tty: &str) -> bool {
        let Ok(pid) = tty.parse::<u32>() else { return false };
        let (parents, consoles) = (crate::proc::parents().into_iter().collect(), win::console_windows());
        let Some(window) = terminal_window(pid, &parents, &consoles) else { return false };
        win::bring_forward(window);
        // Picking the tab takes PowerShell's start-up (~0.5 s); the window is already in front meanwhile.
        std::thread::spawn(move || select_tab(pid, window));
        true
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
        // The window may itself have been started from a Claude Code session; see proc::SESSION_ENV.
        let clear: String = SESSION_ENV.iter().map(|k| format!("set {k}=&& ")).collect();
        let cmd = format!("{clear}set CLAUDE_CONFIG_DIR={}&& claude --resume {id}", config_s.as_deref().unwrap_or("")).replace(';', "\\;");
        let r = run(&WT, &["-w", "0", "new-tab", "--startingDirectory", &dir, "cmd", "/c", &cmd], Duration::from_secs(8));
        if !r.missing {
            return Ok(());
        }
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x10;
        let mut c = command("claude");
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

// The terminal window a session runs in. The console the process is attached to decides: walking up from it, the
// first process with a console names it (its host), and only windows of that console count, so a session started
// from inside another terminal session doesn't lead to that one's window. Under ConPTY (Windows Terminal) the
// console's window is a hidden pseudo-window filed under the console's first client (the shell), owned by the
// terminal window; a classic console window belongs to its host and is the window itself.
fn terminal_window(pid: u32, parents: &HashMap<u32, u32>, consoles: &[win::ConsoleWindow]) -> Option<isize> {
    let mut chain = vec![pid];
    while let Some(&p) = parents.get(chain.last()?).filter(|&&p| p != 0 && !chain.contains(&p) && chain.len() < 16) {
        chain.push(p);
    }
    let first = chain.iter().position(|&p| win::console_host(p).is_some())?;
    let host = win::console_host(chain[first])?;
    let same: Vec<u32> = chain[first..].iter().copied().take_while(|&p| win::console_host(p) == Some(host)).collect();
    let mine = |w: &&win::ConsoleWindow| w.pid == host || (w.pseudo && same.contains(&w.pid));
    consoles.iter().find(mine).and_then(win::terminal_of)
}

// Selects, in the terminal window, the tab whose title is the session's console title (what Windows Terminal shows).
// Reading another process's console title means attaching to its console, which this process can't do while it has
// one of its own; the PowerShell helper starts with a hidden console it can let go of. A leading status glyph
// ("✳ ", "◑ ") may change between the two reads, so a second pass compares without it.
const SELECT_TAB: &str = r#"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace Hangar -Name Con -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern int GetConsoleTitleW(System.Text.StringBuilder s, int n);
'@
[void][Hangar.Con]::FreeConsole()
if (-not [Hangar.Con]::AttachConsole([uint32]$env:HANGAR_FOCUS_PID)) { exit 2 }
$sb = New-Object System.Text.StringBuilder 1024
[void][Hangar.Con]::GetConsoleTitleW($sb, 1024)
[void][Hangar.Con]::FreeConsole()
$title = $sb.ToString()
if (-not $title) { exit 3 }
$bare = { param($s) ($s -replace '^\W\s+', '').Trim() }
$win = [Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$env:HANGAR_FOCUS_WINDOW)
$isTab = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)
$tabs = @($win.FindAll([Windows.Automation.TreeScope]::Descendants, $isTab))
$tab = $tabs | Where-Object { $_.Current.Name -eq $title } | Select-Object -First 1
if (-not $tab) { $t = & $bare $title; $tab = $tabs | Where-Object { (& $bare $_.Current.Name) -eq $t } | Select-Object -First 1 }
if (-not $tab) { exit 4 }
$tab.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select()
"#;

fn select_tab(pid: u32, window: isize) {
    let script: Vec<u8> = SELECT_TAB.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut c = command("powershell.exe");
    c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &base64(&script)])
        .env("HANGAR_FOCUS_PID", pid.to_string())
        .env("HANGAR_FOCUS_WINDOW", window.to_string());
    let r = run_with(&mut c, None, Duration::from_secs(15));
    if !r.ok {
        eprintln!("hangar: no tab selected for pid {pid}: {}", r.err.trim());
    }
}

fn base64(bytes: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            s.push(if i <= c.len() { A[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    s
}

// The few Win32/NT calls needed, declared directly.
mod win {
    use std::ffi::c_void;

    type Hwnd = *mut c_void;

    pub struct ConsoleWindow {
        pub hwnd: isize,
        pub pid: u32,
        /// A ConPTY pseudo-window (owned by the terminal), rather than a classic console window.
        pub pseudo: bool,
    }

    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(f: extern "system" fn(Hwnd, isize) -> i32, l: isize) -> i32;
        fn GetClassNameW(h: Hwnd, s: *mut u16, n: i32) -> i32;
        fn GetWindowThreadProcessId(h: Hwnd, pid: *mut u32) -> u32;
        fn GetAncestor(h: Hwnd, flags: u32) -> Hwnd;
        fn IsWindowVisible(h: Hwnd) -> i32;
        fn IsIconic(h: Hwnd) -> i32;
        fn ShowWindow(h: Hwnd, cmd: i32) -> i32;
        fn SetForegroundWindow(h: Hwnd) -> i32;
    }

    pub fn console_windows() -> Vec<ConsoleWindow> {
        extern "system" fn each(h: Hwnd, out: isize) -> i32 {
            let out = unsafe { &mut *(out as *mut Vec<ConsoleWindow>) };
            let mut buf = [0u16; 64];
            let n = unsafe { GetClassNameW(h, buf.as_mut_ptr(), buf.len() as i32) }.max(0) as usize;
            let class = String::from_utf16_lossy(&buf[..n]);
            let pseudo = class == "PseudoConsoleWindow";
            if pseudo || class == "ConsoleWindowClass" {
                let mut pid = 0;
                unsafe { GetWindowThreadProcessId(h, &mut pid) };
                out.push(ConsoleWindow { hwnd: h as isize, pid, pseudo });
            }
            1
        }
        let mut v: Vec<ConsoleWindow> = Vec::new();
        unsafe { EnumWindows(each, &mut v as *mut _ as isize) };
        v
    }

    /// The window that shows a console: the terminal owning a pseudo-window, or a visible classic console window.
    pub fn terminal_of(w: &ConsoleWindow) -> Option<isize> {
        const GA_ROOTOWNER: u32 = 3;
        let h = w.hwnd as Hwnd;
        let target = if w.pseudo { unsafe { GetAncestor(h, GA_ROOTOWNER) } } else { h };
        (!target.is_null() && (target != h || !w.pseudo) && unsafe { IsWindowVisible(target) } != 0).then_some(target as isize)
    }

    pub fn bring_forward(window: isize) {
        const SW_RESTORE: i32 = 9;
        let h = window as Hwnd;
        unsafe {
            if IsIconic(h) != 0 {
                ShowWindow(h, SW_RESTORE);
            }
            SetForegroundWindow(h);
        }
    }

    /// The process hosting the console `pid` is attached to (conhost / OpenConsole); None without a console.
    pub fn console_host(pid: u32) -> Option<u32> {
        const PROCESS_CONSOLE_HOST_PROCESS: u32 = 49;
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            let mut v: usize = 0;
            let ok = NtQueryInformationProcess(h, PROCESS_CONSOLE_HOST_PROCESS, (&mut v as *mut usize).cast(), std::mem::size_of::<usize>() as u32, std::ptr::null_mut()) == 0;
            CloseHandle(h);
            // The low bits are flags.
            Some((v & !3) as u32).filter(|&p| ok && p != 0)
        }
    }

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
        fn NtQueryInformationProcess(h: *mut c_void, class: u32, info: *mut c_void, len: u32, ret: *mut u32) -> i32;
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
