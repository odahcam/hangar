// Hangar server: local catalog of Claude Code sessions. Reads ~/.claude live, keeps status/priority/notes in SQLite,
// backs up pending transcripts, and drives Terminal.app to resume/close sessions.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { classify } = require("./classify");

// Port 0 = pick a free one; the macOS app reads the chosen port from the "HANGAR_PORT=" line on stdout.
const PORT = Number(process.env.HANGAR_PORT ?? 0);
const WEB_DIR = process.env.HANGAR_WEB_DIR || path.join(__dirname, "..", "web");
const HOME = os.homedir();
const CLAUDE = process.env.HANGAR_CLAUDE_DIR || path.join(HOME, ".claude");
const DATA = process.env.HANGAR_DATA_DIR || path.join(HOME, "Library/Application Support/Hangar");
const BACKUP = path.join(DATA, "transcripts");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
fs.mkdirSync(BACKUP, { recursive: true });

const db = new DatabaseSync(path.join(DATA, "state.db"));
// Every session is pending unless a state row says otherwise; priority null = not triaged yet.
// done_by: 'user' | 'seed' (first-run 14-day cutoff) | 'suggestion' (confirmed by the user) | 'auto' (classifier, >= 0.90).
db.exec(`
create table if not exists state (
  id text primary key, status text not null default 'todo', priority real,
  note text not null default '', done_at text, done_by text);
create table if not exists meta (key text primary key, value text);`);

// transcript/activity are derived caches: on a schema bump they are dropped and rebuilt from the jsonl files.
const SCHEMA = "2";
if (db.prepare("select value from meta where key = 'schema'").get()?.value !== SCHEMA) {
  db.exec("drop table if exists transcript; drop table if exists activity;");
  db.prepare("insert or replace into meta values ('schema', ?)").run(SCHEMA);
}
db.exec(`
create table if not exists transcript (
  id text primary key, file text not null, offset integer not null, mtime real not null, size integer not null default 0,
  cwd text, branch text, agent_name text, ai_title text, first_prompt text, last_prompt text,
  first_at text, last_at text, prompts integer not null default 0,
  tokens_in integer not null default 0, tokens_cache integer not null default 0, tokens_out integer not null default 0,
  last_msg text, last_in integer, last_cache integer, last_out integer);
create table if not exists activity (id text not null, day text not null, n integer not null, primary key (id, day));
create table if not exists verdict (
  id text primary key, offset integer not null, done integer not null, confidence real not null, evidence text, reason text,
  quoted integer not null, dismissed integer not null default 0, cost_usd real, at text not null, error text);`);

const T_COLS = ["id", "file", "offset", "mtime", "size", "cwd", "branch", "agent_name", "ai_title", "first_prompt", "last_prompt",
  "first_at", "last_at", "prompts", "tokens_in", "tokens_cache", "tokens_out", "last_msg", "last_in", "last_cache", "last_out"];

const q = {
  getT: db.prepare("select * from transcript where id = ?"),
  putT: db.prepare(`insert or replace into transcript (${T_COLS}) values (${T_COLS.map((c) => ":" + c)})`),
  allT: db.prepare("select * from transcript"),
  clearActivity: db.prepare("delete from activity where id = ?"),
  addActivity: db.prepare("insert into activity values (?, ?, ?) on conflict (id, day) do update set n = n + excluded.n"),
  activitySince: db.prepare("select day, sum(n) as n from activity where day >= ? group by day order by day"),
  getS: db.prepare("select * from state where id = ?"),
  allS: db.prepare("select * from state"),
  putS: db.prepare("insert or replace into state (id, status, priority, note, done_at, done_by) values (:id, :status, :priority, :note, :done_at, :done_by)"),
  setPriority: db.prepare("insert into state (id, priority) values (?, ?) on conflict(id) do update set priority = excluded.priority"),
  getV: db.prepare("select * from verdict where id = ?"),
  allV: db.prepare("select * from verdict"),
  putV: db.prepare(`insert or replace into verdict (id, offset, done, confidence, evidence, reason, quoted, dismissed, cost_usd, at, error)
    values (:id, :offset, :done, :confidence, :evidence, :reason, :quoted, 0, :cost_usd, :at, :error)`),
  dismissV: db.prepare("update verdict set dismissed = 1 where id = ?"),
  getMeta: db.prepare("select value from meta where key = ?"),
  setMeta: db.prepare("insert or replace into meta values (?, ?)"),
};

