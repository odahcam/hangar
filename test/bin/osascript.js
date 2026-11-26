#!/usr/bin/env node
// Fake osascript: logs the AppleScript it was given and answers from FAKE_TABS (Terminal's tabs) or FAKE_ITERM
// (iTerm2's sessions) instead of driving them. A script naming FAKE_OSASCRIPT_FAIL's app fails, as when that app may
// not be driven.
const fs = require("node:fs");
const script = process.argv[3] ?? "";
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin: "osascript", script }) + "\n");
const fail = process.env.FAKE_OSASCRIPT_FAIL;
if (fail && script.includes(`application "${fail}"`)) {
  process.stderr.write(`Not authorized to send Apple events to ${fail}.`);
  process.exit(1);
}
const iterm = script.includes('application "iTerm"');
const file = iterm ? process.env.FAKE_ITERM : process.env.FAKE_TABS;
const tabs = file && fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
if (script.includes("set out to")) {
  process.stdout.write(tabs.join("\n") + "\n");
} else {
  const tty = script.match(/if tty of [ts] is "([^"]+)"/)?.[1];
  if (tty) process.stdout.write(tabs.some((t) => t.startsWith(tty + "\t") || t === tty) ? "ok\n" : "missing\n");
}
