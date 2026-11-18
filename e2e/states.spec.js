// Every state an action or a load can end in shows: on its way, failed (with why and a way to try again), and done.
const { test, expect } = require("@playwright/test");
const { makeWorld, addSession, addAccount, cleanup, waitFor } = require("../test/helpers");
const { launch } = require("./target");

let w, srv, s;
test.beforeEach(async () => {
  w = makeWorld();
  s = { api: addSession(w, { cwd: "/w/acme/api", agentName: "Rate limiter", turns: [{ user: "add buckets" }] }) };
  srv = await launch(w);
});
test.afterEach(async () => { await srv?.stop(); srv = null; if (w) cleanup(w); w = null; });

const titles = (page) => page.locator("#list li .title");
const panel = async (page) => { await titles(page).first().click(); return page.locator("#detail"); };

test("the first load says the sessions are on their way", async ({ page }) => {
  await srv.slow(page, 1500, "/api/sessions");
  page = await srv.open(page);
  await expect(page.locator("#empty")).toHaveText("Loading the sessions…");
  await expect(page.locator("#counts")).toHaveText("loading…");
  await expect(titles(page)).toHaveText(["Rate limiter"]);
  await expect(page.locator("#empty")).toBeHidden();
});

test("a first load that fails says why in the list's place, and tries again", async ({ page }) => {
  await srv.fail(page, "/api/sessions", "boom");
  page = await srv.open(page);
  await expect(page.locator("#empty")).toContainText("server unavailable: boom");
  await expect(page.locator("#counts")).toHaveText("");
  await srv.slow(page, 0, "/api/sessions");
  await page.locator("#empty").getByRole("button", { name: "Try again" }).click();
  await expect(titles(page)).toHaveText(["Rate limiter"]);
});

test("a reload that fails keeps the list, said to be possibly out of date", async ({ page }) => {
  page = await srv.open(page);
  await expect(titles(page)).toHaveText(["Rate limiter"]);
  await srv.fail(page, "/api/sessions", "boom");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const bar = page.locator("#loadError");
  await expect(bar).toContainText("This list may be out of date. server unavailable: boom");
  await expect(titles(page)).toHaveText(["Rate limiter"]);
  await srv.slow(page, 0, "/api/sessions");
  await bar.getByRole("button", { name: "Try again" }).click();
  await expect(bar).toBeHidden();
});

// The other machine is stood in for at the core's boundary, as in remote.spec.js: shown from the start.
async function otherMachine(page, onCall) {
  await srv.intercept(page, async ({ path, body }) => {
    if (path === "/api/cloud") return { json: { link: { state: "online" }, trust: { state: "member" },
      machines: [{ device: "me-device", me: true, online: true }, { device: "studio-device", me: false, online: true }] } };
    if (path === "/api/remote") return { json: { enabled: false } };
    if (path !== "/api/cloud/call") return null;
    const a = await onCall(body.method, body.path);
    if (a) return a;
    try { const res = await srv.api(body.method, body.path); return { status: res.status, json: res.json }; }
    catch { return { status: 500, json: { error: "stopped" } }; }
  });
  await srv.init(page, () => localStorage.setItem("machine", "studio-device"));
}

test("another machine's failure names it and says what went wrong, once", async ({ page }) => {
  let named, answers = [{ status: 408, json: { error: "stale_call" } }, { status: 504, json: { error: "machine_timeout" } }];
  const naming = new Promise((r) => { named = r; });
  await otherMachine(page, async (method, path) => {
    if (path === "/api/machine") { await naming; return { json: { name: "Studio" } }; }
    if (path === "/api/sessions") return answers.shift();
  });
  page = await srv.open(page);
  const empty = page.locator("#empty");
  // Its name hasn't come yet: its key stands in, and the name replaces it once it does.
  await expect(empty).toContainText("studio-d: the request took over a minute to get there and was dropped, try again");
  named();
  await expect(empty).toContainText("Studio: the request took over a minute");
  await expect(empty).not.toContainText("Failed");
  await empty.getByRole("button", { name: "Try again" }).click();
  await expect(empty).toContainText("Studio didn't answer");
  await empty.getByRole("button", { name: "Try again" }).click();
  await expect(titles(page)).toHaveText(["Rate limiter"]);
});

