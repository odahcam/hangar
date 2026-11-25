// herdr-core terminals (through a fake hc): which session runs in which terminal, and the sessions a restart lost
// typed back into their recovered terminal's shell.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { BIN, RESUME, makeWorld, addSession, addLive, calls, startServer, cleanup, waitFor } = require("./helpers");

let w, srv, hcFile;
beforeEach(() => { w = makeWorld(); hcFile = path.join(w.root, "hc.json"); });
afterEach(async () => { await srv?.stop(); srv = null; cleanup(w); });

const SESSION = "hangar.session", PID = "hangar.pid";
const setTerms = (terms) => fs.writeFileSync(hcFile, JSON.stringify(terms));
const terms = () => JSON.parse(fs.readFileSync(hcFile, "utf8"));
// The server types into hc's terminals from a thread of its own only when HANGAR_HC names one.
const start = () => startServer(w, { HANGAR_HC: path.join(BIN, "hc.js"), FAKE_HC: hcFile, HC_TERMINAL_ID: "t99" });
const sends = () => calls(w, "hc").filter((c) => c.args[0] === "send");
// The world's account isn't the default one: the line names it.
const lineFor = (s) => `cd '${s.cwd}' && '${RESUME}' '${s.id}' '--config' '${w.claude}'`;

test("the session running in a terminal is noted on it, with the terminal's pid", async () => {
  const s = addSession(w, { cwd: "/w/acme/api", turns: [{ user: "a" }] });
  addLive(w, s);
  // The claude runs under the terminal's program: this test's process stands for it.
  setTerms([{ address: "t1", pid: process.pid, fg: process.pid, labels: {} }]);
  srv = await start();
  await waitFor(() => terms()[0].labels[SESSION] === s.id);
  assert.equal(terms()[0].labels[PID], String(process.pid));
  assert.ok(calls(w, "hc").every((c) => !c.identity), "hc is called as the user, not as the terminal Hangar came from");
});

test("a terminal whose claude exited loses its note, and nothing is typed into it", async () => {
  const s = addSession(w, { cwd: "/w/acme/api", turns: [{ user: "a" }] });
  setTerms([{ address: "t1", pid: 4242, fg: 4242, labels: { [SESSION]: s.id, [PID]: "4242" } }]);
  srv = await start();
  await waitFor(() => !terms()[0].labels[SESSION]);
  assert.equal(sends().length, 0);
});

test("a recovered terminal gets its session's resume line typed into its shell, once", async () => {
  const s = addSession(w, { cwd: "/w/acme/api", turns: [{ user: "a" }] });
  setTerms([{ address: "t1", pid: 4242, fg: 4242, labels: { [SESSION]: s.id, [PID]: "1" } }]);
  srv = await start();
  await waitFor(() => sends().length);
  assert.deepEqual(sends()[0].args, ["send", "t1", lineFor(s)]);
  // The note now carries the new pid: a resume that didn't take leaves a shell that isn't typed into again.
  assert.equal(terms()[0].labels[PID], "4242");
});

test("a recovered terminal running something else, or another machine's, is left alone", async () => {
  const s = addSession(w, { cwd: "/w/acme/api", turns: [{ user: "a" }] });
  setTerms([
    { address: "t1", pid: 4242, fg: 5000, labels: { [SESSION]: s.id, [PID]: "1" } },
    { address: "mac/t2", pid: 4343, fg: 4343, labels: { [SESSION]: s.id, [PID]: "1" } },
  ]);
  srv = await start();
  const st = (await srv.api("GET", "/api/herdr")).json;
  assert.deepEqual([st.available, st.restorable], [true, []]);
  assert.equal(sends().length, 0);
});

test("Resume and the global restore type into the recovered terminal instead of opening a tab", async () => {
  const s = addSession(w, { cwd: "/w/acme/api", turns: [{ user: "a" }] });
  // Restoring waits to be asked for: the calls below find it recovered.
  setTerms([{ address: "t1", pid: 4242, fg: 5000, labels: { [SESSION]: s.id, [PID]: "1" } }]);
  srv = await start();
  await srv.api("PATCH", "/api/herdr", { auto: false });
  setTerms([{ address: "t1", pid: 4242, fg: 4242, labels: { [SESSION]: s.id, [PID]: "1" } }]);
  assert.deepEqual((await srv.api("GET", "/api/herdr")).json.restorable, [{ terminal: "t1", session: s.id }]);
  assert.deepEqual((await srv.api("POST", `/api/resume/${s.id}`)).json, { restored: "t1" });
  assert.deepEqual(sends().map((c) => c.args[2]), [lineFor(s)]);
  assert.ok(!calls(w).some((c) => c.bin === "osascript" || c.bin === "wt"), "no terminal tab opened");

  setTerms([{ address: "t1", pid: 4242, fg: 4242, labels: { [SESSION]: s.id, [PID]: "1" } }]);
  const r = await srv.api("POST", "/api/restore-herdr");
  assert.deepEqual(r.json, { restored: [{ terminal: "t1", session: s.id }], failed: [] });
  assert.equal(sends().length, 2);
});

test("a session that started after the last scan is restored too", async () => {
  setTerms([]);
  srv = await start();
  const s = addSession(w, { cwd: "/w/acme/api", turns: [{ user: "a" }] });
  setTerms([{ address: "t1", pid: 4242, fg: 4242, labels: { [SESSION]: s.id, [PID]: "1" } }]);
  // The background pass may get to it first; either way it is typed once.
  const r = await srv.api("POST", "/api/restore-herdr");
  assert.deepEqual(r.json.failed, []);
  await waitFor(() => sends().length);
  assert.deepEqual(sends().map((c) => c.args[2]), [lineFor(s)]);
});

