// Where Resume opens a session: a shell in a terminal app (open.rs), picked on Resume's menu, else set in Settings,
// else the system's. Terminal apps, herdr and consoles are stood in for (test/bin); shells are the machine's own.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { BIN, RESUME, DARWIN, WIN32, makeWorld, addAccount, addSession, addLive, setTabs, calls, startServer, cleanup, waitFor } = require("./helpers");

let w, srv;
beforeEach(() => { w = makeWorld(); });
afterEach(async () => { await srv?.stop(); srv = null; cleanup(w); });

const ids = async () => (await srv.api("GET", "/api/openers")).json.openers.map((o) => o.id);
const resume = (s, opener) => srv.api("POST", `/api/resume/${s.id}`, opener === undefined ? undefined : { opener });
// A terminal app's bundle, as the world's apps folder has it (WezTerm's carries its own binary, a stand-in).
function bundle(name) {
  const app = path.join(w.root, "apps", name);
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  if (name === "WezTerm.app") {
    const bin = path.join(app, "Contents", "MacOS", "wezterm");
    fs.writeFileSync(bin, `#!/usr/bin/env node\nprocess.argv[1] = "wezterm";\nrequire(${JSON.stringify(path.join(BIN, "log.js"))});\n`);
    fs.chmodSync(bin, 0o755);
  }
  return app;
}
const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;
// What zsh runs: the helper in the session's folder, then zsh again, at its prompt.
const zshLine = (s, shell = "/bin/zsh") => `cd ${q(s.cwd)} && ${q(RESUME)} ${q(s.id)} '--config' ${q(w.claude)}; exec ${q(shell)} -li`;

// --- macOS
test("on macOS the openers are zsh and bash in each terminal app found, the login shell in Terminal by default", { skip: !DARWIN }, async () => {
  bundle("iTerm.app"); bundle("Ghostty.app"); bundle("WezTerm.app");
  srv = await startServer(w);
  const o = (await srv.api("GET", "/api/openers")).json;
  assert.deepEqual(o.openers.map((x) => x.id), ["zsh:terminal", "bash:terminal", "zsh:iterm", "bash:iterm", "zsh:ghostty", "bash:ghostty", "zsh:wezterm", "bash:wezterm"]);
  assert.deepEqual([o.system, o.preferred, o.default], ["zsh:terminal", { shell: "", app: "" }, "zsh:terminal"]);
  assert.deepEqual(Object.fromEntries(Object.entries(o.apps).map(([k, v]) => [k, v.name])), { terminal: "Terminal", iterm: "iTerm2", ghostty: "Ghostty", wezterm: "WezTerm" });
  assert.deepEqual(Object.fromEntries(Object.entries(o.shells).map(([k, v]) => [k, v.name])), { zsh: "zsh", bash: "bash" });
});

test("on macOS Resume with the default types the helper's line into Terminal's login shell, as before", { skip: !DARWIN }, async () => {
  const s = addSession(w, { cwd: "/work/api", turns: [{ user: "a" }] });
  srv = await startServer(w);
  assert.deepEqual((await resume(s)).json, { opened: true });
  const [c] = calls(w, "osascript").filter((c) => c.script.includes("do script"));
  assert.ok(c.script.includes(`cd '/work/api'\\ncd '/work/api' && '${RESUME}' '${s.id}'`), c.script);
});

test("on macOS another shell in Terminal starts in the session's folder and runs the helper, staying after", { skip: !DARWIN }, async () => {
  const s = addSession(w, { cwd: "/work/it's", turns: [{ user: "a" }] });
  srv = await startServer(w);
  assert.deepEqual((await resume(s, "bash:terminal")).json, { opened: true });
  const [c] = calls(w, "osascript").filter((c) => c.script.includes("do script"));
  const line = `cd ${q(s.cwd)}\nexec '/bin/bash' '-lic' ${q(zshLine(s, "/bin/bash"))}`;
  assert.ok(c.script.includes(JSON.stringify(line).slice(1, -1)), c.script);
});

