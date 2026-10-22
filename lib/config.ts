// Startup configuration (design §3.7, §13). Owner: platform.
//
// One list — SPEC — of every environment variable this application reads, and one check that runs before the
// server answers its first request. The point is that a misconfigured deployment fails loudly at boot instead
// of quietly at the first patient who needs it: a missing DATABASE_URL should not surface as a 500 halfway
// through an intake, and an APP_URL left pointing at localhost should not surface as an invite link nobody
// can open.
//
// Three requirement levels, because the app degrades differently depending on what is missing:
//
//   required     No default and no degraded path. Missing one is a refusal to start in production
//                (a warning in development, where the next error message is usually clearer anyway).
//   recommended  There is a documented degraded path, so a production deployment without it still works,
//                less well: no model key means Sweetie answers from its scripted path (§3.5, §11.3), no
//                notification channel means the invite link is shown on screen instead of sent (§8).
//                Always a warning, never a refusal — the e2e suite runs a production build with no model
//                key on purpose, and that is a state the design asks us to support, not to reject.
//   optional     Tuning knobs and per-integration settings. Silence when unset.
//
// A value that *is* set but malformed is treated like a missing required one: a `file:` DATABASE_URL left
// over from SQLite (§3.2), a LLM_TIMEOUT_MS of "soon", a half-configured Twilio account. Those are errors in
// production and warnings in development, the same rule as `required`.
//
// Nothing here ever logs or prints a value. Problems name the variable and say what is wrong with it; the
// secret itself stays in the environment where it belongs (§10.6).

import { DEXCOM_BASE_URL, DEXCOM_ENVS, dexcomCredentialNames, dexcomEnv, isDexcomEnv } from "./dexcomEnv";
import { log } from "./log";

export type Requirement = "required" | "recommended" | "optional";
export type Env = Record<string, string | undefined>;

export type VarSpec = {
  name: string;
  group: string;
  requirement: Requirement;
  /** One line for the operator: what this variable is for. Also what `npm run config:check` prints. */
  summary: string;
  /** What happens without it. Required of `recommended` variables, which is the whole point of them. */
  whenMissing?: string;
  /** Other names the app accepts for the same thing. A required variable is satisfied by any of them, so a
   *  deployment that set only the older name is not refused for a variable the code reads perfectly well. */
  aliases?: string[];
  /** Returns a problem phrase ("must be ...") when the value is wrong, or undefined when it is fine.
   *  The phrase is appended to the variable name, so it reads as a sentence and never quotes the value. */
  check?: (value: string, ctx: { production: boolean }) => string | undefined;
};

// ---- Value checks ----------------------------------------------------------------------------------------

const parseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const absoluteUrl = (value: string): string | undefined =>
  parseUrl(value) ? undefined : "must be an absolute URL, like https://sweetspot.example.com";

const positiveInt = (value: string): string | undefined =>
  /^\d+$/.test(value) && Number(value) > 0 ? undefined : "must be a whole number of at least 1";

const oneOf = (...allowed: string[]) => (value: string): string | undefined =>
  allowed.includes(value) ? undefined : `must be one of ${allowed.join(", ")}`;

const awsRegion = (value: string): string | undefined =>
  /^[a-z]{2}(-[a-z]+)+-\d$/.test(value) ? undefined : "must be an AWS region, like us-east-1";

/** E.164, or a Twilio Messaging Service SID, which is what a production Twilio sender usually is. */
const senderNumber = (value: string): string | undefined =>
  /^\+[1-9]\d{6,14}$/.test(value) || /^MG[0-9a-f]{32}$/i.test(value)
    ? undefined
    : "must be a phone number in E.164 form (+15551234567) or a Twilio Messaging Service SID";

/** The session signing key. Short is guessable, and the development constant is in this repository for anyone
 *  to read — either one lets a stranger mint a session for any clinician in the practice. DEV_SECRET is copied
 *  rather than imported because lib/auth.ts pulls in next-auth, which this module is loaded too early to want;
 *  lib/config.test.ts fails if the two ever drift apart. */
export const AUTH_DEV_SECRET = "sweet-spot-development-secret-not-for-deployment";

const authSecret = (value: string, ctx: { production: boolean }): string | undefined => {
  if (ctx.production && value === AUTH_DEV_SECRET) {
    return "is lib/auth.ts's development constant, which is public in this repository — generate one with `openssl rand -base64 32`";
  }
  return value.length >= 16 ? undefined : "must be at least 16 characters — it signs every provider session cookie";
};