test("another machine's account color can't carry other styles", async ({ page }) => {
  await otherMachine(page, async (method, path) => {
    if (path === "/api/machine") return { json: { name: "Studio" } };
    if (path === "/api/accounts") {
      const [main] = (await srv.api("GET", "/api/accounts")).json;
      return { json: [{ ...main, name: "Main", color: "red;position:fixed;inset:0" }, { ...main, dir: "/elsewhere", name: "Other", color: "#123456" }] };
    }
  });
  page = await srv.open(page);
  const acct = page.locator("#list li .acct");
  await expect(acct).toHaveText("Main");
  await expect(acct).toHaveCSS("position", "static");
  await expect(acct).toHaveCSS("color", "rgb(43, 123, 214)");
});

test("an action under way can't be sent twice, and says when it's through", async ({ page }) => {
  const work = addAccount(w, "work", { scanned: false });
  page = await srv.open(page);
  await expect(titles(page)).toHaveText(["Rate limiter"]);
  await page.getByRole("button", { name: "Settings" }).click();
  await srv.slow(page, 1500, "/api/accounts");
  await page.getByRole("textbox", { name: "Add folder" }).fill(work);
  const add = page.locator("#settings").getByRole("button", { name: "Add folder" });
  await add.click();
  await expect(add).toBeDisabled();
  await expect(add).toHaveAttribute("aria-busy", "true");
  const done = page.locator("#toast .toast", { hasText: "Folder added" });
  await expect(done).toBeVisible({ timeout: 10000 });
  await expect(page.locator("#settings .dir", { hasText: work })).toHaveCount(1);
  // A message saying it went through leaves on its own.
  await expect(done).toHaveCount(0, { timeout: 5000 });
});

test("a note that fails to save keeps what was typed, with why", async ({ page }) => {
  page = await srv.open(page);
  const d = await panel(page);
  await srv.fail(page, "/api/session/", "boom");
  const note = d.getByRole("textbox", { name: "Note" });
  await note.fill("stopped at the bucket size");
  await note.press("Tab");
  await expect(d.getByRole("alert")).toHaveText("Failed: boom");
  await expect(note).toHaveValue("stopped at the bucket size");
  await expect(page.locator("#toast .error")).toHaveCount(0);
  await srv.slow(page, 0, "/api/session/");
  await note.fill("stopped at the bucket size, again");
  await note.press("Tab");
  await expect(d.getByRole("alert")).toBeHidden();
  await waitFor(async () => (await srv.session(s.api.id)).note === "stopped at the bucket size, again");
});

test("a resume that never shows up open says so", async ({ page }) => {
  test.setTimeout(45000);
  page = await srv.open(page);
  const d = await panel(page);
  await d.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.locator("#toast .error")).toContainText("Rate limiter didn't show up open within 10 s", { timeout: 20000 });
  await expect(d.getByRole("button", { name: "Resume", exact: true })).toBeEnabled();
});

test("an error stays until dismissed", async ({ page }) => {
  page = await srv.open(page);
  const d = await panel(page);
  await srv.fail(page, "/api/session/", "boom");
  await d.getByRole("button", { name: "In progress" }).click();
  const err = page.locator("#toast .error");
  await expect(err).toContainText("Failed: boom");
  await page.waitForTimeout(3000);
  await expect(err).toBeVisible();
  await err.getByRole("button", { name: "Dismiss" }).click();
  await expect(err).toHaveCount(0);
});

test("Insights says it's loading, and a failure says why and tries again", async ({ page }) => {
  page = await srv.open(page);
  await expect(page.locator("#tiles .tile").first()).toBeVisible();
  await srv.fail(page, "/api/insights", "boom");
  await page.locator("#tabs").getByRole("button", { name: "Insights" }).click();
  const ins = page.locator("#insights");
  await expect(ins).toContainText("Failed to load: boom");
  await srv.slow(page, 1500, "/api/insights");
  await ins.getByRole("button", { name: "Try again" }).click();
  await expect(ins).toHaveText("loading…");
  await expect(ins.locator(".panel").first()).toBeVisible({ timeout: 10000 });
});

test("tiles that fail to load say so, and the overview stops saying they're loading", async ({ page }) => {
  await srv.fail(page, "/api/insights", "boom");
  page = await srv.open(page);
  await expect(page.locator("#tiles")).toContainText("Failed to load: boom");
  await expect(page.locator("#detail")).toContainText("Failed to load: boom");
  await srv.slow(page, 0, "/api/insights");
  await page.locator("#tiles").getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("#tiles .tile").first()).toBeVisible();
  await expect(page.locator("#detail")).toContainText("Pending by project and age");
});
