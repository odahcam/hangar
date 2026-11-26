#!/usr/bin/env node
// Fake herdr-app: logs its arguments (see log.js); `ls` answers the spaces in FAKE_HERDR_SPACES (none without it).
require("./log.js");
const fs = require("node:fs");
if (process.argv[2] === "ls") {
  const f = process.env.FAKE_HERDR_SPACES;
  process.stdout.write(f && fs.existsSync(f) ? fs.readFileSync(f, "utf8") : JSON.stringify({ spaces: [] }));
}