test("on macOS iTerm2 gets a window typing the shell's line", { skip: !DARWIN }, async () => {
  bundle("iTerm.app");
  const s = addSession(w, { cwd: "/work/api", turns: [{ user: "a" }] });
  srv = await startServer(w);
  assert.deepEqual((await resume(s, "zsh:iterm")).json, { opened: true });
  const c = calls(w, "osascript").find((c) => c.script.includes('tell application "iTerm"'));
  assert.ok(c.script.includes("create window with default profile"));
  assert.ok(c.script.includes(JSON.stringify(`cd '/work/api' && exec '/bin/zsh' '-lic' ${q(zshLine(s))}`).slice(1, -1)), c.script);
});

test("on macOS Ghostty is opened in the session's folder running the shell", { skip: !DARWIN }, async () => {
  const app = bundle("Ghostty.app");
  const s = addSession(w, { cwd: "/work/api", turns: [{ user: "a" }] });
  srv = await startServer(w);
  assert.deepEqual((await resume(s, "bash:ghostty")).json, { opened: true });
  assert.deepEqual(calls(w, "open")[0].args, ["-na", app, "--args", "--working-directory=/work/api", "-e", "/bin/bash", "-lic", zshLine(s, "/bin/bash")]);
});

test("on macOS WezTerm starts in the session's folder running the shell", { skip: !DARWIN }, async () => {
  bundle("WezTerm.app");
  const s = addSession(w, { cwd: "/work/api", turns: [{ user: "a" }] });
  srv = await startServer(w);
  assert.deepEqual((await resume(s, "zsh:wezterm")).json, { opened: true });
  await waitFor(() => calls(w, "wezterm").length);
  assert.deepEqual(calls(w, "wezterm")[0].args, ["start", "--cwd", "/work/api", "--", "/bin/zsh", "-lic", zshLine(s)]);
});

test("under a login shell that isn't POSIX, Terminal and iTerm2 offer only it; the others take zsh and bash", { skip: !DARWIN }, async () => {
  bundle("iTerm.app"); bundle("Ghostty.app");
  srv = await startServer(w, { HANGAR_LOGIN_SHELL: "/opt/homebrew/bin/fish" });
  const o = (await srv.api("GET", "/api/openers")).json;
  assert.deepEqual(o.openers.map((x) => x.id), ["fish:terminal", "zsh:ghostty", "bash:ghostty"]);
  assert.equal(o.system, "fish:terminal");
});

test("on macOS a zsh or bash login shell outside /bin (Homebrew's) is the one Terminal types into, as before", { skip: !DARWIN }, async () => {
  const s = addSession(w, { cwd: "/work/api", turns: [{ user: "a" }] });
  srv = await startServer(w, { HANGAR_LOGIN_SHELL: "/opt/homebrew/bin/zsh" });
  const o = (await srv.api("GET", "/api/openers")).json;
  assert.deepEqual([o.system, o.openers[0].id], ["zsh:terminal", "zsh:terminal"]);
  assert.deepEqual((await resume(s)).json, { opened: true });
  const [c] = calls(w, "osascript").filter((c) => c.script.includes("do script"));
  assert.ok(c.script.includes(`cd '/work/api' && '${RESUME}'`) && !c.script.includes("exec "), c.script);
  assert.deepEqual((await resume(s, "zsh:ghostty")).status, 400, "Ghostty isn't installed in this world");
});

test("on macOS another POSIX login shell (ksh) joins zsh and bash everywhere", { skip: !DARWIN }, async () => {
  bundle("Ghostty.app");
  srv = await startServer(w, { HANGAR_LOGIN_SHELL: "/bin/ksh" });
  const o = (await srv.api("GET", "/api/openers")).json;
  assert.deepEqual(o.openers.map((x) => x.id), ["zsh:terminal", "bash:terminal", "ksh:terminal", "zsh:ghostty", "bash:ghostty", "ksh:ghostty"]);
  assert.equal(o.system, "ksh:terminal");
});