/** Postgres only: SQLite is removed (§3.2), and a `file:` URL here fails much later and much less clearly. */
const postgresUrl = (value: string): string | undefined => {
  const url = parseUrl(value);
  if (!url) return "must be a connection URL, like postgresql://user:password@host:5432/sweetspot";
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return "must be a postgresql:// URL — this app is Postgres only (design §3.2)";
  }
  if (!url.pathname.replace(/^\//, "")) return "must name a database after the host, like .../sweetspot";
  return undefined;
};

/** Whether a URL points at this machine. The e2e suite and `npm run build && npm start` are production
 *  builds that are not deployments, and this is what tells them apart: a deployment is reachable by someone
 *  else. Used by the APP_URL check and by the DEV_MAIL_DIR rule in groupProblems. */
export function isLocal(value: string | undefined): boolean {
  const url = value === undefined ? null : parseUrl(value);
  return url !== null && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

/** The link in every invite is built from this, so a wrong one is an email nobody can act on. */
const publicAppUrl = (value: string, ctx: { production: boolean }): string | undefined => {
  const url = parseUrl(value);
  if (!url) return "must be an absolute URL, like https://sweetspot.example.com";
  if (url.protocol !== "http:" && url.protocol !== "https:") return "must be an http:// or https:// URL";
  const local = isLocal(value);
  if (ctx.production && url.protocol === "http:" && !local) {
    return "must use https:// in production — patient links carry a session token (design §10.1)";
  }
  return undefined;
};

/** `user@host` or `Name <user@host>`. Whether the identity is verified with SES is not ours to know. */
const emailAddress = (value: string): string | undefined =>
  /^[^<>@\s]+@[^<>@\s]+\.[A-Za-z]{2,}$/.test(value) || /^[^<>]+<[^<>@\s]+@[^<>@\s]+\.[A-Za-z]{2,}>$/.test(value)
    ? undefined
    : "must be an email address, optionally as \"Name <you@example.com>\"";

const timeZone = (value: string): string | undefined => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return undefined;
  } catch {
    return "must be an IANA time zone, like America/Los_Angeles";
  }
};

const dexcomCallback = (value: string): string | undefined => {
  const url = parseUrl(value);
  if (!url) return "must be an absolute URL";
  if (url.pathname !== "/api/dexcom/callback") return "must end in /api/dexcom/callback (lib/dexcom.ts)";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    return "must use https://, or http:// on localhost";
  }
  return undefined;
};

// ---- The list --------------------------------------------------------------------------------------------
// Every `process.env.X` in lib/ and app/ has a row here; lib/config.test.ts fails the build if one is added
// without one, and .env.example is checked against this list in both directions.

