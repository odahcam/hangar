// The repository is public-ready: no personal paths, emails or credentials in tracked files.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n")
  .filter((f) => f && !/\.(png|icns)$/.test(f) && f !== "package-lock.json");

const PATTERNS = [
  [/\/Users\/(?!demo\b)[a-z][\w.-]*/i, "home directory path"],
  [/[\w.+-]+@[\w-]+\.[\w.]+/, "email address"],
  [/\bsk-ant-[\w-]{10,}/, "Anthropic API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
];
// Addresses that are part of the product, not someone's identity.
const ALLOWED_EMAILS = ["noreply@anthropic.com"];
// Retina asset names (icon@2x.png) look like addresses too.
const ASSET_NAME = /@\d+x\.(png|jpe?g|gif|webp)$/;

test("tracked files contain no personal paths, emails or credentials", () => {
  const found = [];
  for (const f of tracked) {
    const text = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const [re, what] of PATTERNS) {
      const m = text.match(new RegExp(re.source, re.flags + "g")) || [];
      for (const hit of m) if (!ALLOWED_EMAILS.includes(hit) && !ASSET_NAME.test(hit)) found.push(`${f}: ${what}: ${hit}`);
    }
  }
  assert.deepEqual(found, []);
});
