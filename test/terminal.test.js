// Live sessions, transcript backup and the terminal actions (through a fake osascript on macOS, a fake wt.exe on Windows).
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { RESUME, DARWIN, WIN32, makeWorld, addAccount, addSession, appendTurns, addLive, setTabs, calls, resumed, startServer, cleanup, waitFor } = require("./helpers");

let w, srv;
beforeEach(() => { w = makeWorld(); });
afterEach(async () => { await srv?.stop(); srv = null; cleanup(w); });

const backupOf = (s) => path.join(w.data, "transcripts", s.id + ".jsonl");
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a session with a running process is live, with its pid and tty", { skip: !DARWIN }, async () => {
  const s = addSession(w, { turns: [{ user: "a" }] });
  const child = addLive(w, s);
  srv = await startServer(w);
  const row = await srv.session(s.id);
  assert.equal(row.live.pid, child.pid);
  assert.ok(row.live.tty, "tty is reported");
});

test("a registered session whose process is gone is not live", async () => {
  const s = addSession(w, { turns: [{ user: "a" }] });
  fs.writeFileSync(path.join(w.claude, "sessions", "999999.json"), JSON.stringify({ pid: 999999, sessionId: s.id, cwd: s.cwd }));
  srv = await startServer(w);
  assert.equal((await srv.session(s.id)).live, null);
});

test("a live session without a name takes the Terminal tab title", { skip: !DARWIN }, async () => {
  const s = addSession(w, { turns: [{ user: "first prompt" }] });
  addLive(w, s);
  srv = await startServer(w);
  const { tty } = (await srv.session(s.id)).live;
  setTabs(w, [{ tty, busy: true, title: "✳ Tab title" }]);
  assert.equal((await srv.session(s.id)).title, "Tab title");
});

test("resuming a closed session opens a new Terminal tab running the resume helper in its cwd", { skip: !DARWIN }, async () => {
  const s = addSession(w, { cwd: "/work/it's here", turns: [{ user: "a" }] });
  srv = await startServer(w);
  const r = await srv.api("POST", `/api/resume/${s.id}`);
  assert.deepEqual(r.json, { opened: true });
  const script = calls(w, "osascript").map((c) => c.script).find((x) => x.includes("do script"));
  // The cd runs alone first: Terminal only learns the tab's directory at a prompt, and new tabs inherit it from there.
  // The account goes to the helper, which sets it (see the helper's own test below): the shell only runs it.
  assert.ok(script.includes(`do script "cd '/work/it'\\\\''s here'\\ncd '/work/it'\\\\''s here' && '${RESUME}' '${s.id}' '--config' '${w.claude}'"`), script);
});

test("a session with no message yet resumes in the folder its project name resolves to on disk", { skip: !DARWIN }, async () => {
  fs.mkdirSync(path.join(w.root, "my-app/sub dir"), { recursive: true });
  fs.mkdirSync(path.join(w.root, "my"));
  const cwd = fs.realpathSync(path.join(w.root, "my-app/sub dir"));
  const s = addSession(w, { cwd, agentName: "Only a name" });
  srv = await startServer(w);
  assert.deepEqual((await srv.api("POST", `/api/resume/${s.id}`)).json, { opened: true });
  const script = calls(w, "osascript").map((c) => c.script).find((x) => x.includes("do script"));
  assert.ok(script.includes(`do script "cd '${cwd}'\\n`), script);
});

test("a session with no message whose project name fits no single folder is refused, not opened elsewhere", async () => {
  const gone = addSession(w, { cwd: path.join(w.root, "gone"), agentName: "Gone" });
  fs.mkdirSync(path.join(w.root, "two-ways"));
  fs.mkdirSync(path.join(w.root, "two/ways"), { recursive: true });
  const twoWays = addSession(w, { cwd: path.join(w.root, "two-ways"), agentName: "Ambiguous" });
  srv = await startServer(w);
  for (const s of [gone, twoWays]) {
    const r = await srv.api("POST", `/api/resume/${s.id}`);
    assert.equal(r.status, 409);
    assert.deepEqual(r.json, { error: "folder_unknown" });
  }
  assert.ok(!calls(w, "osascript").some((c) => c.script.includes("do script")));
  assert.deepEqual(calls(w, "wt"), []);
});

test("a cwd with a control character or no root is refused, not typed into the terminal", async () => {
  const bad = [addSession(w, { cwd: "/work/a\u0003b", turns: [{ user: "a" }] }), addSession(w, { cwd: "/work/a\u001bb", turns: [{ user: "a" }] }),
    addSession(w, { cwd: "work/relative", turns: [{ user: "a" }] })];
  srv = await startServer(w);
  for (const s of bad) {
    const r = await srv.api("POST", `/api/resume/${s.id}`);
    assert.equal(r.status, 409);
    assert.deepEqual(r.json, { error: "unsupported_path" });
  }
  assert.ok(!calls(w, "osascript").some((c) => c.script.includes("do script")));
  assert.deepEqual(calls(w, "wt"), []);
});

