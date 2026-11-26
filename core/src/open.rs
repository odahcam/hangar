// Where a session opens: a shell in a terminal app ("PowerShell · Windows Terminal"), picked on Resume's menu, else the
// one set in Settings, else the system's. The shell runs the resume helper in the session's folder and stays once
// claude exits. Each shell and app comes with its icon, read from the system once.
use crate::{db, proc, ApiError, ApiResult, Hangar};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

const PREF: &str = "opener";

#[derive(Clone, Copy, PartialEq, Debug)]
#[allow(dead_code)] // each platform has some of these
pub(crate) enum Kind {
    /// zsh, bash (Git Bash on Windows).
    Posix,
    /// PowerShell 7 and Windows PowerShell.
    Pwsh,
    /// Command Prompt.
    Cmd,
    /// A macOS login shell that isn't POSIX (fish, tcsh): Terminal types the line into it (see MacOs::open).
    Login,
}

#[derive(Clone, Debug)]
pub(crate) struct Shell {
    pub id: String,
    pub name: String,
    pub path: String,
    pub kind: Kind,
}

#[derive(Clone, Debug)]
pub(crate) struct App {
    pub id: &'static str,
    pub name: &'static str,
    /// The bundle or executable its icon comes from ("" for none).
    pub icon: String,
}

/// One piece of a command line: quoted as a program's argument, or (Command Prompt's own syntax) passed as it is.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Arg {
    Q(String),
    Raw(String),
}

impl Arg {
    pub fn text(&self) -> &str {
        match self {
            Arg::Q(s) | Arg::Raw(s) => s,
        }
    }
}

pub(crate) fn posix_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// PowerShell takes the typographic single quotes (U+2018..U+201B) for ' too: each one is doubled the same way.
pub(crate) fn pwsh_quote(s: &str) -> String {
    let mut o = String::from("'");
    for c in s.chars() {
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            o.push(c);
        }
        o.push(c);
    }
    o.push('\'');
    o
}

/// The command line that runs `argv` in `cwd` under `shell` and leaves the shell at its prompt afterwards.
pub(crate) fn shell_argv(shell: &Shell, cwd: &str, argv: &[String]) -> Result<Vec<Arg>, String> {
    Ok(match shell.kind {
        Kind::Posix => {
            let line = format!("cd {} && {}; exec {} -li", posix_quote(cwd), argv.iter().map(|a| posix_quote(a)).collect::<Vec<_>>().join(" "), posix_quote(&shell.path));
            vec![Arg::Q(shell.path.clone()), Arg::Q("-lic".into()), Arg::Q(line)]
        }
        Kind::Pwsh => {
            let line = format!("Set-Location -LiteralPath {}; & {}", pwsh_quote(cwd), argv.iter().map(|a| pwsh_quote(a)).collect::<Vec<_>>().join(" "));
            [shell.path.as_str(), "-NoLogo", "-NoExit", "-Command", &line].into_iter().map(|a| Arg::Q(a.into())).collect()
        }
        // Inside double quotes Command Prompt still expands %VAR%, and a double quote ends the string.
        Kind::Cmd => {
            if std::iter::once(cwd).chain(argv.iter().map(String::as_str)).any(|s| s.contains(['"', '%'])) {
                return Err("unsupported_path".into());
            }
            let line = format!("cd /d \"{cwd}\" && {}", argv.iter().map(|a| format!("\"{a}\"")).collect::<Vec<_>>().join(" "));
            vec![Arg::Q(shell.path.clone()), Arg::Raw("/k".into()), Arg::Raw(line)]
        }
        Kind::Login => vec![],
    })
}

