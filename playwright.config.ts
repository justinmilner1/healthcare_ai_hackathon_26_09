import { defineConfig, devices } from "@playwright/test";

// E2E runs against a production build on port 3100 with a throwaway SQLite DB and the model disabled (scripted
// mode), so results are deterministic. scripts/agent-check.sh sets the environment and seeds data before running
// this. `next dev` compiles routes on demand and rewrites its manifests while it serves, so a request could read a
// half-written manifest and 500 ("Unexpected end of JSON input" on /api/book); `next build` + `next start` has no
// on-demand compilation, and is what §3.1 and §13.3 deploy.
const PORT = Number(process.env.E2E_PORT ?? 3100);
// scripts/agent-check.sh sets PW_CHROMIUM_PATH when the Playwright CDN is blocked but a Chromium is pre-installed.
const launchOptions = process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {};

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
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
    command: `npx next build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000, // the build runs inside this window
    env: { ...process.env, PORT: String(PORT), OPENAI_API_KEY: "", APP_URL: `http://localhost:${PORT}` },
  },
});
