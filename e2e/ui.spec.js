// The web UI driven like a user would, against a real server and fixture sessions.
const { test, expect } = require("@playwright/test");
const { DARWIN, makeWorld, addSession, appendTurns, addLive, resumed, cleanup, waitFor } = require("../test/helpers");
const { launch } = require("./target");

let w, srv, s, page;
test.beforeEach(async ({ page: browserPage }) => {
  w = makeWorld();
  s = {
    api: addSession(w, { cwd: "/w/acme/api", agentName: "Rate limiter", turns: [{ user: "add buckets" }] }),
    web: addSession(w, { cwd: "/w/acme/web", agentName: "Checkout redesign", turns: [{ user: "ship it behind a flag" }] }),
    blog: addSession(w, { cwd: "/w/side/blog", agentName: "Blog migration", turns: [{ user: "keep old urls" }, { user: "perfect, that's it" }] }),
  };
  srv = await launch(w);
  await srv.api("POST", "/api/order", { ids: [s.api.id, s.web.id, s.blog.id] });
  page = await srv.open(browserPage);
});
test.afterEach(async () => { await srv?.stop(); srv = null; cleanup(w); });

const titles = (page) => page.locator("#list li .title");
const rowOf = (page, title) => page.locator("#list li", { has: page.locator(".title", { hasText: title }) });

test("lists pending sessions in priority order with their project", async () => {
  await expect(titles(page)).toHaveText(["Rate limiter", "Checkout redesign", "Blog migration"]);
  await expect(rowOf(page, "Rate limiter").locator(".chip").first()).toHaveText("acme/api");
  await expect(page.locator("#counts")).toContainText("3 pending");
});

test("shows the headline tiles on the list views", async () => {
  // The idle-tabs tile only exists where the terminal can list its tabs (macOS).
  await expect(page.locator("#tiles .tile")).toHaveCount(DARWIN ? 7 : 6);
  await expect(page.locator("#tiles .tile").first()).toContainText("pending");
});

test("marking a session done moves it to the Done tab", async () => {
  await rowOf(page, "Checkout redesign").getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator("#list li")).toHaveCount(2);
  await page.locator("#tabs").getByRole("button", { name: "Done" }).click();
  await expect(titles(page)).toHaveText(["Checkout redesign"]);
  expect((await srv.session(s.web.id)).doneBy).toBe("user");
});

test("a note is saved when the field loses focus", async () => {
  const note = rowOf(page, "Rate limiter").locator("textarea");
  await note.fill("stopped at the gateway");
  await note.blur();
  await waitFor(async () => (await srv.session(s.api.id)).note === "stopped at the gateway");
});

test("the arrows reorder sessions", async () => {
  await rowOf(page, "Blog migration").getByRole("button", { name: "↑" }).click();
  await expect(page.locator("#list li .title").nth(1)).toHaveText("Blog migration");
  expect((await srv.session(s.blog.id)).priority).toBe(20);
});

test("dragging a row onto another places it before that row", async () => {
  // Step by step (two hovers so the target sees dragover) instead of dragTo, which is flaky for HTML5 drag under load.
  // The tiles first: they arrive after the list and push it down, which would move the row out from under the drag.
  await expect(page.locator("#tiles .tile")).toHaveCount(DARWIN ? 7 : 6);
  await rowOf(page, "Blog migration").locator(".rank .grip").hover();
  await page.mouse.down();
  await rowOf(page, "Rate limiter").hover();
  await rowOf(page, "Rate limiter").hover({ position: { x: 20, y: 20 } });
  await page.mouse.up();
  await expect(page.locator("#list li .title").first()).toHaveText("Blog migration");
});

test("the filter and the project picker narrow the list", async () => {
  await page.locator("#q").fill("flag");
  await expect(titles(page)).toHaveText(["Checkout redesign"]);
  await page.locator("#q").fill("");
  await page.locator("#proj").selectOption("side/blog");
  await expect(titles(page)).toHaveText(["Blog migration"]);
  await expect(page.locator("#list li .rank .num")).toHaveText(["3"]);
});

test("sorting by last message sent is remembered and leaves the order you set alone", async () => {
  appendTurns(s.web, [{ user: "one more thing" }]);
  await page.reload();
  await page.locator("#sort").selectOption("prompt");
  await expect(page.locator("#sortDir")).toHaveText(/Descending/);
  await expect(titles(page).first()).toHaveText("Checkout redesign");
  await expect(page.locator("#list li").first().locator(".rank .num")).toHaveText("2");
  // Under another sort the priority still edits; only dragging, which needs the list in priority order, is gone.
  await expect(page.locator("#list .grip")).toHaveCount(0);
  await page.locator("#list li").first().getByRole("button", { name: "↑" }).click();
  await expect(page.locator("#list li").first().locator(".rank .num")).toHaveText("1");
  await expect(titles(page).first()).toHaveText("Checkout redesign");
  await page.locator("#list li").first().getByRole("button", { name: "↓" }).click();
  await expect(page.locator("#list li").first().locator(".rank .num")).toHaveText("2");
  await page.locator("#sortDir").click();
  await expect(titles(page).last()).toHaveText("Checkout redesign");
  await page.reload();
  await expect(page.locator("#sort")).toHaveValue("prompt");
  await expect(page.locator("#sortDir")).toHaveText(/Ascending/);
  await page.locator("#sort").selectOption({ label: "Priority" });
  await expect(titles(page)).toHaveText(["Rate limiter", "Checkout redesign", "Blog migration"]);
  await page.locator("#sortDir").click();
  await expect(titles(page)).toHaveText(["Blog migration", "Checkout redesign", "Rate limiter"]);
  await expect(page.locator("#list li .rank .num")).toHaveText(["3", "2", "1"]);
});

