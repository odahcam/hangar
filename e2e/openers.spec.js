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
  system: "zsh:terminal", preferred: { shell: "", app: "" }, default: "zsh:terminal",
};

let w, srv, id, calls;
test.beforeEach(async () => {
  w = makeWorld();
  id = addSession(w, { cwd: "/w/acme/api", agentName: "Rate limiter", turns: [{ user: "add buckets" }] }).id;
  addLive(w, addSession(w, { cwd: "/w/acme/web", agentName: "Landing", turns: [{ user: "hero" }] }));
  srv = await launch(w);
});
test.afterEach(async () => { await srv?.stop(); srv = null; if (w) cleanup(w); w = null; });

// The core's openers, with the default following what Settings set (as open.rs: the shell and terminal set, each
// else the system's; a pair that doesn't exist gives way to the terminal's first); every resume and PATCH recorded.
async function standIn(page, { fail = false, extra = {} } = {}) {
  const st = { ...structuredClone(OPENERS), ...extra };
  calls = [];
  await srv.intercept(page, ({ method, path, body }) => {
    if (path === "/api/openers" && method === "GET") return fail ? { status: 500, json: { error: "boom" } } : { json: st };
    if (path === "/api/openers" && method === "PATCH") {
      calls.push({ method, path, body });
      st.preferred = { ...st.preferred, ...body };
      const [ss, sa] = st.system.split(":"), app = st.preferred.app || sa, shell = st.preferred.shell || ss;
      st.default = [`${shell}:${app}`, `${ss}:${app}`].find((i) => st.openers.some((o) => o.id === i)) ?? st.openers.find((o) => o.app === app)?.id;
      return { json: { ok: true } };
    }
    if (path.startsWith("/api/resume/")) { calls.push({ method, path, body }); return { json: { opened: true } }; }
    return null;
  });
}
// The session's detail (a click on a selected line would close it).
const detail = async (page, title) => {
  const row = page.locator("#list li", { hasText: title });
  if (!/\bsel\b/.test(await row.getAttribute("class"))) await row.locator(".title").click();
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

// Its own class: the list/detail layout is .split, and the two once shared styles (halves apart, layout broken).
test("Resume's two halves sit together, the same height, the menu under them, the page's layout untouched", async ({ page }) => {
  await standIn(page);
  page = await srv.open(page);
  const d = await detail(page, "Rate limiter");
  expect(await page.locator("#split").evaluate((e) => getComputedStyle(e).display)).toBe("grid");
  const [main, more] = [await d.locator("#resumeBtn").boundingBox(), await d.locator("#resumeMore").boundingBox()];
  expect(Math.abs(main.x + main.width - more.x)).toBeLessThan(1);
  expect(Math.abs(main.height - more.height)).toBeLessThan(1);
  expect(Math.abs(main.y - more.y)).toBeLessThan(1);
  await d.locator("#resumeMore").click();
  const menu = await d.getByRole("menu").boundingBox();
  expect(Math.abs(menu.x - main.x)).toBeLessThan(1);
  expect(menu.y).toBeGreaterThan(main.y + main.height);
  const panel = await page.locator("#detail").boundingBox();
  expect(menu.x).toBeGreaterThanOrEqual(panel.x);
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

test("the menu closes when focus leaves it or the view changes, and the screen keeps up meanwhile", async ({ page }) => {
  await standIn(page);
  page = await srv.open(page);
  const d = await detail(page, "Rate limiter");
  await d.locator("#resumeMore").click();
  await expect(d.getByRole("menu")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(d.getByRole("menu")).toHaveCount(0);
  await d.locator("#resumeMore").click();
  await page.locator("#settingsBtn").click();
  await expect(page.locator(".menu")).toHaveCount(0);
  await expect(page.locator("#appPicker")).toBeVisible();
});

// WebKit (the macOS app) doesn't focus a button it clicks: the menu loses focus to nothing before the click lands.
test("an item is picked even when the click takes focus away to nothing, as WebKit's does", async ({ page }) => {
  await standIn(page);
  page = await srv.open(page);
  await page.locator("#settingsBtn").click();
  await page.locator("#appPicker").click();
  const herdr = page.getByRole("menuitemradio", { name: "herdr" });
  await herdr.evaluate((b) => b.addEventListener("mousedown", () => document.activeElement.blur(), { once: true }));
  await herdr.click();
  await expect.poll(() => calls).toEqual([{ method: "PATCH", path: "/api/openers", body: { app: "herdr" } }]);
  await expect(page.locator("#appPicker")).toHaveText("herdr ▾");
  await page.locator("#settingsBtn").click();
  const d = await detail(page, "Rate limiter");
  await d.locator("#resumeMore").click();
  const item = d.getByRole("menuitem").first();
  await item.evaluate((b) => b.addEventListener("mousedown", () => document.activeElement.blur(), { once: true }));
  await item.click();
  await expect.poll(() => calls.at(-1)?.path).toMatch(/^\/api\/resume\//);
});

test("herdr turned off in Settings leaves Resume's menu, and comes back turned on", async ({ page }) => {
  const st = structuredClone(OPENERS);
  let enabled = true;
  await srv.intercept(page, ({ method, path, body }) => {
    if (path === "/api/herdr") {
      if (method === "PATCH") { enabled = body.enabled ?? enabled; return { json: { ok: true } }; }
      return { json: { enabled, auto: true, hcPath: "", hc: "/u/hc", available: enabled, restorable: [] } };
    }
    if (path === "/api/openers") return { json: { ...st, openers: st.openers.filter((o) => enabled || o.app !== "herdr") } };
    return null;
  });
  page = await srv.open(page);
  await page.locator("#settingsBtn").click();
  await page.locator("#herdrOn").uncheck();
  await page.locator("#settingsBtn").click();
  let d = await detail(page, "Rate limiter");
  await d.locator("#resumeMore").click();
  await expect(d.getByRole("menuitem")).toHaveText(["bash · Terminal"]);
  await page.keyboard.press("Escape");
  await page.locator("#settingsBtn").click();
  await page.locator("#herdrOn").check();
  await page.locator("#settingsBtn").click();
  d = await detail(page, "Rate limiter");
  await d.locator("#resumeMore").click();
  await expect(d.getByRole("menuitem")).toHaveText(["bash · Terminal", "zsh · herdr", "bash · herdr"]);
});

// (Where its terminal can't be brought forward, a running session has no button at all: Windows without a console.)
test("a running session's button brings its terminal forward, with no menu", async ({ page }) => {
  await standIn(page);
  page = await srv.open(page);
  const d = await detail(page, "Landing");
  await expect(d.locator(".d-title .live")).toBeVisible();
  await expect(d.locator("#resumeMore")).toHaveCount(0);
  await expect(d.locator("#resumeBtn")).toHaveCount(0);
  if (process.platform === "darwin") await expect(d.getByRole("button", { name: "Go to terminal" })).toBeVisible();
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

test("Settings set the terminal and the shell apart, each shown with its icon; the system's comes back", async ({ page }) => {
  await standIn(page);
  page = await srv.open(page);
  await page.locator("#settingsBtn").click();
  const app = page.locator("#appPicker"), shell = page.locator("#shellPicker");
  await expect(app).toHaveText("System default (Terminal) ▾");
  await expect(shell).toHaveText("System default (zsh) ▾");
  await expect(page.locator(".pickhint")).toHaveText([
    "The terminal emulator: the window the shell runs in (Terminal, iTerm2, Ghostty, WezTerm, Windows Terminal, herdr).",
    "The command interpreter (zsh, bash, PowerShell, Command Prompt).",
  ]);
  await shell.click();
  const items = page.getByRole("menuitemradio");
  await expect(items).toHaveText(["System default (zsh)", "zsh", "bash"]);
  const [box, menu] = [await shell.boundingBox(), await page.getByRole("menu").boundingBox()];
  expect(Math.abs(menu.x - box.x), "the menu opens under its field").toBeLessThan(1);
  await expect(items.nth(0)).toHaveAttribute("aria-checked", "true");
  expect(await srcs(items.nth(2))).toEqual([png("ba")]);
  await items.nth(2).click();
  await expect.poll(() => calls).toEqual([{ method: "PATCH", path: "/api/openers", body: { shell: "bash" } }]);
  await expect(shell).toHaveText("bash ▾");
  expect(await srcs(shell)).toEqual([png("ba")]);
  await app.click();
  await expect(page.getByRole("menuitemradio")).toHaveText(["System default (Terminal)", "Terminal", "herdr"]);
  await page.getByRole("menuitemradio", { name: "herdr" }).click();
  await expect.poll(() => calls.at(-1)).toEqual({ method: "PATCH", path: "/api/openers", body: { app: "herdr" } });
  await expect(app).toHaveText("herdr ▾");
  await expect(shell, "the shell stays").toHaveText("bash ▾");
  await shell.click();
  await expect(page.getByRole("menuitemradio").nth(2)).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio").nth(0).click();
  await expect.poll(() => calls.at(-1)).toEqual({ method: "PATCH", path: "/api/openers", body: { shell: "" } });
  await expect(shell).toHaveText("System default (zsh) ▾");
});

test("the shells listed are the ones the chosen terminal takes", async ({ page }) => {
  await standIn(page, { extra: { openers: [{ id: "zsh:terminal", shell: "zsh", app: "terminal" }, { id: "bash:terminal", shell: "bash", app: "terminal" },
    { id: "zsh:herdr", shell: "zsh", app: "herdr" }] } });
  page = await srv.open(page);
  await page.locator("#settingsBtn").click();
  await page.locator("#appPicker").click();
  await page.getByRole("menuitemradio", { name: "herdr" }).click();
  await expect(page.locator("#appPicker")).toHaveText("herdr ▾");
  await page.locator("#shellPicker").click();
  await expect(page.getByRole("menuitemradio")).toHaveText(["System default (zsh)", "zsh"]);
});

test("Resume follows the terminal and shell set in Settings", async ({ page }) => {
  await standIn(page);
  page = await srv.open(page);
  await page.locator("#settingsBtn").click();
  await page.locator("#appPicker").click();
  await page.getByRole("menuitemradio", { name: "herdr" }).click();
  await expect(page.locator("#appPicker")).toHaveText("herdr ▾");
  await page.locator("#settingsBtn").click();
  const d = await detail(page, "Rate limiter");
  await expect(d.locator("#resumeBtn")).toHaveAttribute("title", "zsh · herdr");
  await d.locator("#resumeMore").click();
  await expect(d.getByRole("menuitem")).toHaveText(["zsh · Terminal", "bash · Terminal", "bash · herdr"]);
});
