import { defineConfig, devices } from "@playwright/test";

// E2E runs against a production build on port 3100 with a throwaway Postgres database and the model disabled
// (scripted mode), so results are deterministic. scripts/agent-check.sh sets the environment and seeds data first.
//
// A build, not `next dev`, because `next dev` compiles a route the first time it is asked for and that made the
// suite fail roughly one run in three. The failure CI caught names the cause: the dev server logged
// `SyntaxError: Unexpected end of JSON input ... page: '/api/provider'` — its own manifest read losing a race with
// a compile triggered by another route — and served an HTML error page, which the test saw as
// "Unexpected token '<' ... is not valid JSON". Warming the routes first does not help, since the route had
// already been warmed when it failed, and CI runs one worker, so it is not concurrency between tests either.
// `next start` serves a finished build, so there is no compile to race with.
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
    command: `npm run build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000, // the build is most of this; it takes about a minute here
    env: { ...process.env, PORT: String(PORT), OPENAI_API_KEY: "", APP_URL: `http://localhost:${PORT}` },
  },
});
