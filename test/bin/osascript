#!/usr/bin/env node
// Fake osascript: logs the AppleScript it was given and answers from FAKE_TABS instead of driving Terminal.
const fs = require("node:fs");
const script = process.argv[3] ?? "";
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin: "osascript", script }) + "\n");
const tabs = fs.readFileSync(process.env.FAKE_TABS, "utf8").split("\n").filter(Boolean);
if (script.includes("set out to")) {
  process.stdout.write(tabs.join("\n") + "\n");
} else {
  const tty = script.match(/if tty of t is "([^"]+)"/)?.[1];
  if (tty) process.stdout.write(tabs.some((t) => t.startsWith(tty + "\t")) ? "ok\n" : "missing\n");
}
