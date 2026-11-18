#!/usr/bin/env node
// Fake wt.exe: logs its arguments instead of opening a Windows Terminal tab.
const fs = require("node:fs");
// sessionEnv: which of the variables that mark a Claude Code session's child it was handed.
const sessionEnv = ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID"].filter((k) => k in process.env);
// terminalEnv: which of the variables describing the terminal Hangar was started from it was handed.
const terminalEnv = ["NO_COLOR", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"].filter((k) => k in process.env);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin: "wt", args: process.argv.slice(2), sessionEnv, terminalEnv }) + "\n");
