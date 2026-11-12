// What another of the account's machines may ask of this one. Remote control is a per-machine switch, off until the
// person turns it on here, and even then a paired device reaches only the session list and what acts on a session:
// adding or editing accounts, moving sessions between them and spending the classifier stay local. Every remote
// request is logged with the device that made it, and the log shows on this machine.
use crate::db;
use crate::{iso, now_ms, ApiError, ApiResult, Hangar, Reply};
use serde_json::{json, Value};

const SWITCH: &str = "remote_control";
/// Changes and refusals kept in the log. Reads don't go in it (the remote UI lists sessions all the time and would
/// push out a resume within minutes); they are counted per device instead.
const LOG_KEEP: i64 = 500;
const PATH_MAX: usize = 120;

/// (method, action) a paired device may call; actions with an id take a session id, checked by the router.
const ALLOWED: &[(&str, &str)] = &[
    ("GET", "sessions"),
    ("GET", "accounts"),
    ("PATCH", "session"),
    ("POST", "order"),
    ("POST", "resume"),
    ("POST", "close"),
    ("POST", "dismiss-suggestion"),
];

impl Hangar {
    /// The API as a paired device sees it. `device` is the caller's device key, already authenticated by the
    /// device chain and the Noise session it came through.
    pub fn handle_remote(&self, device: &str, method: &str, path: &str, body: &str) -> Reply {
        let reply = match self.remote_allowed(method, path) {
            Ok(()) => self.handle(method, path, body),
            Err(ApiError(status, error)) => Reply { status, body: json!({ "error": error }) },
        };
        if let Err(e) = self.log_remote(device, method, path, reply.status) {
            eprintln!("remote log: {e}");
        }
        reply
    }

    fn remote_allowed(&self, method: &str, path: &str) -> ApiResult<()> {
        if !self.remote_enabled() {
            return Err(ApiError(403, "remote_off".into()));
        }
        let action = path.strip_prefix("/api/").map(|p| p.split('/').next().unwrap_or(""));
        match action {
            Some(a) if ALLOWED.contains(&(method, a)) => Ok(()),
            _ => Err(ApiError(403, "remote_forbidden".into())),
        }
    }

    pub(crate) fn remote_enabled(&self) -> bool {
        db::get_meta(&self.db(), SWITCH).ok().flatten().as_deref() == Some("on")
    }

    fn log_remote(&self, device: &str, method: &str, path: &str, status: u16) -> rusqlite::Result<()> {
        let db = self.db();
        let at = iso(now_ms());
        if method == "GET" && status < 400 {
            db.execute(
                "insert into remote_reads (device, last_at, n) values (?, ?, 1) on conflict (device) do update set last_at = excluded.last_at, n = n + 1",
                rusqlite::params![device, at],
            )?;
            return Ok(());
        }
        let path: String = path.chars().take(PATH_MAX).collect();
        db.execute("insert into remote_log (at, device, method, path, status) values (?, ?, ?, ?, ?)", rusqlite::params![at, device, method, path, status])?;
        db.execute("delete from remote_log where rowid <= (select max(rowid) from remote_log) - ?", [LOG_KEEP])?;
        Ok(())
    }

    /// GET /api/remote: the switch, the latest remote changes and refusals, and each device's reads, for this
    /// machine's own UI.
    pub(crate) fn remote_status(&self) -> ApiResult {
        let db = self.db();
        let mut q = db.prepare("select at, device, method, path, status from remote_log order by rowid desc limit 50")?;
        let log: Vec<Value> = q
            .query_map([], |r| Ok(json!({ "at": r.get::<_, String>(0)?, "device": r.get::<_, String>(1)?, "method": r.get::<_, String>(2)?, "path": r.get::<_, String>(3)?, "status": r.get::<_, u16>(4)? })))?
            .collect::<Result<_, _>>()?;
        let mut q = db.prepare("select device, last_at, n from remote_reads order by last_at desc")?;
        let reads: Vec<Value> = q.query_map([], |r| Ok(json!({ "device": r.get::<_, String>(0)?, "at": r.get::<_, String>(1)?, "count": r.get::<_, i64>(2)? })))?.collect::<Result<_, _>>()?;
        Ok(json!({ "enabled": db::get_meta(&db, SWITCH)?.as_deref() == Some("on"), "log": log, "reads": reads }))
    }

    /// PATCH /api/remote {enabled}: local only, never reachable through handle_remote.
    pub(crate) fn set_remote(&self, body: &Value) -> ApiResult {
        let on = body["enabled"].as_bool().ok_or_else(|| ApiError(400, "enabled".into()))?;
        db::set_meta(&self.db(), SWITCH, if on { "on" } else { "off" })?;
        Ok(json!({ "ok": true }))
    }
}
