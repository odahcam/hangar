// What a paired device may ask of this machine (handle_remote): nothing until remote control is on here, then only the
// session list and the actions on a session, each one logged with the device that asked.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { makeWorld, addSession, startServer, cleanup, calls } = require("./helpers");

let w, srv;
beforeEach(() => { w = makeWorld(); });
afterEach(async () => { await srv?.stop(); srv = null; cleanup(w); });

const DEVICE = "A".repeat(43);
const remote = (method, p, body) => srv.api(method, p, body, { "x-hangar-remote-device": DEVICE });

test("remote control is off until this machine turns it on", async () => {
  addSession(w, { turns: [{ user: "a" }] });
  srv = await startServer(w, { HANGAR_TEST_REMOTE: "1" });
  assert.deepEqual((await remote("GET", "/api/sessions")).json, { error: "remote_off" });
  assert.equal((await srv.api("GET", "/api/remote")).json.enabled, false);
  await srv.api("PATCH", "/api/remote", { enabled: true });
  const r = await remote("GET", "/api/sessions");
  assert.equal(r.status, 200);
  assert.equal(r.json.length, 1);
});

test("a paired device reaches the sessions, never accounts, transfers, the classifier or the switch", async () => {
  const s = addSession(w, { turns: [{ user: "a" }] });
  srv = await startServer(w, { HANGAR_TEST_REMOTE: "1" });
  await srv.api("PATCH", "/api/remote", { enabled: true });
  assert.equal((await remote("PATCH", `/api/session/${s.id}`, { note: "from afar" })).status, 200);
  assert.equal((await srv.session(s.id)).note, "from afar");
  const forbidden = [
    ["POST", "/api/accounts", { dir: w.root }],
    ["PATCH", "/api/account", { dir: w.claude, name: "x" }],
    ["DELETE", "/api/account", { dir: w.claude }],
    ["POST", `/api/transfer/${s.id}`, { to: w.claude }],
    ["POST", "/api/classify"],
    ["PATCH", "/api/classifier", { account: "own" }],
    ["PATCH", "/api/remote", { enabled: false }],
    ["GET", "/api/remote"],
    ["POST", "/api/close-idle-tabs"],
    ["GET", "/api/insights"],
  ];
  for (const [m, p, b] of forbidden) assert.deepEqual((await remote(m, p, b)).json, { error: "remote_forbidden" }, `${m} ${p}`);
  assert.equal((await srv.api("GET", "/api/remote")).json.enabled, true);
  assert.deepEqual(calls(w, "claude"), []);
});

test("remote changes and refusals are logged with their device; reads are counted, not logged", async () => {
  const s = addSession(w, { turns: [{ user: "a" }] });
  srv = await startServer(w, { HANGAR_TEST_REMOTE: "1" });
  await remote("GET", "/api/sessions");
  await srv.api("PATCH", "/api/remote", { enabled: true });
  await remote("PATCH", `/api/session/${s.id}`, { status: "doing" });
  for (let i = 0; i < 3; i++) await remote("GET", "/api/sessions");
  await remote("POST", "/api/classify");
  await remote("POST", "/api/" + "x".repeat(500));
  const { log, reads } = (await srv.api("GET", "/api/remote")).json;
  assert.deepEqual(log.map((e) => [e.device, e.method, e.path.slice(0, 13), e.status]), [
    [DEVICE, "POST", "/api/xxxxxxxx", 403],
    [DEVICE, "POST", "/api/classify", 403],
    [DEVICE, "PATCH", `/api/session/`, 200],
    [DEVICE, "GET", "/api/sessions", 403],
  ]);
  assert.equal(log[0].path.length, 120);
  assert.deepEqual(reads.map((r) => [r.device, r.count]), [[DEVICE, 3]]);
});

test("the remote header means nothing without the test switch", async () => {
  srv = await startServer(w);
  assert.equal((await remote("GET", "/api/remote")).status, 200);
  assert.deepEqual((await srv.api("GET", "/api/remote")).json.log, []);
});
