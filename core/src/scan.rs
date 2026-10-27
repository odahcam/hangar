// Transcripts: append-only jsonl, parsed incrementally from the last byte offset seen.
use crate::db::{self, Transcript};
use crate::{local_day, Hangar, UUID};
use regex::Regex;
use rusqlite::Connection;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::LazyLock;

static NOT_HUMAN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(<|\[|Base directory|Another Claude)").unwrap());
static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static TIMESTAMP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""timestamp":"([^"]+)""#).unwrap());
static MSG_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""id":"(msg_[A-Za-z0-9]+)""#).unwrap());
static USAGE: LazyLock<[(&str, Regex); 4]> = LazyLock::new(|| {
    ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"].map(|k| (k, Regex::new(&format!(r#""{k}":(\d+)"#)).unwrap()))
});

fn usage(line: &str, key: &str) -> i64 {
    let re = &USAGE.iter().find(|(k, _)| *k == key).unwrap().1;
    re.captures(line).and_then(|m| m[1].parse().ok()).unwrap_or(0)
}

pub fn collapse(s: &str) -> String {
    SPACE.replace_all(s, " ").trim().to_string()
}

/// The text of a prompt the human typed, or "" for meta, sidechain, tool results and harness-injected turns.
pub fn human_prompt(rec: &Value) -> String {
    if rec["type"] != "user" || rec["isMeta"].as_bool() == Some(true) || rec["isSidechain"].as_bool() == Some(true) {
        return String::new();
    }
    if let Some(o) = rec["turnOrigin"].as_str() {
        if o != "human" {
            return String::new();
        }
    }
    let c = &rec["message"]["content"];
    let text = match c {
        Value::Array(parts) => {
            if parts.iter().any(|x| x["type"] == "tool_result") {
                return String::new();
            }
            parts.iter().filter(|x| x["type"] == "text").filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join(" ")
        }
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    let text = collapse(&text);
    if NOT_HUMAN.is_match(&text) {
        String::new()
    } else {
        text.chars().take(400).collect()
    }
}

fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

fn set_str(slot: &mut Option<String>, v: &Value) {
    if let Some(s) = v.as_str() {
        *slot = Some(s.to_string());
    }
}

/// Reads what was appended since the last scan; false if the file is unchanged.
pub fn scan_file(db: &Connection, file: &Path) -> rusqlite::Result<bool> {
    let id = file.file_stem().unwrap().to_string_lossy().to_string();
    let file_s = file.to_string_lossy().to_string();
    let Ok(meta) = fs::metadata(file) else { return Ok(false) };
    let (size, mtime) = (meta.len() as i64, mtime_ms(&meta));
    let prev = db::get_t(db, &id)?;
    if let Some(p) = &prev {
        if p.file == file_s && p.offset == size && p.mtime == mtime {
            return Ok(false);
        }
    }
    let fresh = prev.as_ref().map_or(true, |p| p.file != file_s || size < p.offset);
    let mut row = match prev {
        Some(p) if !fresh => p,
        _ => Transcript { id: id.clone(), file: file_s, ..Default::default() },
    };
    if fresh {
        db::clear_activity(db, &id)?;
    }
    let mut days: BTreeMap<String, i64> = BTreeMap::new();
    let mut f = match fs::File::open(file) {
        Ok(f) => f,
        Err(_) => return Ok(false),
    };
    if f.seek(SeekFrom::Start(row.offset as u64)).is_err() {
        return Ok(false);
    }
    let mut reader = BufReader::with_capacity(1 << 20, f.take((size - row.offset).max(0) as u64));
    let mut raw = Vec::new();
    loop {
        raw.clear();
        // Only complete lines are consumed; a partial last line is read again next time.
        if !matches!(reader.read_until(b'\n', &mut raw), Ok(n) if n > 0) || raw.last() != Some(&b'\n') {
            break;
        }
        row.offset += raw.len() as i64;
        let line = String::from_utf8_lossy(&raw[..raw.len() - 1]);
        let rec: Option<Value> =
            if line.contains(r#""type":"ai-title""#) || line.contains(r#""type":"agent-name""#) || line.contains(r#""type":"user""#) {
                match serde_json::from_str(&line) {
                    Ok(v) => Some(v),
                    Err(_) => continue,
                }
            } else {
                None
            };
        let kind = rec.as_ref().and_then(|r| r["type"].as_str()).unwrap_or("");
        if kind == "ai-title" {
            set_str(&mut row.ai_title, &rec.unwrap()["aiTitle"]);
        } else if kind == "agent-name" {
            set_str(&mut row.agent_name, &rec.unwrap()["agentName"]);
        } else if kind == "user" {
            let rec = rec.unwrap();
            set_str(&mut row.cwd, &rec["cwd"]);
            set_str(&mut row.branch, &rec["gitBranch"]);
            set_str(&mut row.last_at, &rec["timestamp"]);
            if row.first_at.is_none() {
                set_str(&mut row.first_at, &rec["timestamp"]);
            }
            let p = human_prompt(&rec);
            if !p.is_empty() {
                row.first_prompt.get_or_insert_with(|| p.clone());
                row.last_prompt = Some(p);
                row.prompts += 1;
                if let Some(day) = rec["timestamp"].as_str().and_then(local_day) {
                    *days.entry(day).or_default() += 1;
                }
            }
        } else {
            if let Some(m) = TIMESTAMP.captures(&line) {
                row.last_at = Some(m[1].to_string());
                row.first_at.get_or_insert_with(|| m[1].to_string());
            }
            // Streaming writes one record per content block, repeating the message's usage: count each message once, latest wins.
            if line.contains(r#""type":"assistant""#) && line.contains(r#""usage""#) {
                let msg = MSG_ID.captures(&line).map(|m| m[1].to_string());
                let (i, c, o) = (
                    usage(&line, "input_tokens") + usage(&line, "cache_creation_input_tokens"),
                    usage(&line, "cache_read_input_tokens"),
                    usage(&line, "output_tokens"),
                );
                if msg.is_some() && msg == row.last_msg {
                    row.tokens_in -= row.last_in;
                    row.tokens_cache -= row.last_cache;
                    row.tokens_out -= row.last_out;
                }
                row.tokens_in += i;
                row.tokens_cache += c;
                row.tokens_out += o;
                (row.last_msg, row.last_in, row.last_cache, row.last_out) = (msg, i, c, o);
            }
        }
    }
    row.mtime = mtime;
    row.size = size;
    db::put_t(db, &row)?;
    for (day, n) in days {
        db::add_activity(db, &id, &day, n)?;
    }
    Ok(true)
}

impl Hangar {
    pub(crate) fn scan_all(&self, db: &Connection) -> rusqlite::Result<()> {
        let Ok(dirs) = fs::read_dir(self.claude.join("projects")) else { return Ok(()) };
        for dir in dirs.flatten() {
            let Ok(names) = fs::read_dir(dir.path()) else { continue };
            for entry in names.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let Some(id) = name.strip_suffix(".jsonl") else { continue };
                if !UUID.is_match(id) || !entry.path().is_file() {
                    continue;
                }
                let changed = scan_file(db, &entry.path())?;
                if db::pending(db, id)? && (changed || !self.backup_dir.join(&name).exists()) {
                    self.backup(db, id)?;
                }
            }
        }
        Ok(())
    }

    // Pending transcripts are copied out of ~/.claude so cleanupPeriodDays can never take them.
    pub(crate) fn backup(&self, db: &Connection, id: &str) -> rusqlite::Result<()> {
        if let Some(t) = db::get_t(db, id)? {
            if Path::new(&t.file).exists() {
                let _ = fs::copy(&t.file, self.backup_dir.join(format!("{id}.jsonl")));
            }
        }
        Ok(())
    }

    // First run only: sessions idle for 14+ days were already dealt with; start them as done.
    pub(crate) fn seed_done(&self, db: &Connection) -> rusqlite::Result<()> {
        if db::get_meta(db, "seed_done")?.is_some() {
            return Ok(());
        }
        let cutoff = crate::iso(crate::now_ms() - 14.0 * crate::DAY);
        let now = crate::iso(crate::now_ms());
        for t in db::all_t(db)? {
            if db::get_s(db, &t.id)?.is_none() && t.last_at.as_deref().unwrap_or("") < cutoff.as_str() {
                db::put_s(db, &db::State { id: t.id, status: "done".into(), priority: None, note: String::new(), done_at: Some(now.clone()), done_by: Some("seed".into()) })?;
            }
        }
        db::set_meta(db, "seed_done", &now)
    }
}
