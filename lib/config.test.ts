import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { AUTH_DEV_SECRET, ConfigError, SPEC, assertConfig, demoSignInEnabled, isProduction, read, validateConfig, appUrl } from "./config";
import { setLogSink } from "./log";

/** A production environment with nothing wrong with it. Tests break one thing at a time from here. */
const good = (): Record<string, string | undefined> => ({
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://sweetspot:sweetspot@db.internal:5432/sweetspot?schema=public",
  APP_URL: "https://sweetspot.example.com",
  AUTH_SECRET: "a-long-enough-auth-secret",
  JOBS_SECRET: "a-long-enough-jobs-secret",
  OPENAI_BASE_URL: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1",
  OPENAI_API_KEY: "bedrock-key-not-real",
  BEDROCK_OPENAI_MODEL_ID: "global.openai.gpt-5.6-terra",
  RESEND_API_KEY: "resend-key-not-real",
  EMAIL_FROM: "Sweet Spot <visits@example.com>",
  UPLOADS_BUCKET: "sweetspot-uploads-production",
});

const errors = (env: Record<string, string | undefined>) => validateConfig(env).filter((p) => p.level === "error");
const warnings = (env: Record<string, string | undefined>) => validateConfig(env).filter((p) => p.level === "warning");

/** assert.throws hands back nothing, and these tests want to read the message it refused with. */
const refusal = (fn: () => unknown): ConfigError => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ConfigError, `expected a ConfigError, got ${String(e)}`);
    return e;
  }
  return assert.fail("expected the config check to refuse this environment");
};

test("a complete production environment has no problems", () => {
  assert.deepEqual(validateConfig(good()), []);
});

// ---- required ------------------------------------------------------------------------------------------

test("a missing required variable refuses production and only warns in development", () => {
  for (const name of ["DATABASE_URL", "APP_URL", "AUTH_SECRET"]) {
    const broken = { ...good(), [name]: undefined };
    assert.deepEqual(
      errors(broken).map((p) => p.variable),
      [name],
      `${name} should be fatal in production`,
    );

    const dev = { ...broken, NODE_ENV: "development" };
    assert.deepEqual(errors(dev), [], `${name} should not be fatal in development`);
    assert.deepEqual(
      warnings(dev).map((p) => p.variable),
      [name],
    );
  }
});

test("a variable set to blank or whitespace counts as unset", () => {
  // The e2e suite passes OPENAI_API_KEY="" to mean "no model", so this is load-bearing, not pedantry.
  assert.equal(read({ OPENAI_API_KEY: "   " }, "OPENAI_API_KEY"), undefined);
  assert.deepEqual(
    errors({ ...good(), DATABASE_URL: "" }).map((p) => p.variable),
    ["DATABASE_URL"],
  );
});

test("errors sort before warnings, so the first line is the one that stopped the start", () => {
  const problems = validateConfig({ ...good(), APP_URL: undefined, OPENAI_API_KEY: undefined });
  assert.equal(problems[0].level, "error");
  assert.equal(problems[0].variable, "APP_URL");
  assert.ok(problems.some((p) => p.level === "warning" && p.variable === "OPENAI_API_KEY"));
});

// ---- recommended --------------------------------------------------------------------------------------

test("a missing recommended variable warns in production and never refuses", () => {
  // Scripted mode is a state the design asks us to support (§3.5, §11.3) and the e2e suite runs a production
  // build in it, so no amount of missing model configuration may stop the server.
  const noModel = { ...good(), OPENAI_API_KEY: undefined, OPENAI_BASE_URL: undefined, BEDROCK_OPENAI_MODEL_ID: undefined };
  assert.deepEqual(errors(noModel), []);
  assert.deepEqual(warnings(noModel).map((p) => p.variable).sort(), ["BEDROCK_OPENAI_MODEL_ID", "OPENAI_API_KEY", "OPENAI_BASE_URL"]);
  for (const problem of warnings(noModel)) assert.match(problem.message, /is not set, so /);
});

test("recommended variables stay quiet in development", () => {
  const dev = { DATABASE_URL: good().DATABASE_URL, APP_URL: "http://localhost:3000", AUTH_SECRET: good().AUTH_SECRET, NODE_ENV: "development" };
  assert.deepEqual(validateConfig(dev), []);
});