test("the background pass and the global button racing type the line once", async () => {
  const s = addSession(w, { cwd: "/w/acme/api", turns: [{ user: "a" }] });
  setTerms([{ address: "t1", pid: 4242, fg: 4242, labels: { [SESSION]: s.id, [PID]: "1" } }]);
  srv = await start();
  await Promise.all([1, 2, 3].map(() => srv.api("POST", "/api/restore-herdr")));
  await waitFor(() => sends().length);
  assert.equal(sends().length, 1);
});

test("a program opened in the shell while the line is made ready doesn't get it", async () => {
  const s = addSession(w, { cwd: "/w/acme/api", turns: [{ user: "a" }] });
  setTerms([{ address: "t1", pid: 4242, fg: 5000, labels: { [SESSION]: s.id, [PID]: "1" } }]);
  srv = await start();
  // The background pass would otherwise get to the terminal first and take the failure for itself.
  await srv.api("PATCH", "/api/herdr", { auto: false });
  setTerms([{ address: "t1", pid: 4242, fg: 4242, busyOnLabel: 6000, labels: { [SESSION]: s.id, [PID]: "1" } }]);
  const r = await srv.api("POST", "/api/restore-herdr");
  assert.deepEqual(r.json.failed, [{ terminal: "t1", session: s.id, error: "the shell is no longer at its prompt" }]);
  assert.equal(sends().length, 0);
});

test("restoring only when asked: the background pass leaves a recovered terminal to the button", async () => {
  const s = addSession(w, { cwd: "/w/acme/api", turns: [{ user: "a" }] });
  setTerms([]);
  srv = await start();
  assert.deepEqual((await srv.api("PATCH", "/api/herdr", { auto: false })).json, { ok: true });
  setTerms([{ address: "t1", pid: 4242, fg: 4242, labels: { [SESSION]: s.id, [PID]: "1" } }]);
  const gets = () => calls(w, "hc").filter((c) => c.args[0] === "get").length;
  const before = gets();
  await waitFor(() => gets() > before, { timeout: 20000 });
  assert.equal(sends().length, 0);
  assert.equal(terms()[0].labels[PID], "1", "the note stays for the button");
  const st = (await srv.api("GET", "/api/herdr")).json;
  assert.equal(st.auto, false);
  assert.deepEqual(st.restorable, [{ terminal: "t1", session: s.id }]);
  assert.deepEqual((await srv.api("POST", "/api/restore-herdr")).json.restored, [{ terminal: "t1", session: s.id }]);
  assert.deepEqual(sends().map((c) => c.args[2]), [lineFor(s)]);
});

test("with the integration off, the notes go, nothing is typed and Resume opens a tab", async () => {
  const s = addSession(w, { cwd: "/w/acme/api", turns: [{ user: "a" }] });
  setTerms([{ address: "t1", pid: 4242, fg: 5000, labels: { [SESSION]: s.id, [PID]: "1" } }]);
  srv = await start();
  await srv.api("PATCH", "/api/herdr", { enabled: false });
  assert.deepEqual(terms()[0].labels, {});
  setTerms([{ address: "t1", pid: 4242, fg: 4242, labels: { [SESSION]: s.id, [PID]: "1" } }]);
  const st = (await srv.api("GET", "/api/herdr")).json;
  assert.deepEqual([st.enabled, st.available, st.restorable], [false, false, []]);
  assert.equal((await srv.api("POST", "/api/restore-herdr")).status, 409);
  assert.notDeepEqual((await srv.api("POST", `/api/resume/${s.id}`)).json, { restored: "t1" });
  assert.equal(sends().length, 0);
  assert.ok(calls(w).some((c) => c.bin === "osascript" || c.bin === "wt"), "a terminal tab opened");
});

test("the hc path set in Settings is the hc called", async () => {
  const s = addSession(w, { cwd: "/w/acme/api", turns: [{ user: "a" }] });
  setTerms([{ address: "t1", pid: 4242, fg: 4242, labels: { [SESSION]: s.id, [PID]: "1" } }]);
  // No HANGAR_HC, and a test world doesn't look for the user's hc: none until the path is set.
  srv = await startServer(w, { FAKE_HC: hcFile });
  assert.equal((await srv.api("GET", "/api/herdr")).json.available, false);
  const bin = path.join(BIN, "hc.js");
  await srv.api("PATCH", "/api/herdr", { hcPath: ` ${bin} ` });
  const st = (await srv.api("GET", "/api/herdr")).json;
  assert.deepEqual([st.hcPath, st.hc, st.available, st.restorable], [bin, bin, true, [{ terminal: "t1", session: s.id }]]);
  assert.deepEqual((await srv.api("POST", "/api/restore-herdr")).json.restored, [{ terminal: "t1", session: s.id }]);
  assert.equal((await srv.api("PATCH", "/api/herdr", { enabled: "no" })).status, 400);
});

test("a shell it can't type into is reported, not typed into", async () => {
  const s = addSession(w, { cwd: "/w/acme/api", turns: [{ user: "a" }] });
  setTerms([{ address: "t1", pid: 4242, fg: 5000, labels: { [SESSION]: s.id, [PID]: "1" } }]);
  srv = await start();
  await srv.api("PATCH", "/api/herdr", { auto: false });
  setTerms([{ address: "t1", pid: 4242, fg: 4242, fgName: "fish", labels: { [SESSION]: s.id, [PID]: "1" } }]);
  const r = await srv.api("POST", "/api/restore-herdr");
  assert.deepEqual(r.json.failed, [{ terminal: "t1", session: s.id, error: "unsupported shell fish" }]);
  assert.equal(sends().length, 0);
});
