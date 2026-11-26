// Where Resume opens a session: its button split in two, the default opener (its shell's and app's icons) and a menu of
// the others ("shell · app", shell first, with icons); the default set in Settings.
const { test, expect } = require("@playwright/test");
const { makeWorld, addSession, addLive, cleanup } = require("../test/helpers");
const { launch } = require("./target");

// One-pixel PNGs, one per shell and app, told apart by their src.
const png = (n) => `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk${n}AAAAAAEAAe0D8kQAAAAASUVORK5CYII=`;
const OPENERS = {
  openers: [{ id: "zsh:terminal", shell: "zsh", app: "terminal" }, { id: "bash:terminal", shell: "bash", app: "terminal" },
    { id: "zsh:herdr", shell: "zsh", app: "herdr" }, { id: "bash:herdr", shell: "bash", app: "herdr" }],
  shells: { zsh: { name: "zsh", icon: png("zs") }, bash: { name: "bash", icon: png("ba") } },
  apps: { terminal: { name: "Terminal", icon: png("te") }, herdr: { name: "herdr", icon: null } },
  system: "zsh:terminal", preferred: "", default: "zsh:terminal",
};

let w, srv, id, calls;
test.beforeEach(async () => {
  w = makeWorld();
  id = addSession(w, { cwd: "/w/acme/api", agentName: "Rate limiter", turns: [{ user: "add buckets" }] }).id;
  addLive(w, addSession(w, { cwd: "/w/acme/web", agentName: "Landing", turns: [{ user: "hero" }] }));
  srv = await launch(w);
});
test.afterEach(async () => { await srv?.stop(); srv = null; if (w) cleanup(w); w = null; });

// The core's openers, with the default following what Settings set; every resume and PATCH recorded.
async function standIn(page, { fail = false } = {}) {
  const st = structuredClone(OPENERS);
  calls = [];
  await srv.intercept(page, ({ method, path, body }) => {
    if (path === "/api/openers" && method === "GET") return fail ? { status: 500, json: { error: "boom" } } : { json: st };
    if (path === "/api/openers" && method === "PATCH") {
      calls.push({ method, path, body });
      st.preferred = body.preferred;
      st.default = body.preferred || st.system;
      return { json: { ok: true } };
    }
    if (path.startsWith("/api/resume/")) { calls.push({ method, path, body }); return { json: { opened: true } }; }
    return null;
  });
}
const detail = async (page, title) => {
  await page.locator("#list li", { hasText: title }).locator(".title").click();
  return page.locator("#detail");
};
const srcs = (loc) => loc.locator("img").evaluateAll((imgs) => imgs.map((i) => i.getAttribute("src")));

test("Resume shows the default opener's shell and app icons, names it on hover, and opens with it", async ({ page }) => {
  await standIn(page);
  page = await srv.open(page);
  const d = await detail(page, "Rate limiter");
  const main = d.locator("#resumeBtn");
  await expect(main).toHaveText("Resume");
  await expect(main).toHaveAttribute("title", "zsh · Terminal");
  expect(await srcs(main)).toEqual([png("zs"), png("te")]);
  await main.click();
  await expect.poll(() => calls).toEqual([{ method: "POST", path: `/api/resume/${id}`, body: null }]);
});

test("Resume's menu lists the other openers, shell first, with their icons, and opens with the one picked", async ({ page }) => {
  await standIn(page);
  page = await srv.open(page);
  const d = await detail(page, "Rate limiter");
  const more = d.locator("#resumeMore");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  const items = d.getByRole("menuitem");
  await expect(items).toHaveText(["bash · Terminal", "zsh · herdr", "bash · herdr"]);
  expect(await srcs(items.nth(0))).toEqual([png("ba"), png("te")]);
  expect(await srcs(items.nth(1)), "an app without an icon shows the shell's alone").toEqual([png("zs")]);
  await items.nth(1).click();
  await expect(d.getByRole("menu")).toHaveCount(0);
  await expect.poll(() => calls).toEqual([{ method: "POST", path: `/api/resume/${id}`, body: { opener: "zsh:herdr" } }]);
});

