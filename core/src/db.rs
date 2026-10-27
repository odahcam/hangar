// SQLite state. The schema matches the Node server's state.db exactly, so existing installs keep their data.
use rusqlite::{params, Connection, OptionalExtension, Row};

// transcript/activity are derived caches: on a schema bump they are dropped and rebuilt from the jsonl files.
const SCHEMA: &str = "2";

pub fn open(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let db = Connection::open(path)?;
    db.busy_timeout(std::time::Duration::from_secs(5))?;
    // Every session is pending unless a state row says otherwise; priority null = not triaged yet.
    // done_by: 'user' | 'seed' (first-run 14-day cutoff) | 'suggestion' (confirmed by the user) | 'auto' (classifier, >= 0.90).
    db.execute_batch(
        "create table if not exists state (
          id text primary key, status text not null default 'todo', priority real,
          note text not null default '', done_at text, done_by text);
        create table if not exists meta (key text primary key, value text);",
    )?;
    if get_meta(&db, "schema")?.as_deref() != Some(SCHEMA) {
        db.execute_batch("drop table if exists transcript; drop table if exists activity;")?;
        set_meta(&db, "schema", SCHEMA)?;
    }
    db.execute_batch(
        "create table if not exists transcript (
          id text primary key, file text not null, offset integer not null, mtime real not null, size integer not null default 0,
          cwd text, branch text, agent_name text, ai_title text, first_prompt text, last_prompt text,
          first_at text, last_at text, prompts integer not null default 0,
          tokens_in integer not null default 0, tokens_cache integer not null default 0, tokens_out integer not null default 0,
          last_msg text, last_in integer, last_cache integer, last_out integer);
        create table if not exists activity (id text not null, day text not null, n integer not null, primary key (id, day));
        create table if not exists verdict (
          id text primary key, offset integer not null, done integer not null, confidence real not null, evidence text, reason text,
          quoted integer not null, dismissed integer not null default 0, cost_usd real, at text not null, error text);",
    )?;
    Ok(db)
}

#[derive(Clone, Default)]
pub struct Transcript {
    pub id: String,
    pub file: String,
    pub offset: i64,
    pub mtime: f64,
    pub size: i64,
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub agent_name: Option<String>,
    pub ai_title: Option<String>,
    pub first_prompt: Option<String>,
    pub last_prompt: Option<String>,
    pub first_at: Option<String>,
    pub last_at: Option<String>,
    pub prompts: i64,
    pub tokens_in: i64,
    pub tokens_cache: i64,
    pub tokens_out: i64,
    pub last_msg: Option<String>,
    pub last_in: i64,
    pub last_cache: i64,
    pub last_out: i64,
}

fn transcript(r: &Row) -> rusqlite::Result<Transcript> {
    Ok(Transcript {
        id: r.get("id")?,
        file: r.get("file")?,
        offset: r.get("offset")?,
        mtime: r.get("mtime")?,
        size: r.get("size")?,
        cwd: r.get("cwd")?,
        branch: r.get("branch")?,
        agent_name: r.get("agent_name")?,
        ai_title: r.get("ai_title")?,
        first_prompt: r.get("first_prompt")?,
        last_prompt: r.get("last_prompt")?,
        first_at: r.get("first_at")?,
        last_at: r.get("last_at")?,
        prompts: r.get("prompts")?,
        tokens_in: r.get("tokens_in")?,
        tokens_cache: r.get("tokens_cache")?,
        tokens_out: r.get("tokens_out")?,
        last_msg: r.get("last_msg")?,
        last_in: r.get::<_, Option<i64>>("last_in")?.unwrap_or(0),
        last_cache: r.get::<_, Option<i64>>("last_cache")?.unwrap_or(0),
        last_out: r.get::<_, Option<i64>>("last_out")?.unwrap_or(0),
    })
}

pub fn get_t(db: &Connection, id: &str) -> rusqlite::Result<Option<Transcript>> {
    db.query_row("select * from transcript where id = ?", [id], transcript).optional()
}

pub fn all_t(db: &Connection) -> rusqlite::Result<Vec<Transcript>> {
    db.prepare_cached("select * from transcript")?.query_map([], transcript)?.collect()
}

pub fn put_t(db: &Connection, t: &Transcript) -> rusqlite::Result<()> {
    db.prepare_cached(
        "insert or replace into transcript (id, file, offset, mtime, size, cwd, branch, agent_name, ai_title, first_prompt, last_prompt,
          first_at, last_at, prompts, tokens_in, tokens_cache, tokens_out, last_msg, last_in, last_cache, last_out)
        values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
    )?
    .execute(params![
        t.id, t.file, t.offset, t.mtime, t.size, t.cwd, t.branch, t.agent_name, t.ai_title, t.first_prompt, t.last_prompt,
        t.first_at, t.last_at, t.prompts, t.tokens_in, t.tokens_cache, t.tokens_out, t.last_msg, t.last_in, t.last_cache, t.last_out
    ])?;
    Ok(())
}