export const SPEC: readonly VarSpec[] = [
  {
    name: "NODE_ENV",
    group: "App",
    requirement: "optional",
    summary: "Set by Next.js, not by you. `production` is what makes the checks below a refusal rather than a warning.",
    check: oneOf("development", "test", "production"),
  },
  {
    name: "DATABASE_URL",
    group: "App",
    requirement: "required",
    summary: "Postgres connection URL (RDS in AWS, Docker or a host Postgres locally).",
    check: postgresUrl,
  },
  {
    name: "APP_URL",
    group: "App",
    requirement: "required",
    summary: "Public base URL of this deployment. Every patient and provider link is built from it.",
    check: publicAppUrl,
  },
  {
    name: "SUMMARY_TZ",
    group: "App",
    requirement: "optional",
    summary: "Time zone the Sour one-pager reads times in. Defaults to the server's own zone.",
    check: timeZone,
  },

  {
    name: "JOBS_SECRET",
    group: "Jobs",
    requirement: "recommended",
    summary: "Shared secret the scheduler sends to POST /api/jobs/run as `Authorization: Bearer <secret>`.",
    whenMissing: "POST /api/jobs/run refuses and jobs drain inside the request that enqueued them (design §3.4)",
    // The runner route is public and this secret is the whole door, so a guessable one is worse than none:
    // without it the route refuses outright, with `changeme` it lets anyone drain the queue.
    check: (value) => (value.length >= 16 ? undefined : "must be at least 16 characters — it is the only thing guarding a public route"),
  },
  {
    name: "JOBS_RUNNER",
    group: "Jobs",
    requirement: "optional",
    summary: "Force who drains the queue instead of deciding from JOBS_SECRET: inline or scheduled.",
    check: oneOf("inline", "scheduled"),
  },

  {
    name: "AUTH_SECRET",
    group: "Sign-in",
    requirement: "required",
    summary: "Signs the provider session cookie and hashes the one-time sign-in tokens.",
    // lib/auth.ts falls back to a constant outside production and leaves the production refusal here, by
    // name: "Refusing to start is T31's job (§3.7)". Without it Auth.js answers every request with a
    // Configuration error, so the deployment is up and nobody can sign in — §3.7 exists to stop exactly that
    // before it takes traffic. NEXTAUTH_SECRET satisfies it because lib/auth.ts reads either.
    aliases: ["NEXTAUTH_SECRET"],
    check: authSecret,
  },
  {
    name: "NEXTAUTH_SECRET",
    group: "Sign-in",
    requirement: "optional",
    summary: "Auth.js v4's name for AUTH_SECRET. lib/auth.ts reads it as an alias; prefer AUTH_SECRET in new deployments.",
    check: authSecret,
  },
  {
    name: "DEV_MAIL_DIR",
    group: "Sign-in",
    requirement: "optional",
    summary: "Divert all outgoing mail to files in this directory instead of sending it (local development and the e2e suite).",
    // On a deployment this is not a preference, it is an outage with a security hole in it — see the rule in
    // groupProblems, which needs APP_URL as well to tell a deployment from a production build on a laptop.
  },
  {
    name: "DEMO_SIGN_IN",
    group: "Sign-in",
    requirement: "optional",
    summary: "Let GET /demo sign straight into the seeded demo practice instead of showing the sign-in form (design §13.4). Staging and local demos only.",
    check: oneOf("1", "0", "true", "false", "on", "off"),
    // Production earns a warning rather than a refusal (groupProblems below): staging is a production build,
    // so NODE_ENV cannot tell the two apart, and refusing would refuse the stage the design asks for it on.
  },

  {
    name: "OPENAI_BASE_URL",
    group: "Model",
    requirement: "recommended",
    summary: "Bedrock's OpenAI-compatible endpoint, in the region the key was issued for.",
    whenMissing: "the SDK's own default is used, which is not Bedrock",
    check: absoluteUrl,
  },
  {
    name: "OPENAI_API_KEY",
    group: "Model",
    requirement: "recommended",
    summary: "Bedrock API key (the AWS_BEARER_TOKEN_BEDROCK value), not an OpenAI key.",
    whenMissing: "Sweetie and Sour answer from their scripted paths and the page says so (design §6.3, §11.3)",
    // T63 asked whether this should become `required`, which under §3.7 means a deployment without it
    // refuses to serve at all. Deliberately not: scripted mode is a supported mode of this product rather
    // than a broken one (§6.3, §11.3). Booking visits, the patient's intake and transcript, every
    // deterministic number in lib/sour.ts, the spike table and the printed one-pager all work with no key,
    // so refusing to boot would take a practice entirely offline in order to withhold three sentences of
    // narrative — and a pilot deploying while its Bedrock key is still being issued (§1) is exactly the case
    // the design plans for. What reports the gap instead: this check, which warns about it in production
    // (groupProblems below), the `model` leg of GET /api/health (§11.2), and the §11.1 model alarms. Not a
    // patient's summary, which since T63 says nothing about configuration at all.
  },
  {
    name: "BEDROCK_OPENAI_MODEL_ID",
    group: "Model",
    requirement: "recommended",
    summary: "Model id to call, e.g. global.openai.gpt-5.6-terra.",
    whenMissing: "lib/llm.ts falls back to openai.gpt-5.5, which may not be enabled for your account",
    check: (value) => (/\s/.test(value) ? "must be a single model id, with no spaces" : undefined),
  },
  {
    name: "LLM_TIMEOUT_MS",
    group: "Model",
    requirement: "optional",
    summary: "Per-attempt model timeout in milliseconds. Default 20000.",
    check: positiveInt,
  },
  {
    name: "LLM_CIRCUIT_THRESHOLD",
    group: "Model",
    requirement: "optional",
    summary: "Consecutive failed calls that open the circuit. Default 3.",
    check: positiveInt,
  },
  {
    name: "LLM_CIRCUIT_COOLDOWN_MS",
    group: "Model",
    requirement: "optional",
    summary: "How long an open circuit is left alone, in milliseconds. Default 60000.",
    check: positiveInt,
  },

  {
    name: "AWS_REGION",
    group: "AWS",
    requirement: "optional",
    summary: "Default region for the AWS SDK. Fallback for the SES and SNS regions below.",
    check: awsRegion,
  },
  {
    name: "AWS_DEFAULT_REGION",
    group: "AWS",
    requirement: "optional",
    summary: "Same thing under the name the AWS CLI reads. Either is fine.",
    check: awsRegion,
  },
  {
    name: "AWS_ACCESS_KEY_ID",
    group: "AWS",
    requirement: "optional",
    summary: "Static credentials. Leave unset on AWS, where the task role supplies them.",
  },
  {
    name: "AWS_SECRET_ACCESS_KEY",
    group: "AWS",
    requirement: "optional",
    summary: "Secret half of the static credentials.",
  },
  {
    name: "AWS_SESSION_TOKEN",
    group: "AWS",
    requirement: "optional",
    summary: "Needed only for temporary credentials.",
  },

  {
    name: "UPLOADS_BUCKET",
    group: "Uploads",
    requirement: "recommended",
    summary: "Private, encrypted S3 bucket the raw uploaded exports go to (design §3.3).",
    whenMissing: "lib/storage.ts writes the files to UPLOADS_DIR on the local filesystem, which a deployment loses on redeploy and cannot share between instances",
    // s3.amazonaws.com's own rules: 3 to 63 characters, lowercase, no underscores, and not an IP address.
    check: (value) =>
      /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value) && !/\.\./.test(value) && !/^\d+(\.\d+){3}$/.test(value)
        ? undefined
        : "must be an S3 bucket name: 3 to 63 lowercase letters, digits, dots or hyphens",
  },
  {
    name: "UPLOADS_REGION",
    group: "Uploads",
    requirement: "optional",
    summary: "Region of the uploads bucket, when it differs from the default region.",
    check: awsRegion,
  },
  {
    name: "UPLOADS_KMS_KEY_ID",
    group: "Uploads",
    requirement: "optional",
    summary: "Encrypt objects with this KMS key (SSE-KMS) instead of the bucket default (SSE-S3).",
  },
  {
    name: "UPLOADS_DIR",
    group: "Uploads",
    requirement: "optional",
    summary: "Where the filesystem backend writes. Default data/uploads/.",
  },
  {
    name: "STORAGE_BACKEND",
    group: "Uploads",
    requirement: "optional",
    summary: "Force a backend instead of deciding from UPLOADS_BUCKET: s3 or local.",
    check: oneOf("s3", "local"),
  },

  {
    name: "EMAIL_PROVIDER",
    group: "Email",
    requirement: "optional",
    summary: "Force a backend instead of taking it from the settings each one needs: resend or ses.",
    check: oneOf("resend", "ses"),
  },
  {
    name: "EMAIL_FROM",
    group: "Email",
    requirement: "optional",
    summary: "Verified SES identity to send from, and what selects the SES backend. SES rejects an unverified sender.",
    check: emailAddress,
  },
  {
    name: "RESEND_API_KEY",
    group: "Email",
    requirement: "optional",
    summary: "Set this to send through Resend instead of SES.",
  },
  {
    name: "AWS_SES_REGION",
    group: "Email",
    requirement: "optional",
    summary: "Region for SES, when it differs from the default region.",
    check: awsRegion,
  },

  {
    name: "SMS_PROVIDER",
    group: "SMS",
    requirement: "optional",
    summary: "Force a backend instead of taking it from the settings each one needs: twilio or sns.",
    check: oneOf("twilio", "sns"),
  },
  {
    name: "TWILIO_ACCOUNT_SID",
    group: "SMS",
    requirement: "optional",
    summary: "Set this to send through Twilio instead of SNS; needs TWILIO_AUTH_TOKEN and TWILIO_FROM too.",
    check: (value) => (/^AC[0-9a-f]{32}$/i.test(value) ? undefined : "must be a Twilio account SID, which starts with AC"),
  },
  {
    name: "TWILIO_AUTH_TOKEN",
    group: "SMS",
    requirement: "optional",
    summary: "Twilio auth token.",
  },
  {
    name: "TWILIO_FROM",
    group: "SMS",
    requirement: "optional",
    summary: "Twilio sender: a phone number you own, or a Messaging Service SID.",
    check: senderNumber,
  },
  {
    name: "AWS_SNS_REGION",
    group: "SMS",
    requirement: "optional",
    summary: "Region for SNS, when it differs from the default region.",
    check: awsRegion,
  },
  {
    name: "SNS_ORIGINATION_NUMBER",
    group: "SMS",
    requirement: "optional",
    summary: "Registered origination number, and what selects the SNS backend. US destinations will not deliver without one.",
    check: senderNumber,
  },

  {
    name: "SNS_TOPIC_ARNS",
    group: "Notifications",
    requirement: "optional",
    summary: "SNS topics POST /api/notifications/sns accepts: SES bounces and complaints, and inbound texts (design §8.1).",
    // Unset is not a half-configuration — it is "we are not subscribed to anything yet", and the route says
    // so with a 503 rather than trusting whatever arrives. A value that is set and is not an ARN is a typo
    // worth refusing over, because the symptom otherwise is bounces being dropped in silence.
    check: (value) => {
      const arns = value.split(/[\s,]+/).filter(Boolean);
      const bad = arns.find((arn) => !/^arn:aws[a-z-]*:sns:[a-z0-9-]+:\d{12}:[\w.-]+$/.test(arn));
      return bad ? "must be SNS topic ARNs, comma separated, like arn:aws:sns:us-east-1:123456789012:sweetspot-ses-events" : undefined;
    },
  },
  {
    name: "SES_CONFIGURATION_SET",
    group: "Notifications",
    requirement: "optional",
    summary: "SES configuration set that publishes bounce, complaint and delivery events to the topic above.",
    check: (value) => (/^[\w.-]{1,64}$/.test(value) ? undefined : "must be an SES configuration set name"),
  },

  {
    name: "DEXCOM_ENV",
    group: "Dexcom",
    requirement: "optional",
    summary: "Which Dexcom to talk to: sandbox (the default) or production, once Dexcom approves the app (design §9.2).",
    check: oneOf(...DEXCOM_ENVS),
  },
  {
    name: "DEXCOM_CLIENT_ID",
    group: "Dexcom",
    requirement: "optional",
    summary: "Dexcom application client id, for whichever environment has no id of its own below. The whole group is optional; uploads work without it.",
  },
  {
    name: "DEXCOM_CLIENT_SECRET",
    group: "Dexcom",
    requirement: "optional",
    summary: "Dexcom application client secret, for whichever environment has no secret of its own below.",
  },
  {
    name: "DEXCOM_SANDBOX_CLIENT_ID",
    group: "Dexcom",
    requirement: "optional",
    summary: "Client id used when DEXCOM_ENV=sandbox, for a deployment holding both applications' credentials.",
  },
  {
    name: "DEXCOM_SANDBOX_CLIENT_SECRET",
    group: "Dexcom",
    requirement: "optional",
    summary: "Client secret used when DEXCOM_ENV=sandbox.",
  },
  {
    name: "DEXCOM_PRODUCTION_CLIENT_ID",
    group: "Dexcom",
    requirement: "optional",
    summary: "Client id used when DEXCOM_ENV=production. Dexcom issues a separate application for it.",
  },
  {
    name: "DEXCOM_PRODUCTION_CLIENT_SECRET",
    group: "Dexcom",
    requirement: "optional",
    summary: "Client secret used when DEXCOM_ENV=production.",
  },
  {
    name: "DEXCOM_REDIRECT_URI",
    group: "Dexcom",
    requirement: "optional",
    summary: "OAuth callback, which must be this deployment's /api/dexcom/callback.",
    check: dexcomCallback,
  },
  {
    name: "DEXCOM_TOKEN_KMS_KEY_ID",
    group: "Dexcom",
    requirement: "optional",
    summary: "KMS key (id, alias or ARN) the stored Dexcom refresh tokens are encrypted with (design §4.10, §10.1).",
    // An ARN names its own region, which is why there is no DEXCOM_TOKEN_KMS_REGION; anything else uses the
    // default region. Not validated beyond being one token: KMS accepts a uuid, `alias/name`, and two ARN
    // shapes, and a typo in a key id surfaces at the first connection rather than silently.
    check: (value) => (/\s/.test(value) ? "must be a single KMS key id, alias or ARN, with no spaces" : undefined),
  },
  {
    name: "DEXCOM_BASE_URL",
    group: "Dexcom",
    requirement: "optional",
    summary: "No longer how the host is chosen — DEXCOM_ENV is. Kept so a deployment that pins it is checked against the switch rather than ignored (design §9.2).",
    check: absoluteUrl,
  },
];

