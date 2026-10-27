// Judges whether a closed session's work is finished, by asking Haiku about the tail of its transcript.
// Any done=true verdict is shown as a suggestion; it is applied on its own (auto_done) only at confidence >= 0.90
// and when the quoted evidence is literally one of the user's own messages.
use crate::platform;
use crate::proc::{command, run_with};
use crate::scan::{collapse, human_prompt};
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

const TAIL_BYTES: u64 = 3 << 20;
const MAX_MESSAGES: usize = 24;
const MAX_CHARS: usize = 1500;
const AUTO_DONE: f64 = 0.9;

const SYSTEM: &str = r#"You decide whether a work session between a developer (USER) and a coding agent (ASSISTANT) is FINISHED.
Finished = the session's goal was reached and the USER closed it or accepted the end (e.g. "done", "that's it", "we're finished", "you can close it", "pronto", "fechado", "terminamos", a PR merged with nothing else asked).
NOT finished when: the USER asks for something new or leaves a pending item ("don't forget to…", "later we'll…", "não esquece que…", "segue"), the last message is an unanswered question or request, the ASSISTANT ends by asking or proposing a next step that was not accepted, or the conversation simply stopped.
When in doubt, done=false. confidence is your certainty in the value of done.
evidence: if done=true, copy VERBATIM a fragment (5 to 200 characters) of a USER message that shows the closing; if done=false, an empty string.
reason: one short sentence, in the language the USER writes in."#;

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "done": { "type": "boolean" },
            "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
            "evidence": { "type": "string" },
            "reason": { "type": "string" },
        },
        "required": ["done", "confidence", "evidence", "reason"],
        "additionalProperties": false,
    })
}

pub struct Outcome {
    pub done: bool,
    pub confidence: f64,
    pub evidence: String,
    pub reason: String,
    pub quoted: bool,
    pub auto_done: bool,
    pub cost_usd: Option<f64>,
}

fn find_claude() -> Option<String> {
    if let Ok(bin) = std::env::var("CLAUDE_BIN") {
        return Some(bin);
    }
    let p = platform::current();
    let home = crate::home();
    if let Some(found) = p.claude_candidates(&home).into_iter().find(|c| c.exists()) {
        return Some(found.to_string_lossy().into());
    }
    let (cmd, args) = p.which_claude();
    let out = run_with(command(&cmd).args(&args), None, Duration::from_secs(10));
    out.out.lines().next().map(str::trim).filter(|s| out.ok && !s.is_empty()).map(String::from)
}

fn claude_bin() -> Option<&'static str> {
    static BIN: OnceLock<Option<String>> = OnceLock::new();
    BIN.get_or_init(find_claude).as_deref()
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) if !parts.iter().any(|x| x["type"] == "tool_result") => {
            parts.iter().filter(|x| x["type"] == "text").filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join(" ")
        }
        _ => String::new(),
    }
}

fn norm(s: &str) -> String {
    collapse(s).to_lowercase()
}

/// Last N human and assistant text turns; tool calls and harness-injected user turns are dropped.
pub fn excerpt(file: &Path) -> std::io::Result<Vec<(&'static str, String)>> {
    let mut f = fs::File::open(file)?;
    let size = f.metadata()?.len();
    let start = size.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.split('\n');
    if start > 0 {
        lines.next();
    }
    let mut turns: Vec<(&'static str, String)> = Vec::new();
    for line in lines {
        if !line.contains(r#""type":"user""#) && !line.contains(r#""type":"assistant""#) {
            continue;
        }
        let Ok(rec) = serde_json::from_str::<Value>(line) else { continue };
        if rec["isSidechain"].as_bool() == Some(true) {
            continue;
        }
        if rec["type"] == "user" {
            if !human_prompt(&rec).is_empty() {
                turns.push(("USER", collapse(&text_of(&rec["message"]["content"]))));
            }
        } else if rec["type"] == "assistant" {
            let t = text_of(&rec["message"]["content"]).trim().to_string();
            if t.is_empty() {
                continue;
            }
            // Streamed blocks of one message arrive as separate records; merge consecutive assistant text.
            match turns.last_mut() {
                Some(("ASSISTANT", last)) => {
                    last.push('\n');
                    last.push_str(&t);
                }
                _ => turns.push(("ASSISTANT", t)),
            }
        }
    }
    let skip = turns.len().saturating_sub(MAX_MESSAGES);
    Ok(turns
        .into_iter()
        .skip(skip)
        .map(|(role, t)| {
            let n = t.chars().count();
            (role, if n > MAX_CHARS { format!("…{}", t.chars().skip(n - MAX_CHARS).collect::<String>()) } else { t })
        })
        .collect())
}

/// `account` is the config dir whose login pays for the call: always explicit, never whatever the environment has.
/// ~/.claude goes with CLAUDE_CONFIG_DIR cleared, as on resume (see accounts.rs).
fn ask_haiku(prompt: &str, account: &Path) -> Result<(Value, Option<f64>), String> {
    let bin = claude_bin().ok_or("claude_cli_not_found")?;
    let schema = schema().to_string();
    let args = [
        "-p", "--model", "haiku", "--output-format", "json", "--json-schema", &schema,
        "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--system-prompt", SYSTEM,
    ];
    let mut cmd = command(bin);
    cmd.args(args).current_dir(std::env::temp_dir());
    if crate::accounts::is_default(account) {
        cmd.env_remove("CLAUDE_CONFIG_DIR");
    } else {
        cmd.env("CLAUDE_CONFIG_DIR", account);
    }
    let out = run_with(&mut cmd, Some(prompt), Duration::from_secs(180));
    if !out.ok {
        let tail: String = if out.err.trim().is_empty() { out.out.trim().to_string() } else { out.err.trim().to_string() };
        let n = tail.chars().count();
        return Err(tail.chars().skip(n.saturating_sub(300)).collect());
    }
    let invalid = || format!("invalid_response: {}", out.out.chars().take(200).collect::<String>());
    let res: Value = serde_json::from_str(&out.out).map_err(|_| invalid())?;
    let verdict = match &res["structured_output"] {
        Value::Null => serde_json::from_str(res["result"].as_str().ok_or_else(invalid)?).map_err(|_| invalid())?,
        v => v.clone(),
    };
    Ok((verdict, res["total_cost_usd"].as_f64()))
}

pub fn classify(file: &PathBuf, account: &Path) -> Result<Outcome, String> {
    let turns = excerpt(file).map_err(|e| e.to_string())?;
    if !turns.iter().any(|(r, _)| *r == "USER") {
        return Ok(Outcome { done: false, confidence: 1.0, evidence: String::new(), reason: "no user messages".into(), quoted: false, auto_done: false, cost_usd: Some(0.0) });
    }
    let prompt = format!(
        "Conversation (oldest → newest):\n\n{}",
        turns.iter().map(|(r, t)| format!("[{r}] {t}")).collect::<Vec<_>>().join("\n\n")
    );
    let (v, cost_usd) = ask_haiku(&prompt, account)?;
    let done = v["done"].as_bool().unwrap_or(false);
    let confidence = v["confidence"].as_f64().unwrap_or(0.0);
    let evidence = v["evidence"].as_str().unwrap_or("").to_string();
    let reason = v["reason"].as_str().unwrap_or("").to_string();
    let ev = norm(&evidence);
    let quoted = !evidence.is_empty() && ev.chars().count() >= 5 && turns.iter().any(|(r, t)| *r == "USER" && norm(t).contains(&ev));
    Ok(Outcome { done, confidence, evidence, reason, quoted, auto_done: done && confidence >= AUTO_DONE && quoted, cost_usd })
}
