// Accounts: several Claude Code config dirs side by side, resuming under the right one, and moving a session across.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DARWIN, makeWorld, addAccount, addSession, appendTurns, addLive, calls, startServer, cleanup } = require("./helpers");

let w, srv;
beforeEach(() => { w = makeWorld(); });
afterEach(async () => { await srv?.stop(); srv = null; cleanup(w); });

// Everything Claude Code keeps under a session's id, as a transfer has to carry it.
function addExtras(claude, s) {
  const files = [
    path.join(path.dirname(s.file), s.id, "subagents", "agent-1.jsonl"),
    path.join(claude, "file-history", s.id, "abc@v1"),
    path.join(claude, "session-env", s.id, "env.sh"),
  ];
  for (const f of files) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "x"); }
  return files.map((f) => path.relative(claude, f));
}

test("sessions of every account are listed, each with its account", async () => {
  const personal = addAccount(w, "claude-personal");
  const a = addSession(w, { turns: [{ user: "team work" }] });
  const b = addSession(w, { claude: personal, turns: [{ user: "personal work" }] });
  srv = await startServer(w);
  assert.equal((await srv.session(a.id)).account, w.claude);
  assert.equal((await srv.session(b.id)).account, personal);
  const accounts = (await srv.api("GET", "/api/accounts")).json;
  assert.deepEqual(accounts.map((x) => [x.dir, x.name]), [[w.claude, "claude"], [personal, "personal"]]);
  assert.notEqual(accounts[0].color, accounts[1].color);
});

test("a session running in another account is live", async () => {
  const personal = addAccount(w, "claude-personal");
  const s = addSession(w, { claude: personal, turns: [{ user: "a" }] });
  const child = addLive(w, s);
  srv = await startServer(w);
  assert.equal((await srv.session(s.id)).live.pid, child.pid);
});

test("resuming opens claude under the session's own account", { skip: !DARWIN }, async () => {
  const personal = addAccount(w, "claude-personal");
  const s = addSession(w, { claude: personal, turns: [{ user: "a" }] });
  srv = await startServer(w);
  await srv.api("POST", `/api/resume/${s.id}`);
  const script = calls(w, "osascript").map((c) => c.script).find((x) => x.includes("do script"));
  assert.ok(script.includes(`CLAUDE_CONFIG_DIR='${personal}' claude --resume ${s.id}`), script);
});

test("an account can be renamed and recolored; a bad color is refused", async () => {
  const personal = addAccount(w, "claude-personal");
  srv = await startServer(w);
  assert.deepEqual((await srv.api("PATCH", "/api/account", { dir: personal, name: "Personal", color: "#AA0000" })).json, { ok: true });
  assert.equal((await srv.api("PATCH", "/api/account", { dir: personal, color: "red" })).status, 400);
  assert.equal((await srv.api("PATCH", "/api/account", { dir: "/nope", name: "x" })).status, 404);
  const a = (await srv.api("GET", "/api/accounts")).json.find((x) => x.dir === personal);
  assert.deepEqual([a.name, a.color], ["Personal", "#aa0000"]);
});

test("hiding an account takes its sessions off the list until it is shown again", async () => {
  const personal = addAccount(w, "claude-personal");
  const s = addSession(w, { claude: personal, turns: [{ user: "a" }] });
  srv = await startServer(w);
  assert.deepEqual((await srv.api("DELETE", "/api/account", { dir: personal })).json, { hidden: true });
  assert.equal(await srv.session(s.id), undefined);
  assert.equal((await srv.api("GET", "/api/accounts")).json.find((x) => x.dir === personal).hidden, true);
  await srv.api("PATCH", "/api/account", { dir: personal, hidden: false });
  assert.ok(await srv.session(s.id));
});

