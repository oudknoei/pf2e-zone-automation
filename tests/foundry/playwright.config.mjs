import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.mjs",
  globalSetup: "./global-setup.mjs",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.FOUNDRY_URL || "http://127.0.0.1:31000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [{
    name: "foundry-v14-pf2e",
    use: { ...devices["Desktop Chrome"] }
  }]
});
