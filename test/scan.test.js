// Transcript scanning: what each session shows in the list.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { HOUR, makeWorld, addSession, appendTurns, startServer, cleanup } = require("./helpers");

let w, srv;
beforeEach(() => { w = makeWorld(); });
afterEach(async () => { await srv?.stop(); srv = null; cleanup(w); });

test("title prefers the session name, then the AI title, then the first prompt", async () => {
  const named = addSession(w, { agentName: "Named", aiTitle: "AI title", turns: [{ user: "first prompt" }] });
  const ai = addSession(w, { aiTitle: "AI title", turns: [{ user: "first prompt" }] });
  const plain = addSession(w, { turns: [{ user: "first prompt of plain" }] });
  srv = await startServer(w);
  assert.equal((await srv.session(named.id)).title, "Named");
  assert.equal((await srv.session(ai.id)).title, "AI title");
  assert.equal((await srv.session(plain.id)).title, "first prompt of plain");
});

test("counts only prompts typed by the human", async () => {
  const s = addSession(w, { turns: [
    { user: "real one" },
    { user: "<system-reminder>injected</system-reminder>" },
    { user: "[Earlier notes no longer apply]" },
    { user: "Base directory for this skill: /x" },
    { user: "Another Claude session sent a message" },
    { user: "meta", extra: { isMeta: true } },
    { user: "side", extra: { isSidechain: true } },
    { user: "from a tool", extra: { turnOrigin: "tool" } },
    { raw: { type: "user", cwd: "/work/acme/app", message: { role: "user", content: [{ type: "tool_result", content: "x" }] } } },
    { user: "real two" },
  ] });
  srv = await startServer(w);
  const row = await srv.session(s.id);
  assert.equal(row.prompts, 2);
  assert.equal(row.firstPrompt, "real one");
  assert.equal(row.lastPrompt, "real two");
});

test("reads cwd and branch from the transcript", async () => {
  const s = addSession(w, { cwd: "/work/acme/api", branch: "feat/x", turns: [{ user: "hi" }] });
  srv = await startServer(w);
  const row = await srv.session(s.id);
  assert.equal(row.cwd, "/work/acme/api");
  assert.equal(row.branch, "feat/x");
});

// A message copied into another session keeps its uuid and timestamp.
const m = (uuid, hoursAgo) => ({ user: uuid, extra: { uuid, timestamp: new Date(Date.now() - hoursAgo * HOUR).toISOString() } });

test("a session that stopped where another went on is the same conversation, through a chain too", async () => {
  const original = addSession(w, { turns: [m("a", 9), m("b", 8)] });
  const continuation = addSession(w, { turns: [m("b", 8), m("c", 5)] });
  const next = addSession(w, { turns: [m("c", 5), m("d", 1)] });
  const copy = addSession(w, { turns: [m("a", 9)] });
  const unrelated = addSession(w, { turns: [m("z", 3)] });
  srv = await startServer(w);
  const family = (await srv.session(original.id)).family;
  assert.ok(family);
  for (const s of [continuation, next, copy]) assert.equal((await srv.session(s.id)).family, family);
  assert.equal((await srv.session(unrelated.id)).family, null);
});

test("a fork where both sides kept going is separate work", async () => {
  const original = addSession(w, { turns: [m("a", 9), m("own", 2)] });
  const fork = addSession(w, { turns: [m("a", 9), m("fork-own", 1)] });
  srv = await startServer(w);
  assert.equal((await srv.session(original.id)).family, null);
  assert.equal((await srv.session(fork.id)).family, null);
});

test("a link that appears later in a growing transcript is picked up", async () => {
  const a = addSession(w, { turns: [m("a1", 3)] });
  const b = addSession(w, { turns: [m("b1", 4)] });
  srv = await startServer(w);
  assert.equal((await srv.session(a.id)).family, null);
  const copied = m("a1", 3).extra;
  fs.appendFileSync(b.file, JSON.stringify({ type: "user", cwd: b.cwd, sessionId: b.id, message: { role: "user", content: "copied" }, ...copied }) + "\n");
  assert.ok((await srv.session(a.id)).family);
});

