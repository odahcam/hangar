// The UI showing another machine's sessions: the relay and that machine are stood in for at the HTTP boundary
// (/api/cloud*), so this runs in the web target only; test/cloud.test.js covers the real path.
const { test, expect } = require("@playwright/test");
const { DARWIN, makeWorld, addSession, addLive, cleanup } = require("../test/helpers");
const { launch } = require("./target");

let w, srv;
test.afterEach(async () => { await srv?.stop(); srv = null; cleanup(w); });

test("resuming a session of another machine says where it opens, and confirms it", async ({ page }) => {
  test.skip(test.info().project.name !== "web", "stands in for the relay over HTTP");
  w = makeWorld();
  const closed = addSession(w, { cwd: "/w/acme/api", agentName: "Rate limiter", turns: [{ user: "add buckets" }] });
  const open = addSession(w, { cwd: "/w/acme/web", agentName: "Checkout redesign", turns: [{ user: "ship it" }] });
  addLive(w, open);
  srv = await launch(w);
  const calls = [];
  await page.route("**/api/cloud", (r) => r.fulfill({ json: {
    link: { state: "online" }, trust: { state: "member" },
    machines: [{ device: "me-device", me: true, online: true }, { device: "studio-device", me: false, online: true }],
  } }));
  await page.route("**/api/remote", (r) => r.fulfill({ json: { enabled: false } }));
  // The other machine answers from this test's world: its sessions, and an accepted resume.
  await page.route("**/api/cloud/call", async (r) => {
    const { method, path } = r.request().postDataJSON();
    calls.push(`${method} ${path}`);
    if (path === "/api/machine") return r.fulfill({ json: { name: "Studio" } });
    if (path.startsWith("/api/resume/")) return r.fulfill({ json: { ok: true } });
    // The page keeps polling after the test, while afterEach stops the server: those calls just fail.
    try {
      const res = await srv.api(method, path);
      return await r.fulfill({ status: res.status, json: res.json });
    } catch { return r.abort().catch(() => {}); }
  });
  await page.addInitScript(() => localStorage.setItem("machine", "studio-device"));
  await srv.open(page);

  const row = (title) => page.locator("#list li", { has: page.locator(".title", { hasText: title }) });
  await row("Rate limiter").locator(".title").click();
  const resume = page.locator("#detail").getByRole("button", { name: "Resume on Studio" });
  await resume.click();
  await expect(page.locator("#toast")).toHaveText("Opened on Studio");
  expect(calls).toContain(`POST /api/resume/${closed.id}`);

  // A running session can be brought forward where its terminal is known; on Windows the stand-in process here
  // has no console window, so the button isn't offered at all.
  if (!DARWIN) return;
  await row("Checkout redesign").locator(".title").click();
  await expect(page.locator("#detail").getByRole("button", { name: "Bring forward on Studio" })).toBeVisible();
  await expect(page.locator("#detail").getByRole("button", { name: "Go to terminal" })).toHaveCount(0);
});

// Picking another machine empties the list at once and says whose sessions are coming: nothing of the machine left
// stays on screen while the next one answers. The bar on top names the machine and leads back.
test("switching machines shows the next one loading, never the last one's sessions", async ({ page }) => {
  test.skip(test.info().project.name !== "web", "stands in for the relay over HTTP");
  w = makeWorld();
  addSession(w, { cwd: "/w/acme/api", agentName: "Rate limiter", turns: [{ user: "add buckets" }] });
  srv = await launch(w);
  await page.route("**/api/cloud", (r) => r.fulfill({ json: {
    link: { state: "online" }, trust: { state: "member" },
    machines: [{ device: "me-device", me: true, online: true }, { device: "studio-device", me: false, online: true }],
  } }));
  await page.route("**/api/remote", (r) => r.fulfill({ json: { enabled: false } }));
  // Studio's list is this world's under other titles, and only comes once the test lets it.
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route("**/api/cloud/call", async (r) => {
    const { method, path } = r.request().postDataJSON();
    if (path === "/api/machine") return r.fulfill({ json: { name: "Studio" } });
    if (path === "/api/sessions") await held;
    try {
      const res = await srv.api(method, path);
      const json = path === "/api/sessions" ? res.json.map((s) => ({ ...s, title: `Studio ${s.title}` })) : res.json;
      return await r.fulfill({ status: res.status, json });
    } catch { return r.abort().catch(() => {}); }
  });
  await srv.open(page);
  const titles = page.locator("#list li .title");
  await expect(titles).toHaveText(["Rate limiter"]);

  await page.locator("#machine").selectOption("studio-device");
  await expect(titles).toHaveCount(0);
  await expect(page.locator("#empty")).toHaveText("Loading the sessions of Studio…");
  await expect(page.locator("#remoteBanner")).toContainText("Studio");
  release();
  await expect(titles).toHaveText(["Studio Rate limiter"]);
  // The overview offers none of this machine's insights as if they were Studio's.
  await expect(page.locator("#detail")).not.toContainText("loading");
  await expect(page.locator("#detail").getByRole("button", { name: "All insights →" })).toHaveCount(0);

  await page.locator("#remoteBanner").getByRole("button", { name: "Show this machine" }).click();
  await expect(titles).toHaveText(["Rate limiter"]);
  await expect(page.locator("#remoteBanner")).toBeHidden();
});
