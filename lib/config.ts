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

/** The link in every invite is built from this, so a wrong one is an email nobody can act on. */
const publicAppUrl = (value: string, ctx: { production: boolean }): string | undefined => {
  const url = parseUrl(value);
  if (!url) return "must be an absolute URL, like https://sweetspot.example.com";
  if (url.protocol !== "http:" && url.protocol !== "https:") return "must be an http:// or https:// URL";
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
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
    name: "EMAIL_PROVIDER",
    group: "Email",
    requirement: "optional",
    summary: "Force a backend instead of auto-detecting: resend or ses.",
    check: oneOf("resend", "ses"),
  },
  {
    name: "EMAIL_FROM",
    group: "Email",
    requirement: "optional",
    summary: "Sender address. With SES it must be a verified identity.",
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
    summary: "Force a backend instead of auto-detecting: twilio or sns.",
    check: oneOf("twilio", "sns"),
  },
  {
    name: "TWILIO_ACCOUNT_SID",
    group: "SMS",
    requirement: "optional",
    summary: "Set this to send through Twilio instead of SNS.",
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
    summary: "Registered origination number. US destinations will not deliver without one.",
    check: senderNumber,
  },

  {
    name: "DEXCOM_CLIENT_ID",
    group: "Dexcom",
    requirement: "optional",
    summary: "Dexcom application client id. The whole group is optional; uploads work without it.",
  },
  {
    name: "DEXCOM_CLIENT_SECRET",
    group: "Dexcom",
    requirement: "optional",
    summary: "Dexcom application client secret.",
  },
  {
    name: "DEXCOM_REDIRECT_URI",
    group: "Dexcom",
    requirement: "optional",
    summary: "OAuth callback, which must be this deployment's /api/dexcom/callback.",
    check: dexcomCallback,
  },
  {
    name: "DEXCOM_BASE_URL",
    group: "Dexcom",
    requirement: "optional",
    summary: "https://sandbox-api.dexcom.com until the production application is approved (design §9.2).",
    check: absoluteUrl,
  },
];

const SPEC_BY_NAME = new Map(SPEC.map((s) => [s.name, s]));

export const GROUPS: readonly string[] = [...new Set(SPEC.map((s) => s.group))];

// ---- Validation ------------------------------------------------------------------------------------------

export type ProblemLevel = "error" | "warning";
export type Problem = { level: ProblemLevel; variable?: string; message: string };

/** Unset and set-to-blank are the same thing. The e2e suite passes OPENAI_API_KEY="" to mean "no model". */
export function read(env: Env, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export const isProduction = (env: Env = process.env): boolean => (env.NODE_ENV ?? "development") === "production";

/** Every problem with this environment, worst first. Pure: give it any object, get the same answer. */
export function validateConfig(env: Env = process.env, opts: { production?: boolean } = {}): Problem[] {
  const production = opts.production ?? isProduction(env);
  // In development the same problems are reported, they just do not stop the server.
  const fatal: ProblemLevel = production ? "error" : "warning";
  const problems: Problem[] = [];

  for (const spec of SPEC) {
    const value = read(env, spec.name);
    if (value === undefined) {
      if (spec.requirement === "required") {
        problems.push({ level: fatal, variable: spec.name, message: `${spec.name} is not set. ${spec.summary}` });
      } else if (spec.requirement === "recommended" && production) {
        problems.push({ level: "warning", variable: spec.name, message: `${spec.name} is not set, so ${spec.whenMissing}.` });
      }
      continue;
    }
    const problem = spec.check?.(value, { production });
    if (problem) problems.push({ level: fatal, variable: spec.name, message: `${spec.name} ${problem}.` });
  }

  problems.push(...groupProblems(env, fatal, production));
  return [...problems].sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));
}

/** Problems no single variable can see: half-configured integrations, and a production deployment with no way
 *  to reach a patient. */
function groupProblems(env: Env, fatal: ProblemLevel, production: boolean): Problem[] {
  const v = (name: string) => read(env, name);
  const out: Problem[] = [];

  const companions = (trigger: string, needed: string[], why: string) => {
    if (!v(trigger)) return;
    const missing = needed.filter((name) => !v(name));
    if (missing.length === 0) return;
    out.push({
      level: fatal,
      variable: missing[0],
      message: `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} required when ${trigger} is set (${why}).`,
    });
  };

  companions("AWS_ACCESS_KEY_ID", ["AWS_SECRET_ACCESS_KEY"], "static credentials come in pairs");
  companions("TWILIO_ACCOUNT_SID", ["TWILIO_AUTH_TOKEN", "TWILIO_FROM"], "lib/sms.ts cannot send without them");
  if (v("EMAIL_PROVIDER") === "resend") companions("EMAIL_PROVIDER", ["RESEND_API_KEY"], "the Resend backend was selected");
  if (v("EMAIL_PROVIDER") === "ses") companions("EMAIL_PROVIDER", ["EMAIL_FROM"], "SES rejects an unverified sender");
  if (v("SMS_PROVIDER") === "twilio") companions("SMS_PROVIDER", ["TWILIO_ACCOUNT_SID"], "the Twilio backend was selected");

  // Dexcom is all-or-nothing: lib/dexcom.ts throws on a partial set, which reads as "not connected" in the UI
  // and hides the typo that caused it.
  const dexcom = SPEC.filter((s) => s.group === "Dexcom").map((s) => s.name);
  const dexcomSet = dexcom.filter((name) => v(name));
  if (dexcomSet.length > 0 && dexcomSet.length < dexcom.length) {
    const missing = dexcom.filter((name) => !v(name));
    out.push({
      level: fatal,
      variable: missing[0],
      message: `Dexcom is half-configured: ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not set. Set all of ${dexcom.join(", ")}, or none of them.`,
    });
  }

  if (production) {
    const email = Boolean(v("RESEND_API_KEY") || v("AWS_ACCESS_KEY_ID") || v("EMAIL_PROVIDER"));
    const sms = Boolean(v("TWILIO_ACCOUNT_SID") || v("AWS_ACCESS_KEY_ID") || v("SMS_PROVIDER"));
    if (!email && !sms) {
      out.push({
        level: "warning",
        message: "No email or SMS backend is configured, so invite links can only be read off the screen (design §8).",
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

  log.info("config_checked", { count: SPEC.length, ok: true, degraded: problems.length > 0 });
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
