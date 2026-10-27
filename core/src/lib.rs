// Hangar core: local catalog of Claude Code sessions. Reads every account's config dir live (~/.claude, ~/.claude-*;
// see accounts.rs), keeps status/priority/notes in SQLite, backs up pending transcripts, asks Haiku which closed
// sessions look done, and drives the terminal (see platform/).
//
// Every entry point is `Hangar::handle(method, path, body)`, the same JSON API whether it is called in-process by the
// desktop app (Tauri `invoke`) or over HTTP by the `hangar-server` binary the tests and `npm start` use.
mod accounts;
mod classify;
mod db;
mod insights;
pub mod platform;
mod proc;
mod scan;
mod sessions;

use regex::Regex;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

pub(crate) static UUID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap());
pub(crate) const HOUR: f64 = 36e5;
pub(crate) const DAY: f64 = 864e5;

pub(crate) fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_default()
}

pub(crate) fn now_ms() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}

/// The ISO-8601 form JavaScript's toISOString writes, which is what Claude Code's timestamps use too:
/// timestamps compare as strings.
pub(crate) fn iso(ms: f64) -> String {
    chrono::DateTime::from_timestamp_millis(ms as i64).unwrap_or_default().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(crate) fn parse_ms(iso: &str) -> Option<f64> {
    chrono::DateTime::parse_from_rfc3339(iso).ok().map(|d| d.timestamp_millis() as f64)
}

pub(crate) fn local_day(iso: &str) -> Option<String> {
    let d = chrono::DateTime::parse_from_rfc3339(iso).ok()?;
    Some(d.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
}

pub struct Config {
    /// Claude Code config directories, one per account, always scanned.
    pub claude_dirs: Vec<PathBuf>,
    /// Also scan every ~/.claude and ~/.claude-* that has a projects folder (see accounts.rs).
    pub discover: bool,
    /// Hangar's own state: state.db and the transcript backups.
    pub data_dir: PathBuf,
    /// When the first background rescan + done detection runs, and how often after that.
    pub classify_start: Duration,
    pub classify_every: Duration,
}

impl Config {
    /// HANGAR_CLAUDE_DIRS (a PATH-style list) / HANGAR_CLAUDE_DIR / HANGAR_DATA_DIR override the defaults and turn
    /// discovery off (tests point them at a throwaway world); HANGAR_CLASSIFY_START_MS / HANGAR_CLASSIFY_EVERY_MS pace
    /// the classifier.
    pub fn from_env() -> Self {
        let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
        let ms = |k: &str, default: u64| Duration::from_millis(std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(default));
        let fixed: Option<Vec<PathBuf>> = std::env::var_os("HANGAR_CLAUDE_DIRS")
            .filter(|v| !v.is_empty())
            .map(|v| std::env::split_paths(&v).collect())
            .or_else(|| env("HANGAR_CLAUDE_DIR").map(|d| vec![d]));
        Config {
            discover: fixed.is_none(),
            claude_dirs: fixed.unwrap_or_else(|| env("CLAUDE_CONFIG_DIR").into_iter().collect()),
            data_dir: env("HANGAR_DATA_DIR").unwrap_or_else(|| platform::current().data_dir(&home())),
            classify_start: ms("HANGAR_CLASSIFY_START_MS", 30_000),
            classify_every: ms("HANGAR_CLASSIFY_EVERY_MS", 600_000),
        }
    }
}

pub struct Hangar {
    claude_dirs: Vec<PathBuf>,
    discover: bool,
    backup_dir: PathBuf,
    db: Mutex<Connection>,
    timing: (Duration, Duration),
    classifying: AtomicBool,
    runs: Mutex<Runs>,
    /// Set (and notified) to start the background run now instead of at its next scheduled time.
    wake: (Mutex<bool>, Condvar),
    platform: &'static dyn platform::Platform,
}

/// Done detection runs, as ms timestamps: the last one's start and end, and when the background thread runs next.
#[derive(Default, Clone)]
struct Runs {
    last_start: Option<f64>,
    last_end: Option<f64>,
    next: Option<f64>,
    /// Why the last run classified nothing, when it couldn't (e.g. the chosen account is gone).
    error: Option<String>,
}

/// An API answer: HTTP-style status and a JSON body ({ error } when status >= 400).
pub struct Reply {
    pub status: u16,
    pub body: Value,
}

pub(crate) struct ApiError(u16, String);

impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> Self {
        ApiError(500, e.to_string())
    }
}

pub(crate) type ApiResult<T = Value> = Result<T, ApiError>;

impl Hangar {
    /// Opens the state database, scans every transcript and seeds the first run.
    pub fn open(cfg: Config) -> Result<Arc<Self>, String> {
        let backup_dir = cfg.data_dir.join("transcripts");
        std::fs::create_dir_all(&backup_dir).map_err(|e| format!("{}: {e}", backup_dir.display()))?;
        let db = db::open(&cfg.data_dir.join("state.db")).map_err(|e| e.to_string())?;
        let h = Arc::new(Hangar { claude_dirs: cfg.claude_dirs, discover: cfg.discover, backup_dir, timing: (cfg.classify_start, cfg.classify_every), db: Mutex::new(db), classifying: AtomicBool::new(false),
            runs: Mutex::default(), wake: (Mutex::new(false), Condvar::new()), platform: platform::current() });
        {
            let db = h.db();
            h.scan_all(&db).and_then(|_| h.seed_done(&db)).and_then(|_| h.scan_all(&db)).map_err(|e| e.to_string())?;
        }
        Ok(h)
    }

    fn db(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Rescans and runs done detection on a thread of its own, paced by Config::classify_start/classify_every.
    /// `run_now` starts the next run early; the schedule then counts from that run.
    pub fn spawn_background(self: &Arc<Self>) {
        let h = Arc::clone(self);
        let (start, every) = h.timing;
        std::thread::spawn(move || {
            let mut wait = start;
            loop {
                h.runs.lock().unwrap_or_else(|e| e.into_inner()).next = Some(now_ms() + wait.as_millis() as f64);
                let woken = h.wake.0.lock().unwrap_or_else(|e| e.into_inner());
                let (mut woken, _) = h.wake.1.wait_timeout_while(woken, wait, |w| !*w).unwrap_or_else(|e| e.into_inner());
                *woken = false;
                drop(woken);
                if let Err(e) = h.scan_all(&h.db()) {
                    eprintln!("scan: {e}");
                }
                h.classify_pending();
                wait = every;
            }
        });
    }

    fn run_now(&self) -> Value {
        if self.classifying.load(Ordering::SeqCst) {
            return json!({ "running": true });
        }
        *self.wake.0.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.wake.1.notify_all();
        json!({ "started": true })
    }

    /// When done detection last ran and runs next, for Insights. Timestamps are ISO strings, null before the first run.
    pub(crate) fn classifier_schedule(&self) -> Value {
        let r = self.runs.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let at = |ms: Option<f64>| ms.map(iso);
        json!({ "lastStart": at(r.last_start), "lastEnd": at(r.last_end), "next": at(r.next), "error": r.error,
            "everyMs": self.timing.1.as_millis() as u64, "running": self.classifying.load(Ordering::SeqCst), "account": self.classify_account() })
    }

    /// Whose Claude login done detection uses: "own" (each session's own account, the default) or one account's dir.
    /// Chosen in Settings and shown in Insights; never whatever account Hangar happens to run under.
    fn classify_account(&self) -> String {
        db::get_meta(&self.db(), "classify_account").ok().flatten().unwrap_or_else(|| "own".into())
    }

    fn set_classify_account(&self, body: &Value) -> ApiResult {
        let account = body["account"].as_str().ok_or_else(|| ApiError(400, "account".into()))?;
        let db = self.db();
        let account = if account == "own" { account.to_string() } else {
            let k = accounts::key(std::path::Path::new(account));
            self.dirs_in(&db).iter().any(|d| accounts::key(d) == k).then_some(k).ok_or_else(|| ApiError(400, "unknown_account".into()))?
        };
        db::set_meta(&db, "classify_account", &account)?;
        Ok(json!({ "ok": true }))
    }

    // --- done suggestions: closed, pending sessions idle for 1h+ are classified once per transcript state.
    fn classify_pending(&self) {
        if self.classifying.swap(true, Ordering::SeqCst) {
            return;
        }
        let started = now_ms();
        let finish = |error: Option<String>| {
            let mut r = self.runs.lock().unwrap_or_else(|e| e.into_inner());
            (r.last_start, r.last_end, r.error) = (Some(started), Some(now_ms()), error);
            drop(r);
            self.classifying.store(false, Ordering::SeqCst);
        };
        let visible = self.dirs();
        // A chosen account that is gone or hidden stops the run, visibly, instead of falling back to another login.
        let mode = self.classify_account();
        let fixed = if mode == "own" { None } else {
            match visible.iter().find(|d| accounts::key(d) == mode) {
                Some(d) => Some(d.clone()),
                None => return finish(Some("classifier_account_missing".into())),
            }
        };
        let live = self.live_sessions();
        let cutoff = iso(now_ms() - HOUR);
        let transcripts = db::all_t(&self.db()).unwrap_or_default();
        for t in transcripts {
            let eligible = || -> rusqlite::Result<bool> {
                let db = self.db();
                if live.contains_key(&t.id) || !db::pending(&db, &t.id)? || t.last_at.as_deref().map_or(true, |a| a > cutoff.as_str()) || !std::path::Path::new(&t.file).exists() {
                    return Ok(false);
                }
                Ok(!db::get_v(&db, &t.id)?.is_some_and(|v| v.offset == t.offset && v.error.is_none()))
            };
            if !eligible().unwrap_or(false) {
                continue;
            }
            // A hidden account's sessions aren't classified under their own (hidden) login.
            let file = PathBuf::from(&t.file);
            let Some(account) = fixed.clone().or_else(|| sessions::config_dir(&file).filter(|d| visible.iter().any(|v| accounts::key(v) == accounts::key(d))).map(PathBuf::from)) else { continue };
            let at = iso(now_ms());
            // The lock is not held while Haiku thinks: the UI stays responsive.
            let result = classify::classify(&file, &account);
            let db = self.db();
            let v = match &result {
                Ok(v) => db::Verdict { id: t.id.clone(), offset: t.offset, done: v.done, confidence: v.confidence, evidence: v.evidence.clone(), reason: v.reason.clone(),
                    quoted: v.quoted, dismissed: false, cost_usd: v.cost_usd, at: at.clone(), error: None },
                Err(e) => db::Verdict { id: t.id.clone(), offset: t.offset, done: false, confidence: 0.0, evidence: String::new(), reason: String::new(),
                    quoted: false, dismissed: false, cost_usd: None, at: at.clone(), error: Some(e.clone()) },
            };
            let _ = db::put_v(&db, &v);
            // Re-check pending: the user may have acted on this session while Haiku was thinking.
            if matches!(&result, Ok(o) if o.auto_done) && db::pending(&db, &t.id).unwrap_or(false) {
                if let Ok(mut s) = db::state_of(&db, &t.id) {
                    (s.status, s.done_at, s.done_by) = ("done".into(), Some(at), Some("auto".into()));
                    let _ = db::put_s(&db, &s);
                }
            }
        }
        finish(None);
    }

    /// The whole API. `path` has no query string; `body` is the raw request body ("" for none).
    pub fn handle(&self, method: &str, path: &str, body: &str) -> Reply {
        match self.route(method, path, body) {
            Ok(body) => Reply { status: 200, body },
            Err(ApiError(status, error)) => Reply { status, body: json!({ "error": error }) },
        }
    }

    fn route(&self, method: &str, path: &str, body: &str) -> ApiResult {
        let parse = || -> ApiResult {
            if body.trim().is_empty() {
                return Ok(json!({}));
            }
            serde_json::from_str(body).map_err(|_| ApiError(400, "invalid_json".into()))
        };
        let not_found = || ApiError(404, "not found".into());
        let mut parts = path.split('/').skip(1);
        let (api, action, id) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        if api != "api" {
            return Err(not_found());
        }
        match (method, action) {
            ("GET", "sessions") => return self.list_sessions().map(Value::from),
            ("GET", "insights") => return self.insights(),
            ("POST", "close-idle-tabs") => return Ok(self.close_idle_tabs()),
            ("POST", "classify") => return Ok(self.run_now()),
            ("GET", "classifier") => return Ok(self.classifier_schedule()),
            ("PATCH", "classifier") => return self.set_classify_account(&parse()?),
            ("GET", "accounts") => return self.list_accounts().map(Value::from),
            ("POST", "accounts") => return self.add_account(&parse()?),
            ("PATCH", "account") => return self.update_account(&parse()?),
            ("DELETE", "account") => return self.remove_account(&parse()?),
            ("POST", "order") => {
                self.set_order(&parse()?["ids"])?;
                return Ok(json!({ "ok": true }));
            }
            _ => {}
        }
        if !["session", "dismiss-suggestion", "resume", "close", "transfer"].contains(&action) {
            return Err(not_found());
        }
        if !UUID.is_match(id) {
            return Err(ApiError(400, "id".into()));
        }
        match (method, action) {
            ("PATCH", "session") => {
                self.update_state(id, &parse()?)?;
                Ok(json!({ "ok": true }))
            }
            ("POST", "dismiss-suggestion") => {
                db::dismiss_v(&self.db(), id)?;
                Ok(json!({ "ok": true }))
            }
            ("POST", "resume") => self.resume(id),
            ("POST", "close") => self.close(id),
            ("POST", "transfer") => self.transfer(id, &parse()?),
            _ => Err(not_found()),
        }
    }
}
