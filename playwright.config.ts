import { defineConfig, devices } from "@playwright/test";
import { envMs } from "./e2e/budget";

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
 * How long one test may run before Playwright calls it hung, in milliseconds.
 *
 * Like the build budget further down, this is a ceiling for a test that has stopped making progress, not an
 * estimate of a healthy one — and 60s was being spent as if it were an estimate. On the reviewer's sandbox of
 * 2026-10-18, where a build measured 547s against the ~63s the environment probe documents, tests that
 * normally finish in seconds ran out of it in specs with nothing in common (`deletion`, `flows`,
 * `durability`), each dying on a bare timeout that names the test rather than the clock (T89).
 *
 * A spec that needs more than this says so with `test.setTimeout(Math.max(<its own>, test.info().timeout))`,
 * never a bare number: this ceiling can overtake one. When it went 60s to 180s, `uploads.spec.ts`'s flat
 * 120s turned from twice an ordinary test's budget into two thirds of it, so the test with the most to do
 * (two sign-ins, a verification and a drained queue) had the least headroom on exactly the slow box the
 * ceiling was raised for. The three specs that ask for more are `flows.spec.ts`, `journey.spec.ts` and
 * `uploads.spec.ts` — named without line numbers, which this comment has no way of keeping true; the largest
 * of their floors is what KEEP_ALIVE_MS below has to outlast.
 *
 * It is one of three budgets of this shape, and the only one that lives here: `envMs` above and the suite's
 * "waiting for asynchronous work" budget (`E2E_LOADED_TIMEOUT_MS`) are in e2e/budget.ts, where a spec can
 * import them. Raising this one does not reach that one — a 30s `expect` wait fails inside a 180s test and
 * reports an assertion rather than a clock — so a slow box needs both (T95).
 */
const TEST_TIMEOUT_MS = envMs("E2E_TEST_TIMEOUT_MS", 180_000);

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
 * It has to outlast any test in the suite, because a request context lives at most one test: while that holds,
 * no socket can sit idle in a live context for long enough to be retired, the server never closes an idle
 * connection during a run, and the client is always the side that does — and a close the client initiated is
 * not a reset it has to read. Five minutes was longer than the longest test when the longest was
 * `e2e/journey.spec.ts` at 240s. It is derived now rather than flat, because `E2E_TEST_TIMEOUT_MS` is the
 * override a routine on a slow box is told to reach for (T89): raising the per-test ceiling past a flat five
 * minutes would have quietly handed this bug back. The cost is a handful of sockets held open for the length
 * of a run. The alternative fixes are worse: a `retries` bump would hide real failures in the other 190
 * tests, and a retry wrapper in `e2e/api.ts` would have to decide which of 60-odd `page.request` calls are
 * safe to send twice.
 *
 * The floor is what keeps that true of the specs that set their own: each is written as a floor under
 * `TEST_TIMEOUT_MS` rather than a flat number, so the largest of them is `max(240_000, TEST_TIMEOUT_MS)` —
 * exactly a minute inside this, at every value of `TEST_TIMEOUT_MS`. A per-spec floor above 240s would break
 * that and belongs here, not in a spec.
 *
 * This is the suite's number only. `npm start` keeps Node's default, which is what a deployment behind a load
 * balancer wants.
 */
const KEEP_ALIVE_MS = Math.max(300_000, TEST_TIMEOUT_MS + 60_000);

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
  timeout: TEST_TIMEOUT_MS, // see TEST_TIMEOUT_MS above: a ceiling for a hung test, not an estimate
  retries: 0,
  // The §12.3 size gate (T61): after the last spec, every screenshot this run wrote is measured and one
  // taller than a reviewer can open fails the suite. e2e/screenshotSize.ts says what the limit is and why.
  globalTeardown: "./e2e/screenshotSize.ts",
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
      // Through scripts/timed.sh, so the build's wall time is in the run's log and in the table
      // scripts/agent-check.sh prints at the end (T89). The build is the slowest stage of the whole check
      // and the one whose budget a slow box blows, and it is the only one that does not run in the check
      // script itself — without this the table would be missing the line a reader needs most. The wrapper
      // writes its line to stderr because that is the stream Playwright pipes from a web server; it passes
      // the build's exit status through untouched, so a failing build still fails the run here.
      command: `bash scripts/timed.sh build npm run build && ${nextStart(PORT)}`,
      url: `http://localhost:${PORT}/api/health/live`,
      reuseExistingServer: !process.env.CI,
      // The build is nearly all of this. How long it takes is a property of the box, not of the tree: the
      // 2026-10-10 probe measured about 40s warm and about 63s cold, and the reviewer run of 2026-10-18
      // measured 547s on an idle 4-CPU sandbox with a warm `.next/cache` — nine times the documented figure,
      // on a build that exited 0. A flat 300s turned that healthy tree into `Timed out waiting 300000ms from
      // config.webServer`, which names the server rather than the clock (T89). So the budget carries enough
      // headroom for a box several times slower than the probe, and `E2E_WEBSERVER_TIMEOUT_MS` overrides it
      // where a caller knows better. It is a ceiling for a hung build, not an estimate of a healthy one.
      timeout: envMs("E2E_WEBSERVER_TIMEOUT_MS", 1_800_000),
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