test("every recommended variable says what happens without it", () => {
  for (const spec of SPEC.filter((s) => s.requirement === "recommended")) {
    assert.ok(spec.whenMissing, `${spec.name} is recommended but does not say what breaks without it`);
  }
});

// ---- malformed values ---------------------------------------------------------------------------------

test("DATABASE_URL must be Postgres: a leftover SQLite path is a problem, not a database", () => {
  const sqlite = errors({ ...good(), DATABASE_URL: "file:./prisma/dev.db" });
  assert.equal(sqlite.length, 1);
  assert.match(sqlite[0].message, /Postgres only/);
  assert.match(errors({ ...good(), DATABASE_URL: "postgresql://host:5432" })[0].message, /must name a database/);
  assert.deepEqual(errors({ ...good(), DATABASE_URL: "postgres://u:p@host:5432/sweetspot" }), []);
});

test("APP_URL must be absolute, and https outside localhost in production", () => {
  assert.match(errors({ ...good(), APP_URL: "/s" })[0].message, /absolute URL/);
  assert.match(errors({ ...good(), APP_URL: "ftp://files.example.com" })[0].message, /http:\/\/ or https:\/\//);
  assert.match(errors({ ...good(), APP_URL: "http://sweetspot.example.com" })[0].message, /https:\/\/ in production/);
  // The e2e suite serves a production build on http://localhost:3100; that is not the mistake this catches.
  assert.deepEqual(errors({ ...good(), APP_URL: "http://localhost:3100" }), []);
  assert.deepEqual(errors({ ...good(), APP_URL: "http://127.0.0.1:3100" }), []);
});

test("the numeric model knobs must be positive whole numbers", () => {
  for (const name of ["LLM_TIMEOUT_MS", "LLM_CIRCUIT_THRESHOLD", "LLM_CIRCUIT_COOLDOWN_MS"]) {
    assert.deepEqual(errors({ ...good(), [name]: "20000" }), [], `${name}=20000 should be fine`);
    for (const bad of ["soon", "0", "-1", "2.5"]) {
      assert.deepEqual(
        errors({ ...good(), [name]: bad }).map((p) => p.variable),
        [name],
        `${name}=${bad} should be a problem`,
      );
    }
  }
});

test("enumerated and shaped values are checked", () => {
  assert.match(errors({ ...good(), EMAIL_PROVIDER: "sendgrid" })[0].message, /must be one of resend, ses/);
  assert.match(errors({ ...good(), SMS_PROVIDER: "carrier-pigeon" })[0].message, /must be one of twilio, sns/);
  assert.match(errors({ ...good(), AWS_REGION: "useast1" })[0].message, /AWS region/);
  assert.match(errors({ ...good(), EMAIL_FROM: "visits-at-example.com" })[0].message, /email address/);
  assert.match(errors({ ...good(), SUMMARY_TZ: "Mars/Olympus" })[0].message, /IANA time zone/);
  assert.deepEqual(errors({ ...good(), SUMMARY_TZ: "America/Los_Angeles" }), []);
  assert.match(errors({ ...good(), SNS_ORIGINATION_NUMBER: "555-0132" })[0].message, /E\.164/);
});

// ---- half-configured integrations ---------------------------------------------------------------------

test("Twilio without its token and sender is reported, not left to fail at send time", () => {
  const partial = errors({ ...good(), TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}` });
  assert.equal(partial.length, 1);
  assert.match(partial[0].message, /TWILIO_AUTH_TOKEN and TWILIO_FROM are required when TWILIO_ACCOUNT_SID is set/);
  assert.deepEqual(
    errors({ ...good(), TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`, TWILIO_AUTH_TOKEN: "token-not-real", TWILIO_FROM: "+15551234567" }),
    [],
  );
});

test("a jobs runner set to scheduled with no secret is the queue nothing drains", () => {
  // Either variable alone looks fine: the route refuses every call and the inline path is off, so every
  // summary and notification sits in Job forever.
  const stuck = { ...good(), JOBS_SECRET: undefined, JOBS_RUNNER: "scheduled" };
  assert.match(errors(stuck)[0].message, /JOBS_SECRET is required when JOBS_RUNNER is scheduled/);
  assert.deepEqual(errors({ ...stuck, JOBS_SECRET: "a-long-enough-secret" }), []);
  // And it is not also told that jobs will drain inline, which is what `scheduled` turned off.
  assert.deepEqual(warnings(stuck).filter((p) => p.variable === "JOBS_SECRET"), []);
  assert.deepEqual(errors({ ...good(), JOBS_RUNNER: "inline" }), []);
  assert.match(errors({ ...good(), JOBS_RUNNER: "cron" })[0].message, /must be one of inline, scheduled/);
});