const SPEC_BY_NAME = new Map(SPEC.map((s) => [s.name, s]));

export const GROUPS: readonly string[] = [...new Set(SPEC.map((s) => s.group))];

// ---- Validation ------------------------------------------------------------------------------------------

export type ProblemLevel = "error" | "warning";

/** Why it is a problem, which is not the same question as how bad it is:
 *    missing      — nothing is set, and something has to be. A blank in .env.example is this and only this.
 *    invalid      — a value is set and wrong on its own terms.
 *    combination  — each value is fine alone and they contradict each other. */
export type ProblemKind = "missing" | "invalid" | "combination";
export type Problem = { level: ProblemLevel; kind: ProblemKind; variable?: string; message: string };

/** Unset and set-to-blank are the same thing. The e2e suite passes OPENAI_API_KEY="" to mean "no model". */
export function read(env: Env, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export const isProduction = (env: Env = process.env): boolean => (env.NODE_ENV ?? "development") === "production";

/** Whether `/demo` may sign in rather than offer the form (§13.4, app/demo/route.ts). Off unless asked for:
 *  anything that is not one of the affirmative spellings — including an unset or misspelled value — is off,
 *  because the failure of reading this wrong is a door standing open. */
export function demoSignInEnabled(env: Env = process.env): boolean {
  const value = read(env, "DEMO_SIGN_IN")?.toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

/** Every problem with this environment, worst first. Pure: give it any object, get the same answer. */
export function validateConfig(env: Env = process.env, opts: { production?: boolean } = {}): Problem[] {
  const production = opts.production ?? isProduction(env);
  // In development the same problems are reported, they just do not stop the server.
  const fatal: ProblemLevel = production ? "error" : "warning";
  const problems: Problem[] = [];

  for (const spec of SPEC) {
    const value = read(env, spec.name);
    if (value === undefined) {
      const alias = spec.aliases?.find((name) => read(env, name) !== undefined);
      if (alias) continue; // another name for it is set, and the code reads that one
      const names = [spec.name, ...(spec.aliases ?? [])].join(" or ");
      if (spec.requirement === "required") {
        problems.push({ level: fatal, kind: "missing", variable: spec.name, message: `${names} is not set. ${spec.summary}` });
      } else if (spec.requirement === "recommended" && production) {
        problems.push({ level: "warning", kind: "missing", variable: spec.name, message: `${spec.name} is not set, so ${spec.whenMissing}.` });
      }
      continue;
    }
    const problem = spec.check?.(value, { production });
    if (problem) problems.push({ level: fatal, kind: "invalid", variable: spec.name, message: `${spec.name} ${problem}.` });
  }

  problems.push(...groupProblems(env, fatal, production));

  // Don't also warn about what was just refused over. JOBS_RUNNER=scheduled with no secret earns both a
  // refusal and the "jobs will drain inline instead" warning, and that warning is not even true — inline is
  // what `scheduled` turned off.
  const refused = new Set(problems.filter((p) => p.level === "error" && p.variable).map((p) => p.variable));
  const kept = problems.filter((p) => p.level === "error" || !p.variable || !refused.has(p.variable));

  return kept.sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));
}

