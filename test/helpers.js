// Test harness: a throwaway ~/.claude ("world"), fake osascript/wt/claude binaries, and a real server process per test.
const { spawn, execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const BIN = path.join(__dirname, "bin");
// The core over HTTP (core/src/bin/hangar-server.rs); `npm test` builds it first. HANGAR_SERVER points at another build.
const SERVER = process.env.HANGAR_SERVER || path.join(ROOT, "target/debug", "hangar-server" + (process.platform === "win32" ? ".exe" : ""));
const HOUR = 36e5, DAY = 864e5;
// Terminal features differ per OS (see core/src/platform); tests of one OS's terminal skip on the others.
const DARWIN = process.platform === "darwin", WIN32 = process.platform === "win32";

const ago = (ms) => new Date(Date.now() - ms).toISOString();

function makeWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hangar-test-"));
  const w = {
    root,
    claude: path.join(root, "claude"),
    data: path.join(root, "data"),
    log: path.join(root, "calls.jsonl"),
    tabs: path.join(root, "tabs.tsv"),
    verdicts: path.join(root, "verdicts.json"),
    children: [],
  };
  fs.mkdirSync(path.join(w.claude, "projects"), { recursive: true });
  fs.mkdirSync(path.join(w.claude, "sessions"));
  fs.writeFileSync(w.log, "");
  fs.writeFileSync(w.tabs, "");
  fs.writeFileSync(w.verdicts, "[]");
  return w;
}

// Builds transcript records the way Claude Code writes them.
function userRec(s, text, at, extra = {}) {
  return { type: "user", isSidechain: false, turnOrigin: "human", cwd: s.cwd, gitBranch: s.branch, sessionId: s.id, timestamp: at,
    message: { role: "user", content: text }, ...extra };
}
function assistantRec(s, text, at, usage = {}, msgId = "msg_" + crypto.randomBytes(6).toString("hex")) {
  return { type: "assistant", sessionId: s.id, timestamp: at,
    message: { id: msgId, role: "assistant", content: [{ type: "text", text }],
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5, ...usage } } };
}

// turns: [{ user: "text" } | { assistant: "text", usage } | { raw: record }], spread over time ending at `endAgo`.
function addSession(w, { id = crypto.randomUUID(), cwd = "/work/acme/app", branch = "main", agentName, aiTitle, turns = [], endAgo = 2 * HOUR } = {}) {
  const s = { id, cwd, branch };
  const dir = path.join(w.claude, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + ".jsonl");
  const lines = [];
  if (aiTitle) lines.push({ type: "ai-title", aiTitle, sessionId: id });
  if (agentName) lines.push({ type: "agent-name", agentName, sessionId: id });
  turns.forEach((t, i) => {
    const at = ago(endAgo + (turns.length - 1 - i) * 60e3);
    if (t.raw) lines.push({ ...t.raw, timestamp: t.raw.timestamp ?? at });
    else if (t.user !== undefined) lines.push(userRec(s, t.user, at, t.extra));
    else lines.push(assistantRec(s, t.assistant, at, t.usage, t.msgId));
  });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { ...s, file };
}

function appendTurns(session, turns) {
  const lines = turns.map((t) => t.user !== undefined
    ? userRec(session, t.user, new Date().toISOString())
    : assistantRec(session, t.assistant, new Date().toISOString(), t.usage, t.msgId));
  fs.appendFileSync(session.file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

// A "live" session: a real process registered the way Claude Code does in ~/.claude/sessions.
function addLive(w, session) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600e3)"], { stdio: "ignore" });
  w.children.push(child);
  fs.writeFileSync(path.join(w.claude, "sessions", child.pid + ".json"),
    JSON.stringify({ pid: child.pid, sessionId: session.id, cwd: session.cwd }));
  return child;
}

// Terminal tabs the fake osascript reports: [{ tty, busy, title }].
function setTabs(w, tabs) {
  fs.writeFileSync(w.tabs, tabs.map((t) => `/dev/${t.tty}\t${t.busy}\t${t.title ?? ""}`).join("\n"));
}

