// Done detection: which sessions get classified, and what each verdict does (through a fake `claude`).
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { makeWorld, addSession, appendTurns, addLive, setVerdicts, calls, startServer, cleanup, waitFor } = require("./helpers");

let w, srv;
beforeEach(() => { w = makeWorld(); });
afterEach(async () => { await srv?.stop(); srv = null; cleanup(w); });

const FAST = { HANGAR_CLASSIFY_START_MS: "0", HANGAR_CLASSIFY_EVERY_MS: "200" };
const verdict = (done, confidence, evidence = "", reason = "r") => ({ done, confidence, evidence, reason });
const closing = () => addSession(w, { turns: [{ user: "fix the bug" }, { assistant: "fixed and pushed" }, { user: "perfect, we're done here" }] });
const classified = (n = 1) => waitFor(() => calls(w, "claude").length >= n);
const settle = () => new Promise((r) => setTimeout(r, 600));

test("marks a session done on its own at confidence >= 0.90 with a verbatim quote of the user", async () => {
  const s = closing();
  setVerdicts(w, [{ verdict: verdict(true, 0.92, "we're done here") }]);
  srv = await startServer(w, FAST);
  const row = await waitFor(async () => { const r = await srv.session(s.id); return r.status === "done" && r; });
  assert.equal(row.doneBy, "auto");
  assert.deepEqual(row.autoVerdict, { confidence: 0.92, evidence: "we're done here", reason: "r", quoted: true });
  assert.equal(row.suggestion, null);
});

test("below 0.90 a done verdict is only a suggestion", async () => {
  const s = closing();
  setVerdicts(w, [{ verdict: verdict(true, 0.6, "we're done here", "looks finished") }]);
  srv = await startServer(w, FAST);
  const row = await waitFor(async () => { const r = await srv.session(s.id); return r.suggestion && r; });
  assert.equal(row.status, "todo");
  assert.deepEqual(row.suggestion, { confidence: 0.6, evidence: "we're done here", reason: "looks finished", quoted: true });
});

test("a quote the user never wrote is never applied on its own", async () => {
  const s = closing();
  setVerdicts(w, [{ verdict: verdict(true, 0.99, "fixed and pushed") }]);
  srv = await startServer(w, FAST);
  const row = await waitFor(async () => { const r = await srv.session(s.id); return r.suggestion && r; });
  assert.equal(row.status, "todo");
  assert.equal(row.suggestion.quoted, false, "assistant text does not count as the user's words");
});

test("a not-done verdict leaves the session as it is", async () => {
  const s = closing();
  setVerdicts(w, [{ verdict: verdict(false, 0.97) }]);
  srv = await startServer(w, FAST);
  await classified();
  await settle();
  const row = await srv.session(s.id);
  assert.equal(row.status, "todo");
  assert.equal(row.suggestion, null);
});

test("skips live sessions, sessions active in the last hour, and done sessions", async () => {
  const live = addSession(w, { turns: [{ user: "live one" }] });
  addLive(w, live);
  addSession(w, { endAgo: 10 * 60e3, turns: [{ user: "recent one" }] });
  const done = addSession(w, { turns: [{ user: "done one" }] });
  addSession(w, { turns: [{ user: "eligible one" }] });
  setVerdicts(w, [{ verdict: verdict(false, 0.9) }]);
  srv = await startServer(w, { HANGAR_CLASSIFY_START_MS: "3600000" });
  await srv.api("PATCH", `/api/session/${done.id}`, { status: "done" });
  await srv.stop();
  srv = await startServer(w, FAST);
  await classified();
  await settle();
  const prompts = calls(w, "claude").map((c) => c.stdin);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes("eligible one"));
});

test("classifies a transcript once, and again only after it changes and goes idle", async () => {
  const s = closing();
  setVerdicts(w, [{ verdict: verdict(true, 0.5, "we're done here") }]);
  srv = await startServer(w, FAST);
  await classified();
  await settle();
  assert.equal(calls(w, "claude").length, 1, "no repeat for an unchanged transcript");
  assert.ok((await srv.session(s.id)).suggestion);

  appendTurns(s, [{ user: "actually, one more thing" }]);
  await settle();
  assert.equal((await srv.session(s.id)).suggestion, null, "a suggestion goes stale when the session moves on");
  assert.equal(calls(w, "claude").length, 1, "recent activity is not classified yet");
});

