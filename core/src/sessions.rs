// The session list and what the user does to sessions: status, notes, order, resume and close.
use crate::db;
use crate::proc;
use crate::{iso, now_ms, ApiError, ApiResult, Hangar, UUID};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::Duration;

pub(crate) struct Live {
    pub pid: u32,
    pub cwd: Option<String>,
    pub tty: Option<String>,
}

fn nonempty(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.is_empty())
}

/// Project label = cwd minus the directory every session shares (e.g. ~/Projects), keeping at least the last segment.
/// Returns the shared prefix's length in bytes; Windows paths split on either slash.
fn project_root(cwds: &[&str]) -> usize {
    let parts: Vec<Vec<&str>> = cwds.iter().map(|c| c.split(['/', '\\']).collect()).collect();
    let Some(first) = parts.first() else { return 0 };
    let max = parts.iter().map(Vec::len).min().unwrap_or(0).saturating_sub(1);
    let mut n = 0;
    while n < max && parts.iter().all(|p| p[n] == first[n]) {
        n += 1;
    }
    if n == 0 { 0 } else { first[..n].iter().map(|s| s.len()).sum::<usize>() + n - 1 }
}

impl Hangar {
    /// Sessions Claude Code registered in <claude>/sessions whose process is still running.
    pub(crate) fn live_sessions(&self) -> HashMap<String, Live> {
        let mut live = HashMap::new();
        let Ok(dir) = fs::read_dir(self.claude.join("sessions")) else { return live };
        for f in dir.flatten() {
            if !f.file_name().to_string_lossy().ends_with(".json") {
                continue;
            }
            let Ok(s) = fs::read_to_string(f.path()).map_err(drop).and_then(|t| serde_json::from_str::<Value>(&t).map_err(drop)) else { continue };
            let (Some(pid), Some(id)) = (s["pid"].as_u64(), s["sessionId"].as_str()) else { continue };
            if !proc::alive(pid as u32) {
                continue;
            }
            live.insert(id.to_string(), Live { pid: pid as u32, cwd: s["cwd"].as_str().map(String::from), tty: None });
        }
        if !live.is_empty() {
            let ttys = self.platform.ttys(&live.values().map(|l| l.pid).collect::<Vec<_>>());
            for l in live.values_mut() {
                l.tty = ttys.get(&l.pid).cloned();
            }
        }
        live
    }

    pub(crate) fn list_sessions(&self) -> ApiResult<Vec<Value>> {
        let (states, verdicts, transcripts) = {
            let db = self.db();
            self.scan_all(&db)?;
            (db::all_s(&db)?, db::all_v(&db)?, db::all_t(&db)?)
        };
        let (live, tabs) = std::thread::scope(|s| {
            let tabs = s.spawn(|| self.platform.tabs());
            (self.live_sessions(), tabs.join().unwrap_or_default())
        });
        let states: HashMap<_, _> = states.into_iter().map(|s| (s.id.clone(), s)).collect();
        let verdicts: HashMap<_, _> = verdicts.into_iter().map(|v| (v.id.clone(), v)).collect();
        let cwds: Vec<&str> = transcripts.iter().filter_map(|t| nonempty(&t.cwd)).collect();
        let root = project_root(&cwds);
        let caps = self.platform.caps();
        Ok(transcripts
            .iter()
            .map(|t| {
                let l = live.get(&t.id);
                let c = states.get(&t.id).cloned().unwrap_or_else(|| db::State {
                    id: t.id.clone(), status: "todo".into(), priority: None, note: String::new(), done_at: None, done_by: None,
                });
                let v = verdicts.get(&t.id).filter(|v| v.error.is_none());
                let verdict = v.map(|v| json!({ "confidence": v.confidence, "evidence": v.evidence, "reason": v.reason, "quoted": v.quoted }));
                // A suggestion is stale once the transcript grows past what was classified.
                let suggestion = match v {
                    Some(v) if v.done && !v.dismissed && v.offset == t.offset && c.status != "done" => verdict.clone(),
                    _ => None,
                };
                let tab_title = l.and_then(|l| l.tty.as_ref()).and_then(|tty| tabs.get(tty)).map(|t| t.title.as_str()).filter(|s| !s.is_empty());
                let first: Option<String> = nonempty(&t.first_prompt).map(|p| p.chars().take(80).collect());
                let title = nonempty(&t.agent_name).or(tab_title).or(nonempty(&t.ai_title)).or(first.as_deref()).unwrap_or(&t.id[..8]).to_string();
                let cwd = nonempty(&t.cwd).or(l.and_then(|l| nonempty(&l.cwd))).unwrap_or("");
                let project = if root > 0 { cwd.get(root + 1..).unwrap_or("") } else { cwd };
                // canFocus: Resume can bring this session's own tab forward (otherwise it would open a second copy).
                let live = l.map(|l| {
                    let mut o = json!({ "pid": l.pid, "canFocus": caps.focus && l.tty.is_some() });
                    if let Some(tty) = &l.tty {
                        o["tty"] = json!(tty);
                    }
                    o
                });
                json!({
                    "id": t.id,
                    "title": title,
                    "aiTitle": t.ai_title,
                    "project": project,
                    "cwd": if cwd.is_empty() { Value::Null } else { json!(cwd) },
                    "branch": t.branch,
                    "firstPrompt": t.first_prompt,
                    "lastPrompt": t.last_prompt,
                    "firstAt": t.first_at,
                    "lastAt": t.last_at,
                    "prompts": t.prompts,
                    "tokensIn": t.tokens_in,
                    "tokensCache": t.tokens_cache,
                    "tokensOut": t.tokens_out,
                    "size": t.size,
                    "mtime": t.mtime,
                    "transcript": Path::new(&t.file).exists(),
                    "backedUp": self.backup_dir.join(format!("{}.jsonl", t.id)).exists(),
                    "live": live,
                    "status": c.status,
                    "priority": c.priority,
                    "note": c.note,
                    "doneAt": c.done_at,
                    "doneBy": c.done_by,
                    "suggestion": suggestion,
                    "autoVerdict": if c.done_by.as_deref() == Some("auto") { verdict } else { None },
                })
            })
            .collect())
    }