function stateOf(id) {
  return q.getS.get(id) ?? { id, status: "todo", priority: null, note: "", done_at: null, done_by: null };
}
const pending = (id) => stateOf(id).status !== "done";

// --- transcripts: append-only jsonl, parsed incrementally from the last byte offset seen.

function humanPrompt(rec) {
  if (rec.type !== "user" || rec.isMeta || rec.isSidechain) return "";
  if (rec.turnOrigin && rec.turnOrigin !== "human") return "";
  let c = rec.message?.content;
  if (Array.isArray(c)) {
    if (c.some((x) => x?.type === "tool_result")) return "";
    c = c.filter((x) => x?.type === "text").map((x) => x.text).join(" ");
  }
  c = String(c ?? "").replace(/\s+/g, " ").trim();
  return /^(<|\[|Base directory|Another Claude)/.test(c) ? "" : c.slice(0, 400);
}

function scanFile(file) {
  const id = path.basename(file, ".jsonl");
  const st = fs.statSync(file);
  const prev = q.getT.get(id);
  if (prev && prev.file === file && prev.offset === st.size && prev.mtime === st.mtimeMs) return false;
  const fresh = !prev || prev.file !== file || st.size < prev.offset;
  const row = fresh ? { ...Object.fromEntries(T_COLS.map((c) => [c, null])), id, file, offset: 0, prompts: 0, tokens_in: 0, tokens_cache: 0, tokens_out: 0 } : { ...prev };
  if (fresh) q.clearActivity.run(id);
  const days = {};
  const num = (line, key) => Number(line.match(new RegExp(`"${key}":(\\d+)`))?.[1] ?? 0);
  const fd = fs.openSync(file, "r");
  try {
    let pos = row.offset, carry = "";
    const buf = Buffer.alloc(8 << 20);
    while (pos < st.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - pos), pos);
      if (!n) break;
      pos += n;
      const lines = (carry + buf.toString("utf8", 0, n)).split("\n");
      carry = lines.pop();
      for (const line of lines) {
        row.offset += Buffer.byteLength(line) + 1;
        let rec;
        if (line.includes('"type":"ai-title"') || line.includes('"type":"agent-name"') || line.includes('"type":"user"')) {
          try { rec = JSON.parse(line); } catch { continue; }
        }
        if (rec?.type === "ai-title") row.ai_title = rec.aiTitle ?? row.ai_title;
        else if (rec?.type === "agent-name") row.agent_name = rec.agentName ?? row.agent_name;
        else if (rec?.type === "user") {
          row.cwd = rec.cwd ?? row.cwd;
          row.branch = rec.gitBranch ?? row.branch;
          row.last_at = rec.timestamp ?? row.last_at;
          row.first_at ??= rec.timestamp;
          const p = humanPrompt(rec);
          if (p) {
            row.first_prompt ??= p;
            row.last_prompt = p;
            row.prompts++;
            if (rec.timestamp) { const day = localDay(rec.timestamp); days[day] = (days[day] || 0) + 1; }
          }
        } else {
          const m = line.match(/"timestamp":"([^"]+)"/);
          if (m) { row.last_at = m[1]; row.first_at ??= m[1]; }
          // Streaming writes one record per content block, repeating the message's usage: count each message once, latest wins.
          if (line.includes('"type":"assistant"') && line.includes('"usage"')) {
            const msg = line.match(/"id":"(msg_[A-Za-z0-9]+)"/)?.[1];
            const u = { in: num(line, "input_tokens") + num(line, "cache_creation_input_tokens"), cache: num(line, "cache_read_input_tokens"), out: num(line, "output_tokens") };
            if (msg && msg === row.last_msg) {
              row.tokens_in -= row.last_in; row.tokens_cache -= row.last_cache; row.tokens_out -= row.last_out;
            }
            row.tokens_in += u.in; row.tokens_cache += u.cache; row.tokens_out += u.out;
            Object.assign(row, { last_msg: msg ?? null, last_in: u.in, last_cache: u.cache, last_out: u.out });
          }
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  row.mtime = st.mtimeMs;
  row.size = st.size;
  q.putT.run(row);
  for (const [day, n] of Object.entries(days)) q.addActivity.run(id, day, n);
  return true;
}

function localDay(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function scanAll() {
  const root = path.join(CLAUDE, "projects");
  for (const dir of fs.readdirSync(root)) {
    const d = path.join(root, dir);
    let names;
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".jsonl") || !UUID.test(name.slice(0, -6))) continue;
      const file = path.join(d, name);
      const id = name.slice(0, -6);
      const changed = scanFile(file);
      if (pending(id) && (changed || !fs.existsSync(path.join(BACKUP, name)))) backup(id);
    }
  }
}

