// herdr terminals that lost their Claude session to a restart: the global Restore button and its outcomes.
const { test, expect } = require("@playwright/test");
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

test("without hc the button stays away", async ({ page }) => {
  page = await srv.open(page);
  await expect(page.locator("#list li .title")).toHaveText(["Rate limiter"]);
  await expect(page.locator("#restoreHerdr")).toBeHidden();
});
