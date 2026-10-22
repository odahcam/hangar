#!/usr/bin/env node
// Fake `claude -p`: logs args and prompt, answers with the first verdict rule from FAKE_VERDICTS whose `match` is in the prompt.
const fs = require("node:fs");
let stdin = "";
process.stdin.on("data", (d) => { stdin += d; });
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin: "claude", args: process.argv.slice(2), stdin }) + "\n");
  const rules = JSON.parse(fs.readFileSync(process.env.FAKE_VERDICTS, "utf8"));
  const rule = rules.find((r) => stdin.includes(r.match ?? ""));
  if (!rule || rule.fail) {
    process.stderr.write("fake claude failure\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ type: "result", structured_output: rule.verdict, total_cost_usd: 0.001 }));
});