test("on macOS Terminal or iTerm2 refusing to be driven is said, not reported as opened", { skip: !DARWIN }, async () => {
  bundle("iTerm.app");
  const s = addSession(w, { cwd: "/work/api", turns: [{ user: "a" }] });
  srv = await startServer(w, { FAKE_OSASCRIPT_FAIL: "iTerm" });
  const r = await resume(s, "zsh:iterm");
  assert.equal(r.status, 500);
  assert.match(r.json.error, /Not authorized/);
});

// A running session under another terminal app's process: a stand-in for the app (node, run from a path inside its
// bundle, which is what ps names) starts the claude stand-in.
async function liveUnder(s, bundleName, exe) {
  const dir = path.join(bundle(bundleName), "Contents", "MacOS");
  const bin = path.join(dir, exe);
  fs.symlinkSync(process.execPath, bin);
  const code = "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600e3)'], { stdio: 'ignore' });"
    + "console.log(c.pid); process.on('SIGTERM', () => { c.kill(); process.exit(); }); setInterval(() => {}, 1e3);";
  const app = spawn(bin, ["-e", code], { stdio: ["ignore", "pipe", "ignore"] });
  w.children.push(app);
  const pid = await new Promise((r) => app.stdout.once("data", (d) => r(Number(String(d).trim()))));
  w.children.push({ pid, kill() { try { process.kill(pid); } catch {} } });
  fs.writeFileSync(path.join(w.claude, "sessions", pid + ".json"), JSON.stringify({ pid, sessionId: s.id, cwd: s.cwd }));
}
const iterm = () => path.join(w.root, "iterm.tsv");
const hosted = () => startServer(w, { HANGAR_HOST_APPS: "1", FAKE_ITERM: iterm() });

test("on macOS a running session in iTerm2 that iTerm2 doesn't show is said to be open, never opened again", { skip: !DARWIN }, async () => {
  const s = addSession(w, { cwd: "/work/api", turns: [{ user: "a" }] });
  await liveUnder(s, "iTerm.app", "iTerm2");
  srv = await hosted();
  setTabs(w, []);
  assert.deepEqual((await resume(s)).json, { error: "already_open" });
  assert.ok(!calls(w, "osascript").some((c) => c.script.includes("do script") || c.script.includes("create window")), "no second copy");
});

test("on macOS a running session in iTerm2 is brought forward there", { skip: !DARWIN }, async (t) => {
  const s = addSession(w, { cwd: "/work/api", turns: [{ user: "a" }] });
  await liveUnder(s, "iTerm.app", "iTerm2");
  srv = await hosted();
  setTabs(w, []);
  const tty = (await srv.session(s.id)).live?.tty;
  if (!tty) return t.skip("the session stand-in has no tty here (no terminal runs the tests)");
  fs.writeFileSync(iterm(), `/dev/${tty}\n`);
  assert.deepEqual((await resume(s)).json, { focused: tty });
  assert.ok(calls(w, "osascript").some((c) => c.script.includes('application "iTerm"') && c.script.includes("select s")));
});

test("on macOS a running session in Ghostty or WezTerm brings that app forward, never a second copy", { skip: !DARWIN }, async () => {
  const s = addSession(w, { cwd: "/work/api", turns: [{ user: "a" }] });
  await liveUnder(s, "Ghostty.app", "ghostty");
  srv = await hosted();
  setTabs(w, []);
  const tty = (await srv.session(s.id)).live?.tty;
  assert.deepEqual((await resume(s)).json, { focused: tty ?? "" });
  assert.deepEqual(calls(w, "open")[0].args, ["-a", path.join(w.root, "apps", "Ghostty.app")]);
  assert.ok(!calls(w, "osascript").some((c) => c.script.includes("do script")));
});

