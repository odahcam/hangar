#!/usr/bin/env node
// Fake wt.exe: logs its arguments instead of opening a Windows Terminal tab.
const fs = require("node:fs");
// sessionEnv: which of the variables that mark a Claude Code session's child it was handed.
const sessionEnv = ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID"].filter((k) => k in process.env);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin: "wt", args: process.argv.slice(2), sessionEnv }) + "\n");
