// Judges whether a closed session's work is finished, by asking Haiku about the tail of its transcript.
// Any done=true verdict is shown as a suggestion; it is applied on its own (autoDone) only at confidence >= 0.90
// and when the quoted evidence is literally one of the user's own messages.
const fs = require("node:fs");
const { execFile } = require("node:child_process");

const os = require("node:os");
const { execFileSync } = require("node:child_process");

// Apps launched from Finder get a minimal PATH, so look in the usual install spots before asking a login shell.
function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const home = os.homedir();
  const candidates = [`${home}/.local/bin/claude`, `${home}/.claude/local/claude`, "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  const found = candidates.find((p) => fs.existsSync(p));
  if (found) return found;
  try {
    return execFileSync(process.env.SHELL || "/bin/zsh", ["-lc", "command -v claude"], { encoding: "utf8", timeout: 10000 }).trim() || null;
  } catch {
    return null;
  }
}
let claudeBin;
const TAIL_BYTES = 3 << 20;
const MAX_MESSAGES = 24;
const MAX_CHARS = 1500;
const AUTO_DONE = 0.9;

const SCHEMA = {
  type: "object",
  properties: {
    done: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: { type: "string" },
    reason: { type: "string" },
  },
  required: ["done", "confidence", "evidence", "reason"],
  additionalProperties: false,
};

const SYSTEM = `You decide whether a work session between a developer (USER) and a coding agent (ASSISTANT) is FINISHED.
Finished = the session's goal was reached and the USER closed it or accepted the end (e.g. "done", "that's it", "we're finished", "you can close it", "pronto", "fechado", "terminamos", a PR merged with nothing else asked).
NOT finished when: the USER asks for something new or leaves a pending item ("don't forget to…", "later we'll…", "não esquece que…", "segue"), the last message is an unanswered question or request, the ASSISTANT ends by asking or proposing a next step that was not accepted, or the conversation simply stopped.
When in doubt, done=false. confidence is your certainty in the value of done.
evidence: if done=true, copy VERBATIM a fragment (5 to 200 characters) of a USER message that shows the closing; if done=false, an empty string.
reason: one short sentence, in the language the USER writes in.`;

const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  if (content.some((x) => x?.type === "tool_result")) return "";
  return content.filter((x) => x?.type === "text").map((x) => x.text).join(" ");
}

// Last N human and assistant text turns; tool calls and harness-injected user turns are dropped.
function excerpt(file, isHumanPrompt) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  const lines = buf.toString("utf8").split("\n");
  if (start > 0) lines.shift();
  const turns = [];
  for (const line of lines) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.isSidechain) continue;
    if (rec.type === "user") {
      const p = isHumanPrompt(rec);
      if (p) turns.push({ role: "USER", text: textOf(rec.message?.content).replace(/\s+/g, " ").trim() });
    } else if (rec.type === "assistant") {
      const t = textOf(rec.message?.content).trim();
      if (!t) continue;
      const last = turns[turns.length - 1];
      // Streamed blocks of one message arrive as separate records; merge consecutive assistant text.
      if (last?.role === "ASSISTANT") last.text += "\n" + t;
      else turns.push({ role: "ASSISTANT", text: t });
    }
  }
  return turns.slice(-MAX_MESSAGES).map((t) => ({ ...t, text: t.text.length > MAX_CHARS ? "…" + t.text.slice(-MAX_CHARS) : t.text }));
}

function askHaiku(prompt) {
  const args = [
    "-p", "--model", "haiku", "--output-format", "json", "--json-schema", JSON.stringify(SCHEMA),
    "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--system-prompt", SYSTEM,
  ];
  claudeBin ??= findClaude();
  if (!claudeBin) return Promise.reject(new Error("claude_cli_not_found"));
  return new Promise((resolve, reject) => {
    const child = execFile(claudeBin, args, { timeout: 180000, maxBuffer: 8 << 20, cwd: os.tmpdir() }, (err, out, errOut) => {
      if (err) {
        const why = err.killed ? `timeout/killed (${err.signal})` : `exit ${err.code}`;
        return reject(new Error(`${why}: ${(errOut || out || "").trim().slice(-300)}`));
      }
      try {
        const res = JSON.parse(out);
        const verdict = res.structured_output ?? JSON.parse(res.result);
        resolve({ verdict, costUsd: res.total_cost_usd ?? null });
      } catch (e) {
        reject(new Error("invalid_response: " + String(out).slice(0, 200)));
      }
    });
    child.stdin.end(prompt);
  });
}

async function classify(file, isHumanPrompt) {
  const turns = excerpt(file, isHumanPrompt);
  if (!turns.some((t) => t.role === "USER")) return { done: false, confidence: 1, evidence: "", reason: "no user messages", quoted: false, autoDone: false, costUsd: 0 };
  const prompt = "Conversation (oldest → newest):\n\n" + turns.map((t) => `[${t.role}] ${t.text}`).join("\n\n");
  const { verdict, costUsd } = await askHaiku(prompt);
  const userText = turns.filter((t) => t.role === "USER").map((t) => norm(t.text));
  const quoted = Boolean(verdict.evidence) && norm(verdict.evidence).length >= 5 && userText.some((t) => t.includes(norm(verdict.evidence)));
  return { ...verdict, quoted, autoDone: verdict.done && verdict.confidence >= AUTO_DONE && quoted, costUsd };
}

module.exports = { classify, excerpt };
