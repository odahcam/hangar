// The SessionStart hook, per account: installed in and removed from the account's settings.json beside the person's
// own settings and hooks, and the helper it runs noting the session on the hc terminal claude runs in.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { BIN, RESUME, WIN32, makeWorld, calls, startServer, cleanup } = require("./helpers");

let w, srv, hcFile;
beforeEach(() => { w = makeWorld(); hcFile = path.join(w.root, "hc.json"); fs.writeFileSync(hcFile, "[]"); });
afterEach(async () => { await srv?.stop(); srv = null; cleanup(w); });

const HC = path.join(BIN, "hc.js");
const settingsFile = () => path.join(w.claude, "settings.json");
const settings = () => JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
const hookOn = async () => (await srv.api("GET", "/api/accounts")).json.find((a) => a.dir === w.claude).sessionStartHook;
const setHook = (on) => srv.api("PATCH", "/api/account", { dir: w.claude, sessionStartHook: on });
const ours = () => (settings().hooks?.SessionStart ?? []).flatMap((g) => g.hooks).filter((h) => h.command.includes("--session-start"));
const start = () => startServer(w, { HANGAR_HC: HC, FAKE_HC: hcFile });
const terms = () => JSON.parse(fs.readFileSync(hcFile, "utf8"));

const mine = { hooks: [{ type: "command", command: "my-start-hook" }] };

test("the hook goes into the account's settings.json beside its other settings and hooks, and comes out alone", async () => {
  fs.writeFileSync(settingsFile(), JSON.stringify({ model: "opus", hooks: { SessionStart: [mine], Stop: [mine] } }));
  srv = await start();
  assert.equal(await hookOn(), false);
  assert.deepEqual((await setHook(true)).json, { ok: true });
  assert.equal(await hookOn(), true);
  const s = settings();
  assert.equal(s.model, "opus");
  assert.deepEqual(s.hooks.Stop, [mine]);
  assert.deepEqual(s.hooks.SessionStart[0], mine);
  assert.equal(ours().length, 1);
  assert.equal(ours()[0].type, "command");
  assert.ok(ours()[0].command.includes(path.basename(RESUME)), ours()[0].command);
  // Twice is still once.
  await setHook(true);
  assert.equal(ours().length, 1);
  await setHook(false);
  assert.equal(await hookOn(), false);
  assert.deepEqual(settings(), { model: "opus", hooks: { SessionStart: [mine], Stop: [mine] } });
});

test("removing the hook from a settings.json that only had it leaves no empty hooks behind", async () => {
  srv = await start();
  await setHook(true);
  assert.equal(ours().length, 1);
  await setHook(false);
  assert.deepEqual(settings(), {});
});

test("a hook of Hangar's from another install is replaced, not added to", async () => {
  const old = { hooks: [{ type: "command", command: "'/Old/Hangar.app/Contents/MacOS/hangar-resume' --session-start" }] };
  fs.writeFileSync(settingsFile(), JSON.stringify({ hooks: { SessionStart: [old] } }));
  srv = await start();
  assert.equal(await hookOn(), true);
  await setHook(true);
  assert.equal(ours().length, 1);
  assert.ok(!ours()[0].command.includes("/Old/"));
});

test("settings.json keeps its mode, a new one is the owner's alone, and a symlinked one stays a link", { skip: WIN32 }, async () => {
  srv = await start();
  await setHook(true);
  assert.equal(fs.statSync(settingsFile()).mode & 0o777, 0o600);
  fs.chmodSync(settingsFile(), 0o640);
  await setHook(false);
  assert.equal(fs.statSync(settingsFile()).mode & 0o777, 0o640);
  // Kept in a dotfiles folder, linked from the account.
  const real = path.join(w.root, "dotfiles-settings.json");
  fs.writeFileSync(real, JSON.stringify({ model: "opus" }));
  fs.chmodSync(real, 0o600);
  fs.rmSync(settingsFile());
  fs.symlinkSync(real, settingsFile());
  await setHook(true);
  assert.ok(fs.lstatSync(settingsFile()).isSymbolicLink());
  assert.equal(JSON.parse(fs.readFileSync(real, "utf8")).model, "opus");
  assert.equal(ours().length, 1);
  assert.equal(fs.statSync(real).mode & 0o777, 0o600);
});

test("an unreadable settings.json is left alone", async () => {
  fs.writeFileSync(settingsFile(), "{ not json");
  srv = await start();
  const r = await setHook(true);
  assert.deepEqual([r.status, r.json.error], [409, "settings_unreadable"]);
  assert.equal(fs.readFileSync(settingsFile(), "utf8"), "{ not json");
  assert.equal((await srv.api("PATCH", "/api/account", { dir: w.claude, sessionStartHook: "yes" })).status, 400);
});

