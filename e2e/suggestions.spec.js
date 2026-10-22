// Done suggestions in the UI: confirm, dismiss, and the auto-marked notice.
const { test, expect } = require("@playwright/test");
const { makeWorld, addSession, setVerdicts, startServer, cleanup, waitFor } = require("../test/helpers");

let w, srv, s;
const FAST = { HANGAR_CLASSIFY_START_MS: "0", HANGAR_CLASSIFY_EVERY_MS: "200" };

test.beforeEach(async () => {
  w = makeWorld();
  s = addSession(w, { agentName: "Dark mode", turns: [{ user: "tune the tokens" }, { assistant: "done" }, { user: "perfect, we're done here" }] });
});
test.afterEach(async () => { await srv.stop(); cleanup(w); });

async function openWithSuggestion(page, confidence) {
  setVerdicts(w, [{ verdict: { done: true, confidence, evidence: "we're done here", reason: "The user closed it." } }]);
  srv = await startServer(w, FAST);
  await waitFor(async () => { const r = await srv.session(s.id); return r.suggestion || r.status === "done"; });
  await page.goto(srv.base + "/");
}

test("a suggestion shows confidence and the user's quote, and can be confirmed", async ({ page }) => {
  await openWithSuggestion(page, 0.72);
  const box = page.locator(".suggest");
  await expect(box).toContainText("Looks done (72%)");
  await expect(box).toContainText("“we're done here”");
  await box.getByRole("button", { name: "Confirm done" }).click();
  await expect(page.locator("#list li")).toHaveCount(0);
  expect((await srv.session(s.id)).doneBy).toBe("suggestion");
});

test("a dismissed suggestion disappears", async ({ page }) => {
  await openWithSuggestion(page, 0.72);
  await page.locator(".suggest").getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator(".suggest")).toHaveCount(0);
  await expect(page.locator("#list li")).toHaveCount(1);
});

test("an auto-marked session explains itself in the Done tab and can be reopened", async ({ page }) => {
  await openWithSuggestion(page, 0.95);
  await page.locator("#tabs").getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".suggest")).toContainText("Marked by Haiku (95%)");
  await page.getByRole("button", { name: "To resume" }).click();
  await expect(page.locator("#list li")).toHaveCount(0);
  expect((await srv.session(s.id)).status).toBe("todo");
});
