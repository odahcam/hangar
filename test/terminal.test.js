// Live sessions, transcript backup and the terminal actions (through a fake osascript on macOS, a fake wt.exe on Windows).
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DARWIN, WIN32, makeWorld, addSession, appendTurns, addLive, setTabs, calls, resumed, startServer, cleanup, waitFor } = require("./helpers");

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

test("resuming a closed session opens a new Terminal tab with claude --resume in its cwd", { skip: !DARWIN }, async () => {
  const s = addSession(w, { cwd: "/work/it's here", turns: [{ user: "a" }] });
  srv = await startServer(w);
  const r = await srv.api("POST", `/api/resume/${s.id}`);
  assert.deepEqual(r.json, { opened: true });
  const script = calls(w, "osascript").map((c) => c.script).find((x) => x.includes("do script"));
  assert.ok(script.includes(`cd '/work/it'\\\\''s here' && claude --resume ${s.id}`), script);
});

test("resuming a live session focuses its tab instead of opening another", { skip: !DARWIN }, async () => {
  const s = addSession(w, { turns: [{ user: "a" }] });
  addLive(w, s);
  srv = await startServer(w);
  const { tty } = (await srv.session(s.id)).live;
  setTabs(w, [{ tty, busy: true, title: "x" }]);
  const r = await srv.api("POST", `/api/resume/${s.id}`);
  assert.deepEqual(r.json, { focused: tty });
  assert.ok(!calls(w, "osascript").some((c) => c.script.includes("claude --resume")));
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

test("on Windows resuming a closed session opens a Windows Terminal tab in its cwd", { skip: !WIN32 }, async () => {
  const s = addSession(w, { cwd: String.raw`C:\work\a;b`, turns: [{ user: "a" }] });
  srv = await startServer(w);
  const r = await srv.api("POST", `/api/resume/${s.id}`);
  assert.deepEqual(r.json, { opened: true });
  assert.deepEqual(calls(w, "wt")[0].args, ["-w", "0", "new-tab", "--startingDirectory", String.raw`C:\work\a\;b`, "claude", "--resume", s.id]);
  assert.ok(resumed(w, s.id));
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