// claude --resume finds a session under the project folder named after where it runs: where it started, not where it
// cd'd to last.
test("a session that moved to another folder resumes where its transcript's project is", { skip: !DARWIN }, async () => {
  const started = path.join(w.root, "started"), moved = path.join(w.root, "started", "moved");
  fs.mkdirSync(moved, { recursive: true });
  const s = addSession(w, { cwd: started, turns: [{ user: "a" }, { user: "b" }] });
  fs.writeFileSync(s.file, fs.readFileSync(s.file, "utf8").replaceAll(JSON.stringify(started), JSON.stringify(moved)));
  srv = await startServer(w);
  assert.deepEqual((await resume(s)).json, { opened: true });
  const [c] = calls(w, "osascript").filter((c) => c.script.includes("do script"));
  assert.ok(c.script.includes(`cd ${q(started)}\\ncd ${q(started)} && `), c.script);
});

// --- herdr, wherever it runs
const hcFile = () => path.join(w.root, "hc.json");
const withHc = (env = {}) => {
  if (!fs.existsSync(hcFile())) fs.writeFileSync(hcFile(), "[]");
  return startServer(w, { HANGAR_HC: path.join(BIN, "hc.js"), FAKE_HC: hcFile(), ...env });
};
const shellOf = () => DARWIN ? "zsh" : "powershell";

// herdr opens a tab in the space shown, which may be another machine's (a Windows one, given a macOS folder): the
// tab goes to one of this machine's spaces.
const work = (p) => DARWIN ? `/work/${p}` : `C:\\work\\${p}`;
// Spaces as herdr-app lists them ({ id, folder, machine, active, terminals: [{ address, cwd }] }), their terminals'
// folders as hc lists them. A space's own folder says nothing of where its terminals are.
const spaces = (list) => {
  const f = path.join(w.root, "spaces.json");
  fs.writeFileSync(f, JSON.stringify({ spaces: list.map(({ terminals = [], ...s }) => ({ ...s, tabs: [{ id: "tb", terminals: terminals.map((t) => ({ terminal: t.address })) }] })) }));
  fs.writeFileSync(hcFile(), JSON.stringify(list.flatMap((s) => s.terminals ?? []).map((t, i) => ({ pid: 9000 + i, fg: 9100 + i, labels: {}, ...t }))));
  return { HANGAR_HERDR_APP: path.join(BIN, "herdr-app.js"), FAKE_HERDR_SPACES: f };
};
const opened = () => calls(w, "herdr-app").find((c) => c.args[0] === "do");

test("with hc, herdr is an opener; herdr-app opens a tab running the shell in this machine's space working in the folder", { skip: !DARWIN && !WIN32 }, async () => {
  const s = addSession(w, { cwd: work("api/src"), turns: [{ user: "a" }] });
  srv = await withHc(spaces([
    { id: "spW", folder: work("api"), machine: "box", active: true, terminals: [{ address: "box/t1", cwd: work("api") }] },
    { id: "spA", folder: work("api/src"), machine: null, active: true, terminals: [{ address: "t7", cwd: work("other") }] },
    { id: "spB", folder: work(""), machine: null, active: false, terminals: [{ address: "t6", cwd: work("") }] },
    { id: "spC", folder: work("other"), machine: null, active: false, terminals: [{ address: "t5", cwd: work("api") }] },
  ]));
  assert.ok((await ids()).includes(`${shellOf()}:herdr`));
  assert.ok(!(await ids()).includes("cmd:herdr"), "Command Prompt's syntax doesn't survive herdr's argv");
  assert.deepEqual((await resume(s, `${shellOf()}:herdr`)).json, { opened: true });
  const c = opened();
  assert.deepEqual([...c.args.slice(0, 6), c.args[6]], ["do", "tab.new", "--space", "spC", "--folder", s.cwd, "--argv"]);
  assert.ok(JSON.parse(c.args[7]).some((a) => a.includes(s.id)), c.args[7]);
});

