// Several accounts in the UI: which one a session is in, filtering by it, and moving a session to another.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { makeWorld, addAccount, addSession, cleanup } = require("../test/helpers");
const { launch } = require("./target");

let w, srv, s, page, personal;
test.beforeEach(async ({ page: browserPage }) => {
  w = makeWorld();
  personal = addAccount(w, "claude-personal");
  s = {
    team: addSession(w, { agentName: "Team task", turns: [{ user: "a" }] }),
    wrong: addSession(w, { agentName: "Side project", turns: [{ user: "b" }] }),
    mine: addSession(w, { claude: personal, agentName: "Personal task", turns: [{ user: "c" }] }),
  };
  srv = await launch(w);
  await srv.api("PATCH", "/api/account", { dir: w.claude, name: "team" });
  await srv.api("PATCH", "/api/account", { dir: personal, name: "personal" });
  page = await srv.open(browserPage);
});
test.afterEach(async () => { await srv?.stop(); srv = null; cleanup(w); });

const rowOf = (page, title) => page.locator("#list li", { has: page.locator(".title", { hasText: title }) });

test("each session shows its account, and the list filters by account", async () => {
  await expect(rowOf(page, "Team task").locator(".acct")).toHaveText("team");
  await expect(rowOf(page, "Personal task").locator(".acct")).toHaveText("personal");
  await page.locator("#acct").selectOption({ label: "personal" });
  await expect(page.locator("#list li .title")).toHaveText(["Personal task"]);
});

test("a session started in the wrong account moves to the right one", async () => {
  const row = rowOf(page, "Side project");
  await row.getByText("Details").click();
  await row.locator(".transfer select").selectOption({ label: "personal" });
  await row.locator(".transfer input[type=checkbox]").check();
  await row.getByRole("button", { name: "Move" }).click();
  await expect(rowOf(page, "Side project").locator(".acct")).toHaveText("personal");
  expect(fs.existsSync(s.wrong.file)).toBe(false);
  expect((await srv.session(s.wrong.id)).account).toBe(personal);
});

test("how long each account keeps its transcripts is set in Settings", async () => {
  await page.getByRole("button", { name: "Settings" }).click();
  const keep = page.getByRole("spinbutton", { name: "Days to keep transcripts" });
  await keep.nth(0).fill("365");
  await keep.nth(0).press("Enter");
  await keep.nth(1).fill("90");
  await keep.nth(1).press("Enter");
  const days = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).cleanupPeriodDays; } catch { return undefined; } };
  await expect.poll(() => [days(w.claude), days(personal)]).toEqual([365, 90]);
});

test("the account done detection runs under is chosen in Settings and shown in Insights", async () => {
  await page.getByRole("button", { name: "Settings" }).click();
  const sel = page.getByRole("combobox", { name: "Use the Claude login of" });
  await expect(sel).toHaveValue("own");
  await sel.selectOption({ label: "personal" });
  await expect.poll(async () => (await srv.api("GET", "/api/classifier")).json.account).toBe(personal);
  await page.getByRole("button", { name: "← Back" }).click();
  await page.locator("#tabs").getByRole("button", { name: "Insights" }).click();
  await expect(page.locator("#insights .panel", { hasText: "Done detection" })).toContainText("uses the Claude login of personal");
});

test("accounts are renamed in Settings", async () => {
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator("#list")).toBeHidden();
  await expect(page.locator("#tabs")).toBeHidden();
  await expect(page.locator("#tiles")).toBeHidden();
  await expect(page.locator(".accts .meta").nth(1)).toHaveText("1 sessions · 1 pending · 0 open");
  const name = page.getByRole("textbox", { name: "Account name" }).nth(1);
  await expect(name).toHaveValue("personal");
  await name.fill("Personal");
  await name.press("Enter");
  await expect.poll(async () => (await srv.api("GET", "/api/accounts")).json[1].name).toBe("Personal");
  await page.getByRole("button", { name: "← Back" }).click();
  await expect(page.locator("#tabs")).toBeVisible();
  await expect(rowOf(page, "Personal task").locator(".acct")).toHaveText("Personal");
});