// Verdict rules for the fake claude: first rule whose `match` occurs in the prompt wins.
function setVerdicts(w, rules) {
  fs.writeFileSync(w.verdicts, JSON.stringify(rules));
}

function calls(w, bin) {
  return fs.readFileSync(w.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => !bin || c.bin === bin);
}

// Whether this OS's terminal was asked to run `claude --resume <id>`.
function resumed(w, id) {
  return calls(w).some((c) => c.bin === "osascript" ? c.script.includes(`claude --resume ${id}`)
    : c.bin === "wt" && c.args.join(" ").endsWith(`claude --resume ${id}`));
}

async function startServer(w, env = {}) {
  const proc = spawn(SERVER, [], {
    env: {
      ...process.env,
      HANGAR_PORT: "0",
      HANGAR_CLAUDE_DIR: w.claude,
      HANGAR_DATA_DIR: w.data,
      HANGAR_WEB_DIR: path.join(ROOT, "web"),
      HANGAR_OSASCRIPT: path.join(BIN, "osascript.js"),
      HANGAR_WT: path.join(BIN, "wt.js"),
      CLAUDE_BIN: path.join(BIN, "claude.js"),
      FAKE_LOG: w.log,
      FAKE_TABS: w.tabs,
      FAKE_VERDICTS: w.verdicts,
      HANGAR_CLASSIFY_START_MS: "3600000",
      NODE_NO_WARNINGS: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group, so stop() also takes down fake binaries the server spawned for in-flight requests.
    // (On Windows `detached` would mean a console window; taskkill /T walks the tree instead.)
    detached: !WIN32,
  });
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr += d; });
  const port = await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("server did not start: " + stderr)), 15000);
    proc.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/HANGAR_PORT=(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  async function api(method, p, body, headers = {}) {
    const res = await fetch(base + p, {
      method,
      headers: { "x-hangar": "1", "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, text, headers: res.headers };
  }
  const sessions = async () => (await api("GET", "/api/sessions")).json;
  const session = async (id) => (await sessions()).find((s) => s.id === id);
  async function stop() {
    proc.removeAllListeners("exit");
    const exited = new Promise((r) => proc.once("exit", r));
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      if (WIN32) execFileSync("taskkill", ["/pid", String(proc.pid), "/t", "/f"], { stdio: "ignore" });
      else process.kill(-proc.pid, "SIGKILL");
    } catch {}
    await exited;
  }
  return { port, base, api, sessions, session, stop, stderr: () => stderr };
}

// Stops a desktop app process. On Windows it is asked to close first (WM_CLOSE): its webview's browser processes
// are not its children, so only a clean quit takes them down and frees the profile. Killed if it doesn't comply.
async function stopApp(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const gone = new Promise((r) => proc.once("exit", r));
  const kill = (force) => {
    try {
      if (WIN32) execFileSync("taskkill", ["/pid", String(proc.pid), "/t", ...(force ? ["/f"] : [])], { stdio: "ignore" });
      else proc.kill(force ? "SIGKILL" : "SIGTERM");
    } catch {}
  };
  kill(false);
  const timer = setTimeout(() => kill(true), 5000);
  await gone;
  clearTimeout(timer);
}

function cleanup(w) {
  for (const c of w.children) c.kill();
  // A webview lets go of its profile a few seconds after its app exits, and Windows locks open files. A world still
  // locked after that is left to the OS temp cleanup rather than failing the test. (The backoff is linear: 10 retries
  // wait up to ~14s in all; 60 would wait 7.6 minutes.)
  try { fs.rmSync(w.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); }
  catch (e) { if (e.code !== "EPERM" && e.code !== "EBUSY") throw e; }
}

async function waitFor(fn, { timeout = 10000, every = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, every));
  }
}

module.exports = { stopApp, ROOT, BIN, HOUR, DAY, DARWIN, WIN32, resumed, ago, makeWorld, addSession, appendTurns, addLive, setTabs, setVerdicts, calls, startServer, cleanup, waitFor };