test("without a local space working in the folder, the tab goes to the local one shown, whatever the spaces' own folders", { skip: !DARWIN && !WIN32 }, async () => {
  const s = addSession(w, { cwd: work("api"), turns: [{ user: "a" }] });
  srv = await withHc(spaces([
    { id: "spW", folder: work(""), machine: "box", active: true },
    { id: "spA", folder: work("api"), machine: null, active: false, terminals: [{ address: "t7", cwd: work("other") }] },
    { id: "spB", folder: "", machine: null, active: true },
  ]));
  await resume(s, `${shellOf()}:herdr`);
  assert.equal(opened().args[3], "spB");
});

test("Resume in herdr opens in the space the session last ran in, while that space is there", { skip: !DARWIN }, async () => {
  const s = addSession(w, { cwd: work("api"), turns: [{ user: "a" }] });
  const env = spaces([
    { id: "spOld", folder: "", machine: null, active: false },
    { id: "spNow", folder: "", machine: null, active: true, terminals: [{ address: "t8", cwd: work("api") }] },
  ]);
  // It runs in herdr's t4, shown in spOld (the claude stand-in is this process's child).
  const live = addLive(w, s);
  const t4 = { address: "t4", pid: process.pid, fg: 5000, cwd: work("api"), labels: { "herdr.space": "spOld" } };
  fs.writeFileSync(hcFile(), JSON.stringify([t4, ...JSON.parse(fs.readFileSync(hcFile(), "utf8"))]));
  srv = await withHc(env);
  await waitFor(() => JSON.parse(fs.readFileSync(hcFile(), "utf8")).find((t) => t.address === "t4").labels["hangar.session"] === s.id);
  // It exits and its tab is closed.
  live.kill();
  fs.writeFileSync(hcFile(), JSON.stringify(JSON.parse(fs.readFileSync(hcFile(), "utf8")).filter((t) => t.address !== "t4")));
  await waitFor(async () => !(await srv.session(s.id)).live);
  assert.deepEqual((await resume(s, "zsh:herdr")).json, { opened: true });
  assert.deepEqual(opened().args.slice(0, 4), ["do", "tab.new", "--space", "spOld"]);
  // Once that space is closed, the one working in the folder.
  fs.writeFileSync(env.FAKE_HERDR_SPACES, JSON.stringify({ spaces: JSON.parse(fs.readFileSync(env.FAKE_HERDR_SPACES, "utf8")).spaces.filter((x) => x.id !== "spOld") }));
  assert.deepEqual((await resume(s, "zsh:herdr")).json, { opened: true });
  assert.equal(calls(w, "herdr-app").filter((c) => c.args[0] === "do").at(-1).args[3], "spNow");
});

test("between local spaces working as deep in the folder, the one shown wins", { skip: !DARWIN && !WIN32 }, async () => {
  const s = addSession(w, { cwd: work("api"), turns: [{ user: "a" }] });
  srv = await withHc(spaces([
    { id: "spA", folder: "", machine: null, active: false, terminals: [{ address: "t7", cwd: work("") }] },
    { id: "spB", folder: "", machine: null, active: true, terminals: [{ address: "t8", cwd: work("") }] },
    { id: "spC", folder: "", machine: null, active: false, terminals: [{ address: "t9", cwd: work("") }] },
  ]));
  await resume(s, `${shellOf()}:herdr`);
  assert.equal(opened().args[3], "spB");
});

test("with only other machines' spaces, the tab opens in a new space of this machine", { skip: !DARWIN && !WIN32 }, async () => {
  const s = addSession(w, { cwd: work("api"), turns: [{ user: "a" }] });
  srv = await withHc(spaces([{ id: "spW", folder: work(""), machine: "box", active: true }]));
  assert.deepEqual((await resume(s, `${shellOf()}:herdr`)).json, { opened: true });
  assert.deepEqual(opened().args.slice(0, 6), ["do", "space.new", "--machine", "", "--folder", s.cwd]);
});

