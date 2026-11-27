// herdr terminals that lost their Claude session to a restart: the global Restore button and its outcomes; the herdr
// settings and each account's SessionStart hook.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { makeWorld, addSession, cleanup } = require("../test/helpers");
const { launch } = require("./target");

let w, srv, id;
test.beforeEach(async () => {
  w = makeWorld();
  id = addSession(w, { cwd: "/w/acme/api", agentName: "Rate limiter", turns: [{ user: "add buckets" }] });
  srv = await launch(w);
});
test.afterEach(async () => { await srv?.stop(); srv = null; if (w) cleanup(w); w = null; });

// hc stands in: one recovered terminal until a restore call, which answers `answer`.
function herdr(answer) {
  let lost = [{ terminal: "t7", session: id }], posted = 0;
  const handler = ({ method, path }) => {
    if (method === "GET" && path === "/api/herdr") return { json: { available: true, restorable: lost } };
    if (method === "POST" && path === "/api/restore-herdr") {
      posted++;
      if (!answer.failed.length) lost = [];
      return { json: answer };
    }
    return null;
  };
  return { handler, posted: () => posted };
}

test("the sessions herdr lost show as one button that restores them", async ({ page }) => {
  const h = herdr({ restored: [{ terminal: "t7", session: id }], failed: [] });
  await srv.intercept(page, h.handler);
  page = await srv.open(page);
  const b = page.locator("#restoreHerdr");
  await expect(b).toHaveText("Restore 1 in herdr");
  await b.click();
  await expect(page.locator("#toast")).toContainText("Sessions restored in herdr");
  expect(h.posted()).toBe(1);
  await expect(b).toBeHidden();
});

test("a restore that fails says why and keeps the button", async ({ page }) => {
  const h = herdr({ restored: [], failed: [{ terminal: "t7", session: id, error: "unsupported shell fish" }] });
  await srv.intercept(page, h.handler);
  page = await srv.open(page);
  const b = page.locator("#restoreHerdr");
  await b.click();
  await expect(page.locator("#toast .error")).toContainText("1 not restored: unsupported shell fish");
  await expect(b).toHaveText("Restore 1 in herdr");
  await expect(b).toBeEnabled();
});

test("Settings turn herdr off, make restoring wait to be asked and set the hc path", async ({ page }) => {
  const st = { enabled: true, auto: true, hcPath: "", hc: "/u/.local/bin/hc", available: true, restorable: [] }, patches = [];
  await srv.intercept(page, ({ method, path, body }) => {
    if (path !== "/api/herdr") return null;
    if (method === "PATCH") { patches.push(body); Object.assign(st, body, body.hcPath != null ? { hc: body.hcPath || "/u/.local/bin/hc" } : {}); return { json: { ok: true } }; }
    return { json: st };
  });
  page = await srv.open(page);
  await page.locator("#settingsBtn").click();
  await expect(page.locator("#herdrHc")).toHaveText("hc answers at /u/.local/bin/hc");
  await page.locator("#herdrAuto").selectOption("0");
  await expect.poll(() => patches).toEqual([{ auto: false }]);
  await page.locator("#herdrPath").fill("/opt/hc");
  await page.locator("#herdrPath").press("Enter");
  await expect(page.locator("#herdrHc")).toHaveText("hc answers at /opt/hc");
  await page.locator("#herdrOn").uncheck();
  await expect.poll(() => patches.at(-1)).toEqual({ enabled: false });
  await expect(page.locator("#herdrAuto")).toBeDisabled();
  await expect(page.locator("#herdrHc")).toBeHidden();
});

// The SessionStart hook, per account, against the real core: it lands in the account's own settings.json.
const settingsOf = () => path.join(w.claude, "settings.json");
const hookIn = () => { try { return JSON.parse(fs.readFileSync(settingsOf(), "utf8")).hooks?.SessionStart?.some((g) => g.hooks.some((h) => h.command.includes("--session-start"))) ?? false; } catch { return false; } };
const hookBox = (page) => page.getByRole("checkbox", { name: /SessionStart hook/ });

test("each account offers the SessionStart hook while herdr is on; the box installs and removes it", async ({ page }) => {
  page = await srv.open(page);
  await page.locator("#settingsBtn").click();
  const box = hookBox(page);
  await expect(box).toHaveCount(1);
  await expect(box).not.toBeChecked();
  await box.check();
  await expect.poll(hookIn).toBe(true);
  await hookBox(page).uncheck();
  await expect.poll(hookIn).toBe(false);
  // herdr off: the hooks go and so does the box; back on, it's offered again, unchecked.
  await hookBox(page).check();
  await expect.poll(hookIn).toBe(true);
  await page.locator("#herdrOn").uncheck();
  await expect.poll(hookIn).toBe(false);
  await expect(hookBox(page)).toHaveCount(0);
  await page.locator("#herdrOn").check();
  await expect(hookBox(page)).not.toBeChecked();
});

test("a hook that can't go into settings.json says why and stays unchecked", async ({ page }) => {
  fs.writeFileSync(settingsOf(), "{ not json");
  page = await srv.open(page);
  await page.locator("#settingsBtn").click();
  await hookBox(page).check();
  await expect(page.locator("#toast .error")).toContainText("settings.json isn't valid JSON");
  await expect(hookBox(page)).not.toBeChecked();
  expect(fs.readFileSync(settingsOf(), "utf8")).toBe("{ not json");
});

test("the herdr panel has no hook option of its own, and its hc path field looks like the other fields", async ({ page }) => {
  page = await srv.open(page);
  await page.locator("#settingsBtn").click();
  const panel = page.locator("#herdrPath").locator("xpath=ancestor::*[contains(@class,'panel')][1]");
  await expect(panel).not.toContainText("SessionStart");
  await expect(panel).not.toContainText("coming soon");
  const bg = (loc) => loc.evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(await bg(page.locator("#herdrPath"))).toBe(await bg(page.getByRole("spinbutton", { name: "Days to keep transcripts" }).first()));
});

test("without hc the button stays away", async ({ page }) => {
  page = await srv.open(page);
  await expect(page.locator("#list li .title")).toHaveText(["Rate limiter"]);
  await expect(page.locator("#restoreHerdr")).toBeHidden();
});