test("the jobs secret has to be long enough to be a secret", () => {
  assert.match(errors({ ...good(), JOBS_SECRET: "changeme" })[0].message, /at least 16 characters/);
  assert.deepEqual(errors({ ...good(), JOBS_SECRET: "a-long-enough-secret" }), []);
});

test("the session secret is required, and NEXTAUTH_SECRET is the same thing under its old name", () => {
  // lib/auth.ts reads either, so refusing a deployment that set only the v4 name would be refusing a
  // deployment that works. The alias satisfies the requirement; it does not merely silence it.
  const v4Only = { ...good(), AUTH_SECRET: undefined, NEXTAUTH_SECRET: "a-long-enough-auth-secret" };
  assert.deepEqual(validateConfig(v4Only), []);

  const neither = { ...good(), AUTH_SECRET: undefined };
  assert.equal(errors(neither).length, 1);
  assert.match(errors(neither)[0].message, /AUTH_SECRET or NEXTAUTH_SECRET is not set/);
});

test("a session secret that is short, or the one printed in this repository, is refused", () => {
  // Either one lets a stranger mint a session for any clinician in the practice.
  assert.match(errors({ ...good(), AUTH_SECRET: "secret" })[0].message, /at least 16 characters/);
  const dev = errors({ ...good(), AUTH_SECRET: AUTH_DEV_SECRET });
  assert.equal(dev.length, 1);
  assert.match(dev[0].message, /development constant, which is public in this repository/);
  // Outside production it is exactly what lib/auth.ts falls back to, so it is not a problem there.
  assert.deepEqual(validateConfig({ ...good(), NODE_ENV: "development", AUTH_SECRET: AUTH_DEV_SECRET }), []);
  // And the alias is held to the same standard; it reaches the same code.
  assert.match(errors({ ...good(), AUTH_SECRET: undefined, NEXTAUTH_SECRET: "short" })[0].message, /at least 16 characters/);
});

test("lib/config.ts's copy of the development secret still matches lib/auth.ts's", () => {
  // It is copied rather than imported because lib/auth.ts pulls in next-auth and this module is loaded too
  // early to want it. A silent drift would turn the check above into one that never fires again.
  const auth = readFileSync(path.join(repoRoot, "lib", "auth.ts"), "utf8");
  const match = /const DEV_SECRET = "([^"]+)"/.exec(auth);
  assert.ok(match, "lib/auth.ts no longer declares DEV_SECRET the way this test reads it");
  assert.equal(match[1], AUTH_DEV_SECRET);
});

test("DEV_MAIL_DIR is refused on a deployment, not on a production build of your own", () => {
  // Set on a deployment, lib/devMailbox.ts diverts every email — sign-in links included — to files on the
  // server instead of sending them, whether or not SES is configured, and nothing else in the app notices.
  const diverted = errors({ ...good(), DEV_MAIL_DIR: ".mail" });
  assert.equal(diverted.length, 1);
  assert.match(diverted[0].message, /would be written to a file on the server instead of sent/);

  // But NODE_ENV alone cannot judge it: the e2e suite sets DEV_MAIL_DIR on two production builds on purpose,
  // and `npm run build && npm start` on a laptop is the same shape. A localhost APP_URL is what tells them
  // apart — exactly the signal the APP_URL https rule already uses.
  assert.deepEqual(validateConfig({ ...good(), APP_URL: "http://localhost:3100", DEV_MAIL_DIR: "e2e/.mail" }), []);
  assert.deepEqual(validateConfig({ ...good(), NODE_ENV: "development", DEV_MAIL_DIR: ".mail" }), []);
});

