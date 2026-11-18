---
name: e2e
description: Write, change or run Hangar's UI end-to-end specs (e2e/*.spec.js). Use when adding a UI test, covering a UI bug or state, or running the e2e suites.
---

# UI end-to-end specs

The desktop app is what's used. Specs are the same for both targets; the Playwright project picks one:

- `desktop`: the Tauri app, its WebView2 driven over CDP. Windows only, so locally on macOS it runs in CI.
- `web`: Chrome + `hangar-server`, under the app's CSP. The workaround to run the specs on macOS, where WKWebView
  can't be driven. Not a target of its own.

No skip by target, only by OS feature (e.g. Terminal.app tabs). Commands: `npm run test:e2e` (web),
`npm run test:desktop` (Windows); CI runs both.

## Writing one

- Set up the world (`test/helpers.js`), then `srv = await launch(w)` (`e2e/target.js`) and `page = await srv.open(page)`.
  Always use the page `open` returns: on desktop it's the app's window, not the browser page Playwright hands the spec.
- Stand-ins for the core, the same on both targets, set before or after `open`:
  - `srv.intercept(page, ({ method, path, body }) => ({ status, json }) | null)`: answers any API call; null lets it
    through. Another machine's calls are `path === "/api/cloud/call"` with `body.device/method/path`.
  - `srv.slow(page, ms, prefix)`: calls under `prefix` wait; `0` drops the rules on `prefix`.
  - `srv.fail(page, prefix, error)`: calls under `prefix` fail with `{ error }`.
  - `srv.init(page, fn)`: a script at the start of every document (storage set before the UI reads it). Never
    `page.addInitScript`: on desktop it lands on the wrong page.
- A test for a bug must fail without the fix: `git stash push <the fix's files>`, run it, `git stash pop`.