test("a failed classification is retried on the next pass", async () => {
  const s = closing();
  setVerdicts(w, [{ fail: true }]);
  srv = await startServer(w, FAST);
  await classified();
  setVerdicts(w, [{ verdict: verdict(true, 0.5, "we're done here") }]);
  const row = await waitFor(async () => { const r = await srv.session(s.id); return r.suggestion && r; });
  assert.ok(calls(w, "claude").length >= 2);
  assert.equal(row.suggestion.confidence, 0.5);
});

test("a dismissed suggestion stays hidden", async () => {
  const s = closing();
  setVerdicts(w, [{ verdict: verdict(true, 0.5, "we're done here") }]);
  srv = await startServer(w, FAST);
  await waitFor(async () => (await srv.session(s.id)).suggestion);
  assert.equal((await srv.api("POST", `/api/dismiss-suggestion/${s.id}`)).status, 200);
  await settle();
  assert.equal((await srv.session(s.id)).suggestion, null);
});

test("a session the user reopens after an auto-done is not marked again", async () => {
  const s = closing();
  setVerdicts(w, [{ verdict: verdict(true, 0.95, "we're done here") }]);
  srv = await startServer(w, FAST);
  await waitFor(async () => (await srv.session(s.id)).status === "done");
  await srv.api("PATCH", `/api/session/${s.id}`, { status: "todo" });
  await settle();
  assert.equal((await srv.session(s.id)).status, "todo");
  assert.equal(calls(w, "claude").length, 1);
});

test("calls Haiku headless, without tools or saved sessions, with a JSON schema", async () => {
  closing();
  setVerdicts(w, [{ verdict: verdict(false, 0.9) }]);
  srv = await startServer(w, FAST);
  await classified();
  const { args } = calls(w, "claude")[0];
  const flag = (f) => args[args.indexOf(f) + 1];
  assert.ok(args.includes("-p"));
  assert.equal(flag("--model"), "haiku");
  assert.equal(flag("--output-format"), "json");
  assert.equal(flag("--tools"), "");
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--strict-mcp-config"));
  assert.deepEqual(JSON.parse(flag("--json-schema")).required, ["done", "confidence", "evidence", "reason"]);
});

test("sends the last 24 human and assistant turns, without tool output or injected text", async () => {
  const turns = [];
  for (let i = 1; i <= 30; i++) turns.push({ user: `question ${i}` }, { assistant: `answer ${i}` });
  turns.push({ raw: { type: "user", cwd: "/work/acme/app", message: { role: "user", content: [{ type: "tool_result", content: "TOOL OUTPUT" }] } } });
  turns.push({ user: "<system-reminder>INJECTED</system-reminder>" });
  addSession(w, { turns });
  setVerdicts(w, [{ verdict: verdict(false, 0.9) }]);
  srv = await startServer(w, FAST);
  await classified();
  const { stdin } = calls(w, "claude")[0];
  assert.equal((stdin.match(/\[(USER|ASSISTANT)\]/g) || []).length, 24);
  assert.ok(stdin.includes("[USER] question 30") && stdin.includes("[ASSISTANT] answer 30"));
  assert.ok(!stdin.includes("question 18"));
  assert.ok(!stdin.includes("TOOL OUTPUT") && !stdin.includes("INJECTED"));
});

test("insights count classifications and their cost", async () => {
  closing();
  setVerdicts(w, [{ verdict: verdict(true, 0.5, "we're done here") }]);
  srv = await startServer(w, FAST);
  await classified();
  await settle();
  const { totals } = (await srv.api("GET", "/api/insights")).json;
  assert.equal(totals.classified, 1);
  assert.equal(totals.suggestions, 1);
  assert.equal(totals.classifyCostUsd, 0.001);
});