test("a forced provider must have the credentials that backend needs", () => {
  assert.match(errors({ ...good(), RESEND_API_KEY: undefined, EMAIL_PROVIDER: "resend" })[0].message, /RESEND_API_KEY is required/);
  assert.match(errors({ ...good(), EMAIL_FROM: undefined, EMAIL_PROVIDER: "ses" })[0].message, /EMAIL_FROM is required/);
  assert.match(errors({ ...good(), SMS_PROVIDER: "twilio" })[0].message, /TWILIO_ACCOUNT_SID is required/);
});

test("static AWS credentials come in pairs, but only as a warning", () => {
  // These two names are ambient on CI runners and on this repo's cloud sandbox, so half a pair must not be
  // able to stop a deployment that never asked for them.
  const half = { ...good(), AWS_ACCESS_KEY_ID: "AKIA-not-real" };
  assert.deepEqual(errors(half), []);
  assert.match(warnings(half)[0].message, /AWS_SECRET_ACCESS_KEY is required when AWS_ACCESS_KEY_ID is set/);
  assert.deepEqual(validateConfig({ ...half, AWS_SECRET_ACCESS_KEY: "secret-not-real" }), []);
});

test("uploads: a bucket is expected in production, and asking for S3 without one is refused", () => {
  // T11, design §3.3. Without a bucket the files land on the instance's own disk, which a deployment loses on
  // redeploy — a warning, not a refusal, because that is exactly how development and the e2e suite run.
  const noBucket = { ...good(), UPLOADS_BUCKET: undefined };
  assert.deepEqual(errors(noBucket), []);
  assert.deepEqual(warnings(noBucket).map((p) => p.variable), ["UPLOADS_BUCKET"]);
  assert.match(warnings(noBucket)[0].message, /local filesystem/);
  assert.deepEqual(validateConfig({ ...noBucket, NODE_ENV: "development" }), [], "quiet in development");

  // Forcing the S3 backend with nowhere to write is not a degraded path, it is every upload failing.
  const forced = errors({ ...good(), UPLOADS_BUCKET: undefined, STORAGE_BACKEND: "s3" });
  assert.deepEqual(forced.map((p) => p.variable), ["UPLOADS_BUCKET"]);
  assert.match(forced[0].message, /required when STORAGE_BACKEND is set/);
  assert.deepEqual(errors({ ...good(), STORAGE_BACKEND: "local" }), [], "the filesystem backend needs no bucket");

  assert.match(errors({ ...good(), UPLOADS_BUCKET: "Sweet_Spot_Uploads" })[0].message, /S3 bucket name/);
  assert.match(errors({ ...good(), UPLOADS_BUCKET: "10.0.0.1" })[0].message, /S3 bucket name/);
  assert.match(errors({ ...good(), STORAGE_BACKEND: "disk" })[0].message, /must be one of s3, local/);
  assert.match(errors({ ...good(), UPLOADS_REGION: "us east 1" })[0].message, /AWS region/);
});

/** A deployment with Dexcom fully configured for the sandbox, which is where T24 leaves every environment
 *  until Dexcom approves the application (design §9.2). */
const withDexcom = (): Record<string, string | undefined> => ({
  ...good(),
  DEXCOM_CLIENT_ID: "client-not-real",
  DEXCOM_CLIENT_SECRET: "secret-not-real",
  DEXCOM_REDIRECT_URI: "https://sweetspot.example.com/api/dexcom/callback",
  DEXCOM_TOKEN_KMS_KEY_ID: "alias/sweetspot-dexcom-tokens",
});

test("Dexcom is a whole configuration or none of one", () => {
  assert.deepEqual(errors(good()), []); // none set: fine, uploads work without it
  const partial = errors({ ...good(), DEXCOM_CLIENT_ID: "client-not-real" });
  assert.equal(partial.length, 1);
  assert.match(partial[0].message, /half-configured for DEXCOM_ENV=sandbox/);
  assert.match(partial[0].message, /DEXCOM_CLIENT_SECRET/);
  assert.match(partial[0].message, /DEXCOM_REDIRECT_URI/);

  assert.deepEqual(errors(withDexcom()), []);
  assert.match(errors({ ...withDexcom(), DEXCOM_REDIRECT_URI: "https://sweetspot.example.com/callback" })[0].message, /api\/dexcom\/callback/);
  assert.match(errors({ ...withDexcom(), DEXCOM_ENV: "staging" })[0].message, /must be one of sandbox, production/);
  // With no environment to judge the group against, the bad value is the only thing reported.
  assert.equal(errors({ ...withDexcom(), DEXCOM_ENV: "staging", DEXCOM_CLIENT_SECRET: undefined }).length, 1);
});

