import { defineConfig, devices } from "@playwright/test";

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 0 : 1,
  timeout: isCI ? 5000 : 10000,
  expect: {
    timeout: 2000,
  },
  reporter: isCI ? "dot" : "list",
  use: {
    baseURL: `http://localhost:${process.env.E2E_PORT}`,
    trace: "retain-on-failure",
    actionTimeout: 2000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    wait: { stdout: /localhost:(?<E2E_PORT>\d+)/ },
    reuseExistingServer: !isCI,
    timeout: 60_000,
  },
});
