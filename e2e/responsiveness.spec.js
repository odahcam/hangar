// The list reacts at once to status changes and reordering, even when the server is slow to answer.
const { test, expect } = require("@playwright/test");
const { makeWorld, addSession, startServer, cleanup, waitFor } = require("../test/helpers");

let w, srv, s;
const SLOW_MS = 3000;
// Well under SLOW_MS: the change must show without waiting for any server round trip.
const QUICK = { timeout: 1000 };

test.beforeEach(async ({ page }) => {
  w = makeWorld();
  s = {
    a: addSession(w, { agentName: "Alpha", turns: [{ user: "a" }] }),
    b: addSession(w, { agentName: "Bravo", turns: [{ user: "b" }] }),
    c: addSession(w, { agentName: "Charlie", turns: [{ user: "c" }] }),
  };
  srv = await startServer(w);
  await srv.api("POST", "/api/order", { ids: [s.a.id, s.b.id, s.c.id] });
  await page.goto(srv.base + "/");
  await expect(page.locator("#list li")).toHaveCount(3);
  // From here on every API call takes SLOW_MS to answer.
  await page.route("**/api/**", async (route) => {
    await new Promise((r) => setTimeout(r, SLOW_MS));
    await route.continue();
  });
});
test.afterEach(async () => { await srv.stop(); cleanup(w); });

const rowOf = (page, title) => page.locator("#list li", { has: page.locator(".title", { hasText: title }) });
const titles = (page) => page.locator("#list li .title");

test("a status change shows immediately and is saved", async ({ page }) => {
  await rowOf(page, "Bravo").getByRole("button", { name: "In progress" }).click();
  await expect(rowOf(page, "Bravo")).toHaveClass(/\bdoing\b/, QUICK);
  await waitFor(async () => (await srv.session(s.b.id)).status === "doing", { timeout: SLOW_MS * 3 });
});

test("marking done removes the row immediately", async ({ page }) => {
  await rowOf(page, "Bravo").getByRole("button", { name: "Done", exact: true }).click();
  await expect(titles(page)).toHaveText(["Alpha", "Charlie"], QUICK);
  await waitFor(async () => (await srv.session(s.b.id)).status === "done", { timeout: SLOW_MS * 3 });
});

test("the arrows reorder immediately and the order is saved", async ({ page }) => {
  await rowOf(page, "Charlie").getByRole("button", { name: "↑" }).click();
  await expect(titles(page)).toHaveText(["Alpha", "Charlie", "Bravo"], QUICK);
  await waitFor(async () => (await srv.session(s.c.id)).priority === 20, { timeout: SLOW_MS * 3 });
});

test("dragging reorders immediately", async ({ page }) => {
  await rowOf(page, "Charlie").locator(".rank").hover();
  await page.mouse.down();
  await rowOf(page, "Alpha").hover();
  await rowOf(page, "Alpha").hover({ position: { x: 20, y: 20 } });
  await page.mouse.up();
  await expect(titles(page)).toHaveText(["Charlie", "Alpha", "Bravo"], QUICK);
});

test("a change the server rejects is rolled back with a message", async ({ page }) => {
  await page.unroute("**/api/**");
  await page.route("**/api/session/**", (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));
  await rowOf(page, "Bravo").getByRole("button", { name: "In progress" }).click();
  await expect(page.locator("#toast")).toContainText("boom");
  await expect(rowOf(page, "Bravo")).toHaveClass(/\btodo\b/);
  expect((await srv.session(s.b.id)).status).toBe("todo");
});
