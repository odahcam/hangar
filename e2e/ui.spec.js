// The web UI driven like a user would, against a real server and fixture sessions.
const { test, expect } = require("@playwright/test");
const { makeWorld, addSession, addLive, calls, startServer, cleanup, waitFor } = require("../test/helpers");

let w, srv, s;
test.beforeEach(async ({ page }) => {
  w = makeWorld();
  s = {
    api: addSession(w, { cwd: "/w/acme/api", agentName: "Rate limiter", turns: [{ user: "add buckets" }] }),
    web: addSession(w, { cwd: "/w/acme/web", agentName: "Checkout redesign", turns: [{ user: "ship it behind a flag" }] }),
    blog: addSession(w, { cwd: "/w/side/blog", agentName: "Blog migration", turns: [{ user: "keep old urls" }, { user: "perfect, that's it" }] }),
  };
  srv = await startServer(w);
  await srv.api("POST", "/api/order", { ids: [s.api.id, s.web.id, s.blog.id] });
  await page.goto(srv.base + "/");
});
test.afterEach(async () => { await srv.stop(); cleanup(w); });

const titles = (page) => page.locator("#list li .title");
const rowOf = (page, title) => page.locator("#list li", { has: page.locator(".title", { hasText: title }) });

test("lists pending sessions in priority order with their project", async ({ page }) => {
  await expect(titles(page)).toHaveText(["Rate limiter", "Checkout redesign", "Blog migration"]);
  await expect(rowOf(page, "Rate limiter").locator(".chip").first()).toHaveText("acme/api");
  await expect(page.locator("#counts")).toContainText("3 pending");
});

test("shows the headline tiles on the list views", async ({ page }) => {
  await expect(page.locator("#tiles .tile")).toHaveCount(7);
  await expect(page.locator("#tiles .tile").first()).toContainText("pending");
});

test("marking a session done moves it to the Done tab", async ({ page }) => {
  await rowOf(page, "Checkout redesign").getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator("#list li")).toHaveCount(2);
  await page.locator("#tabs").getByRole("button", { name: "Done" }).click();
  await expect(titles(page)).toHaveText(["Checkout redesign"]);
  expect((await srv.session(s.web.id)).doneBy).toBe("user");
});

test("a note is saved when the field loses focus", async ({ page }) => {
  const note = rowOf(page, "Rate limiter").locator("textarea");
  await note.fill("stopped at the gateway");
  await note.blur();
  await waitFor(async () => (await srv.session(s.api.id)).note === "stopped at the gateway");
});

test("the arrows reorder sessions", async ({ page }) => {
  await rowOf(page, "Blog migration").getByRole("button", { name: "↑" }).click();
  await expect(page.locator("#list li .title").nth(1)).toHaveText("Blog migration");
  expect((await srv.session(s.blog.id)).priority).toBe(20);
});

test("dragging a row onto another places it before that row", async ({ page }) => {
  // Step by step (two hovers so the target sees dragover) instead of dragTo, which is flaky for HTML5 drag under load.
  await rowOf(page, "Blog migration").locator(".rank").hover();
  await page.mouse.down();
  await rowOf(page, "Rate limiter").hover();
  await rowOf(page, "Rate limiter").hover({ position: { x: 20, y: 20 } });
  await page.mouse.up();
  await expect(page.locator("#list li .title").first()).toHaveText("Blog migration");
});

test("the filter and the project picker narrow the list", async ({ page }) => {
  await page.locator("#q").fill("flag");
  await expect(titles(page)).toHaveText(["Checkout redesign"]);
  await page.locator("#q").fill("");
  await page.locator("#proj").selectOption("side/blog");
  await expect(titles(page)).toHaveText(["Blog migration"]);
});

test("Resume opens the session in Terminal", async ({ page }) => {
  await rowOf(page, "Rate limiter").getByRole("button", { name: "Resume", exact: true }).click();
  await waitFor(() => calls(w, "osascript").some((c) => c.script.includes(`claude --resume ${s.api.id}`)));
});

test("Close needs a second click to confirm, then stops the open session", async ({ page }) => {
  const child = addLive(w, s.web);
  await page.reload();
  const row = rowOf(page, "Checkout redesign");
  await expect(row.locator(".live")).toBeVisible();
  await expect(rowOf(page, "Rate limiter").getByRole("button", { name: "Close" })).toHaveCount(0);
  await row.getByRole("button", { name: "Close" }).click();
  await expect(row.getByRole("button", { name: "Confirm close" })).toBeVisible();
  expect(child.exitCode === null && child.signalCode === null).toBe(true);
  await row.getByRole("button", { name: "Confirm close" }).click();
  await waitFor(() => child.signalCode !== null || child.exitCode !== null);
  await expect(row.locator(".live")).toHaveCount(0);
});

test("switching to Portuguese translates the page and is remembered", async ({ page }) => {
  await page.locator("#locale").selectOption("pt");
  await expect(page.locator("#tabs button").first()).toHaveText("Pendentes");
  await page.reload();
  await expect(page.locator("#tabs button").first()).toHaveText("Pendentes");
  await expect(page.locator("#counts")).toContainText("pendentes");
});

test("stopped sessions are flagged for attention; sessions in progress get a neutral mark", async ({ page }) => {
  await rowOf(page, "Checkout redesign").getByRole("button", { name: "In progress" }).click();
  const doing = rowOf(page, "Checkout redesign"), todo = rowOf(page, "Rate limiter");
  await expect(doing).toHaveClass(/\bdoing\b/);
  const token = (name) => page.evaluate((n) => {
    const probe = document.createElement("i");
    probe.style.color = `var(${n})`;
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);
  const css = (loc, prop) => loc.evaluate((el, p) => getComputedStyle(el)[p], prop);
  const [attention, progress] = [await token("--attention"), await token("--progress")];
  expect(await css(todo, "borderLeftColor")).toBe(attention);
  expect(await css(doing, "borderLeftColor")).toBe(progress);
  expect(await css(todo.locator('[data-s="todo"]'), "color")).toBe(attention);
  expect(await css(doing.locator('[data-s="doing"]'), "color")).toBe(progress);
});

test("the Insights tab shows its panels", async ({ page }) => {
  await page.locator("#tabs").getByRole("button", { name: "Insights" }).click();
  await expect(page.locator("#insights .panel h2")).toContainText([
    "Open × RAM", "Pending by project and age", "Prompts per day", "New × done per week",
    "Longest sessions", "Costliest sessions", "Storage", "Idle Terminal tabs",
  ]);
  await expect(page.locator("#toolbar")).toBeHidden();
});
