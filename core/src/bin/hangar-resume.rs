// hangar-resume <session id> [--config <account folder>]: run by a terminal tab in the session's folder, resumes the
// session under its account (see core/src/resume.rs). On Unix it becomes claude; on Windows it waits for claude in
// the same console and hands back its exit code.
use hangar_core::resume;

fn main() {
    let mut args = std::env::args().skip(1);
    let (mut id, mut config) = (None, None);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--config" => config = Some(args.next().unwrap_or_else(|| usage())),
            _ if id.is_none() => id = Some(a),
            _ => usage(),
        }
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
        // Ctrl+C in the tab reaches every process of the console: claude handles it, this one must outlive it.
        #[cfg(windows)]
        unsafe {
            #[link(name = "kernel32")]
            extern "system" {
                fn SetConsoleCtrlHandler(handler: usize, add: i32) -> i32;
            }
            SetConsoleCtrlHandler(0, 1);
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
