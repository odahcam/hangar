// The packaged app: builds, has a valid bundle and signature, and its bundled server runs without Node installed.
// Slow (runs scripts/build.sh); needs Xcode command line tools. Run with `npm run test:build`.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { makeWorld, addSession, cleanup, waitFor } = require("../test/helpers");

const ROOT = path.join(__dirname, "..");
const APP = path.join(ROOT, "build/Hangar.app");
const SERVER = path.join(APP, "Contents/Resources/hangar-server");
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });

let w;
before(() => {
  sh(path.join(ROOT, "scripts/build.sh"), [], { cwd: ROOT, stdio: "pipe" });
  w = makeWorld();
});
after(() => cleanup(w));

test("the bundle has the executable, server, UI, icon and Info.plist", () => {
  for (const p of ["Contents/MacOS/Hangar", "Contents/Resources/hangar-server", "Contents/Resources/web/index.html",
    "Contents/Resources/web/i18n.js", "Contents/Resources/Hangar.icns", "Contents/Info.plist"]) {
    assert.ok(fs.existsSync(path.join(APP, p)), p);
  }
  const plist = (key) => sh("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path.join(APP, "Contents/Info.plist")]).trim();
  assert.equal(plist("CFBundleIdentifier"), "com.odahcam.hangar");
  assert.equal(plist("CFBundleExecutable"), "Hangar");
  assert.equal(plist("CFBundleIconFile"), "Hangar");
  assert.ok(plist("NSAppleEventsUsageDescription").length > 0, "Terminal automation needs a usage description");
});

test("the signature is valid", () => {
  sh("codesign", ["--verify", "--deep", "--strict", APP]);
});

test("both binaries match this Mac's architecture", () => {
  const arch = sh("uname", ["-m"]).trim();
  for (const bin of ["Contents/MacOS/Hangar", "Contents/Resources/hangar-server"]) {
    assert.match(sh("file", [path.join(APP, bin)]), new RegExp(arch), bin);
  }
});

test("the bundled server runs on its own and serves the UI and API", async () => {
  const s = addSession(w, { agentName: "From the bundle", turns: [{ user: "hi" }] });
  const proc = spawn(SERVER, [], {
    env: { PATH: "/usr/bin:/bin", HOME: w.root, HANGAR_PORT: "0", HANGAR_CLAUDE_DIR: w.claude, HANGAR_DATA_DIR: w.data,
      HANGAR_WEB_DIR: path.join(APP, "Contents/Resources/web"), HANGAR_OSASCRIPT: "/usr/bin/true", NODE_NO_WARNINGS: "1",
      HANGAR_CLASSIFY_START_MS: "3600000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const port = await new Promise((resolve, reject) => {
      let out = "";
      proc.stdout.on("data", (d) => { out += d; const m = out.match(/HANGAR_PORT=(\d+)/); if (m) resolve(m[1]); });
      proc.on("exit", (c) => reject(new Error("server exited " + c)));
    });
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    const list = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json();
    assert.equal(list.find((x) => x.id === s.id).title, "From the bundle");
  } finally {
    proc.kill();
  }
});

test("the bundled server exits when the app that started it dies", async () => {
  // A shell stands in for the app: it starts the server in the background and is then killed.
  const parent = spawn("/bin/sh", ["-c", `"${SERVER}" & echo $!; wait`], {
    env: { PATH: "/usr/bin:/bin", HOME: w.root, HANGAR_PORT: "0", HANGAR_CLAUDE_DIR: w.claude, HANGAR_DATA_DIR: w.data,
      HANGAR_OSASCRIPT: "/usr/bin/true", HANGAR_EXIT_WITH_PARENT: "1", NODE_NO_WARNINGS: "1", HANGAR_CLASSIFY_START_MS: "3600000" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const pid = Number(await new Promise((r) => parent.stdout.once("data", (d) => r(String(d).trim().split("\n")[0]))));
  await new Promise((r) => setTimeout(r, 1500));
  parent.kill("SIGKILL");
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await waitFor(() => !alive(), { timeout: 15000 });
});

test("the release zip unpacks to a valid app", () => {
  const zip = path.join(w.root, "Hangar.zip"), out = path.join(w.root, "unzipped");
  sh("ditto", ["-c", "-k", "--keepParent", APP, zip]);
  sh("ditto", ["-x", "-k", zip, out]);
  sh("codesign", ["--verify", "--deep", "--strict", path.join(out, "Hangar.app")]);
});
