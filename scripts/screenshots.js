#!/usr/bin/env node
// Regenerates the app screenshots (README, landing) from a fictitious world: pending view with a session open and
// Insights, in light and dark. Needs `npm run build:core` first. Writes docs/images/*.png and copies them to
// cloud/public/img/.
const { chromium } = require("@playwright/test");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, HOUR, DAY, makeWorld, addAccount, addSession, addLive, setTabs, setVerdicts, startServer, cleanup, waitFor } = require("../test/helpers");

const OUT = path.join(ROOT, "docs/images");
const SITE = path.join(ROOT, "cloud/public/img");
const VIEWPORT = { width: 1280, height: 860 };
const MIN = 60e3;

// A session whose prompts are spread over `days` (days ago, oldest first), `per` prompts each, with token usage.
// The last prompt of the last day is `last`; the session ends `endAgo` before now.
function session(w, { claude = w.claude, cwd, branch, title, days, per = 4, prompts = [], last, endAgo = 2 * HOUR, tokens = 1 }) {
  const id = crypto.randomUUID();
  const turns = [];
  const at = (ms) => new Date(Date.now() - ms).toISOString();
  days.forEach((d, di) => {
    const lastDay = di === days.length - 1;
    const base = lastDay ? endAgo + per * 6 * MIN : d * DAY + 3 * HOUR;
    for (let i = 0; i < per; i++) {
      const t = base - i * 6 * MIN;
      const text = lastDay && i === per - 1 && last ? last : prompts[(di * per + i) % Math.max(prompts.length, 1)] ?? "go on";
      turns.push({ user: text, extra: { timestamp: at(t) } });
      turns.push({ raw: { type: "assistant", sessionId: id, timestamp: at(t - 2 * MIN), message: { id: "msg_" + crypto.randomBytes(6).toString("hex"), role: "assistant",
        content: [{ type: "text", text: "Done. Want me to continue?" }],
        usage: { input_tokens: Math.round(1800 * tokens), cache_creation_input_tokens: Math.round(9000 * tokens), cache_read_input_tokens: Math.round(52000 * tokens), output_tokens: Math.round(1300 * tokens) } } } });
    }
  });
  return addSession(w, { id, claude, cwd, branch, agentName: title, turns, endAgo });
}

