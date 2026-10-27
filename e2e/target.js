// What the UI specs run against, by Playwright project. The same specs prove both:
//   web       the page in Chrome, talking HTTP to hangar-server (the core);
//   desktop   the real desktop app (Tauri), its webview driven over the DevTools protocol. WebView2 speaks it, so this
//             runs on Windows; WKWebView doesn't, so on macOS the packaged app is covered by test:build instead.
// Each spec calls `launch(w, env)` once its world is set up, then `app.open(page)` for the page to drive.
const { chromium, test } = require("@playwright/test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { startServer, stopApp, BIN, ROOT, WIN32, waitFor } = require("../test/helpers");

const APP = process.env.HANGAR_APP || path.join(ROOT, "target/debug", "hangar" + (WIN32 ? ".exe" : ""));

async function launchWeb(w, env) {
  const srv = await startServer(w, env);
  return {
    ...srv,
    async open(page) { await page.goto(srv.base + "/"); return page; },
    // Every API call whose path starts with `prefix` waits `ms` first (0 = back to normal).
    async slow(page, ms, prefix = "/api/") {
      await page.unroute(`**${prefix}**`);
      if (ms) await page.route(`**${prefix}**`, async (route) => { await new Promise((r) => setTimeout(r, ms)); await route.continue(); });
    },
    async fail(page, prefix, error) {
      await page.route(`**${prefix}**`, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error }) }));
    },
  };
}

async function launchDesktop(w, env) {
  test.skip(!WIN32, "only WebView2 (Windows) can be driven over the DevTools protocol; test:build covers the macOS app");
  const profile = path.join(w.root, "webview");
  const log = fs.openSync(path.join(w.root, "app.log"), "a");
  const proc = spawn(APP, [], {
    env: {
      ...process.env,
      HANGAR_CLAUDE_DIR: w.claude,
      HANGAR_DATA_DIR: w.data,
      HANGAR_WEBVIEW_DATA: profile,
      // Port 0: the webview picks a free one and writes it to DevToolsActivePort in its profile, so parallel
      // instances can never end up on the same port.
      // Occlusion off: a window behind others (or off screen) must not be treated as hidden and throttled.
      HANGAR_WEBVIEW_ARGS: "--remote-debugging-port=0 --disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding",
      HANGAR_WINDOW_OFFSCREEN: "1",
      HANGAR_OSASCRIPT: path.join(BIN, "osascript.js"),
      HANGAR_WT: path.join(BIN, "wt.js"),
      CLAUDE_BIN: path.join(BIN, "claude.js"),
      FAKE_LOG: w.log,
      FAKE_TABS: w.tabs,
      FAKE_VERDICTS: w.verdicts,
      HANGAR_CLASSIFY_START_MS: "3600000",
      ...env,
    },
    // The app's stderr goes to the world, so a failing spec can show why the app died.
    stdio: ["ignore", "ignore", log],
  });
  let exited = false, stopping = false;
  proc.on("exit", (code) => {
    exited = true;
    if (!stopping) console.error(`app exited (${code}) mid-test:\n` + fs.readFileSync(path.join(w.root, "app.log"), "utf8").slice(-2000));
  });
  const portFile = path.join(profile, "EBWebView", "DevToolsActivePort");
  let browser, page;
  try {
    browser = await waitFor(async () => {
      if (exited) throw new Error(`${APP} exited before its webview came up`);
      let port;
      try { port = fs.readFileSync(portFile, "utf8").split("\n")[0].trim(); } catch { return null; }
      try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { return null; }
    }, { timeout: 30000, every: 250 });
    page = await waitFor(() => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("tauri.localhost")), { timeout: 15000 });
    await page.waitForLoadState("load");
  } catch (e) {
    // A launch that never comes up still holds the world's files; stop it, and say what it got to.
    stopping = true;
    await browser?.close().catch(() => {});
    await stopApp(proc);
    fs.closeSync(log);
    const list = (dir) => { try { return fs.readdirSync(dir).join(", ") || "(empty)"; } catch { return "(missing)"; } };
    throw new Error(`desktop app did not come up: ${e.message}\nprofile: ${list(profile)}\nprofile/EBWebView: ${list(path.dirname(portFile))}\n`
      + `app.log:\n${fs.readFileSync(path.join(w.root, "app.log"), "utf8").slice(-2000)}`);
  }

  // The core as the UI calls it, bypassing any slow/fail stand-in a test installed.
  const api = async (method, p, body) => {
    const r = await page.evaluate(async ([method, path, body]) => {
      const t = window.__TAURI__;
      try { return { status: 200, json: await (t.realCore || t.core).invoke("api", { method, path, body: body ?? null }) }; }
      catch (e) { return { status: 500, json: { error: String(e) } }; }
    }, [method, p, body]);
    return { ...r, text: JSON.stringify(r.json) };
  };
  const sessions = async () => (await api("GET", "/api/sessions")).json;
  // Swaps the page's invoke for one where calls to `prefix` paths wait `ms`, or fail with `error`.
  // Tauri freezes __TAURI__.core, so the whole core object is replaced (the UI looks it up on every call).
  const standIn = (opts) => page.evaluate(({ ms, prefix, error }) => {
    const t = window.__TAURI__;
    const real = (t.realCore ??= t.core);
    const invoke = async (cmd, args) => {
      if (cmd === "api" && args.path.startsWith(prefix)) {
        if (error) throw error;
        await new Promise((r) => setTimeout(r, ms));
      }
      return real.invoke(cmd, args);
    };
    Object.defineProperty(t, "core", { value: { ...real, invoke }, configurable: true, writable: true });
  }, opts);
  return {
    api,
    sessions,
    session: async (id) => (await sessions()).find((s) => s.id === id),
    // The window loaded at launch; reloading picks up the setup a spec did since, as navigating there does on the web.
    async open() { await page.reload(); return page; },
    async slow(_, ms, prefix = "/api/") { await standIn({ ms, prefix }); },
    async fail(_, prefix, error) { await standIn({ ms: 0, prefix, error }); },
    async stop() {
      stopping = true;
      await browser.close().catch(() => {});
      await stopApp(proc);
      fs.closeSync(log);
    },
  };
}

const launch = (w, env = {}) => (test.info().project.name === "desktop" ? launchDesktop : launchWeb)(w, env);

module.exports = { launch };