// Pending transcripts are copied out of ~/.claude so cleanupPeriodDays can never take them.
function backup(id) {
  const t = q.getT.get(id);
  if (t && fs.existsSync(t.file)) fs.copyFileSync(t.file, path.join(BACKUP, id + ".jsonl"));
}

// First run only: sessions idle for 14+ days were already dealt with; start them as done.
function seedDone() {
  if (q.getMeta.get("seed_done")) return;
  const cutoff = new Date(Date.now() - 14 * 864e5).toISOString();
  const now = new Date().toISOString();
  for (const t of q.allT.all()) {
    if (!q.getS.get(t.id) && (t.last_at || "") < cutoff) q.putS.run({ id: t.id, status: "done", priority: null, note: "", done_at: now, done_by: "seed" });
  }
  q.setMeta.run("seed_done", now);
}

// --- done suggestions: closed, pending sessions idle for 1h+ are classified once per transcript state.

const CLASSIFY_IDLE_MS = 36e5;
let classifying = false;

async function classifyPending() {
  if (classifying) return;
  classifying = true;
  try {
    const live = await liveSessions();
    const cutoff = new Date(Date.now() - CLASSIFY_IDLE_MS).toISOString();
    for (const t of q.allT.all()) {
      if (live[t.id] || !pending(t.id) || !t.last_at || t.last_at > cutoff || !fs.existsSync(t.file)) continue;
      const prev = q.getV.get(t.id);
      if (prev?.offset === t.offset && !prev.error) continue;
      const at = new Date().toISOString();
      try {
        const v = await classify(t.file, humanPrompt);
        q.putV.run({ id: t.id, offset: t.offset, done: v.done ? 1 : 0, confidence: v.confidence, evidence: v.evidence, reason: v.reason,
          quoted: v.quoted ? 1 : 0, cost_usd: v.costUsd, at, error: null });
        // Re-check pending: the user may have acted on this session while Haiku was thinking.
        if (v.autoDone && pending(t.id)) q.putS.run({ ...stateOf(t.id), status: "done", done_at: at, done_by: "auto" });
      } catch (e) {
        q.putV.run({ id: t.id, offset: t.offset, done: 0, confidence: 0, evidence: "", reason: "", quoted: 0, cost_usd: null, at, error: e.message });
      }
    }
  } finally {
    classifying = false;
  }
}

// --- live processes and Terminal tabs

function run(cmd, args) {
  return new Promise((res) => execFile(cmd, args, { timeout: 8000 }, (err, out, errOut) => res({ err, out, errOut })));
}