test("what herdr-app says went wrong is the error", { skip: !DARWIN }, async () => {
  const s = addSession(w, { cwd: work("api"), turns: [{ user: "a" }] });
  const bad = path.join(w.root, "herdr-app-bad.js");
  fs.writeFileSync(bad, `process.stdout.write(process.argv[2] === "ls" ? '{"spaces":[]}' : JSON.stringify({ error: "cannot start a terminal: the directory name is invalid" })); process.exit(process.argv[2] === "ls" ? 0 : 1);`);
  srv = await withHc({ HANGAR_HERDR_APP: bad });
  assert.deepEqual((await resume(s, "zsh:herdr")).json, { error: "cannot start a terminal: the directory name is invalid" });
});

test("without herdr-app, herdr's opener starts a kept terminal of hc's own", { skip: !DARWIN && !WIN32 }, async () => {
  const s = addSession(w, { cwd: DARWIN ? "/work/api" : String.raw`C:\work\api`, turns: [{ user: "a" }] });
  srv = await withHc();
  assert.deepEqual((await resume(s, `${shellOf()}:herdr`)).json, { opened: true });
  const c = calls(w, "hc").find((c) => c.args[0] === "run");
  assert.deepEqual(c.args.slice(0, 7), ["run", "--bg", "--keep", "--no-parent", "--cwd", s.cwd, "--"]);
  assert.ok(c.args.some((a) => a.includes(s.id)));
});

test("with the herdr integration off, herdr isn't an opener", { skip: !DARWIN && !WIN32 }, async () => {
  srv = await withHc();
  await srv.api("PATCH", "/api/herdr", { enabled: false });
  assert.ok(!(await ids()).some((id) => id.endsWith(":herdr")));
});

test("a running session in a herdr terminal is shown there instead of opened again", { skip: !DARWIN }, async () => {
  const s = addSession(w, { cwd: "/work/api", turns: [{ user: "a" }] });
  addLive(w, s);
  // The claude stand-in is this process's child: this process stands for the terminal's program.
  fs.writeFileSync(hcFile(), JSON.stringify([{ address: "t4", pid: process.pid, fg: 5000, labels: { "hangar.session": s.id, "hangar.pid": String(process.pid) } }]));
  srv = await withHc({ HANGAR_HERDR_APP: path.join(BIN, "herdr-app.js") });
  setTabs(w, []);
  assert.deepEqual((await resume(s)).json, { focused: "t4" });
  assert.deepEqual(calls(w, "herdr-app")[0].args, ["do", "agent.focus", "--terminal", "t4"]);
  assert.ok(!calls(w, "osascript").some((c) => c.script.includes("do script")), "no second copy opened");
});

test("a running session in a herdr terminal without herdr-app isn't an error", { skip: !DARWIN }, async () => {
  const s = addSession(w, { cwd: "/work/api", turns: [{ user: "a" }] });
  addLive(w, s);
  fs.writeFileSync(hcFile(), JSON.stringify([{ address: "t4", pid: process.pid, fg: 5000, labels: { "hangar.session": s.id, "hangar.pid": String(process.pid) } }]));
  srv = await withHc({ HANGAR_HERDR_APP: path.join(w.root, "no-herdr-app") });
  setTabs(w, []);
  const r = await resume(s);
  assert.ok(r.status < 500, JSON.stringify(r.json));
});