test("a folder added by hand is scanned, and removing it forgets it", async () => {
  const extra = addAccount(w, "elsewhere", { scanned: false });
  const s = addSession(w, { claude: extra, turns: [{ user: "a" }] });
  srv = await startServer(w);
  assert.equal(await srv.session(s.id), undefined);
  assert.equal((await srv.api("POST", "/api/accounts", { dir: path.join(w.root, "missing") })).status, 400);
  assert.deepEqual((await srv.api("POST", "/api/accounts", { dir: extra })).json, { dir: extra });
  assert.equal((await srv.session(s.id)).account, extra);
  assert.deepEqual((await srv.api("DELETE", "/api/account", { dir: extra })).json, { removed: true });
  assert.deepEqual((await srv.api("GET", "/api/accounts")).json.map((x) => x.dir), [w.claude]);
});

test("transfer copies the session into the other account and keeps its notes and status", async () => {
  const personal = addAccount(w, "claude-personal");
  const s = addSession(w, { turns: [{ user: "started with the wrong account" }] });
  const extras = addExtras(w.claude, s);
  srv = await startServer(w);
  await srv.api("PATCH", `/api/session/${s.id}`, { status: "doing", note: "carry me" });
  const r = await srv.api("POST", `/api/transfer/${s.id}`, { to: personal });
  assert.deepEqual(r.json, { account: personal, removed: false });
  const dest = path.join(personal, path.relative(w.claude, s.file));
  assert.equal(fs.readFileSync(dest, "utf8"), fs.readFileSync(s.file, "utf8"));
  for (const x of extras) assert.ok(fs.existsSync(path.join(personal, x)), x);
  const row = await srv.session(s.id);
  assert.deepEqual([row.account, row.alsoIn, row.status, row.note], [personal, [w.claude], "doing", "carry me"]);
  assert.equal(row.prompts, 1);
});

test("transfer with remove deletes the source", async () => {
  const personal = addAccount(w, "claude-personal");
  const s = addSession(w, { turns: [{ user: "a" }] });
  const extras = addExtras(w.claude, s);
  srv = await startServer(w);
  assert.deepEqual((await srv.api("POST", `/api/transfer/${s.id}`, { to: personal, remove: true })).json, { account: personal, removed: true });
  assert.ok(!fs.existsSync(s.file));
  for (const x of extras) assert.ok(!fs.existsSync(path.join(w.claude, x)), x);
  const row = await srv.session(s.id);
  assert.deepEqual([row.account, row.alsoIn, row.transcript], [personal, [], true]);
});

test("the copy written last is the session: going on in the source brings it back there", async () => {
  const personal = addAccount(w, "claude-personal");
  const s = addSession(w, { turns: [{ user: "a" }] });
  srv = await startServer(w);
  await srv.api("POST", `/api/transfer/${s.id}`, { to: personal });
  await new Promise((r) => setTimeout(r, 20));
  appendTurns(s, [{ user: "b" }]);
  const row = await srv.session(s.id);
  assert.deepEqual([row.account, row.alsoIn, row.prompts], [w.claude, [personal], 2]);
});

test("transfer refuses an open session, the same account, and a target copy that has moved on", async () => {
  const personal = addAccount(w, "claude-personal");
  const open = addSession(w, { turns: [{ user: "a" }] });
  addLive(w, open);
  const s = addSession(w, { turns: [{ user: "a" }] });
  srv = await startServer(w);
  assert.equal((await srv.api("POST", `/api/transfer/${open.id}`, { to: personal })).status, 409);
  assert.ok(!fs.existsSync(path.join(personal, path.relative(w.claude, open.file))));
  assert.equal((await srv.api("POST", `/api/transfer/${s.id}`, { to: w.claude })).status, 400);
  assert.equal((await srv.api("POST", `/api/transfer/${s.id}`, { to: "/nope" })).status, 400);

  await srv.api("POST", `/api/transfer/${s.id}`, { to: personal });
  const dest = path.join(personal, path.relative(w.claude, s.file));
  await new Promise((r) => setTimeout(r, 20));
  appendTurns({ ...s, file: dest }, [{ user: "went on in personal" }]);
  const r = await srv.api("POST", `/api/transfer/${s.id}`, { to: personal });
  assert.equal(r.status, 400, "the newer copy is the session now, so personal is its own account");
  const back = await srv.api("POST", `/api/transfer/${s.id}`, { to: w.claude });
  assert.deepEqual(back.json, { account: w.claude, removed: false }, "the older source is overwritten by the newer copy");
});
