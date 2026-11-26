// Open at login: the login item starts Hangar with --hidden, without its window; Open Hangar (the tray) shows it with
// the size and place it was saved with, and a quit before it was ever shown leaves that saved state alone.
// Desktop app only (its native window, menus and login item); Windows, where the e2e specs drive the app.
const { test, expect } = require("@playwright/test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { makeWorld, addSession, cleanup, waitFor } = require("../test/helpers");
const { launchApp, APP } = require("./target");

let w, app, stateFile;
test.beforeEach(() => {
  w = makeWorld();
  addSession(w, { cwd: "/w/acme/api", agentName: "Rate limiter", turns: [{ user: "add buckets" }] });
  stateFile = path.join(w.root, "window-state.json");
});
test.afterEach(async () => { await app?.stop(); app = null; if (w) cleanup(w); w = null; });

// A saved window, off screen like every e2e window (window-state keeps a place no monitor shows where the window is).
const saved = (width, height) => fs.writeFileSync(stateFile, JSON.stringify({
  main: { width, height, x: -32000, y: -32000, prev_x: -32000, prev_y: -32000, maximized: false, visible: true, decorated: true, fullscreen: false },
}));
const start = (args = ["--hidden"], env = {}) => launchApp(w, { HANGAR_WINDOW_STATE: stateFile, ...env }, args);

test("started from the login item, Hangar runs without its window", async () => {
  app = await start();
  expect((await app.window()).visible).toBe(false);
  expect((await app.sessions()).map((s) => s.title)).toEqual(["Rate limiter"]);
});

test("Open Hangar shows the window at the size it was saved with", async () => {
  saved(900, 700);
  app = await start();
  await app.menu("tray-open");
  await expect.poll(() => app.window()).toEqual({ visible: true, width: 900, height: 700 });
});

test("quitting before the window was ever shown leaves its saved size alone", async () => {
  saved(900, 700);
  const before = fs.readFileSync(stateFile, "utf8");
  app = await start();
  expect(await app.quits(() => app.menu("tray-quit"))).toBe(0);
  expect(fs.readFileSync(stateFile, "utf8")).toBe(before);
});

test("with nothing saved, a quit before the window showed saves nothing", async () => {
  app = await start();
  expect(await app.quits(() => app.menu("tray-quit"))).toBe(0);
  expect(fs.existsSync(stateFile)).toBe(false);
});

test("once shown, the window's size is saved on quit", async () => {
  app = await start();
  await app.menu("tray-open");
  await expect.poll(async () => (await app.window()).visible).toBe(true);
  const { width, height } = await app.window();
  expect(await app.quits(() => app.menu("tray-quit"))).toBe(0);
  expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).main).toMatchObject({ width, height });
});

test("started without --hidden, the window shows", async () => {
  app = await start([]);
  expect((await app.window()).visible).toBe(true);
});

// The login item: a value named after the app in HKCU's Run key, even with the app elevated (as on CI), never in
// HKLM's (which starts it for every user); both are looked at. Turning it on or off also writes StartupApproved\Run
// (Task Manager's switch). The installed Hangar's login item has the same name, so these keys are exported before each
// spec, the app's values dropped (a spec starts with no login item), and put back from the export afterwards, types
// and all.
const NAME = "Hangar";
const WIN = "Software\\Microsoft\\Windows\\CurrentVersion\\";
const KEYS = ["HKCU", "HKLM"].flatMap((root) => [`${root}\\${WIN}Run`, `${root}\\${WIN}Explorer\\StartupApproved\\Run`]);
const RUNS = KEYS.filter((k) => k.endsWith("Version\\Run"));
function runValues() {
  return RUNS.flatMap((key) => {
    let out = "";
    try { out = execFileSync("reg", ["query", key], { encoding: "utf8" }); } catch { return []; }
    return out.split(/\r?\n/).map((l) => l.match(/^\s+(.+?)\s{4}REG_\w+\s{4}(.*)$/)).filter(Boolean).map(([, name, data]) => ({ key, name, data }));
  });
}
const ours = () => runValues().find((v) => v.data.toLowerCase().includes(APP.toLowerCase()));
const setRun = ({ key, name, data }) => execFileSync("reg", ["add", key, "/v", name, "/t", "REG_SZ", "/d", data, "/f"]);
const reg = (...args) => { try { execFileSync("reg", args, { stdio: "ignore" }); return true; } catch { return false; } };
const dropApp = () => KEYS.forEach((k) => reg("delete", k, "/v", NAME, "/f"));

test.describe("the login item, the person's own", () => {
  // One Run key for all of them.
  test.describe.configure({ mode: "serial" });
  let exports;
  test.beforeEach(() => {
    exports = KEYS.map((k, i) => ({ k, file: path.join(w.root, `run${i}.reg`) })).filter(({ k, file }) => reg("export", k, file, "/y"));
    dropApp();
  });
  test.afterEach(async () => {
    await app?.stop(); app = null;
    dropApp();
    for (const { file } of exports) reg("import", file);
  });

  test("Open at Login starts Hangar with --hidden, and turned off it doesn't start it", async () => {
    app = await start([], { HANGAR_E2E_LOGIN: "1" });
    await app.menu("login");
    await waitFor(() => ours()).catch(() => {
      throw new Error(`no Run value names ${APP}: ${JSON.stringify(runValues())}\n${fs.readFileSync(path.join(w.root, "app.log"), "utf8").slice(-1000)}`);
    });
    expect(ours().data).toMatch(/--hidden/);
    expect(ours().key).toMatch(/^HKCU\\/);
    await app.menu("login");
    await waitFor(() => !ours());
  });

  test("a login item from before --hidden is written again with it", async () => {
    app = await start([], { HANGAR_E2E_LOGIN: "1" });
    await app.menu("login");
    const item = await waitFor(() => ours());
    await app.stop(); app = null;
    setRun({ ...item, data: `"${APP}"` });
    app = await start([], { HANGAR_E2E_LOGIN: "1" });
    await waitFor(() => /--hidden/.test(ours()?.data ?? ""));
  });
});