test("the menu answers the keyboard and closes on Escape or a click elsewhere", async ({ page }) => {
  await standIn(page);
  page = await srv.open(page);
  const d = await detail(page, "Rate limiter");
  const more = d.locator("#resumeMore");
  await more.click();
  const items = d.getByRole("menuitem");
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(items.nth(2)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(d.getByRole("menu")).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await page.locator("#detail h2").click();
  await expect(d.getByRole("menu")).toHaveCount(0);
  await more.click();
  await more.click();
  await expect(d.getByRole("menu"), "the arrow closes its own menu").toHaveCount(0);
  expect(calls).toEqual([]);
});

test("a running session's button brings its terminal forward, with no menu", async ({ page }) => {
  await standIn(page);
  page = await srv.open(page);
  const d = await detail(page, "Landing");
  await expect(d.getByRole("button", { name: "Go to terminal" })).toBeVisible();
  await expect(d.locator("#resumeMore")).toHaveCount(0);
});

test("without the openers, Resume is a plain button that opens with the default", async ({ page }) => {
  await standIn(page, { fail: true });
  page = await srv.open(page);
  const d = await detail(page, "Rate limiter");
  await expect(d.locator("#resumeMore")).toHaveCount(0);
  await d.getByRole("button", { name: "Resume", exact: true }).click();
  await expect.poll(() => calls).toEqual([{ method: "POST", path: `/api/resume/${id}`, body: null }]);
});

test("while it opens, the main half says so and the arrow waits", async ({ page }) => {
  await standIn(page);
  page = await srv.open(page);
  const d = await detail(page, "Rate limiter");
  await d.locator("#resumeBtn").click();
  await expect(d.locator("#resumeBtn")).toHaveText("Opening…");
  await expect(d.locator("#resumeBtn")).toBeDisabled();
  await expect(d.locator("#resumeMore")).toBeDisabled();
});

test("Settings set the default opener, shown with its icons; the system's comes back with its own choice", async ({ page }) => {
  await standIn(page);
  page = await srv.open(page);
  await page.locator("#settingsBtn").click();
  const picker = page.locator("#openerPicker");
  await expect(picker).toHaveText("System default (zsh · Terminal) ▾");
  await picker.click();
  const items = page.getByRole("menuitemradio");
  await expect(items).toHaveText(["System default (zsh · Terminal)", "zsh · Terminal", "bash · Terminal", "zsh · herdr", "bash · herdr"]);
  await expect(items.nth(0)).toHaveAttribute("aria-checked", "true");
  expect(await srcs(items.nth(2))).toEqual([png("ba"), png("te")]);
  await items.nth(2).click();
  await expect.poll(() => calls).toEqual([{ method: "PATCH", path: "/api/openers", body: { preferred: "bash:terminal" } }]);
  await expect(picker).toHaveText("bash · Terminal ▾");
  expect(await srcs(picker)).toEqual([png("ba"), png("te")]);
  await picker.click();
  await expect(page.getByRole("menuitemradio").nth(2)).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio").nth(0).click();
  await expect.poll(() => calls.at(-1)).toEqual({ method: "PATCH", path: "/api/openers", body: { preferred: "" } });
  await expect(picker).toHaveText("System default (zsh · Terminal) ▾");
});

test("Resume follows the default set in Settings", async ({ page }) => {
  await standIn(page);
  page = await srv.open(page);
  await page.locator("#settingsBtn").click();
  await page.locator("#openerPicker").click();
  await page.getByRole("menuitemradio", { name: "zsh · herdr" }).click();
  await expect(page.locator("#openerPicker")).toHaveText("zsh · herdr ▾");
  await page.locator("#settingsBtn").click();
  const d = await detail(page, "Rate limiter");
  await expect(d.locator("#resumeBtn")).toHaveAttribute("title", "zsh · herdr");
  await d.locator("#resumeMore").click();
  await expect(d.getByRole("menuitem")).toHaveText(["zsh · Terminal", "bash · Terminal", "bash · herdr"]);
});
