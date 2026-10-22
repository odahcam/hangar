// UI end-to-end tests: each test starts its own server over a fixture ~/.claude (see test/helpers.js).
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  reporter: "list",
  use: { channel: "chrome", headless: true, locale: "en-US", colorScheme: "light" },
});
