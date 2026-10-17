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
// A fourth server, the only one talking to Dexcom's production environment (T24, design §9.2). The switch
// is the whole fixture: real-looking credentials that are never used for a request, and a registered
// callback on a host that is not this one, because production refuses an http://localhost callback (§10.1).
// e2e/dexcom.spec.ts is the only spec that uses it — nothing else in the suite configures Dexcom at all, so
// without it the production half of the switch has no screen anybody can look at.
const DEXCOM_PORT = PORT + 3;
// A fifth server, the only one with DEMO_SIGN_IN set (T32, design §13.4). The main server keeps the default —
// `/demo` offers the sign-in form with the address filled in, which e2e/signin.spec.ts asserts — so the
// shortcut needs a server of its own to be seen at all. e2e/demo.spec.ts is the only spec that uses it.
const DEMO_PORT = PORT + 4;
/**
 * How long each server below holds an idle keep-alive socket open, in milliseconds (T59).
 *
 * `next start` leaves Node's `server.keepAliveTimeout` at its five-second default, so the server retires an
 * idle keep-alive connection a few seconds after the last response: a raw socket to this build is sent FIN
 * 6.00s after the response it is holding, and is still open at 100s with the flag below. Playwright's
 * `APIRequestContext` pools its connections and does not retry a reset, so a `request.*` call that picks a
 * pooled socket in the moment the server is closing it is written to a socket that answers RST. The test then
 * dies on the call — `apiRequestContext.get: read ECONNRESET` — without reaching an assertion, and with
 * `retries: 0` one of those is a red run.
 *
 * That is why the failures moved between specs, routes and verbs (`deletion.spec.ts`, `flows.spec.ts`,
 * `durability.spec.ts`, `followup.spec.ts`, `mobile.spec.ts`) with no route or load in common: the only thing
 * they share is a request context reused across an idle gap, which is usually a screenshot or a run of page
 * assertions.
 *
 * Five minutes is longer than the longest test in the suite — `e2e/journey.spec.ts` sets 240s, everything else
 * gets the 60s `timeout` below — and a request context lives at most one test, so no socket can sit idle in a
 * live context for long enough to be retired. The server therefore never closes an idle connection during a
 * run and the client is always the side that does, and a close the client initiated is not a reset it has to
 * read. The cost is a handful of sockets held open for the length of a run. The alternative fixes are worse: a
 * `retries` bump would hide real failures in the other 190 tests, and a retry wrapper in `e2e/api.ts` would
 * have to decide which of 60-odd `page.request` calls are safe to send twice.
 *
 * This is the suite's number only. `npm start` keeps Node's default, which is what a deployment behind a load
 * balancer wants.
 */
const KEEP_ALIVE_MS = 300_000;

/** `next start` for one of the servers below, on a port, with the keep-alive above. */
const nextStart = (port: number) => `npx next start -p ${port} --keepAliveTimeout ${KEEP_ALIVE_MS}`;
// Long enough to satisfy the §3.7 config gate, which refuses a secret under 16 characters because this one
// guards a public route (T31). Named like AUTH_SECRET below for the same reason: neither is a secret here.
const RUNNER_SECRET = "e2e-jobs-secret-not-for-deployment";
// Where the sign-in links land (design §5.1, e2e/auth.ts) and the secret that signs the session cookie. Neither
// is a secret in a throwaway test database; production supplies AUTH_SECRET from SSM (§10.6).
const MAIL_DIR = process.env.DEV_MAIL_DIR ?? "e2e/.mail";
const AUTH_SECRET = process.env.AUTH_SECRET ?? "e2e-session-secret-not-for-deployment";
// Every server below is waited for on /api/health/live, not /api/health: the dependency report answers 503
// when a configured dependency is down (T28, design §11.2), and the degraded server's gateway is down on
// purpose. Playwright treats anything from 404 up as "not ready yet", so that server would never start.
// Liveness is also the question being asked here — "is this build answering?" — not "is Bedrock up?".
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
    // Design §6.5 names 375px as the width the patient pages are tested at — the narrowest phone still in
    // common use (iPhone SE / 8). Pixel 7 supplies the rest of the phone profile (touch, mobile user agent,
    // device scale) because only Chromium is installed in CI and the sandbox, and its own 412px viewport is
    // 37px of slack that hides exactly the overflow this project exists to catch (T23).
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], viewport: { width: 375, height: 667 } },
    },
  ],
  webServer: [
    {
      command: `npm run build && ${nextStart(PORT)}`,
      url: `http://localhost:${PORT}/api/health/live`,
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
      command: nextStart(DEGRADED_PORT),
      url: `http://localhost:${DEGRADED_PORT}/api/health/live`,
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
      command: nextStart(DEXCOM_PORT),
      url: `http://localhost:${DEXCOM_PORT}/api/health/live`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000, // no build of its own either
      env: {
        ...process.env,
        PORT: String(DEXCOM_PORT),
        APP_URL: `http://localhost:${DEXCOM_PORT}`,
        OPENAI_API_KEY: "",
        AUTH_SECRET,
        DEV_MAIL_DIR: `${MAIL_DIR}-dexcom`, // its own mailbox, like the other two
        DEXCOM_ENV: "production",
        DEXCOM_CLIENT_ID: "e2e-dexcom-client-not-real",
        DEXCOM_CLIENT_SECRET: "e2e-dexcom-secret-not-real",
        // Registered with Dexcom rather than served by this run: the suite looks at the button, it does not
        // press it. A press would be refused anyway, by the connect route's origin check and by the
        // form-action in the build these servers share, which was built with no Dexcom configured.
        DEXCOM_REDIRECT_URI: "https://sweetspot.example.test/api/dexcom/callback",
      },
    },
    {
      command: nextStart(DEMO_PORT),
      url: `http://localhost:${DEMO_PORT}/api/health/live`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000, // no build of its own either
      env: {
        ...process.env,
        PORT: String(DEMO_PORT),
        APP_URL: `http://localhost:${DEMO_PORT}`,
        OPENAI_API_KEY: "",
        AUTH_SECRET, // the same secret: the link /demo mints is signed against it, like an emailed one
        DEV_MAIL_DIR: `${MAIL_DIR}-demo`, // its own mailbox, like the others
        DEMO_SIGN_IN: "1",
      },
    },
    {
      command: nextStart(RUNNER_PORT),
      url: `http://localhost:${RUNNER_PORT}/api/health/live`,
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

export { DEMO_PORT, DEXCOM_PORT, E2E_TOPIC_ARN, RUNNER_PORT, RUNNER_SECRET };