/** Problems no single variable can see: half-configured integrations, and a production deployment with no way
 *  to reach a patient. */
function groupProblems(env: Env, fatal: ProblemLevel, production: boolean): Problem[] {
  const v = (name: string) => read(env, name);
  const out: Problem[] = [];

  const companions = (trigger: string, needed: string[], why: string, level: ProblemLevel = fatal) => {
    if (!v(trigger)) return;
    const missing = needed.filter((name) => !v(name));
    if (missing.length === 0) return;
    out.push({
      level,
      kind: "combination",
      variable: missing[0],
      message: `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} required when ${trigger} is set (${why}).`,
    });
  };

  // A warning, not a refusal, even in production: unlike every other variable here, the AWS credential names
  // are ambient. CI runners and this repo's own cloud sandbox export them for their own reasons, and a
  // deployment that half-inherits them should degrade to "the invite link is on screen", not refuse to serve a
  // visit. The other half of the pair being absent is still worth saying out loud.
  companions("AWS_ACCESS_KEY_ID", ["AWS_SECRET_ACCESS_KEY"], "static credentials come in pairs", "warning");

  // `scheduled` with no secret is the one combination where nothing drains the queue at all: the route
  // refuses every call (503) and the inline path is off, so every summary and notification sits in `Job`
  // forever. Neither variable alone can see it.
  if (v("JOBS_RUNNER") === "scheduled" && !v("JOBS_SECRET")) {
    out.push({
      level: fatal,
      kind: "combination",
      variable: "JOBS_SECRET",
      message: "JOBS_SECRET is required when JOBS_RUNNER is scheduled: POST /api/jobs/run refuses without it and nothing else drains the queue (design §3.4).",
    });
  }
  companions("TWILIO_ACCOUNT_SID", ["TWILIO_AUTH_TOKEN", "TWILIO_FROM"], "lib/sms.ts cannot send without them");
  if (v("EMAIL_PROVIDER") === "resend") companions("EMAIL_PROVIDER", ["RESEND_API_KEY"], "the Resend backend was selected");
  // §8.1 SES sends from a verified identity, and since T110 that address is also what selects the backend
  // (lib/email.ts). Forcing `ses` without it is the one way left to ask for a backend that cannot send:
  // lib/email.ts reports itself unconfigured rather than building a client, so say which setting is missing.
  if (v("EMAIL_PROVIDER") === "ses") companions("EMAIL_PROVIDER", ["EMAIL_FROM"], "the SES backend was selected and it rejects an unverified sender");
  if (v("SMS_PROVIDER") === "twilio") companions("SMS_PROVIDER", ["TWILIO_ACCOUNT_SID"], "the Twilio backend was selected");
  // §8.1 SNS sends through a registered origination number, and since T94 that number is also what selects
  // the backend (lib/sms.ts). Forcing `sns` without it is the one way left to ask for a backend that cannot
  // send: lib/sms.ts reports itself unconfigured rather than publishing, so say which setting is missing.
  if (v("SMS_PROVIDER") === "sns") companions("SMS_PROVIDER", ["SNS_ORIGINATION_NUMBER"], "the SNS backend was selected and it sends through a registered origination number");
  // Asking for S3 with no bucket is not a degraded path: lib/storage.ts has nowhere to put the file, so every
  // upload fails at the moment a patient tries one.
  if (v("STORAGE_BACKEND") === "s3") companions("STORAGE_BACKEND", ["UPLOADS_BUCKET"], "lib/storage.ts has no bucket to write to");
  // §8.1 A configuration set publishes the events; the topic ARN is what makes this app act on them. Set one
  // without the other and bounces are published to a topic nothing here will believe — a warning rather than
  // a refusal, because the sending still works and it is suppression, not delivery, that is missing.
  companions("SES_CONFIGURATION_SET", ["SNS_TOPIC_ARNS"], "POST /api/notifications/sns ignores a topic that is not listed, so bounces would not suppress anything", "warning");

  // Dexcom (design §9.2). The group is optional as a whole — uploads work without any of it — but a partial
  // set is not a lighter version of it: lib/dexcom.ts throws on one, which reads as "not connected" in the UI
  // and hides the typo that caused it. What "complete" means now depends on DEXCOM_ENV, since each
  // environment has its own credentials and either may fall back to the unprefixed pair.
  // What counts as "being configured" is intent, not plumbing. The credentials and the two switches
  // (DEXCOM_ENV, DEXCOM_BASE_URL) are an operator saying they mean to talk to Dexcom. The callback URL and
  // the KMS key are not: both are things a deployment's infrastructure can provision before anyone has a
  // Dexcom application, and the T29 stack does exactly that — it knows this deployment's callback and owns
  // the key, and writes both whether or not the credentials ever arrive. Counting either as intent made the
  // §3.7 gate fail every deployment that had not signed up with Dexcom yet, which is most of them.
  const dexcomIntent = SPEC.filter((s) => s.group === "Dexcom")
    .map((s) => s.name)
    .filter((name) => name !== "DEXCOM_REDIRECT_URI" && name !== "DEXCOM_TOKEN_KMS_KEY_ID");
  if (dexcomIntent.some((name) => v(name))) {
    // A DEXCOM_ENV that is neither has already been reported by the row's own check; there is no environment
    // to judge the rest of the group against, so the rules below stand down rather than guess at one.
    const requested = v("DEXCOM_ENV");
    const selected = !requested || isDexcomEnv(requested) ? dexcomEnv(requested) : null;
    if (selected) {
      const credential = (suffix: "CLIENT_ID" | "CLIENT_SECRET") => {
        const names = dexcomCredentialNames(selected, suffix);
        return names.some((name) => v(name)) ? null : names.join(" or ");
      };
      const missing = [credential("CLIENT_ID"), credential("CLIENT_SECRET"), v("DEXCOM_REDIRECT_URI") ? null : "DEXCOM_REDIRECT_URI"]
        .filter((name): name is string => name !== null);
      if (missing.length > 0) {
        out.push({
          level: fatal,
          kind: "combination",
          variable: missing[0].split(" or ")[0],
          message: `Dexcom is half-configured for DEXCOM_ENV=${selected}: ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not set. Set all of them, or none of the DEXCOM_* variables.`,
        });
      }

      // DEXCOM_BASE_URL is no longer the switch, so a value that contradicts it is an operator who believes
      // they are in the other environment. lib/dexcom.ts refuses to build a client from the pair.
      const pinned = v("DEXCOM_BASE_URL")?.replace(/\/+$/, "");
      if (pinned && pinned !== DEXCOM_BASE_URL[selected]) {
        out.push({
          level: fatal,
          kind: "combination",
          variable: "DEXCOM_BASE_URL",
          message: `DEXCOM_BASE_URL is ${pinned === DEXCOM_BASE_URL.production ? "Dexcom's production host" : pinned === DEXCOM_BASE_URL.sandbox ? "Dexcom's sandbox host" : "not a Dexcom host"} while DEXCOM_ENV is ${selected}, whose host is ${DEXCOM_BASE_URL[selected]}. Unset DEXCOM_BASE_URL, or set DEXCOM_ENV to the environment you meant (design §9.2).`,
        });
      }

      // §4.10 and §10.1 ask for a KMS-backed key, and this is the line between a deployment and a production
      // build on somebody's laptop — the same test the DEV_MAIL_DIR rule above uses, for the same reason: the
      // e2e suite and `npm run build && npm start` are production builds that nobody else can reach. Without
      // a key, lib/dexcom.ts derives one from the client secret, which is fine for a demo and is not
      // encryption a deployment holding a patient's refresh token should be relying on.
      // Only once the rest of the group is whole: a half-configured Dexcom stores no tokens at all, so the
      // missing credentials are the problem to report and the key is a problem it does not have yet.
      if (missing.length === 0 && production && !isLocal(v("APP_URL")) && !v("DEXCOM_TOKEN_KMS_KEY_ID")) {
        out.push({
          level: "error",
          kind: "combination",
          variable: "DEXCOM_TOKEN_KMS_KEY_ID",
          message: "DEXCOM_TOKEN_KMS_KEY_ID is required on a deployment with Dexcom configured: a stored refresh token is a standing key to a patient's glucose history and must be encrypted with a KMS-backed key (design §4.10, §10.1).",
        });
      }
    }
  }

  // Diverting mail is how local development and the e2e suite work, and both run production builds, so
  // NODE_ENV alone cannot judge this. A production build serving a public URL is a deployment, and there
  // every sign-in link stops being delivered and starts being written to a file on the server — an outage
  // whose leftovers are bearer credentials (§10.6). APP_URL is the same localhost signal publicAppUrl uses.
  if (production && v("DEV_MAIL_DIR") && !isLocal(v("APP_URL"))) {
    out.push({
      level: "error",
      kind: "combination",
      variable: "DEV_MAIL_DIR",
      message:
        "DEV_MAIL_DIR is set on a deployment serving a public APP_URL: every email, sign-in links included, would be written to a file on the server instead of sent (design §5.1, §10.6). Unset it, or point APP_URL at localhost if this is a local production build.",
    });
  }

  // §13.4's shortcut is for staging, and staging is a production build with a public URL — so there is no
  // variable here that says "this is not production" and this cannot be a refusal. It is said out loud
  // instead, on every boot, because the one thing worse than the shortcut being on is nobody knowing it is.
  // What it can open is still only the seeded demo practice: app/demo/route.ts checks `Practice.isDemo`.
  if (production && demoSignInEnabled(env) && !isLocal(v("APP_URL"))) {
    out.push({
      level: "warning",
      kind: "combination",
      variable: "DEMO_SIGN_IN",
      message:
        "DEMO_SIGN_IN is on, so GET /demo signs in as the seeded demo provider with no link to click (design §13.4). That is meant for staging; unset it on production.",
    });
  }

  if (production) {
    // The question lib/email.ts answers, and not AWS_ACCESS_KEY_ID: a credential is not an email backend
    // (T110). A verified sending identity is, because that is the setting SES cannot mail anybody without.
    const email = Boolean(v("RESEND_API_KEY") || v("EMAIL_FROM") || v("EMAIL_PROVIDER"));
    // The same question lib/sms.ts answers, and not AWS_ACCESS_KEY_ID: a credential is not an SMS backend
    // (T94). An origination number is, because that is the setting SNS cannot text anybody without.
    const sms = Boolean(v("TWILIO_ACCOUNT_SID") || v("SNS_ORIGINATION_NUMBER") || v("SMS_PROVIDER"));
    if (!email && !isLocal(v("APP_URL"))) {
      // The second arm of the rule above, and the one it was written for (T113). Diverting mail to files on
      // a deployment is refused; a deployment with no email backend *at all* used to earn the warning below
      // and then behave identically, because lib/devMailbox.ts treated "nothing configured" as a reason to
      // divert. That arm is gone, which makes this an outage rather than a security hole — and an outage of
      // the two messages the product cannot be entered without, so it is an error and not a warning: no
      // provider can be sent a sign-in link (§5.1) and no patient can be sent the six-digit code their link
      // asks for (§2.3). SMS does not stand in for it, because a magic link is only ever email.
      out.push({
        level: "error",
        kind: "combination",
        variable: "EMAIL_FROM",
        message:
          "No email backend is configured on a deployment serving a public APP_URL: set EMAIL_FROM to a verified SES identity (design §8.1), or RESEND_API_KEY locally. Without one, a provider's sign-in link (§5.1) and a patient's six-digit code (§2.3) are never sent, so nobody can sign in and no patient can open their link.",
      });
    } else if (!email && !sms) {
      // A production build nobody else can reach — the e2e suite, `npm run build && npm start` — with no
      // sender of any kind. The invite half of this has always been true and fails soft: staff read the link
      // off the screen (§8.1). The other half is the two messages that are nobody's to read off a screen,
      // and naming DEV_MAIL_DIR is the whole of the answer for a local checkout (§11.3). The sentence used
      // to offer only the invite half, which described a different behaviour from the one that happened.
      out.push({
        level: "warning",
        kind: "combination",
        message:
          "No email or SMS backend is configured: invite links can only be read off the screen (design §8.1), and a sign-in link (§5.1) or a patient's six-digit code (§2.3) is not sent at all unless DEV_MAIL_DIR names a directory to write it to.",
      });
    }
  }

  return out;
}

