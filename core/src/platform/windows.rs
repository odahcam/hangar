// Windows: sessions open as Windows Terminal tabs. Windows Terminal can't list its tabs from outside, so there is no
// idle-tab cleanup here. A running session is still brought forward: its console's window leads to the terminal
// window that hosts it, and UI Automation selects the tab whose title is that console's title.
use super::{Caps, Platform, Tab};
use crate::proc::{command, run_with, TERMINAL_ENV};
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

    // $PATH: searches only the PATH; a bare name would look in the current folder first (for the resume helper, the
    // session's own repository).
    fn which_claude(&self) -> (String, Vec<String>) {
        ("where.exe".into(), vec!["$PATH:claude".into()])
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
    // The tab runs the helper's command line itself, no shell, under the user's default profile: given a command
    // without -p, Windows Terminal takes the profiles' common settings ("Default", no icon) instead, so the default
    // profile is named. wt splits its command line on ";", so each one is escaped. The tab closes when claude exits.
    fn open(&self, cwd: &str, argv: &[String]) -> Result<(), String> {
        let dir = cwd.replace(';', "\\;");
        let line: Vec<String> = argv.iter().map(|a| a.replace(';', "\\;")).collect();
        // The tab inherits wt's environment, ours: without the look of the terminal Hangar may have been started from.
        let mut wt = command(&WT);
        for k in TERMINAL_ENV {
            wt.env_remove(k);
        }
        wt.args(["-w", "0", "new-tab"]);
        if let Some(p) = default_profile() {
            wt.args(["-p", &p.replace(';', "\\;")]);
        }
        wt.args(["--startingDirectory", &dir]).args(&line);
        let r = run_with(&mut wt, None, Duration::from_secs(8));
        if !r.missing {
            return Ok(());
        }
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x10;
        let (bin, args) = argv.split_first().ok_or("no command")?;
        let mut c = command(bin);
        for k in TERMINAL_ENV {
            c.env_remove(k);
        }
        c.args(args).current_dir(cwd).creation_flags(CREATE_NEW_CONSOLE).spawn().map(drop).map_err(|e| e.to_string())
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

/// A new tab in the most recent Windows Terminal window, under the default profile (see `open`), running `line` (a
/// shell's, see open.rs) as its command line; without Windows Terminal, a console window.
pub(crate) fn wt_tab(cwd: &str, line: &[crate::open::Arg]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let mut wt = command(&WT);
    for k in TERMINAL_ENV {
        wt.env_remove(k);
    }
    wt.args(["-w", "0", "new-tab"]);
    if let Some(p) = default_profile() {
        wt.args(["-p", &p.replace(';', "\\;")]);
    }
    wt.args(["--startingDirectory", &cwd.replace(';', "\\;")]);
    wt.raw_arg(crate::open::win_cmdline(line).replace(';', "\\;"));
    if run_with(&mut wt, None, Duration::from_secs(8)).missing {
        return console(cwd, line);
    }
    Ok(())
}

/// A console window of its own running `line`.
pub(crate) fn console(cwd: &str, line: &[crate::open::Arg]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x10;
    let (bin, rest) = line.split_first().ok_or("no command")?;
    // Tests stand in for the console window: given the program and the command line it would get.
    if let Ok(fake) = std::env::var("HANGAR_CONSOLE") {
        let r = run_with(command(&fake).args([bin.text(), &crate::open::win_cmdline(rest), cwd]), None, Duration::from_secs(8));
        return if r.ok { Ok(()) } else { Err(r.err) };
    }
    let mut c = command(bin.text());
    for k in TERMINAL_ENV {
        c.env_remove(k);
    }
    c.raw_arg(crate::open::win_cmdline(rest)).current_dir(cwd).creation_flags(CREATE_NEW_CONSOLE).spawn().map(drop).map_err(|e| e.to_string())
}

/// JSON with comments (// and /* */) and trailing commas, as Windows Terminal takes it, made plain JSON.
pub(crate) fn strict_json(text: &str) -> String {
    // Comments first (outside strings), then commas whose next non-blank is } or ].
    let c: Vec<char> = text.chars().collect();
    let (mut bare, mut i, mut in_str) = (Vec::with_capacity(c.len()), 0, false);
    while i < c.len() {
        match (in_str, c[i], c.get(i + 1)) {
            (true, '\\', Some(&n)) => {
                bare.extend([c[i], n]);
                i += 2;
                continue;
            }
            (true, '"', _) | (false, '"', _) => in_str = !in_str,
            (false, '/', Some('/')) => {
                while i < c.len() && c[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            (false, '/', Some('*')) => {
                i += 2;
                while i < c.len() && !(c[i] == '*' && c.get(i + 1) == Some(&'/')) {
                    i += 1;
                }
                i += 2;
                continue;
            }
            _ => {}
        }
        bare.push(c[i]);
        i += 1;
    }
    let mut out = String::with_capacity(bare.len());
    let (mut in_str, mut esc) = (false, false);
    for (j, &ch) in bare.iter().enumerate() {
        if esc {
            esc = false;
        } else if in_str && ch == '\\' {
            esc = true;
        } else if ch == '"' {
            in_str = !in_str;
        }
        if !in_str && ch == ',' && matches!(bare[j + 1..].iter().find(|c| !c.is_whitespace()), Some('}' | ']')) {
            continue;
        }
        out.push(ch);
    }
    out
}

fn settings_text() -> Option<String> {
    let local = PathBuf::from(std::env::var_os("LOCALAPPDATA")?);
    [
        local.join(r"Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json"),
        local.join(r"Packages\Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe\LocalState\settings.json"),
        local.join(r"Microsoft\Windows Terminal\settings.json"),
    ]
    .iter()
    .find_map(|f| std::fs::read_to_string(f).ok())
}

/// The name of Windows Terminal's default profile ("Windows PowerShell", "Command Prompt"...), which tells its shell.
pub(crate) fn default_profile_name() -> Option<String> {
    let guid = default_profile()?;
    let v: serde_json::Value = serde_json::from_str(&strict_json(&settings_text()?)).ok()?;
    let list = v["profiles"]["list"].as_array().or(v["profiles"].as_array())?;
    list.iter().find(|p| p["guid"].as_str().is_some_and(|g| g.eq_ignore_ascii_case(&guid)))?["name"].as_str().map(String::from)
}

// The "defaultProfile" of Windows Terminal's settings (the Store build's, else Preview's, else the unpackaged one's).
// The file allows comments, so the value is read as the first string after the key rather than parsed as JSON; a key
// behind "//" on its line is a comment's.
fn default_profile() -> Option<String> {
    let text = settings_text()?;
    const KEY: &str = "\"defaultProfile\"";
    let at = text.match_indices(KEY).map(|(i, _)| i).find(|&i| !text[text[..i].rfind('\n').map_or(0, |n| n + 1)..i].contains("//"))?;
    let rest = &text[at + KEY.len()..];
    let rest = rest.trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
    Some(rest[..rest.find('"')?].to_string()).filter(|p| !p.is_empty() && !p.contains('\\'))
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

// Ctrl+Break to the console `pid` is attached to, from a PowerShell helper (attaching to another console means
// letting go of one's own). Claude Code takes it as a quit: it exits 0 and cleans up after itself, ending its remote
// control session too, which TerminateProcess skips. The event reaches every process of that console; PowerShell
// (5.1 and 7) and the resume helper outlive it. The helper itself may die of it: the event is sent by then.
const CTRL_BREAK: &str = r#"
Add-Type -Namespace Hangar -Name Brk -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
[DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint ev, uint group);
'@
[void][Hangar.Brk]::FreeConsole()
if (-not [Hangar.Brk]::AttachConsole([uint32]$env:HANGAR_BREAK_PID)) { exit 2 }
[void][Hangar.Brk]::GenerateConsoleCtrlEvent(1, 0)
"#;

/// Asks the session `pid` to quit as Ctrl+Break would; false when that couldn't be sent. Never to a session on this
/// process's own console (hangar-server started from a terminal, with the session beside it): the event would reach
/// that terminal's shell and whatever it runs, which a script-running PowerShell takes as "break into the debugger".
pub(crate) fn ctrl_break(pid: u32) -> bool {
    let mine = win::console_host(std::process::id());
    if mine.is_some() && mine == win::console_host(pid) {
        return false;
    }
    let script: Vec<u8> = CTRL_BREAK.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut c = command("powershell.exe");
    c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &base64(&script)])
        .env("HANGAR_BREAK_PID", pid.to_string());
    // Exit code 2: no console to attach to. Anything else, the event went out (the helper may die of it).
    let r = run_with(&mut c, None, Duration::from_secs(10));
    !r.missing && !r.err.starts_with("exit 2:")
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

#[cfg(test)]
mod tests {
    use super::strict_json;

    #[test]
    fn windows_terminal_settings_parse_with_comments_and_trailing_commas() {
        let text = "{\n  // \"defaultProfile\": \"{x}\",\n  \"defaultProfile\": \"{y}\", /* mine */\n  \"profiles\": { \"list\": [\n    { \"name\": \"Power//Shell, \\\"7\\\"\", // the new one\n      \"guid\": \"{y}\", },\n  ], },\n}\n";
        let v: serde_json::Value = serde_json::from_str(&strict_json(text)).expect("plain JSON");
        assert_eq!(v["defaultProfile"], "{y}");
        assert_eq!(v["profiles"]["list"][0]["name"], "Power//Shell, \"7\"");
    }
}