test("an opener asked for wins over the herdr terminal that lost the session", { skip: !DARWIN }, async () => {
  const s = addSession(w, { cwd: "/work/api", turns: [{ user: "a" }] });
  fs.writeFileSync(hcFile(), JSON.stringify([{ address: "t4", pid: 4242, fg: 5000, labels: { "hangar.session": s.id, "hangar.pid": "1" } }]));
  srv = await withHc();
  await srv.api("PATCH", "/api/herdr", { auto: false });
  fs.writeFileSync(hcFile(), JSON.stringify([{ address: "t4", pid: 4242, fg: 4242, labels: { "hangar.session": s.id, "hangar.pid": "1" } }]));
  assert.deepEqual((await resume(s, "bash:terminal")).json, { opened: true });
  assert.ok(!calls(w, "hc").some((c) => c.args[0] === "send"));
  assert.ok(calls(w, "osascript").some((c) => c.script.includes("do script")));
});

// --- the default, set in Settings
test("the shell and the terminal set in Settings, each apart, make Resume's default; \"\" goes back to the system's", { skip: !DARWIN }, async () => {
  bundle("Ghostty.app");
  const s = addSession(w, { cwd: "/work/api", turns: [{ user: "a" }] });
  srv = await startServer(w);
  const get = async () => (await srv.api("GET", "/api/openers")).json;
  assert.deepEqual((await get()).preferred, { shell: "", app: "" });
  assert.deepEqual((await srv.api("PATCH", "/api/openers", { app: "ghostty" })).json, { ok: true });
  assert.deepEqual([(await get()).preferred, (await get()).default], [{ shell: "", app: "ghostty" }, "zsh:ghostty"]);
  await srv.api("PATCH", "/api/openers", { shell: "bash" });
  assert.deepEqual([(await get()).preferred, (await get()).default], [{ shell: "bash", app: "ghostty" }, "bash:ghostty"]);
  await srv.api("PATCH", "/api/openers", { app: "" });
  assert.equal((await get()).default, "bash:terminal", "the shell stays when the terminal goes back to the system's");
  await srv.api("PATCH", "/api/openers", { shell: "" });
  assert.equal((await get()).default, (await get()).system);
  assert.equal((await srv.api("PATCH", "/api/openers", { shell: "nope" })).status, 400);
  assert.equal((await srv.api("PATCH", "/api/openers", { app: "nope" })).status, 400);
  assert.equal((await srv.api("PATCH", "/api/openers", { app: 3 })).status, 400);
  assert.deepEqual((await resume(s, "nope:none")).json, { error: "unknown_opener" });
  assert.equal((await resume(s, 7)).status, 400);
});

test("a shell the terminal set in Settings can't take gives way to one it can", { skip: !WIN32 }, async () => {
  fs.writeFileSync(path.join(w.root, "hc.json"), "[]");
  srv = await startServer(w, { HANGAR_HC: path.join(BIN, "hc.js"), FAKE_HC: path.join(w.root, "hc.json") });
  await srv.api("PATCH", "/api/openers", { shell: "cmd", app: "herdr" });
  assert.equal((await srv.api("GET", "/api/openers")).json.default, "powershell:herdr");
});

test("Resume without an opener uses the shell and terminal set in Settings", { skip: !DARWIN }, async () => {
  const s = addSession(w, { cwd: "/work/api", turns: [{ user: "a" }] });
  srv = await startServer(w);
  await srv.api("PATCH", "/api/openers", { shell: "bash" });
  assert.deepEqual((await resume(s)).json, { opened: true });
  assert.ok(calls(w, "osascript").some((c) => c.script.includes("exec '/bin/bash'")));
});

// --- Windows
const PS = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const CMD = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");

test("on Windows the openers pair each shell found with Windows Terminal, a console and herdr", { skip: !WIN32 }, async () => {
  srv = await startServer(w);
  const o = (await srv.api("GET", "/api/openers")).json;
  for (const id of ["powershell:wt", "cmd:wt", "powershell:console", "cmd:console"]) assert.ok(o.openers.some((x) => x.id === id), id);
  assert.deepEqual([o.apps.wt.name, o.apps.console.name, o.shells.powershell.name, o.shells.cmd.name], ["Windows Terminal", "Console", "Windows PowerShell", "Command Prompt"]);
  assert.equal(o.system, "powershell:wt");
});