test("under a non-POSIX login shell a cwd its quoting can't hold is refused", { skip: !DARWIN }, async () => {
  const s = addSession(w, { cwd: "/work/it's here", turns: [{ user: "a" }] });
  const plain = addSession(w, { cwd: "/work/plain", turns: [{ user: "a" }] });
  srv = await startServer(w, { HANGAR_LOGIN_SHELL: "/opt/homebrew/bin/fish" });
  assert.deepEqual((await srv.api("POST", `/api/resume/${s.id}`)).json, { error: "unsupported_path" });
  assert.ok(!calls(w, "osascript").some((c) => c.script.includes("do script")));
  assert.deepEqual((await srv.api("POST", `/api/resume/${plain.id}`)).json, { opened: true });
});

test("resuming a live session focuses its tab instead of opening another", { skip: !DARWIN }, async () => {
  const s = addSession(w, { turns: [{ user: "a" }] });
  addLive(w, s);
  srv = await startServer(w);
  const { tty } = (await srv.session(s.id)).live;
  setTabs(w, [{ tty, busy: true, title: "x" }]);
  const r = await srv.api("POST", `/api/resume/${s.id}`);
  assert.deepEqual(r.json, { focused: tty });
  assert.ok(!calls(w, "osascript").some((c) => c.script.includes("hangar-resume")));
});

test("resuming a live session whose tab is gone opens a new tab", { skip: !DARWIN }, async () => {
  const s = addSession(w, { turns: [{ user: "a" }] });
  addLive(w, s);
  srv = await startServer(w);
  const r = await srv.api("POST", `/api/resume/${s.id}`);
  assert.deepEqual(r.json, { opened: true });
});

test("pending transcripts are backed up and the copy follows new activity", async () => {
  const s = addSession(w, { turns: [{ user: "a" }] });
  srv = await startServer(w);
  assert.equal(fs.readFileSync(backupOf(s), "utf8"), fs.readFileSync(s.file, "utf8"));
  appendTurns(s, [{ user: "b" }]);
  await srv.sessions();
  assert.equal(fs.readFileSync(backupOf(s), "utf8"), fs.readFileSync(s.file, "utf8"));
  assert.equal((await srv.session(s.id)).backedUp, true);
});

test("done sessions stop being backed up", async () => {
  const s = addSession(w, { turns: [{ user: "a" }] });
  srv = await startServer(w);
  await srv.api("PATCH", `/api/session/${s.id}`, { status: "done" });
  const before = fs.readFileSync(backupOf(s), "utf8");
  appendTurns(s, [{ user: "b" }]);
  await srv.sessions();
  assert.equal(fs.readFileSync(backupOf(s), "utf8"), before);
});

test("resume restores a deleted transcript from the backup", async () => {
  const s = addSession(w, { turns: [{ user: "a" }] });
  srv = await startServer(w);
  const content = fs.readFileSync(s.file, "utf8");
  fs.rmSync(s.file);
  const row = await srv.session(s.id);
  assert.equal(row.transcript, false);
  assert.equal(row.backedUp, true);
  await srv.api("POST", `/api/resume/${s.id}`);
  assert.equal(fs.readFileSync(s.file, "utf8"), content);
});

test("closing a live session stops its process and exits its tab", { skip: !DARWIN }, async () => {
  const s = addSession(w, { turns: [{ user: "a" }] });
  const child = addLive(w, s);
  srv = await startServer(w);
  const { tty } = (await srv.session(s.id)).live;
  setTabs(w, [{ tty, busy: true, title: "x" }]);
  const r = await srv.api("POST", `/api/close/${s.id}`);
  assert.deepEqual(r.json, { closed: true });
  await waitFor(() => !alive(child.pid) || child.exitCode !== null || child.signalCode !== null);
  const exit = calls(w, "osascript").find((c) => c.script.includes('do script "exit" in t'));
  assert.ok(exit && exit.script.includes(`"/dev/${tty}"`));
  assert.equal((await srv.session(s.id)).live, null);
});

test("closing a session that is not running does nothing", async () => {
  const s = addSession(w, { turns: [{ user: "a" }] });
  srv = await startServer(w);
  const r = await srv.api("POST", `/api/close/${s.id}`);
  assert.deepEqual(r.json, { closed: false, reason: "not_running" });
});