test("a session not prioritized yet shows a dash, and the others keep their numbers", async () => {
  addSession(w, { cwd: "/w/acme/api", agentName: "Fresh one", turns: [{ user: "hi" }] });
  await page.reload();
  await expect(titles(page)).toHaveText(["Fresh one", "Rate limiter", "Checkout redesign", "Blog migration"]);
  await expect(page.locator("#list li .rank .num")).toHaveText(["—", "1", "2", "3"]);
  await expect(rowOf(page, "Fresh one").locator(".chip", { hasText: "not prioritized" })).toHaveCount(1);
  await expect(rowOf(page, "Fresh one").getByRole("button", { name: "↓" })).toHaveCount(0);
  // Moving a prioritized session leaves the untriaged one alone.
  await rowOf(page, "Rate limiter").getByRole("button", { name: "↓" }).click();
  await expect(page.locator("#list li .rank .num")).toHaveText(["—", "1", "2", "3"]);
  await expect(titles(page)).toHaveText(["Fresh one", "Checkout redesign", "Rate limiter", "Blog migration"]);
  const fresh = (await srv.sessions()).find((x) => x.title === "Fresh one");
  expect(fresh.priority).toBeNull();
});

test("clicking the number takes a new priority", async () => {
  await rowOf(page, "Blog migration").locator(".rank .num").click();
  await rowOf(page, "Blog migration").locator(".rank input").fill("1");
  await rowOf(page, "Blog migration").locator(".rank input").press("Enter");
  await expect(titles(page)).toHaveText(["Blog migration", "Rate limiter", "Checkout redesign"]);
  await waitFor(async () => (await srv.session(s.blog.id)).priority === 10);
  // An untriaged session gets its first place the same way; the others keep theirs.
  addSession(w, { cwd: "/w/acme/api", agentName: "Fresh one", turns: [{ user: "hi" }] });
  await page.reload();
  await rowOf(page, "Fresh one").locator(".rank .num").click();
  await rowOf(page, "Fresh one").locator(".rank input").fill("2");
  await rowOf(page, "Fresh one").locator(".rank input").press("Enter");
  await expect(titles(page)).toHaveText(["Blog migration", "Fresh one", "Rate limiter", "Checkout redesign"]);
});

test("dropping on the lower half of a row places the session after it", async () => {
  await expect(page.locator("#tiles .tile")).toHaveCount(DARWIN ? 7 : 6);
  await rowOf(page, "Rate limiter").locator(".rank .grip").hover();
  await page.mouse.down();
  const target = rowOf(page, "Checkout redesign");
  await target.hover();
  const box = await target.boundingBox();
  await target.hover({ position: { x: 20, y: box.height - 8 } });
  await page.mouse.up();
  await expect(titles(page)).toHaveText(["Checkout redesign", "Rate limiter", "Blog migration"]);
});

test("Resume opens the session in the terminal", async () => {
  await rowOf(page, "Rate limiter").getByRole("button", { name: "Resume", exact: true }).click();
  await waitFor(() => resumed(w, s.api.id));
});

test("Close needs a second click to confirm, then stops the open session", async () => {
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

test("switching to Portuguese translates the page and is remembered", async () => {
  await page.locator("#locale").selectOption("pt");
  await expect(page.locator("#tabs button").first()).toHaveText("Pendentes");
  await page.reload();
  await expect(page.locator("#tabs button").first()).toHaveText("Pendentes");
  await expect(page.locator("#counts")).toContainText("pendentes");
});

test("stopped sessions are flagged for attention; sessions in progress get a neutral mark", async () => {
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

test("Close idle tabs shows it is working until Terminal answers", async () => {
  test.skip(!DARWIN, "only Terminal.app can list its tabs");
  const { setTabs } = require("../test/helpers");
  setTabs(w, [{ tty: "ttys001", busy: false }]);
  await page.locator("#tabs").getByRole("button", { name: "Insights" }).click();
  await srv.slow(page, 3000, "/api/close-idle-tabs");
  await page.getByRole("button", { name: "Close 1 idle tabs" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("button", { name: "Closing…" })).toBeDisabled({ timeout: 1000 });
});

test("the Insights tab shows its panels", async () => {
  await page.locator("#tabs").getByRole("button", { name: "Insights" }).click();
  await expect(page.locator("#insights .panel h2")).toContainText([
    "Open × RAM", "Pending by project and age", "Prompts per day", "New × done per week",
    "Longest sessions", "Costliest sessions", "Storage", ...(DARWIN ? ["Idle Terminal tabs"] : []),
  ]);
  await expect(page.locator("#toolbar")).toBeHidden();
});