test("on Windows the default opener's shell is the one of Windows Terminal's default profile", { skip: !WIN32 }, async () => {
  const dir = path.join(w.root, "local", "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ defaultProfile: "{0caa0dad-35be-5f56-a8ff-afceeeaa6101}",
    profiles: { list: [{ guid: "{0caa0dad-35be-5f56-a8ff-afceeeaa6101}", name: "Command Prompt" }] } }));
  srv = await startServer(w);
  assert.equal((await srv.api("GET", "/api/openers")).json.system, "cmd:wt");
});

test("on Windows PowerShell in Windows Terminal starts in the session's folder and runs the helper, staying after", { skip: !WIN32 }, async () => {
  const s = addSession(w, { cwd: String.raw`C:\work\a;b it's`, turns: [{ user: "a" }] });
  srv = await startServer(w);
  assert.deepEqual((await resume(s, "powershell:wt")).json, { opened: true });
  const [c] = calls(w, "wt");
  assert.deepEqual(c.args.slice(0, 5), ["-w", "0", "new-tab", "--startingDirectory", String.raw`C:\work\a\;b it's`]);
  const line = `Set-Location -LiteralPath 'C:\\work\\a;b it''s'; & '${RESUME}' '${s.id}' '--config' '${w.claude.replaceAll("'", "''")}'`;
  assert.deepEqual(c.args.slice(5), [PS, "-NoLogo", "-NoExit", "-Command", line.replaceAll(";", "\\;")]);
});

// The folder goes by --startingDirectory, never into Command Prompt's line: wt splits a command line and joins it
// again quoting only what has spaces, so C:\work\R&D in the line would run "D".
test("on Windows Command Prompt in Windows Terminal runs the helper in the session's folder, a folder with & included", { skip: !WIN32 }, async () => {
  const s = addSession(w, { cwd: String.raw`C:\work\R&D a&b`, turns: [{ user: "a" }] });
  srv = await startServer(w);
  assert.deepEqual((await resume(s, "cmd:wt")).json, { opened: true });
  const [c] = calls(w, "wt");
  assert.deepEqual(c.args.slice(3, 5), ["--startingDirectory", String.raw`C:\work\R&D a&b`]);
  assert.deepEqual(c.args.slice(5), [CMD, "/k", "call", RESUME, s.id, "--config", w.claude]);
});

test("on Windows an argument Command Prompt would act on (&, %) is refused for it", { skip: !WIN32 }, async () => {
  for (const name of ["claude-R&D", "claude-100%"]) {
    const dir = addAccount(w, name);
    const s = addSession(w, { claude: dir, cwd: String.raw`C:\work\p`, turns: [{ user: "a" }] });
    srv = await startServer(w);
    assert.deepEqual((await resume(s, "cmd:wt")).json, { error: "unsupported_path" }, name);
    assert.deepEqual((await resume(s, "powershell:wt")).json, { opened: true }, "PowerShell's quoting holds it");
    await srv.stop(); srv = null;
  }
  assert.ok(!calls(w, "wt").some((c) => c.args.includes(CMD)));
});

test("on Windows a console window gets the shell's command line, in the session's folder", { skip: !WIN32 }, async () => {
  const s = addSession(w, { cwd: String.raw`C:\work\p`, turns: [{ user: "a" }] });
  srv = await startServer(w);
  assert.deepEqual((await resume(s, "powershell:console")).json, { opened: true });
  const [c] = calls(w, "console");
  assert.equal(c.args[0], PS);
  assert.ok(c.args[1].startsWith("-NoLogo -NoExit -Command \"Set-Location -LiteralPath 'C:\\work\\p'; & "), c.args[1]);
  assert.equal(c.args[2], String.raw`C:\work\p`);
});
