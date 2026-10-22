// Session state (status, notes, order), first-run seeding and the HTTP guards.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { DAY, makeWorld, addSession, startServer, cleanup } = require("./helpers");

let w, srv;
beforeEach(() => { w = makeWorld(); });
afterEach(async () => { await srv?.stop(); srv = null; cleanup(w); });

test("new sessions start pending and untriaged", async () => {
  const s = addSession(w, { turns: [{ user: "a" }] });
  srv = await startServer(w);
  const row = await srv.session(s.id);
  assert.equal(row.status, "todo");
  assert.equal(row.priority, null);
  assert.equal(row.note, "");
});

test("first run marks sessions idle for 14+ days as done, only once", async () => {
  const old = addSession(w, { endAgo: 20 * DAY, turns: [{ user: "old" }] });
  const recent = addSession(w, { endAgo: 2 * DAY, turns: [{ user: "recent" }] });
  srv = await startServer(w);
  assert.equal((await srv.session(old.id)).status, "done");
  assert.equal((await srv.session(old.id)).doneBy, "seed");
  assert.equal((await srv.session(recent.id)).status, "todo");

  await srv.api("PATCH", `/api/session/${old.id}`, { status: "todo" });
  const later = addSession(w, { endAgo: 30 * DAY, turns: [{ user: "found later" }] });
  await srv.stop();
  srv = await startServer(w);
  assert.equal((await srv.session(old.id)).status, "todo", "reopened session stays reopened");
  assert.equal((await srv.session(later.id)).status, "todo", "seeding does not run again");
});

test("status changes record when and how a session was done", async () => {
  const s = addSession(w, { turns: [{ user: "a" }] });
  srv = await startServer(w);
  assert.equal((await srv.api("PATCH", `/api/session/${s.id}`, { status: "doing" })).status, 200);
  assert.equal((await srv.session(s.id)).status, "doing");

  await srv.api("PATCH", `/api/session/${s.id}`, { status: "done" });
  let row = await srv.session(s.id);
  assert.equal(row.doneBy, "user");
  assert.ok(Date.now() - new Date(row.doneAt) < 60000);

  await srv.api("PATCH", `/api/session/${s.id}`, { status: "done", via: "suggestion" });
  assert.equal((await srv.session(s.id)).doneBy, "suggestion");

  await srv.api("PATCH", `/api/session/${s.id}`, { status: "todo" });
  row = await srv.session(s.id);
  assert.equal(row.doneAt, null);
  assert.equal(row.doneBy, null);
});

test("ignores unknown statuses", async () => {
  const s = addSession(w, { turns: [{ user: "a" }] });
  srv = await startServer(w);
  await srv.api("PATCH", `/api/session/${s.id}`, { status: "archived" });
  assert.equal((await srv.session(s.id)).status, "todo");
});

test("notes are saved and survive a restart", async () => {
  const s = addSession(w, { turns: [{ user: "a" }] });
  srv = await startServer(w);
  await srv.api("PATCH", `/api/session/${s.id}`, { note: "stopped at step 3" });
  await srv.stop();
  srv = await startServer(w);
  assert.equal((await srv.session(s.id)).note, "stopped at step 3");
});

test("order sets priorities 10, 20, 30… in the given order", async () => {
  const [a, b, c] = ["a", "b", "c"].map((x) => addSession(w, { turns: [{ user: x }] }));
  srv = await startServer(w);
  assert.equal((await srv.api("POST", "/api/order", { ids: [c.id, a.id, b.id] })).status, 200);
  assert.deepEqual([c, a, b].map((x) => x.id), (await srv.sessions()).filter((s) => s.priority != null).sort((x, y) => x.priority - y.priority).map((s) => s.id));
  assert.equal((await srv.session(c.id)).priority, 10);
  assert.equal((await srv.session(b.id)).priority, 30);
});

test("order rejects anything that is not a list of session ids", async () => {
  srv = await startServer(w);
  assert.equal((await srv.api("POST", "/api/order", { ids: ["nope"] })).status, 400);
  assert.equal((await srv.api("POST", "/api/order", { ids: "x" })).status, 400);
});

test("unknown session ids are 404, malformed ids 400", async () => {
  srv = await startServer(w);
  assert.equal((await srv.api("PATCH", "/api/session/00000000-0000-0000-0000-000000000000", { status: "done" })).status, 404);
  assert.equal((await srv.api("PATCH", "/api/session/not-a-uuid", { status: "done" })).status, 400);
  assert.equal((await srv.api("POST", "/api/resume/00000000-0000-0000-0000-000000000000")).status, 404);
});

test("invalid JSON bodies are 400", async () => {
  const s = addSession(w, { turns: [{ user: "a" }] });
  srv = await startServer(w);
  const r = await srv.api("PATCH", `/api/session/${s.id}`, "{nope");
  assert.equal(r.status, 400);
  assert.equal(r.json.error, "invalid_json");
});

test("mutations without the x-hangar header are refused (CSRF)", async () => {
  const s = addSession(w, { turns: [{ user: "a" }] });
  srv = await startServer(w);
  const r = await srv.api("PATCH", `/api/session/${s.id}`, { status: "done" }, { "x-hangar": "" });
  assert.equal(r.status, 403);
  assert.equal((await srv.session(s.id)).status, "todo");
});

test("requests for another Host are refused (DNS rebinding)", async () => {
  srv = await startServer(w);
  const http = require("node:http");
  const status = await new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: srv.port, path: "/api/sessions", headers: { host: "evil.example:80" } }, (res) => resolve(res.statusCode));
  });
  assert.equal(status, 403);
});

test("serves the UI files and nothing else", async () => {
  srv = await startServer(w);
  const page = await srv.api("GET", "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(page.text, /<title>Hangar<\/title>/);
  for (const p of ["/i18n.js", "/icon.svg", "/icon-512.png", "/manifest.webmanifest"]) {
    assert.equal((await srv.api("GET", p)).status, 200, p);
  }
  assert.equal((await srv.api("GET", "/../server/server.js")).status, 404);
  assert.equal((await srv.api("GET", "/api/nope")).status, 404);
});