async function main() {
  const w = makeWorld();
  let srv, browser;
  try {
    const personal = addAccount(w, "personal");
    const P = (p) => `/Users/dev/code/${p}`;

    const s = {
      rate: session(w, { cwd: P("acme/api"), branch: "feat/rate-limit", title: "Rate limiter for public API", days: [12, 9, 6, 3, 1, 0], per: 6, tokens: 1.4, endAgo: 30 * MIN,
        prompts: ["add per-token buckets to the gateway", "wire Redis for the counters", "return 429 with Retry-After", "load test at 2k rps"],
        last: "now cover the gateway path with the same headers" }),
      checkout: session(w, { cwd: P("acme/web-app"), branch: "feat/checkout-v2", title: "Checkout redesign", days: [16, 13, 10, 7, 2], per: 5, tokens: 1.2, endAgo: 5 * HOUR,
        prompts: ["split the checkout into three steps", "keep the old flow behind a flag", "port the address form"],
        last: "ship the new checkout behind the flag, then we review copy" }),
      deeplinks: session(w, { cwd: P("acme/mobile"), branch: "feat/deeplinks", title: "Push notification deep links", days: [11, 8, 5, 2], per: 5, tokens: 1.1, endAgo: 2 * DAY,
        prompts: ["route notification taps to the right screen", "handle the cold start on Android"],
        last: "android works, now check iOS cold start" }),
      flaky: session(w, { cwd: P("acme/web-app"), branch: "fix/e2e-timeouts", title: "Flaky e2e on CI", days: [4, 1], per: 4, endAgo: 26 * HOUR,
        prompts: ["find why the checkout spec times out on CI"],
        last: "rerun the suite 3 times and tell me which specs still fail" }),
      dark: session(w, { cwd: P("acme/web-app"), branch: "feat/dark", title: "Dark mode tokens", days: [9, 6, 3], per: 4, endAgo: 3 * DAY,
        prompts: ["extract the color tokens", "add the dark palette"],
        last: "perfect, that's it, we're done here" }),
      pg: session(w, { cwd: P("acme/api"), branch: "chore/pg16", title: "Postgres 16 upgrade plan", days: [8, 4], per: 3, endAgo: 4 * DAY,
        prompts: ["list what breaks moving to Postgres 16"],
        last: "draft the rollout steps with a rollback" }),
      offline: session(w, { claude: personal, cwd: P("acme/mobile"), branch: "feat/offline", title: "Offline sync queue", days: [6, 2, 0], per: 4, tokens: 0.9, endAgo: 20 * MIN,
        prompts: ["queue writes while offline", "retry with backoff"],
        last: "dedupe the queue by entity id" }),
      onboarding: session(w, { claude: personal, cwd: P("acme/web-app"), branch: "feat/onboarding", title: "Onboarding checklist", days: [5, 1], per: 3, endAgo: 22 * HOUR,
        prompts: ["design a 4-step onboarding checklist"],
        last: "persist progress per workspace" }),
    };
    // Done: some marked this week and earlier, some idle long enough to start as done.
    const done = [
      session(w, { cwd: P("acme/api"), branch: "fix/n-plus-one", title: "N+1 on the orders endpoint", days: [6, 5], per: 5, endAgo: 5 * DAY, last: "great, merged" }),
      session(w, { cwd: P("acme/web-app"), branch: "chore/vite6", title: "Upgrade to Vite 6", days: [10, 9], per: 4, endAgo: 9 * DAY, last: "all green, thanks" }),
      session(w, { claude: personal, cwd: P("acme/mobile"), branch: "fix/crash-ios", title: "iOS crash on launch", days: [13, 12], per: 6, tokens: 1.3, endAgo: 12 * DAY, last: "fixed in 2.3.1" }),
      session(w, { cwd: P("acme/infra"), branch: "chore/tf-state", title: "Terraform state cleanup", days: [33, 30, 26], per: 5, tokens: 1.2, endAgo: 26 * DAY, last: "done" }),
      session(w, { cwd: P("acme/api"), branch: "feat/webhooks", title: "Webhook retries", days: [41, 38, 35], per: 4, endAgo: 35 * DAY, last: "ship it" }),
      session(w, { cwd: P("acme/web-app"), branch: "feat/search", title: "Search with typo tolerance", days: [48, 45, 22, 19], per: 5, tokens: 1.1, endAgo: 19 * DAY, last: "looks good" }),
      session(w, { claude: personal, cwd: P("acme/mobile"), branch: "feat/biometrics", title: "Biometric login", days: [52, 50, 17, 15], per: 4, endAgo: 15 * DAY, last: "done, thanks" }),
      // A project outside acme/, so projects show as acme/<name> (the common root of all sessions is cut off).
      session(w, { claude: personal, cwd: P("side/blog"), branch: "main", title: "Migrate blog to Astro", days: [44, 40, 29, 24], per: 5, endAgo: 24 * DAY, last: "deployed, thanks" }),
    ];
    addLive(w, s.offline);
    setTabs(w, [{ tty: "ttys003", busy: true, title: "claude" }, { tty: "ttys005", busy: false, title: "zsh" }]);
    setVerdicts(w, [
      { match: "we're done here", verdict: { done: true, confidence: 0.86, evidence: "perfect, that's it, we're done here", reason: "The user accepted the result and closed the session." } },
      { verdict: { done: false, confidence: 0.2, evidence: "", reason: "Work is still open." } },
    ]);

    srv = await startServer(w, { HANGAR_CLASSIFY_START_MS: "3600000" });
    await srv.api("PATCH", "/api/account", { dir: w.claude, name: "work" });
    await srv.api("PATCH", "/api/account", { dir: personal, name: "personal" });
    await srv.api("POST", "/api/order", { ids: [s.rate.id, s.checkout.id, s.offline.id, s.deeplinks.id, s.dark.id, s.flaky.id, s.pg.id, s.onboarding.id] });
    const state = {
      [s.rate.id]: { status: "doing", note: "Buckets and Redis done; Retry-After still missing on the gateway path." },
      [s.checkout.id]: { status: "todo", note: "Waiting for design review on the copy." },
      [s.offline.id]: { status: "doing" },
      [s.deeplinks.id]: { status: "todo", note: "Test on a real iPhone before merging." },
      [s.flaky.id]: { status: "todo" },
      [s.dark.id]: { status: "todo", note: "Check chart contrast in dark before closing." },
      [s.pg.id]: { status: "todo", note: "Staging first; needs a maintenance window." },
    };
    for (const [id, body] of Object.entries(state)) await srv.api("PATCH", `/api/session/${id}`, body);
    for (const d of done.slice(0, 3)) await srv.api("PATCH", `/api/session/${d.id}`, { status: "done" });
    // Spread when they were marked done over the past weeks, for the weekly chart (the API stamps "now").
    const db = path.join(w.data, "state.db");
    const sql = done.slice(0, 3).map((d, i) => `update state set done_at='${new Date(Date.now() - [1, 8, 15][i] * DAY).toISOString()}' where id='${d.id}';`).join("");
    execFileSync("sqlite3", [db, sql]);

    await srv.api("POST", "/api/classify");
    await waitFor(async () => (await srv.session(s.dark.id))?.suggestion, { timeout: 20000 });
    await waitFor(async () => !(await srv.api("GET", "/api/classifier")).json.running, { timeout: 20000 });

    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(SITE, { recursive: true });
    browser = await chromium.launch({ channel: "chrome" });
    for (const scheme of ["light", "dark"]) {
      const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: scheme, locale: "en-US" });
      const page = await ctx.newPage();
      // Machine-wide figures (swap, RAM, a live process's memory and tty) come from this machine, and the fixture
      // transcripts are tiny; show plausible ones instead.
      await page.route("**/api/insights", async (route) => {
        const res = await route.fetch();
        const j = await res.json();
        j.memory.swapUsedMb = 1240;
        j.memory.ramTotalMb = 32768;
        for (const r of j.memory.sessions) Object.assign(r, { mb: 412, tty: "ttys003" });
        j.memory.liveTotalMb = 412 * j.memory.sessions.length;
        j.storage.accounts.forEach((a, i) => { a.transcriptsMb = [184, 62][i] ?? 10; });
        j.storage.transcriptsMb = j.storage.accounts.reduce((n, a) => n + a.transcriptsMb, 0);
        j.storage.backupMb = 37;
        await route.fulfill({ response: res, json: j });
      });
      await page.route("**/api/sessions", async (route) => {
        const res = await route.fetch();
        const j = await res.json();
        for (const x of j) if (x.live) x.live.tty = "ttys003";
        await route.fulfill({ response: res, json: j });
      });
      // The resume command names the world's temp config dir; keep this machine's paths out of the picture.
      await page.addInitScript(() => addEventListener("DOMContentLoaded", () => {
        document.head.append(Object.assign(document.createElement("style"), { textContent: "#detail .extra p:has(code) { display: none }" }));
      }));
      await page.goto(srv.base + "/");
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      await page.locator("#list li").first().waitFor();

      const suffix = scheme === "dark" ? "-dark" : "";
      await page.locator("#list li", { has: page.locator(".title", { hasText: "Dark mode tokens" }) }).locator(".title").click();
      await page.locator("#detail .suggest").waitFor();
      await page.mouse.move(0, 0);
      await shot(page, `pending${suffix}.png`);

      await page.locator("#tabs").getByRole("button", { name: "Insights" }).click();
      await page.locator("#insights .panel").first().waitFor();
      await page.waitForTimeout(300);
      await shot(page, `insights${suffix}.png`);
      await ctx.close();
    }
  } finally {
    await browser?.close().catch(() => {});
    await srv?.stop().catch(() => {});
    cleanup(w);
  }
}

// The whole page down to its content, so nothing empty is left below.
async function shot(page, name) {
  const height = await page.evaluate(() => Math.ceil(document.querySelector(".wrap, main, body > *")?.getBoundingClientRect().bottom ?? document.body.scrollHeight));
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y: 0, width: VIEWPORT.width, height: Math.max(height + 24, 200) } });
  fs.copyFileSync(file, path.join(SITE, name));
  console.log(path.relative(ROOT, file));
}

main().catch((e) => { console.error(e); process.exit(1); });
