#!/usr/bin/env node
// Fake hc (herdr-core): terminals come from the JSON file FAKE_HC ([{ address, pid, fg, fgName, labels }]); label
// writes back to it; every call is logged, with whether it carried a terminal's identity (HC_TERMINAL_ID).
const fs = require("node:fs");
const [cmd, addr, ...rest] = process.argv.slice(2);
const terms = JSON.parse(fs.readFileSync(process.env.FAKE_HC, "utf8"));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin: "hc", args: process.argv.slice(2), identity: "HC_TERMINAL_ID" in process.env }) + "\n");
const t = terms.find((t) => t.address === addr);
const view = (t) => ({ address: t.address, pid: t.pid, state: "live", labels: t.labels, foreground: { pid: t.fg, name: t.fgName ?? "zsh" } });
if (cmd === "ls") process.stdout.write(JSON.stringify({ terminals: terms.map((t) => ({ address: t.address })) }));
else if (!t) { process.stderr.write("not_found"); process.exit(3); }
else if (cmd === "get") process.stdout.write(JSON.stringify(view(t)));
else if (cmd === "label") {
  for (const kv of rest) {
    const [k, v] = kv.split(/=(.*)/s);
    if (v) t.labels[k] = v; else delete t.labels[k];
  }
  fs.writeFileSync(process.env.FAKE_HC, JSON.stringify(terms));
} else if (cmd !== "send") process.exit(2);