    // Idle = the terminal reports nothing but the login shell running; exiting the shell lets it close the tab.
    pub(crate) fn close_idle_tabs(&self) -> Value {
        let idle: Vec<String> = self.platform.tabs().into_iter().filter(|(_, t)| !t.busy).map(|(tty, _)| tty).collect();
        for tty in &idle {
            self.platform.exit_tab(tty, true);
        }
        json!({ "closed": idle.len() })
    }

    pub(crate) fn resume(&self, id: &str) -> ApiResult {
        let t = db::get_t(&self.db(), id)?.ok_or_else(|| ApiError(404, "unknown_session".into()))?;
        let live = self.live_sessions().remove(id);
        if let Some(tty) = live.as_ref().and_then(|l| l.tty.as_ref()) {
            if self.platform.focus(tty) {
                return Ok(json!({ "focused": tty }));
            }
        }
        // Resuming a session that is still running elsewhere would fork it; only a tab we can't find any more is reopened.
        if live.is_some() && !self.platform.caps().focus {
            return Err(ApiError(409, "already_open".into()));
        }
        let saved = self.backup_dir.join(format!("{id}.jsonl"));
        let file = Path::new(&t.file);
        if !file.exists() && saved.exists() {
            if let Some(dir) = file.parent() {
                let _ = fs::create_dir_all(dir);
            }
            let _ = fs::copy(&saved, file);
        }
        let home = crate::home();
        let cwd = nonempty(&t.cwd).map(String::from).unwrap_or_else(|| home.to_string_lossy().into());
        self.platform.open(&cwd, id).map_err(|e| ApiError(500, e))?;
        Ok(json!({ "opened": true }))
    }

    pub(crate) fn close(&self, id: &str) -> ApiResult {
        let Some(live) = self.live_sessions().remove(id) else { return Ok(json!({ "closed": false, "reason": "not_running" })) };
        self.backup(&self.db(), id)?;
        proc::terminate(live.pid);
        for _ in 0..50 {
            if !proc::alive(live.pid) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if let Some(tty) = &live.tty {
            self.platform.exit_tab(tty, false);
        }
        Ok(json!({ "closed": true }))
    }

    pub(crate) fn update_state(&self, id: &str, body: &Value) -> ApiResult<()> {
        let db = self.db();
        if db::get_t(&db, id)?.is_none() {
            return Err(ApiError(404, "unknown_session".into()));
        }
        let mut next = db::state_of(&db, id)?;
        if let Some(status) = body["status"].as_str().filter(|s| ["todo", "doing", "done"].contains(s)) {
            let done = status == "done";
            next.status = status.into();
            next.done_at = done.then(|| iso(now_ms()));
            next.done_by = done.then(|| if body["via"] == "suggestion" { "suggestion" } else { "user" }.into());
        }
        if let Some(note) = body["note"].as_str() {
            next.note = note.into();
        }
        db::put_s(&db, &next)?;
        if next.status != "done" {
            self.backup(&db, id)?;
        }
        Ok(())
    }

    // Reordering rewrites the whole pending order at once, so untriaged and triaged rows never interleave ambiguously.
    pub(crate) fn set_order(&self, ids: &Value) -> ApiResult<()> {
        let bad = || ApiError(400, "ids".into());
        let ids: Vec<&str> = ids.as_array().ok_or_else(bad)?.iter().map(|v| v.as_str().filter(|id| UUID.is_match(id)).ok_or_else(bad)).collect::<Result<_, _>>()?;
        let mut db = self.db();
        let tx = db.transaction()?;
        for (i, id) in ids.iter().enumerate() {
            db::set_priority(&tx, id, (i as f64 + 1.0) * 10.0)?;
        }
        tx.commit()?;
        Ok(())
    }
}