/// A Windows command line from `args`, each quoted the way programs built on the C runtime split it.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn win_cmdline(args: &[Arg]) -> String {
    args.iter()
        .map(|a| match a {
            Arg::Raw(s) => s.clone(),
            Arg::Q(s) if !s.is_empty() && !s.contains([' ', '\t', '"']) => s.clone(),
            // Backslashes count only before a quote: doubled there (and before the closing one), the quote escaped.
            Arg::Q(s) => {
                let mut o = String::from("\"");
                let mut slashes = 0;
                for c in s.chars() {
                    if c == '\\' {
                        slashes += 1;
                        continue;
                    }
                    o.push_str(&"\\".repeat(if c == '"' { slashes * 2 + 1 } else { slashes }));
                    slashes = 0;
                    o.push(c);
                }
                o.push_str(&"\\".repeat(slashes * 2));
                o.push('"');
                o
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn exists(p: &str) -> bool {
    !p.is_empty() && Path::new(p).exists()
}

/// zsh and bash (the login shell's own copy when it is one of them, Homebrew's say), another POSIX login shell (sh,
/// ksh, dash), and a login shell that isn't POSIX (fish, tcsh): that one only as Terminal's own (see `openers`).
#[cfg(target_os = "macos")]
fn shells() -> Vec<Shell> {
    let login = crate::platform::macos::login_shell();
    let name = Path::new(&login).file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    let mut out: Vec<Shell> = [("zsh", "/bin/zsh"), ("bash", "/bin/bash")]
        .into_iter()
        .map(|(id, path)| (id, if name == id { login.clone() } else { path.to_string() }))
        .filter(|(id, p)| exists(p) || name == *id)
        .map(|(id, path)| Shell { id: id.into(), name: id.into(), path, kind: Kind::Posix })
        .collect();
    match name.as_str() {
        "" | "zsh" | "bash" => {}
        "sh" | "ksh" | "dash" => out.push(Shell { id: name.clone(), name, path: login, kind: Kind::Posix }),
        _ => out.push(Shell { id: name.clone(), name, path: login, kind: Kind::Login }),
    }
    out
}

#[cfg(windows)]
fn on_path(exe: &str) -> Option<String> {
    std::env::split_paths(&std::env::var_os("PATH")?).map(|d| d.join(exe)).find(|p| p.is_file()).map(|p| p.to_string_lossy().into_owned())
}

#[cfg(windows)]
fn shells() -> Vec<Shell> {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let programs = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
    let pwsh = on_path("pwsh.exe").unwrap_or_else(|| format!(r"{programs}\PowerShell\7\pwsh.exe"));
    [
        ("pwsh", "PowerShell", pwsh, Kind::Pwsh),
        ("powershell", "Windows PowerShell", format!(r"{root}\System32\WindowsPowerShell\v1.0\powershell.exe"), Kind::Pwsh),
        ("cmd", "Command Prompt", format!(r"{root}\System32\cmd.exe"), Kind::Cmd),
        ("gitbash", "Git Bash", format!(r"{programs}\Git\bin\bash.exe"), Kind::Posix),
    ]
    .into_iter()
    .filter(|(_, _, p, _)| exists(p))
    .map(|(id, name, path, kind)| Shell { id: id.into(), name: name.into(), path, kind })
    .collect()
}

#[cfg(not(any(target_os = "macos", windows)))]
fn shells() -> Vec<Shell> {
    vec![]
}

/// Where .app bundles are looked for; a test world names its own (HANGAR_APPS_DIR).
#[cfg(target_os = "macos")]
fn find_app(name: &str) -> Option<String> {
    let dirs: Vec<std::path::PathBuf> = match std::env::var_os("HANGAR_APPS_DIR") {
        Some(d) => std::env::split_paths(&d).collect(),
        None => vec!["/Applications".into(), "/System/Applications/Utilities".into(), crate::home().join("Applications")],
    };
    dirs.iter().map(|d| d.join(name)).find(|p| p.exists()).map(|p| p.to_string_lossy().into_owned())
}

impl Hangar {
    #[cfg(target_os = "macos")]
    fn apps(&self) -> Vec<App> {
        let mut apps = vec![App { id: "terminal", name: "Terminal", icon: find_app("Terminal.app").unwrap_or_default() }];
        for (id, name, bundle) in [("iterm", "iTerm2", "iTerm.app"), ("ghostty", "Ghostty", "Ghostty.app"), ("wezterm", "WezTerm", "WezTerm.app")] {
            if let Some(icon) = find_app(bundle) {
                apps.push(App { id, name, icon });
            }
        }
        if self.herdr_available() {
            apps.push(App { id: "herdr", name: "herdr", icon: find_app("Herdr.app").unwrap_or_default() });
        }
        apps
    }

    #[cfg(windows)]
    fn apps(&self) -> Vec<App> {
        let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let mut apps = vec![];
        if std::env::var_os("HANGAR_WT").is_some() || exists(&format!(r"{local}\Microsoft\WindowsApps\wt.exe")) {
            apps.push(App { id: "wt", name: "Windows Terminal", icon: WT_ICON.into() });
        }
        apps.push(App { id: "console", name: "Console", icon: format!(r"{root}\System32\conhost.exe") });
        if self.herdr_available() {
            apps.push(App { id: "herdr", name: "herdr", icon: self.herdr_app_icon() });
        }
        apps
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    fn apps(&self) -> Vec<App> {
        vec![]
    }

    /// Every shell × app pair that works together: (opener id, shell, app).
    pub(crate) fn openers(&self) -> Vec<(String, Shell, App)> {
        let shells = shells();
        // Terminal and iTerm2 type into the login shell; one that isn't POSIX can't take the quoted line that starts
        // another shell, so there it's its own and nothing else.
        let typed_posix = !shells.iter().any(|s| s.kind == Kind::Login);
        let mut out = vec![];
        for app in self.apps() {
            for s in &shells {
                let typed = matches!(app.id, "terminal" | "iterm");
                let fits = match s.kind {
                    // herdr starts its terminals from an argv of its own, which Command Prompt's syntax doesn't survive.
                    Kind::Cmd => app.id != "herdr",
                    Kind::Login => app.id == "terminal",
                    _ => !typed || typed_posix,
                };
                if !fits {
                    continue;
                }
                out.push((format!("{}:{}", s.id, app.id), s.clone(), app.clone()));
            }
        }
        out
    }

    /// The system's: the login shell in Terminal (macOS); Windows Terminal (else a console) with its default profile's
    /// shell.
    fn system_opener(&self, openers: &[(String, Shell, App)]) -> Option<String> {
        #[cfg(target_os = "macos")]
        let wanted = {
            let login = crate::platform::macos::login_shell();
            let name = Path::new(&login).file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            vec![format!("{name}:terminal"), "zsh:terminal".to_string()]
        };
        #[cfg(windows)]
        let wanted = {
            let profile = crate::platform::windows::default_profile_name().unwrap_or_default().to_lowercase();
            let shell = if profile.contains("command") || profile.contains("cmd") || profile.contains("prompt") {
                "cmd"
            } else if profile.contains("bash") {
                "gitbash"
            } else if profile.contains("powershell") && !profile.contains("windows") {
                "pwsh"
            } else {
                "powershell"
            };
            ["wt", "console"].iter().flat_map(|a| [format!("{shell}:{a}"), format!("powershell:{a}")]).collect::<Vec<_>>()
        };
        #[cfg(not(any(target_os = "macos", windows)))]
        let wanted: Vec<String> = vec![];
        wanted.into_iter().find(|w| openers.iter().any(|(id, ..)| id == w)).or_else(|| openers.first().map(|(id, ..)| id.clone()))
    }

    fn preferred_opener(&self) -> String {
        db::get_meta(&self.db(), PREF).ok().flatten().unwrap_or_default()
    }

    /// GET /api/openers: every pair, the shells and apps with their names and icons, the system's, the one set in
    /// Settings ("" for none) and the one Resume uses.
    pub(crate) fn openers_status(&self) -> Value {
        let openers = self.openers();
        let system = self.system_opener(&openers);
        let preferred = self.preferred_opener();
        let default = Some(preferred.clone()).filter(|p| openers.iter().any(|(id, ..)| id == p)).or(system.clone());
        let mut paths: Vec<String> = openers.iter().flat_map(|(_, s, a)| [s.path.clone(), a.icon.clone()]).filter(|p| !p.is_empty()).collect();
        paths.sort();
        paths.dedup();
        let icons = if self.discover { icons(&paths) } else { HashMap::new() };
        let (mut shells, mut apps) = (Map::new(), Map::new());
        for (_, s, a) in &openers {
            shells.insert(s.id.clone(), json!({ "name": s.name, "icon": icons.get(&s.path) }));
            apps.insert(a.id.into(), json!({ "name": a.name, "icon": icons.get(&a.icon) }));
        }
        json!({
            "openers": openers.iter().map(|(id, s, a)| json!({ "id": id, "shell": s.id, "app": a.id })).collect::<Vec<_>>(),
            "shells": shells, "apps": apps, "system": system, "preferred": preferred, "default": default,
        })
    }

    /// PATCH /api/openers: { preferred } ("" goes back to the system's).
    pub(crate) fn set_opener(&self, body: &Value) -> ApiResult {
        let p = body["preferred"].as_str().ok_or_else(|| ApiError(400, "preferred".into()))?;
        if !p.is_empty() && !self.openers().iter().any(|(id, ..)| id == p) {
            return Err(ApiError(400, "unknown_opener".into()));
        }
        db::set_meta(&self.db(), PREF, p)?;
        Ok(json!({ "ok": true }))
    }

    /// Opens `argv` in `cwd` with opener `id` (None: the default).
    pub(crate) fn open_with(&self, id: Option<&str>, cwd: &str, argv: &[String]) -> ApiResult<()> {
        let openers = self.openers();
        let id = match id {
            Some(i) => i.to_string(),
            None => {
                let p = self.preferred_opener();
                if openers.iter().any(|(o, ..)| *o == p) { p } else { self.system_opener(&openers).unwrap_or_default() }
            }
        };
        let Some((_, shell, app)) = openers.iter().find(|(o, ..)| *o == id) else {
            // No shell or app found (an unknown platform): the platform's own way.
            if openers.is_empty() {
                return self.platform.open(cwd, argv).map_err(|e| ApiError(500, e));
            }
            return Err(ApiError(400, "unknown_opener".into()));
        };
        let line = shell_argv(shell, cwd, argv).map_err(|e| ApiError(409, e))?;
        self.launch(shell, app, cwd, argv, &line).map_err(|e| ApiError(500, e))
    }

    /// macOS: a running session that isn't in a Terminal tab is in another terminal app (its process's ancestors say
    /// which). iTerm2 brings its session forward; Ghostty and WezTerm, which can't be asked for a tab, come forward
    /// themselves. Opening it again would fork the session, so where it can't be shown it says so. None: in none of
    /// them (Terminal's own flow goes on).
    #[cfg(target_os = "macos")]
    pub(crate) fn focus_in_app(&self, pid: u32, tty: Option<&str>) -> Option<ApiResult> {
        use crate::platform::macos as mac;
        let shown = |ok: bool| Some(if ok { Ok(json!({ "focused": tty.unwrap_or_default() })) } else { Err(ApiError(409, "already_open".into())) });
        // A test world's sessions run under the test runner, whose own terminal isn't theirs; a test asks by name.
        if !self.discover && std::env::var_os("HANGAR_HOST_APPS").is_none() {
            return None;
        }
        match mac::host_app(pid)? {
            "terminal" => None,
            "iterm" => shown(tty.is_some_and(mac::iterm_focus)),
            app @ ("ghostty" | "wezterm") => {
                let bundle = find_app(if app == "ghostty" { "Ghostty.app" } else { "WezTerm.app" });
                shown(bundle.is_some_and(|b| mac::activate(&b)))
            }
            _ => shown(false),
        }
    }

    #[cfg(not(target_os = "macos"))]
    pub(crate) fn focus_in_app(&self, _: u32, _: Option<&str>) -> Option<ApiResult> {
        None
    }

    #[cfg(target_os = "macos")]
    fn launch(&self, shell: &Shell, app: &App, cwd: &str, argv: &[String], line: &[Arg]) -> Result<(), String> {
        use crate::platform::macos as mac;
        let words: Vec<String> = line.iter().map(|a| a.text().to_string()).collect();
        let exec = format!("exec {}", words.iter().map(|w| posix_quote(w)).collect::<Vec<_>>().join(" "));
        match app.id {
            // The login shell types the helper's line itself, as Terminal always did (see MacOs::open).
            "terminal" if shell.path == mac::login_shell() => self.platform.open(cwd, argv),
            "terminal" => mac::terminal_type(&format!("cd {}\n{exec}", posix_quote(cwd))),
            "iterm" => mac::iterm_type(&format!("cd {} && {exec}", posix_quote(cwd))),
            "ghostty" => {
                let mut args = vec!["-na".to_string(), app.icon.clone(), "--args".into(), format!("--working-directory={cwd}"), "-e".into()];
                args.extend(words);
                let o = proc::run(&mac::open_bin(), &args.iter().map(String::as_str).collect::<Vec<_>>(), Duration::from_secs(8));
                if o.ok { Ok(()) } else { Err(o.err.trim().to_string()) }
            }
            "wezterm" => {
                let bin = Path::new(&app.icon).join("Contents/MacOS/wezterm");
                let mut c = proc::command(&bin.to_string_lossy());
                c.args(["start", "--cwd", cwd, "--"]).args(&words);
                spawn_detached(c)
            }
            "herdr" => self.herdr_open(cwd, &words),
            other => Err(format!("unknown app {other}")),
        }
    }

    #[cfg(windows)]
    fn launch(&self, _: &Shell, app: &App, cwd: &str, _: &[String], line: &[Arg]) -> Result<(), String> {
        use crate::platform::windows as win;
        match app.id {
            "wt" => win::wt_tab(cwd, line),
            "console" => win::console(cwd, line),
            "herdr" => self.herdr_open(cwd, &line.iter().map(|a| a.text().to_string()).collect::<Vec<_>>()),
            other => Err(format!("unknown app {other}")),
        }
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    fn launch(&self, _: &Shell, _: &App, cwd: &str, argv: &[String], _: &[Arg]) -> Result<(), String> {
        self.platform.open(cwd, argv)
    }
}

/// Windows Terminal's icon: its package's executable, found at icon time (the WindowsApps alias has none).
#[cfg(windows)]
const WT_ICON: &str = "<wt>";

#[cfg(target_os = "macos")]
fn spawn_detached(mut c: std::process::Command) -> Result<(), String> {
    use std::process::Stdio;
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = c.spawn().map_err(|e| e.to_string())?;
    std::thread::spawn(move || child.wait());
    Ok(())
}

/// Icons as data: URLs (PNG, 32 px), by path; each read once per run.
static ICONS: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);

fn icons(paths: &[String]) -> HashMap<String, String> {
    let mut cache = ICONS.lock().unwrap_or_else(|e| e.into_inner());
    let cache = cache.get_or_insert_with(HashMap::new);
    let missing: Vec<String> = paths.iter().filter(|p| !cache.contains_key(*p)).cloned().collect();
    if !missing.is_empty() {
        let got = read_icons(&missing);
        for p in missing {
            let icon = got.get(&p).cloned();
            cache.insert(p, icon);
        }
    }
    paths.iter().filter_map(|p| Some((p.clone(), cache.get(p)?.clone()?))).collect()
}

/// AppKit draws each file's icon (an app's own, a shell's generic one) at 32 points; PNG out.
#[cfg(target_os = "macos")]
fn read_icons(paths: &[String]) -> HashMap<String, String> {
    const JXA: &str = r#"ObjC.import('AppKit');
function run(argv) {
  var out = {};
  argv.forEach(function (p) {
    var img = $.NSWorkspace.sharedWorkspace.iconForFile(p);
    var small = $.NSImage.alloc.initWithSize({ width: 32, height: 32 });
    small.lockFocus;
    img.drawInRectFromRectOperationFraction({ origin: { x: 0, y: 0 }, size: { width: 32, height: 32 } }, { origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } }, $.NSCompositingOperationSourceOver, 1);
    small.unlockFocus;
    var rep = $.NSBitmapImageRep.imageRepWithData(small.TIFFRepresentation);
    var png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
    out[p] = png.base64EncodedStringWithOptions(0).js;
  });
  return JSON.stringify(out);
}"#;
    let mut args = vec!["-l", "JavaScript", "-e", JXA];
    args.extend(paths.iter().map(String::as_str));
    parse_icons(&proc::run("osascript", &args, Duration::from_secs(20)).out)
}

/// The icon each executable shows in Explorer (Windows Terminal's from its package), PNG out.
#[cfg(windows)]
fn read_icons(paths: &[String]) -> HashMap<String, String> {
    const PS: &str = r#"Add-Type -AssemblyName System.Drawing
$o = @{}
foreach ($p in ([Console]::In.ReadToEnd() -split "`n")) {
  $p = $p.Trim(); if (-not $p) { continue }
  $f = $p
  if ($p -eq '<wt>') { $k = Get-AppxPackage Microsoft.WindowsTerminal | Select-Object -First 1; if (-not $k) { continue }; $f = Join-Path $k.InstallLocation 'WindowsTerminal.exe' }
  try {
    $b = [System.Drawing.Icon]::ExtractAssociatedIcon($f).ToBitmap()
    $m = New-Object IO.MemoryStream
    $b.Save($m, [System.Drawing.Imaging.ImageFormat]::Png)
    $o[$p] = [Convert]::ToBase64String($m.ToArray())
  } catch {}
}
$o | ConvertTo-Json -Compress"#;
    let mut c = proc::command("powershell.exe");
    c.args(["-NoProfile", "-NonInteractive", "-Command", PS]);
    parse_icons(&proc::run_with(&mut c, Some(&paths.join("\n")), Duration::from_secs(30)).out)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn read_icons(_: &[String]) -> HashMap<String, String> {
    HashMap::new()
}

fn parse_icons(out: &str) -> HashMap<String, String> {
    let v: Value = serde_json::from_str(out.trim()).unwrap_or(Value::Null);
    v.as_object()
        .into_iter()
        .flatten()
        .filter_map(|(k, v)| Some((k.clone(), format!("data:image/png;base64,{}", v.as_str().filter(|s| !s.is_empty())?))))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(kind: Kind, path: &str) -> Shell {
        Shell { id: "x".into(), name: "x".into(), path: path.into(), kind }
    }

    #[test]
    fn shell_lines() {
        let argv = vec!["/A/hangar-resume".to_string(), "id".to_string()];
        assert_eq!(
            shell_argv(&sh(Kind::Posix, "/bin/zsh"), "/w/it's", &argv).unwrap(),
            vec![Arg::Q("/bin/zsh".into()), Arg::Q("-lic".into()), Arg::Q(r"cd '/w/it'\''s' && '/A/hangar-resume' 'id'; exec '/bin/zsh' -li".into())]
        );
        assert_eq!(
            shell_argv(&sh(Kind::Pwsh, "pwsh.exe"), r"C:\it's", &argv).unwrap().last().unwrap(),
            &Arg::Q(r"Set-Location -LiteralPath 'C:\it''s'; & '/A/hangar-resume' 'id'".into())
        );
        assert_eq!(
            shell_argv(&sh(Kind::Cmd, "cmd.exe"), r"C:\a b", &argv).unwrap(),
            vec![Arg::Q("cmd.exe".into()), Arg::Raw("/k".into()), Arg::Raw(r#"cd /d "C:\a b" && "/A/hangar-resume" "id""#.into())]
        );
        assert!(shell_argv(&sh(Kind::Cmd, "cmd.exe"), r"C:\100%", &argv).is_err());
    }

    #[test]
    fn windows_command_lines() {
        let line = win_cmdline(&[Arg::Q(r"C:\Program Files\x.exe".into()), Arg::Q("plain".into()), Arg::Q(r#"say "hi""#.into()), Arg::Q(r"C:\dir\".into()), Arg::Raw("/k".into())]);
        assert_eq!(line, r#""C:\Program Files\x.exe" plain "say \"hi\"" C:\dir\ /k"#);
        assert_eq!(win_cmdline(&[Arg::Q(r"C:\a b\".into())]), r#""C:\a b\\""#);
        assert_eq!(win_cmdline(&[Arg::Q(String::new())]), r#""""#);
    }
}
