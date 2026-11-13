// Builds the resume helper (core/src/bin/hangar-resume.rs) and puts it where the app bundle takes it from:
// app/binaries/hangar-resume-<target triple>, Tauri's externalBin (see app/tauri.conf.json), which lands beside the
// app's executable (Hangar.app/Contents/MacOS, the install folder on Windows).
//   node scripts/sidecar.js [debug|release]
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const profile = process.argv[2] === "release" ? "release" : "debug";
const root = path.join(__dirname, "..");
const exe = process.platform === "win32" ? ".exe" : "";
execFileSync("cargo", ["build", "-q", "-p", "hangar-core", "--bin", "hangar-resume", ...(profile === "release" ? ["--release"] : [])],
  { cwd: root, stdio: "inherit" });
const triple = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (\S+)$/m)[1];
fs.mkdirSync(path.join(root, "app", "binaries"), { recursive: true });
fs.copyFileSync(path.join(root, "target", profile, "hangar-resume" + exe), path.join(root, "app", "binaries", `hangar-resume-${triple}${exe}`));
