// What the UI specs run against, by Playwright project. The same specs prove both:
//   web       the page in Chrome, talking HTTP to hangar-server (the core);
//   desktop   the real desktop app (Tauri), its webview driven over the DevTools protocol. WebView2 speaks it, so this
//             runs on Windows; WKWebView doesn't, so on macOS the packaged app is covered by test:build instead.
// Each spec calls `launch(w, env)` once its world is set up, then `app.open(page)` for the page to drive. Stand-ins
// for the core (`intercept`, `slow`, `fail`) work the same on both, set before or after `open`.
const { chromium, test } = require("@playwright/test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { startServer, stopApp, BIN, ROOT, WIN32, waitFor } = require("../test/helpers");

const APP = process.env.HANGAR_APP || path.join(ROOT, "target/debug", "hangar" + (WIN32 ? ".exe" : ""));

// The desktop app's CSP, as the webview gets it: Tauri adds a nonce to script-src and style-src and puts it on the
// page's <script> and <style> tags, and with a nonce present the browser ignores 'unsafe-inline' (style attributes
// set as markup are dropped). The web target serves the page the same way, so what the CSP blocks shows here too;
// only connect-src differs, the web page talking HTTP to its own origin instead of IPC.
const NONCE = "e2e";
const CSP = JSON.parse(fs.readFileSync(path.join(ROOT, "app/tauri.conf.json"), "utf8")).app.security.csp
  .replace(/connect-src [^;]*/, "connect-src 'self'")
  .replace(/(script-src|style-src) ([^;]*)/g, `$1 $2 'nonce-${NONCE}'`);

// Stand-ins for the core, the same on both targets and in place before the page first loads: every API call the UI
// makes ({ method, path, body }) is asked of `intercept`'s handler, then of the slow/fail rules. An answer
// ({ status, json }) is what the UI gets; none lets the call through to the real core.
function standIns() {
  let handler = null, rules = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    async answer(call) {
      const a = handler && await handler(call);
      if (a) return a;
      for (const r of rules.filter((r) => call.path.startsWith(r.prefix))) {
        if (r.ms) await sleep(r.ms);
        if (r.error) return { status: 500, json: { error: r.error } };
      }
      return null;
    },
    // The UI's calls go to `fn` first ({ method, path, body } → { status, json } or nothing).
    intercept(fn) { handler = fn; },
    // Every call whose path starts with `prefix` waits `ms` first; 0 drops the rules on `prefix` ("/api/": all of them).
    slow(ms, prefix = "/api/") {
      rules = rules.filter((r) => prefix !== "/api/" && r.prefix !== prefix);
      if (ms) rules.push({ prefix, ms });
    },
    fail(prefix, error) { rules.push({ prefix, error }); },
  };
}

async function launchWeb(w, env) {
  const srv = await startServer(w, env);
  const stand = standIns();
  return {
    ...srv,
    async open(page) {
      // The page the server would send, read from the same folder (HANGAR_WEB_DIR) rather than fetched again.
      const html = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8").replace(/<(script|style)>/g, `<$1 nonce="${NONCE}">`);
      await page.route(srv.base + "/", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: html, headers: { "content-security-policy": CSP } }));
      await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
        const req = route.request(), url = new URL(req.url());
        let body = null;
        try { body = req.postDataJSON(); } catch {}
        const a = await stand.answer({ method: req.method(), path: url.pathname + url.search, body });
        if (!a) return route.continue().catch(() => {});
        return route.fulfill({ status: a.status ?? 200, contentType: "application/json", body: JSON.stringify(a.json ?? {}) }).catch(() => {});
      });
      await page.goto(srv.base + "/");
      return page;
    },
    // A script run at the start of every document of the page the specs drive (storage set up before the UI reads it).
    async init(page, fn) { await page.addInitScript(fn); },
    async intercept(_, fn) { stand.intercept(fn); },
    async slow(_, ms, prefix) { stand.slow(ms, prefix); },
    async fail(_, prefix, error) { stand.fail(prefix, error); },
  };
}

async function launchDesktop(w, env) {
  test.skip(!WIN32, "only WebView2 (Windows) can be driven over the DevTools protocol; test:build covers the macOS app");
  const profile = path.join(w.root, "webview");
  const log = fs.openSync(path.join(w.root, "app.log"), "a");
  const proc = spawn(APP, [], {
    env: {
      ...process.env,
      HANGAR_CLAUDE_DIRS: w.accounts.join(path.delimiter),
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
  // The stand-ins: every `api` invoke asks this process first (a binding), from the moment a document starts, so a
  // reload is covered from its first call. Tauri freezes __TAURI__.core, so the whole core object is replaced (the
  // UI looks it up on every call); the real one stays as realCore. A refusal arrives as Tauri's do, a rejected string.
  const stand = standIns();
  await page.exposeBinding("__e2eAnswer", (_, call) => stand.answer(call));
  await page.addInitScript(() => {
    const wrap = (t) => {
      if (!t?.core || t.realCore) return;
      const real = (t.realCore = t.core);
      const invoke = async (cmd, args) => {
        if (cmd !== "api") return real.invoke(cmd, args);
        const a = await window.__e2eAnswer({ method: args.method, path: args.path, body: args.body ?? null });
        if (!a) return real.invoke(cmd, args);
        if ((a.status ?? 200) >= 400) throw a.json?.error ?? String(a.status);
        return a.json;
      };
      Object.defineProperty(t, "core", { value: { ...real, invoke }, configurable: true, writable: true });
    };
    // Tauri's own script runs first and has set __TAURI__ already; should it come later, it's wrapped as it's set.
    if (window.__TAURI__) wrap(window.__TAURI__);
    else {
      let v;
      Object.defineProperty(window, "__TAURI__", { configurable: true, get: () => v, set: (x) => { v = x; wrap(x); } });
    }
  });
  return {
    api,
    sessions,
    session: async (id) => (await sessions()).find((s) => s.id === id),
    // The window loaded at launch; reloading picks up the setup a spec did since (stand-ins, storage), as navigating
    // there does on the web.
    async open() { await page.reload(); return page; },
    // On the app's window, not the browser page Playwright hands the spec.
    async init(_, fn) { await page.addInitScript(fn); },
    async intercept(_, fn) { stand.intercept(fn); },
    async slow(_, ms, prefix) { stand.slow(ms, prefix); },
    async fail(_, prefix, error) { stand.fail(prefix, error); },
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