test("with the herdr integration off the hook isn't installed, and turning it off removes the installed ones", async () => {
  fs.writeFileSync(settingsFile(), JSON.stringify({ hooks: { SessionStart: [mine] } }));
  srv = await start();
  await setHook(true);
  await srv.api("PATCH", "/api/herdr", { enabled: false });
  assert.equal(await hookOn(), false);
  assert.deepEqual(settings(), { hooks: { SessionStart: [mine] } });
  const r = await setHook(true);
  assert.deepEqual([r.status, r.json.error], [409, "herdr_off"]);
  assert.equal(await hookOn(), false);
  await srv.api("PATCH", "/api/herdr", { enabled: true });
  assert.deepEqual((await setHook(true)).json, { ok: true });
});

test("the hook calls the hc set in Settings, and follows it when it changes", async () => {
  srv = await start();
  await setHook(true);
  assert.ok(!ours()[0].command.includes("--hc"));
  await srv.api("PATCH", "/api/herdr", { hcPath: "/opt/hc" });
  assert.match(ours()[0].command, /--hc ['"]\/opt\/hc['"]$/);
  await srv.api("PATCH", "/api/herdr", { hcPath: "" });
  assert.ok(!ours()[0].command.includes("--hc"));
});

// --- the helper the hook runs
const id = crypto.randomUUID();
const runHook = (env, input = JSON.stringify({ session_id: id, source: "startup" })) =>
  spawnSync(RESUME, ["--session-start"], { input, encoding: "utf8", env: { ...process.env, HANGAR_HC: HC, FAKE_HC: hcFile, FAKE_LOG: w.log, ...env } });

test("the helper notes the session and the terminal's pid on the hc terminal claude runs in, printing nothing", () => {
  fs.writeFileSync(hcFile, JSON.stringify([{ address: "t1", pid: 4242, fg: 5000, labels: { other: "x" } }]));
  const r = runHook({ HC_TERMINAL_ID: "t1" });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
  assert.deepEqual(terms()[0].labels, { other: "x", "hangar.session": id, "hangar.pid": "4242" });
});

test("outside an hc terminal, with a session id that isn't one, or a terminal hc doesn't know, the helper does nothing", () => {
  fs.writeFileSync(hcFile, JSON.stringify([{ address: "t1", pid: 4242, fg: 5000, labels: {} }]));
  const env = { ...process.env };
  delete env.HC_TERMINAL_ID;
  const outside = spawnSync(RESUME, ["--session-start"], { input: JSON.stringify({ session_id: id }), encoding: "utf8", env: { ...env, HANGAR_HC: HC, FAKE_HC: hcFile, FAKE_LOG: w.log } });
  assert.deepEqual([outside.status, outside.stdout], [0, ""]);
  assert.equal(calls(w, "hc").length, 0);
  for (const r of [runHook({ HC_TERMINAL_ID: "t1" }, JSON.stringify({ session_id: "../x" })), runHook({ HC_TERMINAL_ID: "t1" }, "not json"), runHook({ HC_TERMINAL_ID: "t9" })]) {
    assert.deepEqual([r.status, r.stdout], [0, ""]);
  }
  assert.deepEqual(terms()[0].labels, {});
});

test("the helper calls the hc given with --hc", () => {
  fs.writeFileSync(hcFile, JSON.stringify([{ address: "t1", pid: 4242, fg: 5000, labels: {} }]));
  const env = { ...process.env, HC_TERMINAL_ID: "t1", FAKE_HC: hcFile, FAKE_LOG: w.log };
  delete env.HANGAR_HC;
  const r = spawnSync(RESUME, ["--session-start", "--hc", HC], { input: JSON.stringify({ session_id: id }), encoding: "utf8", env });
  assert.equal(r.status, 0);
  assert.equal(terms()[0].labels["hangar.session"], id);
});

// The command as installed, run the way Claude Code runs hooks: in a POSIX shell (Git Bash on Windows).
const SH = WIN32 ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe") : "/bin/sh";
test("the installed command runs in a shell and notes the session", { skip: !fs.existsSync(SH) }, async () => {
  fs.writeFileSync(hcFile, JSON.stringify([{ address: "t1", pid: 4242, fg: 5000, labels: {} }]));
  srv = await start();
  await srv.api("PATCH", "/api/herdr", { hcPath: HC });
  await setHook(true);
  const env = { ...process.env, HC_TERMINAL_ID: "t1", FAKE_HC: hcFile, FAKE_LOG: w.log };
  delete env.HANGAR_HC;
  const r = spawnSync(SH, ["-c", ours()[0].command], { input: JSON.stringify({ session_id: id }), encoding: "utf8", env });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
  assert.equal(terms()[0].labels["hangar.session"], id);
});
