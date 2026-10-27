// The packaged desktop app: `tauri build` succeeds, the bundle is what the OS expects, and the packaged app starts on
// its own over a fixture world (scans it, backs up its pending transcript) and keeps running.
// Slow (a release build); on macOS needs the Xcode command line tools. Run with `npm run test:build`.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, DARWIN, WIN32, makeWorld, addSession, cleanup, stopApp, waitFor } = require("../test/helpers");

const RELEASE = path.join(ROOT, "target/release");
const APP = path.join(RELEASE, "bundle/macos/Hangar.app");
const EXE = DARWIN ? path.join(APP, "Contents/MacOS/Hangar") : path.join(RELEASE, WIN32 ? "Hangar.exe" : "Hangar");
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });
const du = (p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).reduce((n, f) => n + du(path.join(p, f)), 0) : fs.statSync(p).size;

let w;
before(() => {
  // npx is a .cmd on Windows, which only runs through a shell.
  sh(WIN32 ? "npx.cmd" : "npx", ["tauri", "build"], { cwd: ROOT, stdio: "pipe", shell: WIN32 });
  w = makeWorld();
});
after(() => cleanup(w));

test("the macOS bundle has the executable, icon and Info.plist", { skip: !DARWIN }, () => {
  for (const p of ["Contents/MacOS/Hangar", "Contents/Resources/icon.icns", "Contents/Info.plist"]) {
    assert.ok(fs.existsSync(path.join(APP, p)), p);
  }
  const plist = (key) => sh("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path.join(APP, "Contents/Info.plist")]).trim();
  assert.equal(plist("CFBundleIdentifier"), "com.odahcam.hangar");
  assert.equal(plist("CFBundleExecutable"), "Hangar");
  assert.equal(plist("LSMinimumSystemVersion"), "13.0");
  assert.ok(plist("NSAppleEventsUsageDescription").length > 0, "Terminal automation needs a usage description");
});

test("the macOS signature is valid", { skip: !DARWIN }, () => {
  sh("codesign", ["--verify", "--deep", "--strict", APP]);
});

test("the macOS binary matches this Mac's architecture", { skip: !DARWIN }, () => {
  assert.match(sh("file", [EXE]), new RegExp(sh("uname", ["-m"]).trim()));
});

test("the macOS release zip unpacks to a valid app", { skip: !DARWIN }, () => {
  const zip = path.join(w.root, "Hangar.zip"), out = path.join(w.root, "unzipped");
  sh("ditto", ["-c", "-k", "--keepParent", APP, zip]);
  sh("ditto", ["-x", "-k", zip, out]);
  sh("codesign", ["--verify", "--deep", "--strict", path.join(out, "Hangar.app")]);
});

test("the Windows installer is built", { skip: !WIN32 }, () => {
  const dir = path.join(RELEASE, "bundle/nsis");
  assert.ok(fs.readdirSync(dir).some((f) => /^Hangar_.*-setup\.exe$/.test(f)), fs.readdirSync(dir).join(", "));
});

test("the app is one small binary, without a bundled Node", () => {
  const mb = du(DARWIN ? APP : EXE) / 2 ** 20;
  assert.ok(mb < 40, `${mb.toFixed(1)} MB`);
});

test("the packaged app starts on its own, scans the world and keeps running", async () => {
  const s = addSession(w, { agentName: "From the bundle", turns: [{ user: "hi" }] });
  const proc = spawn(EXE, [], {
    env: { ...process.env, HANGAR_CLAUDE_DIR: w.claude, HANGAR_DATA_DIR: w.data, HANGAR_WEBVIEW_DATA: path.join(w.root, "webview"), HANGAR_WINDOW_OFFSCREEN: "1",
      HANGAR_CLASSIFY_START_MS: "3600000" },
    stdio: "ignore",
  });
  let exit = null;
  proc.on("exit", (code, signal) => { exit = { code, signal }; });
  try {
    await waitFor(() => fs.existsSync(path.join(w.data, "transcripts", s.id + ".jsonl")), { timeout: 20000 });
    assert.ok(fs.existsSync(path.join(w.data, "state.db")));
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(exit, null, "still running");
  } finally {
    await stopApp(proc);
  }
});
