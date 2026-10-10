import { defineConfig, devices } from "@playwright/test";

// E2E runs against a dev server on port 3100 with a throwaway Postgres database and the model disabled (scripted mode),
// so results are deterministic. scripts/agent-check.sh sets the environment and seeds data before running this.
const PORT = Number(process.env.E2E_PORT ?? 3100);
// scripts/agent-check.sh sets PW_CHROMIUM_PATH when the Playwright CDN is blocked but a Chromium is pre-installed.
const launchOptions = process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {};

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  globalSetup: "./e2e/global-setup.ts",
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e/report" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } }, // Chromium-based phone profile; only Chromium is installed in CI and the sandbox
  ],
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { ...process.env, PORT: String(PORT), OPENAI_API_KEY: "", APP_URL: `http://localhost:${PORT}` },
  },
});