// ---- The startup gate ------------------------------------------------------------------------------------

export class ConfigError extends Error {
  readonly problems: Problem[];
  constructor(message: string, problems: Problem[]) {
    super(message);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export function formatProblems(problems: Problem[]): string {
  return problems.map((p) => `  - ${p.message}`).join("\n");
}

/** Called once per server process from instrumentation.ts. Logs every problem, then throws if any of them is
 *  fatal — which in production is how the deployment refuses to serve (design §3.7). Returns the problems so a
 *  caller that wants to report rather than die (scripts/check-config.ts) can. */
export function assertConfig(env: Env = process.env): Problem[] {
  const problems = validateConfig(env);
  for (const p of problems) {
    // The message names variables and says what is wrong; it never carries a value, so there is nothing here
    // the log must not see (§10.6).
    if (p.level === "error") log.error("config_invalid", { error: p.message });
    else log.warn("config_incomplete", { error: p.message });
  }

  const errors = problems.filter((p) => p.level === "error");
  if (errors.length > 0) {
    throw new ConfigError(
      `Refusing to start: ${errors.length} configuration problem${errors.length > 1 ? "s" : ""}.\n` +
        `${formatProblems(errors)}\n` +
        "See .env.example for every variable, or run `npm run config:check`.",
      problems,
    );
  }

  // `count` is how many warnings were just logged, so one grep for config_checked says both that the
  // gate ran and whether anything above it needs reading.
  log.info("config_checked", { count: problems.length, ok: true });
  return problems;
}

// ---- Accessors -------------------------------------------------------------------------------------------
// Where a default exists, it lives here once rather than at each call site.

/** Public base URL with any trailing slash removed, so callers can append a path. */
export function appUrl(env: Env = process.env): string {
  return (read(env, "APP_URL") ?? "http://localhost:3000").replace(/\/+$/, "");
}

export function describe(name: string): VarSpec | undefined {
  return SPEC_BY_NAME.get(name);
}