test("the production switch takes production's credentials, or the shared pair (design §9.2)", () => {
  // Credentials for the other environment are not credentials for this one.
  const wrongWay = errors({ ...withDexcom(), DEXCOM_ENV: "production", DEXCOM_CLIENT_ID: undefined, DEXCOM_SANDBOX_CLIENT_ID: "sandbox-client-not-real" });
  assert.equal(wrongWay.length, 1);
  assert.match(wrongWay[0].message, /half-configured for DEXCOM_ENV=production/);
  assert.match(wrongWay[0].message, /DEXCOM_PRODUCTION_CLIENT_ID or DEXCOM_CLIENT_ID/);
  // Both applications' credentials in one environment is the point of the prefixed names: either switch works.
  const both = {
    ...withDexcom(),
    DEXCOM_SANDBOX_CLIENT_ID: "sandbox-client-not-real",
    DEXCOM_SANDBOX_CLIENT_SECRET: "sandbox-secret-not-real",
    DEXCOM_PRODUCTION_CLIENT_ID: "production-client-not-real",
    DEXCOM_PRODUCTION_CLIENT_SECRET: "production-secret-not-real",
  };
  assert.deepEqual(errors(both), []);
  assert.deepEqual(errors({ ...both, DEXCOM_ENV: "production" }), []);
});

test("DEXCOM_BASE_URL is checked against the switch rather than ignored", () => {
  // T24 moved the host to DEXCOM_ENV. A deployment that still pins the old variable believes it is in the
  // environment it named, so a disagreement is refused instead of silently resolved either way.
  const pinned = errors({ ...withDexcom(), DEXCOM_BASE_URL: "https://api.dexcom.com" });
  assert.deepEqual(pinned.map((p) => p.variable), ["DEXCOM_BASE_URL"]);
  assert.match(pinned[0].message, /production host while DEXCOM_ENV is sandbox/);
  assert.deepEqual(errors({ ...withDexcom(), DEXCOM_BASE_URL: "https://sandbox-api.dexcom.com" }), [], "agreeing with the switch is fine");
  assert.match(errors({ ...withDexcom(), DEXCOM_BASE_URL: "https://dexcom.example.com" })[0].message, /not a Dexcom host/);
});

test("a deployment storing Dexcom tokens needs the KMS key (design §4.10, §10.1)", () => {
  const noKey = { ...withDexcom(), DEXCOM_TOKEN_KMS_KEY_ID: undefined };
  assert.deepEqual(errors(noKey).map((p) => p.variable), ["DEXCOM_TOKEN_KMS_KEY_ID"]);
  assert.match(errors(noKey)[0].message, /refresh token/);
  // The same carve-out as DEV_MAIL_DIR: a production build nobody else can reach is not a deployment, and
  // the e2e suite and `npm run build && npm start` are exactly that.
  assert.deepEqual(errors({ ...noKey, APP_URL: "http://localhost:3000" }), []);
  assert.deepEqual(errors({ ...noKey, NODE_ENV: "development", APP_URL: "http://localhost:3000" }), []);
  // No Dexcom, no tokens to encrypt.
  assert.deepEqual(errors({ ...good(), DEXCOM_TOKEN_KMS_KEY_ID: undefined }), []);
  assert.match(errors({ ...withDexcom(), DEXCOM_TOKEN_KMS_KEY_ID: "alias/one alias/two" })[0].message, /single KMS key/);
});

test("a production deployment with no way to reach a patient is a warning", () => {
  const silent = { ...good(), RESEND_API_KEY: undefined };
  assert.deepEqual(errors(silent), []);
  assert.ok(warnings(silent).some((p) => p.message.includes("invite links can only be read off the screen")));
});

// ---- the gate -----------------------------------------------------------------------------------------

