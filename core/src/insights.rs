// Insights: totals, pending by project and age, memory of open sessions, activity, weekly counts, top lists, storage.
use crate::db;
use crate::proc;
use crate::{iso, local_day, now_ms, parse_ms, ApiResult, Hangar, DAY};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

impl Hangar {
    // Each session counts its MCP children too.
    fn session_memory(&self, pids: &[u32]) -> HashMap<u32, i64> {
        if pids.is_empty() {
            return HashMap::new();
        }
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for (pid, ppid) in proc::parents() {
            children.entry(ppid).or_default().push(pid);
        }
        let tree: HashMap<u32, Vec<u32>> = pids
            .iter()
            .map(|&root| {
                let mut all = vec![root];
                let mut i = 0;
                while i < all.len() {
                    all.extend(children.get(&all[i]).cloned().unwrap_or_default());
                    i += 1;
                }
                (root, all)
            })
            .collect();
        let mb = self.platform.memory_mb(&tree.values().flatten().copied().collect::<Vec<_>>());
        tree.into_iter().map(|(root, all)| (root, all.iter().map(|p| mb.get(p).copied().unwrap_or(0.0)).sum::<f64>().round() as i64)).collect()
    }

    pub(crate) fn insights(&self) -> ApiResult {
        let sessions = self.list_sessions()?;
        let now = now_ms();
        let age_days = |v: &Value| v.as_str().and_then(parse_ms).map_or(f64::INFINITY, |t| (now - t) / DAY);
        let s_str = |s: &Value, k: &str| s[k].as_str().unwrap_or("").to_string();
        let done = |s: &Value| s["status"] == "done";
        let pend: Vec<&Value> = sessions.iter().filter(|s| !done(s)).collect();

        let mut by_project: Vec<Value> = Vec::new();
        for s in &pend {
            let name = Some(s_str(s, "project")).filter(|p| !p.is_empty()).unwrap_or_else(|| "?".into());
            let i = match by_project.iter().position(|p| p["project"] == name.as_str()) {
                Some(i) => i,
                None => {
                    by_project.push(json!({ "project": name, "d1": 0, "d7": 0, "d14": 0, "older": 0, "total": 0 }));
                    by_project.len() - 1
                }
            };
            let a = age_days(&s["lastAt"]);
            let bucket = if a < 1.0 { "d1" } else if a < 7.0 { "d7" } else if a < 14.0 { "d14" } else { "older" };
            let p = &mut by_project[i];
            p[bucket] = json!(p[bucket].as_i64().unwrap() + 1);
            p["total"] = json!(p["total"].as_i64().unwrap() + 1);
        }
        by_project.sort_by(|a, b| b["total"].as_i64().cmp(&a["total"].as_i64()));
        let live: Vec<&Value> = sessions.iter().filter(|s| !s["live"].is_null()).collect();
        let pids: Vec<u32> = live.iter().filter_map(|s| s["live"]["pid"].as_u64()).map(|p| p as u32).collect();
        let (mem, tabs) = std::thread::scope(|sc| {
            let tabs = sc.spawn(|| self.platform.tabs());
            (self.session_memory(&pids), tabs.join().unwrap_or_default())
        });
        let (ram_total, swap_used) = (proc::memory_totals().0, self.platform.swap_used_mb());

        let weeks: Vec<Value> = (0..=7)
            .rev()
            .map(|w| {
                let (start, end) = (now - (w as f64 + 1.0) * 7.0 * DAY, now - w as f64 * 7.0 * DAY);
                let in_week = |v: &Value| v.as_str().and_then(parse_ms).is_some_and(|t| t >= start && t < end);
                json!({
                    "start": &iso(start)[..10],
                    "created": sessions.iter().filter(|s| in_week(&s["firstAt"])).count(),
                    "done": sessions.iter().filter(|s| s["doneBy"] != "seed" && done(s) && in_week(&s["doneAt"])).count(),
                })
            })
            .collect();

        // Each account's own cleanupPeriodDays decides when Claude Code deletes its transcripts.
        let accounts = self.list_accounts()?;
        let retention = |s: &Value| -> f64 {
            let days = accounts.iter().find(|a| a["dir"] == s["account"]).and_then(|a| a["cleanupDays"].as_u64()).unwrap_or(crate::accounts::DEFAULT_CLEANUP_DAYS);
            days as f64 * DAY
        };
        let top = |key: &str| -> Vec<Value> {
            let mut v: Vec<&Value> = sessions.iter().collect();
            v.sort_by(|a, b| num(&b[key]).total_cmp(&num(&a[key])));
            v.into_iter()
                .take(10)
                .map(|s| json!({ "id": s["id"], "account": s["account"], "title": s["title"], "project": s["project"], "prompts": s["prompts"],
                    "tokensIn": s["tokensIn"], "tokensCache": s["tokensCache"], "tokensOut": s["tokensOut"], "status": s["status"] }))
                .collect()
        };
        let backup_bytes: u64 = fs::read_dir(&self.backup_dir).map_or(0, |d| d.flatten().filter_map(|f| f.metadata().ok()).map(|m| m.len()).sum());
        let since = local_day(&iso(now - 29.0 * DAY)).unwrap_or_default();
        let (verdicts, activity) = {
            let db = self.db();
            (db::all_v(&db)?, db::activity_since(&db, &since)?)
        };
        let brief = |s: &Value| json!({ "id": s["id"], "account": s["account"], "title": s["title"] });
        let mut live_rows: Vec<Value> = live
            .iter()
            .map(|s| {
                let pid = s["live"]["pid"].as_u64().unwrap_or(0) as u32;
                let idle = s["lastAt"].as_str().and_then(parse_ms).map(|t| ((now - t) / 36e5).round());
                json!({ "id": s["id"], "account": s["account"], "title": s["title"], "tty": s["live"]["tty"], "mb": mem.get(&pid).copied().unwrap_or(0),
                    "idleHours": idle, "status": s["status"] })
            })
            .collect();
        live_rows.sort_by(|a, b| b["mb"].as_i64().cmp(&a["mb"].as_i64()));
        let caps = self.platform.caps();

        Ok(json!({
            "totals": {
                "pending": pend.len(),
                "untriaged": pend.iter().filter(|s| s["priority"].is_null()).count(),
                "live": live.len(),
                "done": sessions.len() - pend.len(),
                "sessions": sessions.len(),
                "tokensOut": sessions.iter().map(|s| num(&s["tokensOut"])).sum::<f64>(),
                "suggestions": pend.iter().filter(|s| !s["suggestion"].is_null()).count(),
                "autoDone": sessions.iter().filter(|s| s["doneBy"] == "auto").count(),
                "classified": verdicts.len(),
                "classifyCostUsd": verdicts.iter().map(|v| v.cost_usd.unwrap_or(0.0)).sum::<f64>(),
            },
            "byProject": by_project,
            "memory": {
                "swapUsedMb": swap_used.round(),
                "ramTotalMb": ram_total.round(),
                "liveTotalMb": mem.values().sum::<i64>(),
                "sessions": live_rows,
            },
            // null when the platform's terminal can't list tabs, so the UI drops the panel instead of showing "none".
            "idleTabs": if caps.tabs { json!(tabs.iter().filter(|(_, t)| !t.busy).map(|(tty, _)| tty).collect::<Vec<_>>()) } else { Value::Null },
            "weeks": weeks,
            "activity": activity.into_iter().map(|(day, n)| json!({ "day": day, "n": n })).collect::<Vec<_>>(),
            "topPrompts": top("prompts"),
            "topTokens": top("tokensOut"),
            "storage": {
                "transcriptsMb": (sessions.iter().map(|s| num(&s["size"])).sum::<f64>() / 1048576.0).round(),
                // Per account that isn't hidden, in listing order.
                "accounts": accounts.iter().filter(|a| a["hidden"] != true).map(|a| json!({
                    "dir": a["dir"],
                    "transcriptsMb": (sessions.iter().filter(|s| s["account"] == a["dir"] && s["transcript"] == true).map(|s| num(&s["size"])).sum::<f64>() / 1048576.0).round(),
                    "cleanupDays": a["cleanupDays"],
                })).collect::<Vec<_>>(),
                "backupMb": (backup_bytes as f64 / 1048576.0).round(),
                "pendingWithoutBackup": pend.iter().filter(|s| s["backedUp"] != true).map(|s| brief(s)).collect::<Vec<_>>(),
                // A week ahead: with Claude Code's 30-day default a 30-day window would list nearly everything.
                "expiringSoon": sessions.iter().filter(|s| s["transcript"] == true && num(&s["mtime"]) + retention(s) - now < 7.0 * DAY)
                    .map(|s| json!({ "id": s["id"], "account": s["account"], "title": s["title"], "expiresAt": iso(num(&s["mtime"]) + retention(s)), "backedUp": s["backedUp"] }))
                    .collect::<Vec<_>>(),
            },
            "classifier": self.classifier_schedule(),
        }))
    }
}
