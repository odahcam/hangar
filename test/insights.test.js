// Insights payload: totals, pending by project and age, activity, weekly counts, top lists, storage, open sessions.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { HOUR, DAY, makeWorld, addSession, addLive, setTabs, startServer, cleanup } = require("./helpers");

let w, srv;
beforeEach(() => { w = makeWorld(); });
afterEach(async () => { await srv?.stop(); srv = null; cleanup(w); });

const insights = async () => (await srv.api("GET", "/api/insights")).json;

test("totals count pending, untriaged, done and open sessions", async () => {
  const [a, b, c] = ["a", "b", "c"].map((x) => addSession(w, { turns: [{ user: x }, { assistant: "ok", usage: { output_tokens: 100 } }] }));
  addLive(w, c);
  srv = await startServer(w);
  await srv.api("POST", "/api/order", { ids: [a.id] });
  await srv.api("PATCH", `/api/session/${b.id}`, { status: "done" });
  const { totals } = await insights();
  assert.equal(totals.pending, 2);
  assert.equal(totals.untriaged, 1);
  assert.equal(totals.done, 1);
  assert.equal(totals.live, 1);
  assert.equal(totals.sessions, 3);
  assert.equal(totals.tokensOut, 300);
});

test("pending sessions are bucketed by project and age of last activity", async () => {
  addSession(w, { cwd: "/w/acme/api", endAgo: 2 * HOUR, turns: [{ user: "a" }] });
  addSession(w, { cwd: "/w/acme/api", endAgo: 3 * DAY, turns: [{ user: "b" }] });
  addSession(w, { cwd: "/w/acme/api", endAgo: 10 * DAY, turns: [{ user: "c" }] });
  addSession(w, { cwd: "/w/side/blog", endAgo: 2 * HOUR, turns: [{ user: "d" }] });
  srv = await startServer(w);
  const { byProject } = await insights();
  assert.deepEqual(byProject[0], { project: "acme/api", d1: 1, d7: 1, d14: 1, older: 0, total: 3 });
  assert.deepEqual(byProject[1], { project: "side/blog", d1: 1, d7: 0, d14: 0, older: 0, total: 1 });
});

test("activity counts human prompts per local day for the last 30 days", async () => {
  addSession(w, { endAgo: 2 * HOUR, turns: [{ user: "a" }, { assistant: "x" }, { user: "b" }] });
  addSession(w, { endAgo: 40 * DAY, turns: [{ user: "too old" }] });
  srv = await startServer(w);
  const { activity } = await insights();
  assert.equal(activity.reduce((n, d) => n + d.n, 0), 2);
  assert.ok(activity.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day)));
});

test("weekly counts: new sessions by first activity, done only when marked by the user", async () => {
  addSession(w, { endAgo: 2 * HOUR, turns: [{ user: "new this week" }] });
  const old = addSession(w, { endAgo: 20 * DAY, turns: [{ user: "seeded done" }] });
  const mine = addSession(w, { endAgo: 2 * HOUR, turns: [{ user: "done by me" }] });
  srv = await startServer(w);
  await srv.api("PATCH", `/api/session/${mine.id}`, { status: "done" });
  const { weeks } = await insights();
  assert.equal(weeks.length, 8);
  const thisWeek = weeks.at(-1);
  assert.equal(thisWeek.created, 2);
  assert.equal(thisWeek.done, 1, "the first-run seed does not count as done this week");
  assert.equal((await srv.session(old.id)).doneBy, "seed");
});

test("top lists rank by prompts and by tokens generated, 10 at most", async () => {
  for (let i = 1; i <= 12; i++) {
    const turns = [];
    for (let j = 0; j < i; j++) turns.push({ user: `p${j}` });
    turns.push({ assistant: "ok", usage: { output_tokens: 1000 * (13 - i) } });
    addSession(w, { agentName: `s${i}`, turns });
  }
  srv = await startServer(w);
  const { topPrompts, topTokens } = await insights();
  assert.equal(topPrompts.length, 10);
  assert.equal(topPrompts[0].title, "s12");
  assert.equal(topPrompts[0].prompts, 12);
  assert.equal(topTokens[0].title, "s1");
  assert.equal(topTokens[0].tokensOut, 12000);
});

test("storage reports sizes, backups and nothing pending without backup", async () => {
  addSession(w, { turns: [{ user: "a" }] });
  srv = await startServer(w);
  const { storage } = await insights();
  assert.equal(storage.pendingWithoutBackup.length, 0);
  assert.equal(storage.expiringSoon.length, 0);
  assert.equal(typeof storage.transcriptsMb, "number");
  assert.equal(typeof storage.backupMb, "number");
});

test("open sessions report memory and idle hours; idle tabs are listed", async () => {
  const s = addSession(w, { agentName: "open one", endAgo: 30 * HOUR, turns: [{ user: "a" }] });
  addLive(w, s);
  setTabs(w, [{ tty: "ttys009", busy: false }, { tty: "ttys010", busy: true }]);
  srv = await startServer(w);
  const { memory, idleTabs } = await insights();
  assert.equal(memory.sessions.length, 1);
  assert.equal(memory.sessions[0].title, "open one");
  assert.ok(memory.sessions[0].idleHours >= 30);
  assert.ok(memory.sessions[0].mb >= 0);
  assert.ok(memory.ramTotalMb > 0);
  assert.deepEqual(idleTabs, ["ttys009"]);
});