test("assertConfig refuses a production environment and names every problem", () => {
  const lines: string[] = [];
  setLogSink((_level, line) => lines.push(line));
  try {
    const broken = { ...good(), DATABASE_URL: undefined, APP_URL: "http://sweetspot.example.com" };
    const error = refusal(() => assertConfig(broken));
    assert.match(error.message, /Refusing to start: 2 configuration problems/);
    assert.match(error.message, /DATABASE_URL/);
    assert.match(error.message, /APP_URL/);
    assert.equal(error.problems.filter((p) => p.level === "error").length, 2);
    assert.equal(lines.filter((l) => l.includes("config_invalid")).length, 2);
  } finally {
    setLogSink();
  }
});

test("assertConfig lets a development environment start and logs the same problems as warnings", () => {
  const lines: string[] = [];
  setLogSink((_level, line) => lines.push(line));
  try {
    const problems = assertConfig({ NODE_ENV: "development" });
    assert.deepEqual(problems.filter((p) => p.level === "error"), []);
    assert.equal(problems.length, 3); // DATABASE_URL, APP_URL and AUTH_SECRET, as warnings
    assert.equal(lines.filter((l) => l.includes("config_incomplete")).length, 3);
    assert.equal(lines.filter((l) => l.includes("config_invalid")).length, 0);
  } finally {
    setLogSink();
  }
});

test("a good environment logs one line and no warnings", () => {
  const lines: string[] = [];
  setLogSink((_level, line) => lines.push(line));
  try {
    assert.deepEqual(assertConfig(good()), []);
    assert.equal(lines.length, 1);
    const line = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(line.event, "config_checked");
    assert.equal(line.ok, true);
    assert.equal(line.count, 0);
  } finally {
    setLogSink();
  }
});

test("no problem message or log line carries a value", () => {
  // §10.6: a config error is read by whoever can see the logs, which is not whoever may see the secrets.
  const secrets = {
    ...good(),
    DATABASE_URL: "postgresql://sweetspot:hunter2-not-real@db.internal:5432/sweetspot",
    OPENAI_API_KEY: "sk-leak-me-not",
    APP_URL: "http://sweetspot.example.com",
    TWILIO_ACCOUNT_SID: "ACnot-a-real-sid",
    SUMMARY_TZ: "Mars/Olympus",
  };
  const lines: string[] = [];
  setLogSink((_level, line) => lines.push(line));
  let message = "";
  try {
    message = refusal(() => assertConfig(secrets)).message;
  } finally {
    setLogSink();
  }
  const text = `${message}\n${lines.join("\n")}`;
  for (const secret of ["hunter2-not-real", "sk-leak-me-not", "ACnot-a-real-sid", "Mars/Olympus"]) {
    assert.equal(text.includes(secret), false, `leaked ${secret}`);
  }
  // It still has to be useful: the variable names are there.
  for (const name of ["APP_URL", "TWILIO_ACCOUNT_SID", "SUMMARY_TZ"]) assert.ok(text.includes(name), `missing ${name}`);
});

test("isProduction treats an unset NODE_ENV as development", () => {
  assert.equal(isProduction({}), false);
  assert.equal(isProduction({ NODE_ENV: "test" }), false);
  assert.equal(isProduction({ NODE_ENV: "production" }), true);
});

test("appUrl defaults to localhost and drops the trailing slash so callers can append a path", () => {
  assert.equal(appUrl({}), "http://localhost:3000");
  assert.equal(appUrl({ APP_URL: "https://sweetspot.example.com/" }), "https://sweetspot.example.com");
  assert.equal(appUrl({ APP_URL: "  https://sweetspot.example.com  " }), "https://sweetspot.example.com");
});

// ---- the list stays complete --------------------------------------------------------------------------

const repoRoot = path.join(import.meta.dirname, "..");

const envExampleNames = (): string[] => {
  const text = readFileSync(path.join(repoRoot, ".env.example"), "utf8");
  const names = new Set<string>();
  // A commented-out assignment counts as documented: that is how a variable the tooling sets is listed.
  for (const line of text.split("\n")) {
    const match = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) names.add(match[1]);
  }
  return [...names];
};

test(".env.example documents every variable the app reads", () => {
  const documented = new Set(envExampleNames());
  const missing = SPEC.filter((s) => !documented.has(s.name)).map((s) => s.name);
  assert.deepEqual(missing, [], "add these to .env.example");
});