// Inside a Terminal tell block `tab` means Terminal's tab class, so the separator is spelled out.
const TABS_SCRIPT = `set out to ""
set sep to ASCII character 9
tell application "Terminal" to repeat with w in windows
repeat with t in tabs of w
set out to out & (tty of t) & sep & (busy of t) & sep & (custom title of t) & linefeed
end repeat
end repeat
return out`;

async function terminalTabs() {
  const { out } = await run("osascript", ["-e", TABS_SCRIPT]);
  const tabs = {};
  for (const line of (out || "").split("\n")) {
    const [tty, busy, title] = line.split("\t");
    if (tty) tabs[tty.replace("/dev/", "")] = { busy: busy === "true", title: (title || "").replace(/^[^\p{L}\p{N}]+/u, "").trim() };
  }
  return tabs;
}

async function liveSessions() {
  const dir = path.join(CLAUDE, "sessions");
  const live = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    try { process.kill(s.pid, 0); } catch { continue; }
    live[s.sessionId] = { pid: s.pid, cwd: s.cwd };
  }
  const pids = Object.values(live).map((l) => l.pid);
  if (pids.length) {
    const { out } = await run("ps", ["-o", "pid=,tty=", "-p", pids.join(",")]);
    const ttyOf = Object.fromEntries((out || "").trim().split("\n").map((l) => l.trim().split(/\s+/)).map(([p, t]) => [p, t]));
    for (const l of Object.values(live)) l.tty = ttyOf[l.pid];
  }
  return live;
}

