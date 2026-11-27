// hangar-resume <session id> [--config <account folder>]: run by a terminal tab in the session's folder, resumes the
// session under its account (see core/src/resume.rs). On Unix it becomes claude; on Windows it waits for claude in
// the same console and hands back its exit code.
// hangar-resume --session-start [--hc <path>]: run by an account's SessionStart hook (see core/src/hook.rs).
use hangar_core::resume;

fn main() {
    let mut args = std::env::args().skip(1);
    let (mut id, mut config, mut hook, mut hc) = (None, None, false, None);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--config" => config = Some(args.next().unwrap_or_else(|| usage())),
            "--session-start" => hook = true,
            "--hc" => hc = Some(args.next().unwrap_or_default()),
            _ if id.is_none() => id = Some(a),
            _ => usage(),
        }
    }
    if hook {
        hangar_core::hook::session_start(hc.filter(|p| !p.is_empty()));
        return;
    }
    let id = id.filter(|i| resume::valid_id(i)).unwrap_or_else(|| usage());
    let mut c = resume::claude_command(&id, config.as_deref()).unwrap_or_else(|e| fail(&e));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let e = c.exec();
        fail(&format!("can't start claude: {e}"));
    }
    #[cfg(not(unix))]
    {
        // Ctrl+C in the tab, and the Ctrl+Break Hangar's close sends, reach every process of the console: claude
        // handles them, this one must outlive them to hand back claude's exit code.
        #[cfg(windows)]
        unsafe {
            #[link(name = "kernel32")]
            extern "system" {
                fn SetConsoleCtrlHandler(handler: Option<unsafe extern "system" fn(u32) -> i32>, add: i32) -> i32;
            }
            unsafe extern "system" fn outlive(event: u32) -> i32 {
                // CTRL_C_EVENT, CTRL_BREAK_EVENT: handled (ignored). Closing the window still ends this.
                (event <= 1) as i32
            }
            SetConsoleCtrlHandler(Some(outlive), 1);
        }
        match c.status() {
            Ok(s) => std::process::exit(s.code().unwrap_or(1)),
            Err(e) => fail(&format!("can't start claude: {e}")),
        }
    }
}

fn usage() -> ! {
    fail("usage: hangar-resume <session id> [--config <account folder>]")
}

fn fail(msg: &str) -> ! {
    eprintln!("hangar-resume: {msg}");
    std::process::exit(2)
}
