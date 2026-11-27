#!/usr/bin/env node
// A stand-in that only says it was called, under the name it was called by (open.js logs as "open"): macOS `open`,
// herdr-app, a console's shell. A test can copy it under any name (a terminal app's own binary).
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin: path.basename(process.argv[1], ".js"), args: process.argv.slice(2) }) + "\n");
