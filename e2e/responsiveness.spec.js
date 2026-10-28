// The list reacts at once to status changes and reordering, even when the server is slow to answer.
const { test, expect } = require("@playwright/test");
const { DARWIN, makeWorld, addSession, cleanup, waitFor } = require("../test/helpers");
const { launch } = require("./target");

let w, srv, s, page;
const SLOW_MS = 3000;
// Well under SLOW_MS: the change must show without waiting for any server round trip.
const QUICK = { timeout: 1000 };

test.beforeEach(async ({ page: browserPage }) => {
  w = makeWorld();
  s = {
    a: addSession(w, { agentName: "Alpha", turns: [{ user: "a" }] }),
    b: addSession(w, { agentName: "Bravo", turns: [{ user: "b" }] }),
    c: addSession(w, { agentName: "Charlie", turns: [{ user: "c" }] }),
  };
  srv = await launch(w);
  await srv.api("POST", "/api/order", { ids: [s.a.id, s.b.id, s.c.id] });
  page = await srv.open(browserPage);
  await expect(page.locator("#list li")).toHaveCount(3);
  // From here on every API call takes SLOW_MS to answer.
  await srv.slow(page, SLOW_MS);
});
test.afterEach(async () => { await srv?.stop(); srv = null; cleanup(w); });

const rowOf = (page, title) => page.locator("#list li", { has: page.locator(".title", { hasText: title }) });
const titles = (page) => page.locator("#list li .title");

test("a status change shows immediately and is saved", async () => {
  await rowOf(page, "Bravo").getByRole("button", { name: "In progress" }).click();
  await expect(rowOf(page, "Bravo")).toHaveClass(/\bdoing\b/, QUICK);
  await waitFor(async () => (await srv.session(s.b.id)).status === "doing", { timeout: SLOW_MS * 3 });
});

test("marking done removes the row immediately", async () => {
  await rowOf(page, "Bravo").getByRole("button", { name: "Done", exact: true }).click();
  await expect(titles(page)).toHaveText(["Alpha", "Charlie"], QUICK);
  await waitFor(async () => (await srv.session(s.b.id)).status === "done", { timeout: SLOW_MS * 3 });
});

test("the arrows reorder immediately and the order is saved", async () => {
  await rowOf(page, "Charlie").getByRole("button", { name: "↑" }).click();
  await expect(titles(page)).toHaveText(["Alpha", "Charlie", "Bravo"], QUICK);
  await waitFor(async () => (await srv.session(s.c.id)).priority === 20, { timeout: SLOW_MS * 3 });
});

test("dragging reorders immediately", async () => {
  // The tiles arrive after the list and push it down; wait for them so the drag starts on a row that stays put.
  await expect(page.locator("#tiles .tile")).toHaveCount(DARWIN ? 7 : 6);
  await rowOf(page, "Charlie").locator(".rank .grip").hover();
  await page.mouse.down();
  await rowOf(page, "Alpha").hover();
  await rowOf(page, "Alpha").hover({ position: { x: 20, y: 20 } });
  await page.mouse.up();
  await expect(titles(page)).toHaveText(["Charlie", "Alpha", "Bravo"], QUICK);
});

test("Resume shows it is working until Terminal answers", async () => {
  const resume = rowOf(page, "Alpha").getByRole("button", { name: "Resume", exact: true });
  await resume.click();
  const busy = rowOf(page, "Alpha").getByRole("button", { name: "Opening…" });
  await expect(busy).toBeDisabled(QUICK);
  await expect(busy).toHaveAttribute("aria-busy", "true");
  await expect(rowOf(page, "Alpha").getByRole("button", { name: "Resume", exact: true })).toBeEnabled({ timeout: SLOW_MS * 4 });
});

test("Close shows it is working until the session has stopped", async () => {
  await srv.slow(page, 0);
  const { addLive } = require("../test/helpers");
  addLive(w, s.b);
  await page.reload();
  await srv.slow(page, SLOW_MS);
  const row = rowOf(page, "Bravo");
  await row.getByRole("button", { name: "Close" }).click();
  await row.getByRole("button", { name: "Confirm close" }).click();
  await expect(row.getByRole("button", { name: "Closing…" })).toBeDisabled(QUICK);
  await expect(row.locator(".live")).toHaveCount(0, { timeout: SLOW_MS * 4 });
});

test("a change the server rejects is rolled back with a message", async () => {
  await srv.slow(page, 0);
  await srv.fail(page, "/api/session/", "boom");
  await rowOf(page, "Bravo").getByRole("button", { name: "In progress" }).click();
  await expect(page.locator("#toast")).toContainText("boom");
  await expect(rowOf(page, "Bravo")).toHaveClass(/\btodo\b/);
  expect((await srv.session(s.b.id)).status).toBe("todo");
});
