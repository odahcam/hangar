// UI end-to-end tests: each test starts its own core over a fixture ~/.claude (see test/helpers.js, e2e/target.js).
// Two projects run the same specs: "web" (Chrome + hangar-server) and "desktop" (the real Tauri app).
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  reporter: "list",
  use: { channel: "chrome", headless: true, locale: "en-US", colorScheme: "light" },
  projects: [
    // One retry on CI: HTML5 drag in headless Chrome occasionally misses a dragover on a loaded runner.
    { name: "web", retries: process.env.CI ? 1 : 0 },
    // One retry: WebView2 sometimes closes the DevTools connection (cleanly, code 1000) while a delayed core call is
    // pending, with the app still running and silent. That's the test transport, not Hangar; a real app failure
    // fails both attempts, and an app that dies is reported as "exited mid-test".
    { name: "desktop", timeout: 60000, retries: 1 },
  ],
});
