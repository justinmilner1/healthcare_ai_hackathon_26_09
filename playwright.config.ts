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

/** The SNS topic the main server accepts notifications from (design §8.1). No such topic exists; the point is
 *  that the route has an allow-list to check a message against. */
const E2E_TOPIC_ARN = "arn:aws:sns:us-east-1:000000000000:sweetspot-e2e-events";
// A second server on the next port, identical but with a model gateway that is not there: a key is configured
// (so the app is not in "Demo mode") and OPENAI_BASE_URL points at a closed loopback port, so every call is
// refused at once. That is the only way to see the design 6.3 degraded note and the scripted fallback end to
// end without a model. e2e/degraded.spec.ts is the only spec that uses it. Playwright starts web servers one
// after another, so this one begins after the first has built and is answering, and reuses that build.
const DEGRADED_PORT = PORT + 1;
// A third server on the next port again, the only one with a JOBS_SECRET. Configuring the secret is what puts
// the app in "scheduled" mode (lib/jobs.ts), so this is the one place the §3.4 runner answers the way a
// deployed environment does: 401 without the secret, a drain report with it. e2e/security.spec.ts uses it to
// prove the CSRF middleware stands down for the runner — EventBridge sends a bearer token and no cookie, and
// a 403 in front of that route means the queue never drains in production.
const RUNNER_PORT = PORT + 2;
// Long enough to satisfy the §3.7 config gate, which refuses a secret under 16 characters because this one
// guards a public route (T31). Named like AUTH_SECRET below for the same reason: neither is a secret here.
const RUNNER_SECRET = "e2e-jobs-secret-not-for-deployment";
// Where the sign-in links land (design §5.1, e2e/auth.ts) and the secret that signs the session cookie. Neither
// is a secret in a throwaway test database; production supplies AUTH_SECRET from SSM (§10.6).
const MAIL_DIR = process.env.DEV_MAIL_DIR ?? "e2e/.mail";
const AUTH_SECRET = process.env.AUTH_SECRET ?? "e2e-session-secret-not-for-deployment";
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
  webServer: [
    {
      command: `npm run build && npx next start -p ${PORT}`,
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000, // the build is most of this; it takes about a minute here
      // DEV_MAIL_DIR: with no email provider configured, lib/mailer.ts writes the sign-in links here instead
      // of sending them (design §5.1), and e2e/auth.ts reads them. scripts/agent-check.sh empties it first.
      // SNS_TOPIC_ARNS: §8.1's webhook trusts nothing until a topic is configured, and answers 503 while
      // none is. e2e/notifications.spec.ts is about the checks *after* that one, so the server is given a
      // topic ARN that exists nowhere — it is an allow-list entry, not a credential.
      env: {
        ...process.env,
        PORT: String(PORT),
        OPENAI_API_KEY: "",
        APP_URL: `http://localhost:${PORT}`,
        DEV_MAIL_DIR: MAIL_DIR,
        AUTH_SECRET,
        SNS_TOPIC_ARNS: E2E_TOPIC_ARN,
      },
    },
    {
      command: `npx next start -p ${DEGRADED_PORT}`,
      url: `http://localhost:${DEGRADED_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000, // no build of its own: the first server already made one
      env: {
        ...process.env,
        PORT: String(DEGRADED_PORT),
        APP_URL: `http://localhost:${DEGRADED_PORT}`,
        OPENAI_API_KEY: "e2e-unreachable-gateway",
        OPENAI_BASE_URL: "http://127.0.0.1:9/openai/v1", // nothing listens on 9: ECONNREFUSED, no waiting
        LLM_TIMEOUT_MS: "2000",
        LLM_CIRCUIT_THRESHOLD: "1", // one failed call is enough; the test has no time to earn three
        LLM_CIRCUIT_COOLDOWN_MS: "600000",
        AUTH_SECRET,
        DEV_MAIL_DIR: `${MAIL_DIR}-degraded`, // its own mailbox, so neither server's links show up in the other's
      },
    },
    {
      command: `npx next start -p ${RUNNER_PORT}`,
      url: `http://localhost:${RUNNER_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000, // no build of its own either
      env: {
        ...process.env,
        PORT: String(RUNNER_PORT),
        APP_URL: `http://localhost:${RUNNER_PORT}`,
        OPENAI_API_KEY: "",
        JOBS_SECRET: RUNNER_SECRET,
        AUTH_SECRET,
        DEV_MAIL_DIR: `${MAIL_DIR}-runner`, // its own mailbox too, for the same reason
      },
    },
  ],
});

export { E2E_TOPIC_ARN, RUNNER_PORT, RUNNER_SECRET };
