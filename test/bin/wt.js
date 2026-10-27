#!/usr/bin/env node
// Fake wt.exe: logs its arguments instead of opening a Windows Terminal tab.
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin: "wt", args: process.argv.slice(2) }) + "\n");
