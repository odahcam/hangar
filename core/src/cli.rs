// Pairing from a command line, both ways: `Hangar --offer` prints a code from this machine (a member) and waits for a
// machine to join with it; `Hangar --pair <code>` joins this machine with the member showing that code.
//
// The running app does the work. The command starts the app again with its request and a reply file; the single
// instance plugin hands those arguments to the running app (or that launch becomes the app), which answers in the
// file, one JSON line at a time: {"say": text} to print, {"exit": code} to end. Only a local process can pass
// arguments, unlike a hangar:// link, which any web page can open.
use crate::Hangar;
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

const REPLY: &str = "--reply";
const PREFIX: &str = "hangar-reply-";
/// How long a member waits for the joining machine once its code is up (the code lives 300 s).
const OFFER_WAIT: Duration = Duration::from_secs(300);
/// How long the link may take to be online with the chain seen.
const READY_WAIT: Duration = Duration::from_secs(30);
const PAIR_WAIT: Duration = Duration::from_secs(60);

enum Request {
    Offer,
    Pair(String),
}

fn request(argv: &[String]) -> Option<Request> {
    match argv.get(1)?.as_str() {
        "--offer" => Some(Request::Offer),
        "--pair" => Some(Request::Pair(argv.get(2)?.clone())),
        _ => None,
    }
}

/// In the command's own process, before the app starts: Some(exit code) when it was a pairing command.
pub fn client() -> Option<i32> {
    let argv: Vec<String> = std::env::args().collect();
    if argv.iter().any(|a| a == REPLY) {
        return None;
    }
    if argv.get(1).is_some_and(|a| a == "--pair") && argv.len() != 3 || argv.get(1).is_some_and(|a| a == "--offer") && argv.len() != 2 {
        eprintln!("usage: Hangar --offer | Hangar --pair <code>");
        return Some(2);
    }
    let req = request(&argv)?;
    attach_console();
    Some(run_client(&argv[1..], match req {
        Request::Offer => OFFER_WAIT + READY_WAIT,
        Request::Pair(_) => PAIR_WAIT + READY_WAIT,
    }))
}

fn run_client(args: &[String], wait: Duration) -> i32 {
    let mut id = [0u8; 16];
    if getrandom::fill(&mut id).is_err() {
        eprintln!("hangar: no random source");
        return 1;
    }
    let name: String = id.iter().map(|b| format!("{b:02x}")).collect();
    let path = std::env::temp_dir().join(format!("{PREFIX}{name}.jsonl"));
    let Ok(mut file) = OpenOptions::new().write(true).create_new(true).open(&path).and_then(|_| File::open(&path)) else {
        eprintln!("hangar: can't create {}", path.display());
        return 1;
    };
    let code = (|| {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        Command::new(exe)
            .args(args)
            .arg(REPLY)
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        let (start, mut at, mut partial) = (Instant::now(), 0u64, String::new());
        while start.elapsed() < wait {
            std::thread::sleep(Duration::from_millis(250));
            let mut chunk = String::new();
            file.seek(SeekFrom::Start(at)).and_then(|_| file.read_to_string(&mut chunk)).map_err(|e| e.to_string())?;
            at += chunk.len() as u64;
            partial.push_str(&chunk);
            while let Some(n) = partial.find('\n') {
                let line: String = partial.drain(..=n).collect();
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(s) = v["say"].as_str() {
                    println!("{s}");
                }
                if let Some(c) = v["exit"].as_i64() {
                    return Ok(c as i32);
                }
            }
        }
        Err("no answer from Hangar".to_string())
    })();
    drop(file);
    let _ = std::fs::remove_file(&path);
    code.unwrap_or_else(|e| {
        eprintln!("hangar: {e}");
        1
    })
}