test("closing idle tabs exits only tabs with nothing running", { skip: !DARWIN }, async () => {
  setTabs(w, [{ tty: "ttys001", busy: false }, { tty: "ttys002", busy: true }, { tty: "ttys003", busy: false }]);
  srv = await startServer(w);
  const r = await srv.api("POST", "/api/close-idle-tabs");
  assert.deepEqual(r.json, { closed: 2 });
  await tick();
  const exited = calls(w, "osascript").filter((c) => c.script.includes('do script "exit"')).map((c) => c.script.match(/"\/dev\/(\w+)"/)[1]);
  assert.deepEqual(exited.sort(), ["ttys001", "ttys003"]);
});

test("on Windows a live session is live, with no tab to focus", { skip: !WIN32 }, async () => {
  const s = addSession(w, { turns: [{ user: "a" }] });
  const child = addLive(w, s);
  srv = await startServer(w);
  assert.deepEqual((await srv.session(s.id)).live, { pid: child.pid, canFocus: false });
});

// The tab runs the helper itself, no shell, so Windows Terminal opens the user's default profile; the helper sets the
// account (see its own test below). wt gets neither what would make claude a Claude Code session's child nor the
// look of the terminal Hangar was started from (an agent's NO_COLOR left sessions colorless).
test("on Windows resuming a closed session opens a Windows Terminal tab running the resume helper in its cwd", { skip: !WIN32 }, async () => {
  const s = addSession(w, { cwd: String.raw`C:\work\a;b`, turns: [{ user: "a" }] });
  srv = await startServer(w, { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ID: "parent",
    NO_COLOR: "1", TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "1.0" });
  const r = await srv.api("POST", `/api/resume/${s.id}`);
  assert.deepEqual(r.json, { opened: true });
  const [call] = calls(w, "wt");
  assert.deepEqual(call.args, ["-w", "0", "new-tab", "--startingDirectory", String.raw`C:\work\a\;b`,
    RESUME.replaceAll(";", "\\;"), s.id, "--config", w.claude.replaceAll(";", "\\;")]);
  assert.deepEqual(call.terminalEnv, []);
  assert.ok(resumed(w, s.id));
});

// No shell parses the account folder any more: quotes of any kind reach the helper as they are.
test("on Windows an account folder with quotes reaches the helper as one argument", { skip: !WIN32 }, async () => {
  const dir = addAccount(w, "claude-it's \u2018a\u2019 \"b\"");
  const s = addSession(w, { claude: dir, cwd: String.raw`C:\work\q`, turns: [{ user: "a" }] });
  srv = await startServer(w);
  assert.deepEqual((await srv.api("POST", `/api/resume/${s.id}`)).json, { opened: true });
  assert.deepEqual(calls(w, "wt")[0].args.slice(-2), ["--config", dir]);
});

// What every tab runs: claude --resume under the account, without what makes it a Claude Code session's child.
test("the resume helper starts claude --resume under the given account, as no session's child", () => {
  const id = "0b7e4a2c-1d2f-4a6b-9c3d-5e6f7a8b9c0d";
  const env = { ...process.env, CLAUDE_BIN: path.join(__dirname, "bin", "claude.js"), FAKE_LOG: w.log, FAKE_VERDICTS: w.verdicts,
    CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "parent", CLAUDE_CONFIG_DIR: "/somewhere/else" };
  const run = (args) => spawnSync(RESUME, args, { env, input: "", encoding: "utf8" });
  run([id, "--config", "/accounts/work"]);
  run([id]);
  const [withAccount, plain] = calls(w, "claude");
  assert.deepEqual(withAccount.args, ["--resume", id]);
  assert.equal(withAccount.config, "/accounts/work");
  assert.deepEqual(withAccount.sessionEnv, []);
  // No account: the default one, so a CLAUDE_CONFIG_DIR the tab carries goes.
  assert.equal(plain.config, null);
  // Anything but a session id is refused, claude not started.
  assert.equal(run(["--version; rm -rf ~"]).status, 2);
  assert.equal(calls(w, "claude").length, 2);
});

test("on Windows resuming a session that is still running is refused instead of forking it", { skip: !WIN32 }, async () => {
  const s = addSession(w, { turns: [{ user: "a" }] });
  addLive(w, s);
  srv = await startServer(w);
  const r = await srv.api("POST", `/api/resume/${s.id}`);
  assert.equal(r.status, 409);
  assert.deepEqual(calls(w, "wt"), []);
});

test("on Windows closing a live session stops its process", { skip: !WIN32 }, async () => {
  const s = addSession(w, { turns: [{ user: "a" }] });
  const child = addLive(w, s);
  srv = await startServer(w);
  const r = await srv.api("POST", `/api/close/${s.id}`);
  assert.deepEqual(r.json, { closed: true });
  await waitFor(() => !alive(child.pid) || child.exitCode !== null || child.signalCode !== null);
  assert.equal((await srv.session(s.id)).live, null);
});
