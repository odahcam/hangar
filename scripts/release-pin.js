// The landing page and its install scripts (cloud/public) download one pinned release and check its SHA-256.
//   node scripts/release-pin.js [vX.Y.Z] [--from DIR]   pins that release (default: the latest)
//   node scripts/release-pin.js --check                 fails unless the pinned release is the latest one and its
//                                                       digests match
// With --from, the digests come from the files in DIR (the ones attached to the release) and the published assets
// must be byte for byte the same; without it they come from what GitHub serves at pin time.
// After pinning: commit, then `npx wrangler deploy` in cloud/.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REPO = "odahcam/hangar";
const PUBLIC = path.join(__dirname, "..", "cloud", "public");
const SH = path.join(PUBLIC, "install.sh");
const PS1 = path.join(PUBLIC, "install.ps1");
const HTML = path.join(PUBLIC, "index.html");

const assets = (v) => ({ mac: "Hangar.zip", win: `Hangar_${v}_x64-setup.exe` });

// The version ends up in a shell assignment, a PowerShell string, HTML and a regex: digits and dots only, whoever
// named the tag.
function version(s) {
  const v = String(s ?? "").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`not a version: ${JSON.stringify(s)}`);
  return v;
}

async function latest() {
  // The token (read-only, in CI) keeps the runner's shared address off the anonymous API limit.
  const headers = { "user-agent": "hangar-release-pin" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers });
  if (!r.ok) throw new Error(`latest release: HTTP ${r.status}`);
  return version((await r.json()).tag_name);
}

const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

async function sha256(v, name) {
  const r = await fetch(`https://github.com/${REPO}/releases/download/v${v}/${name}`);
  if (!r.ok) throw new Error(`${name} of v${v}: HTTP ${r.status}`);
  return digest(Buffer.from(await r.arrayBuffer()));
}

// The digest to pin: of the local file when there is one, after checking GitHub serves exactly that.
async function pinnedDigest(v, name, from) {
  const published = await sha256(v, name);
  if (!from) return published;
  const local = digest(fs.readFileSync(path.join(from, name)));
  if (local !== published) throw new Error(`${name}: the published asset of v${v} differs from ${path.join(from, name)}`);
  return local;
}

function pinned() {
  const sh = fs.readFileSync(SH, "utf8"), ps1 = fs.readFileSync(PS1, "utf8"), html = fs.readFileSync(HTML, "utf8");
  const one = (re, text) => (text.match(re) || [])[1];
  return {
    sh: { version: one(/^VERSION=(\S+)$/m, sh), mac: one(/^SHA256=(\w+)$/m, sh) },
    ps1: { version: one(/^\s*\$version = '([^']+)'$/m, ps1), win: one(/^\s*\$sha256 = '(\w+)'$/m, ps1) },
    html: [...new Set([...html.matchAll(/releases\/download\/v([\d.]+)\//g)].map((m) => m[1]))],
  };
}

async function check() {
  const v = await latest(), p = pinned(), a = assets(v);
  const errors = [];
  if (p.sh.version !== v) errors.push(`install.sh pins ${p.sh.version}, latest is ${v}`);
  if (p.ps1.version !== v) errors.push(`install.ps1 pins ${p.ps1.version}, latest is ${v}`);
  if (p.html.length !== 1 || p.html[0] !== v) errors.push(`index.html links ${p.html.join(", ") || "nothing"}, latest is ${v}`);
  if (!errors.length) {
    if ((await sha256(v, a.mac)) !== p.sh.mac) errors.push(`install.sh digest doesn't match ${a.mac} of v${v}`);
    if ((await sha256(v, a.win)) !== p.ps1.win) errors.push(`install.ps1 digest doesn't match ${a.win} of v${v}`);
  }
  if (errors.length) {
    console.error(errors.join("\n") + "\nRun: node scripts/release-pin.js, commit, then npx wrangler deploy in cloud/");
    process.exit(1);
  }
  console.log(`cloud/public pins v${v}, digests match`);
}

async function pin(args) {
  const i = args.indexOf("--from");
  const from = i >= 0 ? args.splice(i, 2)[1] : undefined;
  if (i >= 0 && !from) throw new Error("--from needs a directory");
  const v = args[0] ? version(args[0]) : await latest();
  const old = version(pinned().sh.version), a = assets(v);
  const mac = await pinnedDigest(v, a.mac, from), win = await pinnedDigest(v, a.win, from);
  const edit = (file, pairs) => {
    let text = fs.readFileSync(file, "utf8");
    for (const [re, to] of pairs) {
      if (!re.test(text)) throw new Error(`${path.basename(file)}: nothing matches ${re}`);
      text = text.replace(re, to);
    }
    fs.writeFileSync(file, text);
  };
  edit(SH, [[/^VERSION=\S+$/m, `VERSION=${v}`], [/^SHA256=\w+$/m, `SHA256=${mac}`]]);
  edit(PS1, [[/^(\s*\$version = ')[^']+(')$/m, `$1${v}$2`], [/^(\s*\$sha256 = ')\w+(')$/m, `$1${win}$2`]]);
  const esc = old.replace(/\./g, "\\.");
  edit(HTML, [[new RegExp(`\\bv${esc}\\b`, "g"), `v${v}`], [new RegExp(`Hangar_${esc}_x64`, "g"), `Hangar_${v}_x64`]]);
  console.log(`pinned v${v}\n  ${a.mac}  ${mac}\n  ${a.win}  ${win}\nNow commit, then npx wrangler deploy in cloud/`);
}

(process.argv[2] === "--check" ? check() : pin(process.argv.slice(2))).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
