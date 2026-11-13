#!/usr/bin/env node
// Fake `claude -p`: logs args, prompt and the account it ran under (CLAUDE_CONFIG_DIR), answers with the first verdict rule from FAKE_VERDICTS whose `match` is in the prompt.
const fs = require("node:fs");
let stdin = "";
process.stdin.on("data", (d) => { stdin += d; });
process.stdin.on("end", () => {
  // sessionEnv: which of the variables that mark a Claude Code session's child it was handed.
  const sessionEnv = ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID"].filter((k) => k in process.env);
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin: "claude", args: process.argv.slice(2), stdin, config: process.env.CLAUDE_CONFIG_DIR ?? null, sessionEnv }) + "\n");
  const rules = JSON.parse(fs.readFileSync(process.env.FAKE_VERDICTS, "utf8"));
  const rule = rules.find((r) => stdin.includes(r.match ?? ""));
  if (!rule || rule.fail) {
    process.stderr.write("fake claude failure\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ type: "result", structured_output: rule.verdict, total_cost_usd: 0.001 }));
});