/// A Windows GUI program has no console of its own: print in the one it was started from, unless its output is
/// already going somewhere.
fn attach_console() {
    #[cfg(windows)]
    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetStdHandle(n: u32) -> isize;
            fn AttachConsole(pid: u32) -> i32;
        }
        const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
        const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
        if GetStdHandle(STD_OUTPUT_HANDLE) == 0 {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

/// The reply file of a request: only one the command made, in the temp folder under its own name, so the arguments
/// can't make the app write anywhere else.
fn reply_file(argv: &[String]) -> Option<File> {
    let p = PathBuf::from(argv.get(argv.iter().position(|a| a == REPLY)? + 1)?);
    let name = p.file_name()?.to_str()?;
    let hex = name.strip_prefix(PREFIX)?.strip_suffix(".jsonl")?;
    if hex.len() != 32 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let tmp = std::env::temp_dir().canonicalize().ok()?;
    if p.parent()?.canonicalize().ok()? != tmp || !std::fs::symlink_metadata(&p).ok()?.is_file() {
        return None;
    }
    OpenOptions::new().append(true).open(&p).ok()
}

/// In the running app, for the arguments a launch handed over: true when they were a pairing request, answered on a
/// thread of its own.
pub fn serve(hangar: &Arc<Hangar>, argv: &[String]) -> bool {
    let Some(req) = request(argv) else { return false };
    let Some(mut out) = reply_file(argv) else { return true };
    let hangar = Arc::clone(hangar);
    std::thread::spawn(move || {
        let mut say = |v: Value| {
            let _ = writeln!(out, "{v}");
        };
        let code = match answer(&hangar, req, &mut |s: &str| say(json!({ "say": s }))) {
            Ok(()) => 0,
            Err(e) => {
                say(json!({ "say": format!("hangar: {e}") }));
                1
            }
        };
        say(json!({ "exit": code }));
    });
    true
}

fn answer(hangar: &Hangar, req: Request, say: &mut dyn FnMut(&str)) -> Result<(), String> {
    let cloud = hangar.cloud().ok_or("cloud_off")?;
    let status = || cloud.status();
    let ready = wait(READY_WAIT, || {
        let s = status();
        match s["link"]["state"].as_str() {
            Some("signed_out") => Some(Err("signed_out".to_string())),
            Some("online") if s["trust"]["state"] != "unknown" => Some(Ok(())),
            _ => None,
        }
    });
    ready.unwrap_or(Err("not_online".into()))?;
    match req {
        Request::Offer => {
            let code = cloud.offer()?;
            say(&code);
            wait(OFFER_WAIT, || {
                let s = status();
                if let Some(d) = s["joined"].as_str() {
                    return Some(Ok(d.to_string()));
                }
                s["offer"].is_null().then(|| Err("code_expired".to_string()))
            })
            .unwrap_or(Err("code_expired".into()))
            .map(|d| say(&format!("joined: {d}")))
        }
        Request::Pair(code) => {
            cloud.join(&code)?;
            wait(PAIR_WAIT, || {
                let s = status();
                if s["trust"]["state"] == "member" {
                    return Some(Ok(()));
                }
                if s["joinRefused"] == true {
                    return Some(Err("refused".to_string()));
                }
                (s["joining"] == false).then(|| Err("no_answer".to_string()))
            })
            .unwrap_or(Err("no_answer".into()))
            .map(|_| say(&format!("paired: {}", status()["device"].as_str().unwrap_or(""))))
        }
    }
}

fn wait<T>(limit: Duration, mut check: impl FnMut() -> Option<T>) -> Option<T> {
    let start = Instant::now();
    loop {
        if let Some(v) = check() {
            return Some(v);
        }
        if start.elapsed() >= limit {
            return None;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reply_file_is_only_one_the_command_made() {
        let name = format!("{PREFIX}{}.jsonl", "ab".repeat(16));
        let ok = std::env::temp_dir().join(&name);
        std::fs::write(&ok, "").unwrap();
        assert!(reply_file(&args(&["h", "--offer", REPLY, ok.to_str().unwrap()])).is_some());
        let missing = std::env::temp_dir().join(format!("{PREFIX}{}.jsonl", "cd".repeat(16)));
        assert!(reply_file(&args(&["h", "--offer", REPLY, missing.to_str().unwrap()])).is_none());
        let elsewhere = std::env::temp_dir().join("x").join(&name);
        assert!(reply_file(&args(&["h", "--offer", REPLY, elsewhere.to_str().unwrap()])).is_none());
        let other = std::env::temp_dir().join("notes.txt");
        assert!(reply_file(&args(&["h", "--offer", REPLY, other.to_str().unwrap()])).is_none());
        std::fs::remove_file(&ok).unwrap();
    }

    #[test]
    fn requests() {
        assert!(matches!(request(&args(&["h", "--offer"])), Some(Request::Offer)));
        assert!(matches!(request(&args(&["h", "--pair", "ABC123"])), Some(Request::Pair(c)) if c == "ABC123"));
        assert!(request(&args(&["h", "--pair"])).is_none());
        assert!(request(&args(&["h", "hangar://auth/callback?x"])).is_none());
    }
}