function asString(s) { return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }
function shQuote(s) { return "'" + s.replace(/'/g, "'\\''") + "'"; }

function tabScript(tty, body) {
  return `tell application "Terminal"
repeat with w in windows
repeat with t in tabs of w
if tty of t is ${asString("/dev/" + tty)} then
${body}
return "ok"
end if
end repeat
end repeat
end tell
return "missing"`;
}

// --- API

// Project label = cwd minus the directory every session shares (e.g. ~/Projects), keeping at least the last segment.
function projectRoot(cwds) {
  const parts = cwds.filter(Boolean).map((c) => c.split("/"));
  if (!parts.length) return "";
  const max = Math.min(...parts.map((p) => p.length)) - 1;
  let n = 0;
  while (n < max && parts.every((p) => p[n] === parts[0][n])) n++;
  return parts[0].slice(0, n).join("/");
}

async function listSessions() {
  scanAll();
  const [live, tabs] = await Promise.all([liveSessions(), terminalTabs()]);
  const states = Object.fromEntries(q.allS.all().map((s) => [s.id, s]));
  const verdicts = Object.fromEntries(q.allV.all().map((v) => [v.id, v]));
  const transcripts = q.allT.all();
  const root = projectRoot(transcripts.map((t) => t.cwd));
  return transcripts.map((t) => {
    const l = live[t.id], c = states[t.id] ?? stateOf(t.id), v = verdicts[t.id];
    // A suggestion is stale once the transcript grows past what was classified.
    const verdict = v && !v.error ? { confidence: v.confidence, evidence: v.evidence, reason: v.reason, quoted: Boolean(v.quoted) } : null;
    const suggestion = verdict && v.done && !v.dismissed && v.offset === t.offset && c.status !== "done" ? verdict : null;
    const tabTitle = l?.tty ? tabs[l.tty]?.title : null;
    return {
      id: t.id,
      title: t.agent_name || tabTitle || t.ai_title || t.first_prompt?.slice(0, 80) || t.id.slice(0, 8),
      aiTitle: t.ai_title,
      project: root ? (t.cwd || l?.cwd || "").slice(root.length + 1) : t.cwd || l?.cwd || "",
      cwd: t.cwd || l?.cwd,
      branch: t.branch,
      firstPrompt: t.first_prompt,
      lastPrompt: t.last_prompt,
      firstAt: t.first_at,
      lastAt: t.last_at,
      prompts: t.prompts,
      tokensIn: t.tokens_in,
      tokensCache: t.tokens_cache,
      tokensOut: t.tokens_out,
      size: t.size,
      mtime: t.mtime,
      transcript: fs.existsSync(t.file),
      backedUp: fs.existsSync(path.join(BACKUP, t.id + ".jsonl")),
      live: l ? { pid: l.pid, tty: l.tty } : null,
      status: c.status,
      priority: c.priority,
      note: c.note,
      doneAt: c.done_at,
      doneBy: c.done_by,
      suggestion,
      autoVerdict: c.done_by === "auto" ? verdict : null,
    };
  });
}

// Footprint (not RSS) because most of these processes live in the compressor/swap; each session counts its MCP children too.
async function sessionMemory(pids) {
  const { out: psOut } = await run("ps", ["-Ao", "pid=,ppid="]);
  const children = {};
  for (const l of (psOut || "").trim().split("\n")) {
    const [pid, ppid] = l.trim().split(/\s+/).map(Number);
    (children[ppid] ||= []).push(pid);
  }
  const tree = {};
  for (const root of pids) {
    const all = [root];
    for (let i = 0; i < all.length; i++) all.push(...(children[all[i]] || []));
    tree[root] = all;
  }
  const every = Object.values(tree).flat();
  if (!every.length) return {};
  const { out } = await run("footprint", every.flatMap((p) => ["-p", String(p)]));
  const mb = {};
  for (const m of (out || "").matchAll(/\[(\d+)\]:.*?Footprint: ([\d.]+) (KB|MB|GB)/g)) {
    mb[m[1]] = Number(m[2]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[m[3]];
  }
  return Object.fromEntries(Object.entries(tree).map(([root, all]) => [root, Math.round(all.reduce((s, p) => s + (mb[p] || 0), 0))]));
}

async function insights() {
  const sessions = await listSessions();
  const now = Date.now(), day = 864e5;
  const ageDays = (iso) => iso ? (now - new Date(iso)) / day : Infinity;
  const pend = sessions.filter((s) => s.status !== "done");

  const byProject = {};
  for (const s of pend) {
    const p = (byProject[s.project || "?"] ||= { project: s.project || "?", d1: 0, d7: 0, d14: 0, older: 0, total: 0 });
    const a = ageDays(s.lastAt);
    p[a < 1 ? "d1" : a < 7 ? "d7" : a < 14 ? "d14" : "older"]++;
    p.total++;
  }

  const live = sessions.filter((s) => s.live);
  const mem = await sessionMemory(live.map((s) => s.live.pid));
  const [{ out: swap }, tabs] = await Promise.all([run("sysctl", ["-n", "vm.swapusage", "hw.memsize"]), terminalTabs()]);
  const swapUsed = Number(swap?.match(/used = ([\d.]+)M/)?.[1] ?? 0);
  const ramTotal = Number(swap?.trim().split("\n").pop() ?? 0) / 2 ** 20;

  const weeks = [];
  for (let w = 7; w >= 0; w--) {
    const start = now - (w + 1) * 7 * day, end = now - w * 7 * day;
    const inWeek = (iso) => iso && new Date(iso) >= start && new Date(iso) < end;
    weeks.push({
      start: new Date(start).toISOString().slice(0, 10),
      created: sessions.filter((s) => inWeek(s.firstAt)).length,
      done: sessions.filter((s) => s.doneBy !== "seed" && s.status === "done" && inWeek(s.doneAt)).length,
    });
  }

  const retentionMs = 365 * day;
  const top = (key) => [...sessions].sort((a, b) => b[key] - a[key]).slice(0, 10)
    .map((s) => ({ id: s.id, title: s.title, project: s.project, prompts: s.prompts, tokensIn: s.tokensIn, tokensCache: s.tokensCache, tokensOut: s.tokensOut, status: s.status }));
  const backupBytes = fs.readdirSync(BACKUP).reduce((n, f) => n + fs.statSync(path.join(BACKUP, f)).size, 0);
  const since = localDay(new Date(now - 29 * day).toISOString());

  return {
    totals: {
      pending: pend.length, untriaged: pend.filter((s) => s.priority == null).length, live: live.length,
      done: sessions.length - pend.length, sessions: sessions.length,
      tokensOut: sessions.reduce((n, s) => n + s.tokensOut, 0),
      suggestions: pend.filter((s) => s.suggestion).length,
      autoDone: sessions.filter((s) => s.doneBy === "auto").length,
      classified: q.allV.all().length,
      classifyCostUsd: q.allV.all().reduce((n, v) => n + (v.cost_usd || 0), 0),
    },
    byProject: Object.values(byProject).sort((a, b) => b.total - a.total),
    memory: {
      swapUsedMb: Math.round(swapUsed), ramTotalMb: Math.round(ramTotal),
      liveTotalMb: Object.values(mem).reduce((a, b) => a + b, 0),
      sessions: live.map((s) => ({ id: s.id, title: s.title, tty: s.live.tty, mb: mem[s.live.pid] ?? 0, idleHours: Math.round((now - new Date(s.lastAt)) / 36e5), status: s.status }))
        .sort((a, b) => b.mb - a.mb),
    },
    idleTabs: Object.entries(tabs).filter(([, t]) => !t.busy).map(([tty]) => tty),
    weeks,
    activity: q.activitySince.all(since),
    topPrompts: top("prompts"),
    topTokens: top("tokensOut"),
    storage: {
      transcriptsMb: Math.round(sessions.reduce((n, s) => n + s.size, 0) / 2 ** 20),
      backupMb: Math.round(backupBytes / 2 ** 20),
      pendingWithoutBackup: pend.filter((s) => !s.backedUp).map((s) => ({ id: s.id, title: s.title })),
      expiringSoon: sessions.filter((s) => s.transcript && s.mtime + retentionMs - now < 30 * day)
        .map((s) => ({ id: s.id, title: s.title, expiresAt: new Date(s.mtime + retentionMs).toISOString(), backedUp: s.backedUp })),
    },
  };
}

// Idle = Terminal reports nothing but the login shell running; exiting the shell lets Terminal close the tab.
async function closeIdleTabs() {
  const idle = Object.entries(await terminalTabs()).filter(([, t]) => !t.busy).map(([tty]) => tty);
  for (const tty of idle) await run("osascript", ["-e", tabScript(tty, 'if busy of t is false then do script "exit" in t')]);
  return { closed: idle.length };
}

async function resume(id) {
  const t = q.getT.get(id);
  if (!t) throw httpError(404, "unknown_session");
  const live = (await liveSessions())[id];
  if (live?.tty) {
    const r = await run("osascript", ["-e", tabScript(live.tty, "set selected of t to true\nset index of w to 1\nactivate")]);
    if (r.out?.trim() === "ok") return { focused: live.tty };
  }
  const saved = path.join(BACKUP, id + ".jsonl");
  if (!fs.existsSync(t.file) && fs.existsSync(saved)) {
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    fs.copyFileSync(saved, t.file);
  }
  const cmd = `cd ${shQuote(t.cwd || HOME)} && claude --resume ${id}`;
  await run("osascript", ["-e", `tell application "Terminal"\ndo script ${asString(cmd)}\nactivate\nend tell`]);
  return { opened: true };
}

async function close(id) {
  const live = (await liveSessions())[id];
  if (!live) return { closed: false, reason: "not_running" };
  backup(id);
  process.kill(live.pid, "SIGTERM");
  for (let i = 0; i < 50; i++) {
    try { process.kill(live.pid, 0); } catch { break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  // The tab is back at its shell prompt; exiting the shell lets Terminal close it.
  if (live.tty) await run("osascript", ["-e", tabScript(live.tty, 'do script "exit" in t')]);
  return { closed: true };
}

function updateState(id, body) {
  if (!q.getT.get(id)) throw httpError(404, "unknown_session");
  const next = { ...stateOf(id) };
  if (["todo", "doing", "done"].includes(body.status)) {
    next.status = body.status;
    next.done_at = body.status === "done" ? new Date().toISOString() : null;
    next.done_by = body.status === "done" ? (body.via === "suggestion" ? "suggestion" : "user") : null;
  }
  if (typeof body.note === "string") next.note = body.note;
  q.putS.run(next);
  if (next.status !== "done") backup(id);
}

// Reordering rewrites the whole pending order at once, so untriaged and triaged rows never interleave ambiguously.
function setOrder(ids) {
  if (!Array.isArray(ids) || !ids.every((id) => UUID.test(id))) throw httpError(400, "ids");
  db.exec("begin");
  try {
    ids.forEach((id, i) => q.setPriority.run(id, (i + 1) * 10));
    db.exec("commit");
  } catch (e) {
    db.exec("rollback");
    throw e;
  }
}

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

function readBody(req) {
  return new Promise((res, rej) => {
    let s = "";
    req.on("data", (d) => { s += d; if (s.length > 1e6) req.destroy(); });
    req.on("end", () => { try { res(s ? JSON.parse(s) : {}); } catch { rej(httpError(400, "invalid_json")); } });
  });
}

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/i18n.js": ["i18n.js", "text/javascript; charset=utf-8"],
  "/icon.svg": ["icon.svg", "image/svg+xml"],
  "/icon-512.png": ["icon-512.png", "image/png"],
  "/apple-touch-icon.png": ["apple-touch-icon.png", "image/png"],
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
};
let HOSTS = new Set();

const server = http.createServer(async (req, res) => {
  const send = (status, body, type = "application/json") => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  try {
    // DNS-rebinding and CSRF guard: only our own origin, and mutations need a header a cross-site form can't send.
    if (!HOSTS.has(req.headers.host)) return send(403, { error: "host" });
    if (req.method !== "GET" && req.headers["x-hangar"] !== "1") return send(403, { error: "csrf" });

    const url = new URL(req.url, "http://x");
    const [, api, action, id] = url.pathname.split("/");
    const asset = STATIC[url.pathname];
    if (asset) return send(200, fs.readFileSync(path.join(WEB_DIR, asset[0])), asset[1]);
    if (api !== "api") return send(404, { error: "not found" });
    if (action === "sessions" && req.method === "GET") return send(200, await listSessions());
    if (action === "insights" && req.method === "GET") return send(200, await insights());
    if (action === "close-idle-tabs" && req.method === "POST") return send(200, await closeIdleTabs());
    if (action === "order" && req.method === "POST") { setOrder((await readBody(req)).ids); return send(200, { ok: true }); }
    if (!UUID.test(id || "")) return send(400, { error: "id" });

    if (action === "session" && req.method === "PATCH") { updateState(id, await readBody(req)); return send(200, { ok: true }); }
    if (action === "dismiss-suggestion" && req.method === "POST") { q.dismissV.run(id); return send(200, { ok: true }); }
    if (action === "resume" && req.method === "POST") return send(200, await resume(id));
    if (action === "close" && req.method === "POST") return send(200, await close(id));
    send(404, { error: "not found" });
  } catch (e) {
    send(e.status || 500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const port = server.address().port;
  HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const t0 = Date.now();
  scanAll();
  seedDone();
  scanAll();
  setTimeout(classifyPending, 30e3);
  setInterval(() => { scanAll(); classifyPending(); }, 10 * 60e3);
  // Launched by the macOS app: if the app dies without stopping us, we get re-parented to launchd and exit.
  if (process.env.HANGAR_EXIT_WITH_PARENT) {
    const parent = process.ppid;
    setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 5000).unref();
  }
  console.log(`HANGAR_PORT=${port}`);
  console.error(`hangar on http://127.0.0.1:${port} (scan ${Date.now() - t0}ms)`);
});
