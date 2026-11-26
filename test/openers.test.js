// Where Resume opens a session: a shell in a terminal app (open.rs), picked on Resume's menu, else set in Settings,
// else the system's. Terminal apps, herdr and consoles are stood in for (test/bin); shells are the machine's own.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { BIN, RESUME, DARWIN, WIN32, makeWorld, addSession, addLive, setTabs, calls, startServer, cleanup, waitFor } = require("./helpers");

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
  assert.deepEqual([o.system, o.preferred, o.default], ["zsh:terminal", "", "zsh:terminal"]);
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

// --- herdr, wherever it runs
const hcFile = () => path.join(w.root, "hc.json");
const withHc = (env = {}) => {
  if (!fs.existsSync(hcFile())) fs.writeFileSync(hcFile(), "[]");
  return startServer(w, { HANGAR_HC: path.join(BIN, "hc.js"), FAKE_HC: hcFile(), ...env });
};
const shellOf = () => DARWIN ? "zsh" : "powershell";

test("with hc, herdr is an opener; herdr-app opens a tab running the shell in the session's folder", { skip: !DARWIN && !WIN32 }, async () => {
  const s = addSession(w, { cwd: DARWIN ? "/work/api" : String.raw`C:\work\api`, turns: [{ user: "a" }] });
  srv = await withHc({ HANGAR_HERDR_APP: path.join(BIN, "herdr-app.js") });
  assert.ok((await ids()).includes(`${shellOf()}:herdr`));
  assert.ok(!(await ids()).includes("cmd:herdr"), "Command Prompt's syntax doesn't survive herdr's argv");
  assert.deepEqual((await resume(s, `${shellOf()}:herdr`)).json, { opened: true });
  const [c] = calls(w, "herdr-app");
  assert.deepEqual([c.args[0], c.args[1], c.args[2], c.args[4], c.args[5]], ["do", "terminal.open", "--argv", "--folder", s.cwd]);
  const argv = JSON.parse(c.args[3]);
  assert.ok(argv.some((a) => a.includes(s.id)), c.args[3]);
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
test("the opener set in Settings is Resume's default; \"\" goes back to the system's", { skip: !DARWIN && !WIN32 }, async () => {
  const s = addSession(w, { cwd: DARWIN ? "/work/api" : String.raw`C:\work\api`, turns: [{ user: "a" }] });
  srv = await startServer(w);
  const { system } = (await srv.api("GET", "/api/openers")).json;
  const other = (await ids()).find((id) => id !== system);
  assert.deepEqual((await srv.api("PATCH", "/api/openers", { preferred: other })).json, { ok: true });
  const o = (await srv.api("GET", "/api/openers")).json;
  assert.deepEqual([o.preferred, o.default], [other, other]);
  assert.deepEqual((await srv.api("PATCH", "/api/openers", { preferred: "" })).json, { ok: true });
  assert.equal((await srv.api("GET", "/api/openers")).json.default, o.system);
  assert.equal((await srv.api("PATCH", "/api/openers", { preferred: "nope:none" })).status, 400);
  assert.equal((await srv.api("PATCH", "/api/openers", { preferred: 3 })).status, 400);
  assert.deepEqual((await resume(s, "nope:none")).json, { error: "unknown_opener" });
  assert.equal((await resume(s, 7)).status, 400);
});

test("Resume without an opener uses the one set in Settings", { skip: !DARWIN }, async () => {
  const s = addSession(w, { cwd: "/work/api", turns: [{ user: "a" }] });
  srv = await startServer(w);
  await srv.api("PATCH", "/api/openers", { preferred: "bash:terminal" });
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

test("on Windows Command Prompt in Windows Terminal changes to the folder and runs the helper", { skip: !WIN32 }, async () => {
  const s = addSession(w, { cwd: String.raw`C:\work\p q`, turns: [{ user: "a" }] });
  srv = await startServer(w);
  assert.deepEqual((await resume(s, "cmd:wt")).json, { opened: true });
  const [c] = calls(w, "wt");
  assert.deepEqual(c.args.slice(5), [CMD, "/k", "cd", "/d", String.raw`C:\work\p q`, "&&", RESUME, s.id, "--config", w.claude]);
});

test("on Windows a folder Command Prompt would expand (%) is refused for it", { skip: !WIN32 }, async () => {
  const s = addSession(w, { cwd: String.raw`C:\work\100%`, turns: [{ user: "a" }] });
  srv = await startServer(w);
  assert.deepEqual((await resume(s, "cmd:wt")).json, { error: "unsupported_path" });
  assert.deepEqual(calls(w, "wt"), []);
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
