// Every UI string exists in both languages, and every key the page uses is defined.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const web = path.join(__dirname, "..", "web");
const html = fs.readFileSync(path.join(web, "index.html"), "utf8");

function loadStrings() {
  const sandbox = { localStorage: { getItem: () => null }, navigator: { language: "en" }, document: { documentElement: {} }, location: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(web, "i18n.js"), "utf8") + "\nthis.STRINGS = STRINGS; this.t = t;", sandbox);
  return sandbox;
}

test("English and Portuguese define the same keys", () => {
  const { STRINGS } = loadStrings();
  assert.deepEqual(Object.keys(STRINGS.pt).sort(), Object.keys(STRINGS.en).sort());
});

test("both languages use the same placeholders for each key", () => {
  const { STRINGS } = loadStrings();
  const vars = (s) => (s.match(/\{\w+\}/g) || []).sort();
  for (const k of Object.keys(STRINGS.en)) assert.deepEqual(vars(STRINGS.pt[k]), vars(STRINGS.en[k]), k);
});

test("every key used by the page exists", () => {
  const { STRINGS } = loadStrings();
  const used = new Set([
    ...[...html.matchAll(/\bt\("(\w+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/data-i18n(?:-placeholder|-label)?="(\w+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/\["(col\w+)"/g)].map((m) => m[1]),
  ]);
  assert.ok(used.size > 50, `found ${used.size} keys`);
  for (const k of used) assert.ok(k in STRINGS.en, `missing key: ${k}`);
});

test("t() fills placeholders and falls back to the key", () => {
  const { t } = loadStrings();
  assert.equal(t("daysAgo", { n: 3 }), "3d ago");
  assert.equal(t("no_such_key"), "no_such_key");
});

test("the page has no hard-coded Portuguese left", () => {
  const script = html.slice(html.indexOf("<script>"));
  assert.doesNotMatch(script, /[ãõçáéíóú]/i);
});
