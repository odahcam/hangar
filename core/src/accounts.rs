// Accounts: one per Claude Code config directory. ~/.claude is the default account (Claude Code keeps its .claude.json
// in the home folder for it); any other directory is used through CLAUDE_CONFIG_DIR, which moves .claude.json inside it.
// They are found as ~/.claude and ~/.claude-* folders that have a projects folder, plus folders added by hand; the
// name, color and whether it is hidden are the user's (db::Account).
use crate::db::{self, Account};
use crate::{home, ApiError, ApiResult, Hangar};
use regex::Regex;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

// Distinct in light and dark; assigned in listing order until the user picks a color.
const PALETTE: [&str; 6] = ["#2b7bd6", "#b7791f", "#8a4fbf", "#14866a", "#c2410c", "#5b6b7a"];
static COLOR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#[0-9a-fA-F]{6}$").unwrap());

pub(crate) struct Acct {
    pub dir: PathBuf,
    /// The directory as stored and sent to the UI: no trailing separator.
    pub key: String,
    pub name: String,
    pub color: String,
    pub added: bool,
    pub hidden: bool,
}

pub(crate) fn key(dir: &Path) -> String {
    dir.to_string_lossy().trim_end_matches(['/', '\\']).to_string()
}

pub(crate) fn is_default(dir: &Path) -> bool {
    key(dir) == key(&home().join(".claude"))
}

// ~/.claude → "claude", ~/.claude-work → "work", anything else → its folder name.
fn default_name(dir: &Path) -> String {
    let base = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| key(dir));
    let base = base.trim_start_matches('.');
    base.strip_prefix("claude-").filter(|s| !s.is_empty()).unwrap_or(base).to_string()
}

impl Hangar {
    fn found_dirs(&self) -> Vec<PathBuf> {
        let mut dirs = self.claude_dirs.clone();
        if self.discover {
            let mut found: Vec<PathBuf> = fs::read_dir(home())
                .map(|d| {
                    d.flatten()
                        .filter(|e| e.file_name().to_str().is_some_and(|n| n == ".claude" || n.starts_with(".claude-")))
                        .map(|e| e.path())
                        .filter(|p| p.join("projects").is_dir())
                        .collect()
                })
                .unwrap_or_default();
            // ".claude" sorts before ".claude-*": the default account comes first.
            found.sort();
            dirs.extend(found);
        }
        let mut seen = std::collections::HashSet::new();
        dirs.retain(|d| seen.insert(key(d)));
        dirs
    }

    pub(crate) fn accounts_in(&self, db: &Connection) -> rusqlite::Result<Vec<Acct>> {
        let rows = db::all_accounts(db)?;
        let mut dirs = self.found_dirs();
        for r in rows.iter().filter(|r| r.added) {
            if !dirs.iter().any(|d| key(d) == r.dir) {
                dirs.push(PathBuf::from(&r.dir));
            }
        }
        Ok(dirs
            .into_iter()
            .enumerate()
            .map(|(i, dir)| {
                let k = key(&dir);
                let r = rows.iter().find(|r| r.dir == k);
                Acct {
                    name: r.and_then(|r| r.name.clone()).unwrap_or_else(|| default_name(&dir)),
                    color: r.and_then(|r| r.color.clone()).unwrap_or_else(|| PALETTE[i % PALETTE.len()].into()),
                    added: r.is_some_and(|r| r.added),
                    hidden: r.is_some_and(|r| r.hidden),
                    key: k,
                    dir,
                }
            })
            .collect())
    }

    /// The config directories Hangar reads: every account that isn't hidden.
    pub(crate) fn dirs_in(&self, db: &Connection) -> Vec<PathBuf> {
        self.accounts_in(db).unwrap_or_default().into_iter().filter(|a| !a.hidden).map(|a| a.dir).collect()
    }

    pub(crate) fn dirs(&self) -> Vec<PathBuf> {
        self.dirs_in(&self.db())
    }

    pub(crate) fn list_accounts(&self) -> ApiResult<Vec<Value>> {
        Ok(self
            .accounts_in(&self.db())?
            .into_iter()
            .map(|a| json!({ "dir": a.key, "name": a.name, "color": a.color, "default": is_default(&a.dir), "added": a.added, "hidden": a.hidden }))
            .collect())
    }

    fn account_row(&self, db: &Connection, body: &Value) -> ApiResult<Account> {
        let dir = body["dir"].as_str().map(|d| key(Path::new(d))).ok_or_else(|| ApiError(400, "dir".into()))?;
        if !self.accounts_in(db)?.iter().any(|a| a.key == dir) {
            return Err(ApiError(404, "unknown_account".into()));
        }
        Ok(db::all_accounts(db)?.into_iter().find(|r| r.dir == dir).unwrap_or(Account { dir, ..Default::default() }))
    }

    /// A folder added by hand: any Claude Code config directory, wherever it lives. Adding a hidden one shows it again.
    pub(crate) fn add_account(&self, body: &Value) -> ApiResult {
        let dir = body["dir"].as_str().map(str::trim).filter(|d| !d.is_empty()).ok_or_else(|| ApiError(400, "dir".into()))?;
        let dir = match dir.strip_prefix("~") {
            Some(rest) => home().join(rest.trim_start_matches(['/', '\\'])),
            None => PathBuf::from(dir),
        };
        if !dir.is_absolute() || !dir.is_dir() {
            return Err(ApiError(400, "not_a_folder".into()));
        }
        let db = self.db();
        let k = key(&dir);
        let mut row = db::all_accounts(&db)?.into_iter().find(|r| r.dir == k).unwrap_or(Account { dir: k.clone(), ..Default::default() });
        if !self.found_dirs().iter().any(|d| key(d) == k) {
            row.added = true;
        }
        row.hidden = false;
        db::put_account(&db, &row)?;
        Ok(json!({ "dir": k }))
    }

    pub(crate) fn update_account(&self, body: &Value) -> ApiResult {
        let db = self.db();
        let mut row = self.account_row(&db, body)?;
        if let Some(name) = body["name"].as_str() {
            row.name = Some(name.trim().to_string()).filter(|n| !n.is_empty());
        }
        if let Some(color) = body["color"].as_str() {
            if !COLOR.is_match(color) {
                return Err(ApiError(400, "color".into()));
            }
            row.color = Some(color.to_lowercase());
        }
        if let Some(hidden) = body["hidden"].as_bool() {
            row.hidden = hidden;
        }
        db::put_account(&db, &row)?;
        Ok(json!({ "ok": true }))
    }

    /// A folder added by hand is forgotten; one Hangar found on its own can't be, so it is hidden instead.
    pub(crate) fn remove_account(&self, body: &Value) -> ApiResult {
        let db = self.db();
        let mut row = self.account_row(&db, body)?;
        if row.added {
            db::delete_account(&db, &row.dir)?;
            return Ok(json!({ "removed": true }));
        }
        row.hidden = true;
        db::put_account(&db, &row)?;
        Ok(json!({ "hidden": true }))
    }
}
