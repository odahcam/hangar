// The UI showing another machine's sessions: the relay and that machine are stood in for at the core's boundary
// (/api/cloud*, see target.js), so this runs on either target; test/cloud.test.js covers the real path.
const { test, expect } = require("@playwright/test");
const { DARWIN, makeWorld, addSession, addLive, cleanup } = require("../test/helpers");
const { launch } = require("./target");

let w, srv;
test.afterEach(async () => { await srv?.stop(); srv = null; if (w) cleanup(w); w = null; });

// The account's machines (this one, then `others`), remote control off here, and calls to another machine answered by
// `call(device, method, path)`, or else by this test's world as if it were that machine.
function machines(others, call) {
  return srv.intercept(null, async ({ path, body }) => {
    if (path === "/api/cloud") return { json: { link: { state: "online" }, trust: { state: "member" },
      machines: [{ device: "me-device", me: true, online: true }, ...others.map((device) => ({ device, me: false, online: true }))] } };
    if (path === "/api/remote") return { json: { enabled: false } };
    if (path !== "/api/cloud/call") return null;
    const a = await call(body.device, body.method, body.path);
    if (a) return a;
    // The page keeps polling after the test, while afterEach stops the core: those calls just fail.
    try { const res = await srv.api(body.method, body.path); return { status: res.status, json: res.json }; }
    catch { return { status: 500, json: { error: "stopped" } }; }
  });
}

test("resuming a session of another machine says where it opens, and confirms it", async ({ page }) => {
  w = makeWorld();
  const closed = addSession(w, { cwd: "/w/acme/api", agentName: "Rate limiter", turns: [{ user: "add buckets" }] });
  const open = addSession(w, { cwd: "/w/acme/web", agentName: "Checkout redesign", turns: [{ user: "ship it" }] });
  addLive(w, open);
  srv = await launch(w);
  const calls = [];
  // The other machine answers from this test's world: its sessions, and an accepted resume.
  await machines(["studio-device"], (device, method, path) => {
    calls.push(`${method} ${path}`);
    if (path === "/api/machine") return { json: { name: "Studio" } };
    if (path.startsWith("/api/resume/")) return { json: { ok: true } };
  });
  await page.addInitScript(() => localStorage.setItem("machine", "studio-device"));
  page = await srv.open(page);

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
  w = makeWorld();
  addSession(w, { cwd: "/w/acme/api", agentName: "Rate limiter", turns: [{ user: "add buckets" }] });
  srv = await launch(w);
  // Studio's list is this world's under other titles, and only comes once the test lets it.
  let release;
  const held = new Promise((r) => { release = r; });
  await machines(["studio-device"], async (device, method, path) => {
    if (path === "/api/machine") return { json: { name: "Studio" } };
    if (path === "/api/sessions") {
      await held;
      const res = await srv.api(method, path);
      return { json: res.json.map((s) => ({ ...s, title: `Studio ${s.title}` })) };
    }
  });
  page = await srv.open(page);
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

// Opening on another machine (a reload, a restart) says its sessions are coming, and a third machine slow to say its
// name doesn't hold them back.
test("a machine slow to answer doesn't hold back the sessions of the one shown", async ({ page }) => {
  w = makeWorld();
  addSession(w, { cwd: "/w/acme/api", agentName: "Rate limiter", turns: [{ user: "add buckets" }] });
  srv = await launch(w);
  let release, sessions;
  const held = new Promise((r) => { release = r; });
  const listed = new Promise((r) => { sessions = r; });
  await machines(["studio-device", "laptop-device"], async (device, method, path) => {
    if (path === "/api/machine") {
      if (device === "laptop-device") await held;
      return { json: { name: device === "studio-device" ? "Studio" : "Laptop" } };
    }
    if (path === "/api/sessions") await listed;
  });
  await page.addInitScript(() => localStorage.setItem("machine", "studio-device"));
  page = await srv.open(page);
  await expect(page.locator("#empty")).toHaveText("Loading the sessions of Studio…");
  sessions();
  await expect(page.locator("#list li .title")).toHaveText(["Rate limiter"]);
  await expect(page.locator("#machine option[value=laptop-device]")).toHaveText("laptop-d");
  release();
  await expect(page.locator("#machine option[value=laptop-device]")).toHaveText("Laptop");
});