test(".env.example is a file you can copy to .env and get a clean start", () => {
  // The values in it are examples, so they have to be examples that pass: a half-filled DEXCOM_* group or a
  // stray SUMMARY_TZ would greet every new developer with a warning about a file they did not write.
  const text = readFileSync(path.join(repoRoot, ".env.example"), "utf8");
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z][A-Z0-9_]*)="?([^"#]*)"?/.exec(line);
    if (match) env[match[1]] = match[2].trim();
  }
  assert.ok(env.DATABASE_URL, "the parse above found nothing, so this test is not testing anything");

  // The file cannot ship a secret, so "AUTH_SECRET is not set" is the file working as intended. What it must
  // never contain is a value that is wrong on its own terms, or two values that contradict each other.
  const problems = validateConfig(env);
  assert.deepEqual(problems.filter((p) => p.kind !== "missing"), []);
  assert.deepEqual(problems.filter((p) => p.level === "error"), []);
});

test(".env.example has nothing the validator does not know about", () => {
  const known = new Set(SPEC.map((s) => s.name));
  const extra = envExampleNames().filter((name) => !known.has(name));
  assert.deepEqual(extra, [], "add these to SPEC in lib/config.ts");
});

const sourceFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
};

// ---- §13.4's demo sign-in ---------------------------------------------------------------------------------

test("DEMO_SIGN_IN is off unless it is one of the affirmative spellings", () => {
  for (const value of ["1", "true", "TRUE", "on", " on "]) {
    assert.equal(demoSignInEnabled({ DEMO_SIGN_IN: value }), true, JSON.stringify(value));
  }
  // Anything else is off, including the spellings a human might expect to work: the thing being decided is
  // whether a route hands out a session without a link, so the default has to be the closed door.
  for (const value of [undefined, "", " ", "0", "false", "off", "yes", "demo", "no"]) {
    assert.equal(demoSignInEnabled({ DEMO_SIGN_IN: value }), false, JSON.stringify(value));
  }
});

test("a value that is not a DEMO_SIGN_IN spelling at all is a problem, not a silent off", () => {
  const problems = validateConfig({ ...good(), DEMO_SIGN_IN: "yes" });
  assert.ok(problems.some((p) => p.variable === "DEMO_SIGN_IN" && p.kind === "invalid"));
});

test("DEMO_SIGN_IN on a production deployment is a warning, never a refusal", () => {
  // Staging is a production build on a public URL, which is exactly where §13.4 asks for the shortcut — so
  // this cannot refuse. It says so on every boot instead.
  const env = { ...good(), DEMO_SIGN_IN: "1" };
  assert.deepEqual(errors(env), []);
  const warning = warnings(env).find((p) => p.variable === "DEMO_SIGN_IN");
  assert.ok(warning, "a deployment with the shortcut on says so");
  assert.match(warning!.message, /staging/);

  // Off, and a local production build with it on, are both silent: the second is `npm run build && npm start`.
  assert.equal(warnings(good()).some((p) => p.variable === "DEMO_SIGN_IN"), false);
  assert.equal(
    warnings({ ...good(), DEMO_SIGN_IN: "1", APP_URL: "http://localhost:3000" }).some((p) => p.variable === "DEMO_SIGN_IN"),
    false,
  );
});

test("every environment variable read in lib/ and app/ has a row in SPEC", () => {
  // This is the test that keeps the list honest as the app grows: a new `process.env.WHATEVER` in application
  // code is a variable a deployment has to set, so it needs documenting and checking.
  const known = new Set(SPEC.map((s) => s.name));
  const found = new Map<string, string>();
  const files = [...sourceFiles(path.join(repoRoot, "lib")), ...sourceFiles(path.join(repoRoot, "app"))]
    .filter((file) => file !== path.join(repoRoot, "lib", "config.ts")); // the list itself, read by name
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      // A variable the code *sets* is not configuration a deployment has to supply — lib/fixtures.ts pins
      // process.env.TZ so dates render the same everywhere. Only reads belong in the list.
      if (/^\s*=[^=]/.test(text.slice(match.index + match[0].length))) continue;
      if (!known.has(match[1])) found.set(match[1], path.relative(repoRoot, file));
    }
  }
  assert.deepEqual(
    [...found].map(([name, file]) => `${name} (${file})`),
    [],
    "add these to SPEC in lib/config.ts and to .env.example",
  );
});