test("project label drops the directory every session shares", async () => {
  const a = addSession(w, { cwd: "/work/acme/api", turns: [{ user: "a" }] });
  const b = addSession(w, { cwd: "/work/side/blog", turns: [{ user: "b" }] });
  srv = await startServer(w);
  assert.equal((await srv.session(a.id)).project, "acme/api");
  assert.equal((await srv.session(b.id)).project, "side/blog");
});

test("a single project keeps its last path segment", async () => {
  const a = addSession(w, { cwd: "/work/acme/api", turns: [{ user: "a" }] });
  srv = await startServer(w);
  assert.equal((await srv.session(a.id)).project, "api");
});

test("project label works on Windows paths too", async () => {
  const a = addSession(w, { cwd: String.raw`C:\Users\demo\Projects\acme\api`, turns: [{ user: "a" }] });
  const b = addSession(w, { cwd: String.raw`C:\Users\demo\Projects\blog`, turns: [{ user: "b" }] });
  srv = await startServer(w);
  assert.equal((await srv.session(a.id)).project, String.raw`acme\api`);
  assert.equal((await srv.session(b.id)).project, "blog");
});

test("streamed records of one message count its tokens once, latest usage wins", async () => {
  const s = addSession(w, { turns: [
    { user: "go" },
    { assistant: "part 1", msgId: "msg_A", usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 1000, output_tokens: 5 } },
    { assistant: "part 2", msgId: "msg_A", usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 1000, output_tokens: 50 } },
    { assistant: "other", msgId: "msg_B", usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 10, output_tokens: 7 } },
  ] });
  srv = await startServer(w);
  const row = await srv.session(s.id);
  assert.equal(row.tokensIn, 121);
  assert.equal(row.tokensCache, 1010);
  assert.equal(row.tokensOut, 57);
});

test("picks up appended lines incrementally", async () => {
  const s = addSession(w, { turns: [{ user: "one" }] });
  srv = await startServer(w);
  assert.equal((await srv.session(s.id)).prompts, 1);
  appendTurns(s, [{ user: "two" }, { assistant: "ok" }]);
  const row = await srv.session(s.id);
  assert.equal(row.prompts, 2);
  assert.equal(row.lastPrompt, "two");
});

test("rescans from scratch when a transcript shrinks", async () => {
  const s = addSession(w, { turns: [{ user: "one" }, { user: "two" }, { user: "three" }] });
  srv = await startServer(w);
  assert.equal((await srv.session(s.id)).prompts, 3);
  fs.writeFileSync(s.file, fs.readFileSync(s.file, "utf8").split("\n")[0] + "\n");
  assert.equal((await srv.session(s.id)).prompts, 1);
});

test("ignores files that are not session transcripts", async () => {
  addSession(w, { turns: [{ user: "a" }] });
  const dir = fs.readdirSync(w.claude + "/projects")[0];
  fs.writeFileSync(`${w.claude}/projects/${dir}/notes.jsonl`, "{}\n");
  fs.mkdirSync(`${w.claude}/projects/${dir}/11111111-1111-1111-1111-111111111111`);
  srv = await startServer(w);
  assert.equal((await srv.sessions()).length, 1);
});

test("last activity is the newest timestamp in the transcript", async () => {
  const s = addSession(w, { endAgo: 3 * HOUR, turns: [{ user: "a" }, { assistant: "b" }] });
  srv = await startServer(w);
  const age = Date.now() - new Date((await srv.session(s.id)).lastAt);
  assert.ok(age >= 3 * HOUR - 5000 && age < 3 * HOUR + 60000, `age ${age}`);
});

test("last message sent is the newest human prompt, not the assistant's reply", async () => {
  const s = addSession(w, { endAgo: 3 * HOUR, turns: [{ user: "a" }, { user: "<system-reminder>x</system-reminder>" }, { assistant: "b" }] });
  srv = await startServer(w);
  const row = await srv.session(s.id);
  const age = Date.now() - new Date(row.lastPromptAt);
  assert.ok(age >= 3 * HOUR + 120000 - 5000 && age < 3 * HOUR + 180000, `age ${age}`);
  assert.ok(row.lastPromptAt < row.lastAt);
});
