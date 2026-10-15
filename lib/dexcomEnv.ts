// Which Dexcom this deployment talks to (design §9.2). Owner: platform.
//
// Dexcom ships two of everything. The sandbox (`sandbox-api.dexcom.com`) answers with synthetic readings for
// a handful of fixed test accounts and is open to any registered application; production
// (`api.dexcom.com`) answers with a real person's glucose and is only opened once Dexcom approves the
// application. The two are separate applications on Dexcom's side, so they have separate client credentials
// as well as separate hosts — which is why one switch has to move both, and why §9.2 can promise that
// production is "the same code behind a DEXCOM_ENV switch" rather than a second integration.
//
//   DEXCOM_ENV=sandbox      the default, and what every environment stays on until approval comes through
//   DEXCOM_ENV=production   real patients, real readings
//
// Sandbox is the default because the failure modes are not symmetric: a deployment that meant to be in
// production and is still in sandbox imports nothing anybody will mistake for care data, while the reverse
// pulls a real person's glucose into a demo. An unrecognised value is neither, so it throws rather than
// guess (lib/config.ts refuses it at boot first; this is what happens if it ever gets past that).
//
// This module is deliberately pure: no node: imports, no logging, no reading of process.env except through
// the defaults below. middleware.ts runs on the edge runtime and needs the authorization origin for its
// `form-action` policy, and it can only reach a module that stays inside Web APIs.

export const DEXCOM_ENVS = ["sandbox", "production"] as const;
export type DexcomEnv = (typeof DEXCOM_ENVS)[number];

/** Dexcom's two hosts. Not configurable: an operator picks an environment, not a URL (design §9.2). */
export const DEXCOM_BASE_URL: Record<DexcomEnv, string> = {
  sandbox: "https://sandbox-api.dexcom.com",
  production: "https://api.dexcom.com",
};

/** What an import is filed under in `Upload.filename` (§4.6). One per environment, so a synthetic sandbox
 *  import and a real one are never mistaken for each other in a list of uploads or in the audit trail. */
export const DEXCOM_IMPORT_FILENAME: Record<DexcomEnv, string> = {
  sandbox: "dexcom-sandbox.json",
  production: "dexcom-production.json",
};

/** Credentials come from the environment-specific name when it is set, and from the unprefixed name
 *  otherwise. Both halves matter: a deployment holding both applications' credentials flips environment by
 *  changing DEXCOM_ENV alone, and a deployment that only ever had one application keeps the four variables
 *  it already has. */
export const DEXCOM_CREDENTIAL_PREFIX: Record<DexcomEnv, string> = {
  sandbox: "DEXCOM_SANDBOX_",
  production: "DEXCOM_PRODUCTION_",
};

export type Env = Record<string, string | undefined>;

/** Unset, blank and whitespace are the same thing here, as they are in lib/config.ts. */
const value = (env: Env, name: string): string | undefined => {
  const raw = env[name];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
};

export const isDexcomEnv = (v: unknown): v is DexcomEnv => DEXCOM_ENVS.includes(v as DexcomEnv);

/** The selected environment. Sandbox when unset; a throw when set to something that is neither. */
export function dexcomEnv(raw: string | undefined = process.env.DEXCOM_ENV): DexcomEnv {
  const selected = raw?.trim();
  if (!selected) return "sandbox";
  if (!isDexcomEnv(selected)) throw new Error(`DEXCOM_ENV must be one of ${DEXCOM_ENVS.join(", ")}.`);
  return selected;
}

/** The two credential names for an environment, most specific first, for a caller that wants to name them in
 *  a message (lib/config.ts) rather than read them. */
export const dexcomCredentialNames = (which: DexcomEnv, suffix: "CLIENT_ID" | "CLIENT_SECRET"): string[] =>
  [`${DEXCOM_CREDENTIAL_PREFIX[which]}${suffix}`, `DEXCOM_${suffix}`];

export function dexcomCredentials(which: DexcomEnv, env: Env = process.env): { clientId?: string; secret?: string } {
  const pick = (suffix: "CLIENT_ID" | "CLIENT_SECRET") =>
    dexcomCredentialNames(which, suffix).map((name) => value(env, name)).find(Boolean);
  return { clientId: pick("CLIENT_ID"), secret: pick("CLIENT_SECRET") };
}

/**
 * The base URL for an environment, and a check of DEXCOM_BASE_URL where a deployment still sets it.
 *
 * DEXCOM_BASE_URL predates the switch and is no longer how the host is chosen, but silently ignoring it
 * would be the worst of both worlds: an operator who pins the production host and leaves DEXCOM_ENV alone
 * believes they are in production and is not. Either it agrees with the selected environment or it is a
 * configuration error, which is also how it stays true that a sandbox deployment cannot be pointed at
 * `api.dexcom.com` by one variable.
 */
export function dexcomBaseUrl(which: DexcomEnv, override: string | undefined = process.env.DEXCOM_BASE_URL): string {
  const base = DEXCOM_BASE_URL[which];
  const pinned = override?.trim().replace(/\/+$/, "");
  if (pinned && pinned !== base) {
    throw new Error(`DEXCOM_BASE_URL does not match DEXCOM_ENV=${which}, whose host is ${base}. Unset it, or set DEXCOM_ENV to the environment you meant.`);
  }
  return base;
}

/** Origins a form in this app may be redirected on to, for middleware.ts's `form-action` (§10.8). Takes the
 *  variables rather than reading them, because the caller is edge middleware whose environment reads are
 *  inlined at build time. Empty when Dexcom is not configured — there is no button to redirect — and empty
 *  rather than throwing on a bad value: a response header is not the place to report a configuration
 *  problem, and lib/config.ts has already refused to start over it. */
export function dexcomFormActions(env: Env): string[] {
  try {
    const which = dexcomEnv(env.DEXCOM_ENV);
    if (!dexcomCredentialNames(which, "CLIENT_ID").some((name) => value(env, name))) return [];
    return [new URL(dexcomBaseUrl(which, env.DEXCOM_BASE_URL)).origin];
  } catch {
    return [];
  }
}