pub fn clear_activity(db: &Connection, id: &str) -> rusqlite::Result<()> {
    db.execute("delete from activity where id = ?", [id]).map(drop)
}

pub fn add_activity(db: &Connection, id: &str, day: &str, n: i64) -> rusqlite::Result<()> {
    db.prepare_cached("insert into activity values (?, ?, ?) on conflict (id, day) do update set n = n + excluded.n")?
        .execute(params![id, day, n])
        .map(drop)
}

pub fn activity_since(db: &Connection, day: &str) -> rusqlite::Result<Vec<(String, i64)>> {
    db.prepare("select day, sum(n) as n from activity where day >= ? group by day order by day")?
        .query_map([day], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect()
}

#[derive(Clone)]
pub struct State {
    pub id: String,
    pub status: String,
    pub priority: Option<f64>,
    pub note: String,
    pub done_at: Option<String>,
    pub done_by: Option<String>,
}

fn state(r: &Row) -> rusqlite::Result<State> {
    Ok(State {
        id: r.get("id")?,
        status: r.get("status")?,
        priority: r.get("priority")?,
        note: r.get("note")?,
        done_at: r.get("done_at")?,
        done_by: r.get("done_by")?,
    })
}

pub fn get_s(db: &Connection, id: &str) -> rusqlite::Result<Option<State>> {
    db.query_row("select * from state where id = ?", [id], state).optional()
}

pub fn state_of(db: &Connection, id: &str) -> rusqlite::Result<State> {
    Ok(get_s(db, id)?.unwrap_or(State { id: id.into(), status: "todo".into(), priority: None, note: String::new(), done_at: None, done_by: None }))
}

pub fn pending(db: &Connection, id: &str) -> rusqlite::Result<bool> {
    Ok(state_of(db, id)?.status != "done")
}

pub fn all_s(db: &Connection) -> rusqlite::Result<Vec<State>> {
    db.prepare("select * from state")?.query_map([], state)?.collect()
}

pub fn put_s(db: &Connection, s: &State) -> rusqlite::Result<()> {
    db.prepare_cached("insert or replace into state (id, status, priority, note, done_at, done_by) values (?, ?, ?, ?, ?, ?)")?
        .execute(params![s.id, s.status, s.priority, s.note, s.done_at, s.done_by])
        .map(drop)
}

pub fn set_priority(db: &Connection, id: &str, p: f64) -> rusqlite::Result<()> {
    db.prepare_cached("insert into state (id, priority) values (?, ?) on conflict(id) do update set priority = excluded.priority")?
        .execute(params![id, p])
        .map(drop)
}

#[derive(Clone)]
pub struct Verdict {
    pub id: String,
    pub offset: i64,
    pub done: bool,
    pub confidence: f64,
    pub evidence: String,
    pub reason: String,
    pub quoted: bool,
    pub dismissed: bool,
    pub cost_usd: Option<f64>,
    pub at: String,
    pub error: Option<String>,
}

fn verdict(r: &Row) -> rusqlite::Result<Verdict> {
    Ok(Verdict {
        id: r.get("id")?,
        offset: r.get("offset")?,
        done: r.get::<_, i64>("done")? != 0,
        confidence: r.get("confidence")?,
        evidence: r.get::<_, Option<String>>("evidence")?.unwrap_or_default(),
        reason: r.get::<_, Option<String>>("reason")?.unwrap_or_default(),
        quoted: r.get::<_, i64>("quoted")? != 0,
        dismissed: r.get::<_, i64>("dismissed")? != 0,
        cost_usd: r.get("cost_usd")?,
        at: r.get("at")?,
        error: r.get("error")?,
    })
}

pub fn get_v(db: &Connection, id: &str) -> rusqlite::Result<Option<Verdict>> {
    db.query_row("select * from verdict where id = ?", [id], verdict).optional()
}

pub fn all_v(db: &Connection) -> rusqlite::Result<Vec<Verdict>> {
    db.prepare("select * from verdict")?.query_map([], verdict)?.collect()
}

/// A new verdict always starts undismissed.
pub fn put_v(db: &Connection, v: &Verdict) -> rusqlite::Result<()> {
    db.execute(
        "insert or replace into verdict (id, offset, done, confidence, evidence, reason, quoted, dismissed, cost_usd, at, error)
        values (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
        params![v.id, v.offset, v.done as i64, v.confidence, v.evidence, v.reason, v.quoted as i64, v.cost_usd, v.at, v.error],
    )
    .map(drop)
}

pub fn dismiss_v(db: &Connection, id: &str) -> rusqlite::Result<()> {
    db.execute("update verdict set dismissed = 1 where id = ?", [id]).map(drop)
}

pub fn get_meta(db: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    db.query_row("select value from meta where key = ?", [key], |r| r.get(0)).optional()
}

pub fn set_meta(db: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    db.execute("insert or replace into meta values (?, ?)", [key, value]).map(drop)
}
