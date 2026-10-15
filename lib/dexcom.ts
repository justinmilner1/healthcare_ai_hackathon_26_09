// Dexcom v3 integration, sandbox or production behind one switch (design §9.2). Owner: platform.
//
// The flow is the same code either way: lib/dexcomEnv.ts turns DEXCOM_ENV into a host, a pair of client
// credentials and an upload filename, and everything below reads those rather than an environment variable
// of its own. Sandbox is the default, so a deployment that has not been approved by Dexcom yet behaves
// exactly as it did before the switch existed.
//
// Never log request URLs, codes, or tokens: a Dexcom URL carries an authorization code and the token
// responses are bearer credentials (§10.3, §10.6).
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "crypto";
import { DEXCOM_IMPORT_FILENAME, type DexcomEnv, dexcomBaseUrl, dexcomCredentials, dexcomEnv } from "./dexcomEnv";
import type { GlucoseReading } from "./types";

export const DEXCOM_COOKIE = "sweetspot_dexcom_state";
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** What an import of the current environment is filed under (§4.6). */
export const importFilename = (which: DexcomEnv = dexcomEnv()) => DEXCOM_IMPORT_FILENAME[which];

/** The selected environment, or sandbox when DEXCOM_ENV is unreadable. For the places that describe the
 *  configuration rather than use it (GET /api/dexcom/status), where a bad value should read as "not
 *  configured" rather than fail the request; lib/config.ts refuses it at boot. */
export function currentDexcomEnv(): DexcomEnv {
  try {
    return dexcomEnv();
  } catch {
    return "sandbox";
  }
}

/**
 * Whether this visit is the kind that belongs on this Dexcom.
 *
 * `Visit.isSandbox` marks a synthetic demonstration visit (§13.4) — no consent, no verification, uploads
 * disabled, every summary stamped as synthetic. The sandbox API answers with invented readings, so that is
 * the only place they may land; production answers with a real person's glucose, which has no business on a
 * demo record. One rule covers both directions, and in sandbox it is exactly the check that was here before
 * the switch existed.
 */
export const visitMatchesEnv = (visit: { isSandbox: boolean }, which: DexcomEnv = currentDexcomEnv()) =>
  visit.isSandbox === (which === "sandbox");

export function dexcomConfig() {
  const which = dexcomEnv();
  const { clientId, secret } = dexcomCredentials(which);
  const redirectUri = process.env.DEXCOM_REDIRECT_URI;
  // Throws when DEXCOM_BASE_URL contradicts the switch, which is a configuration error rather than a
  // deployment without Dexcom — the caller turns either into the same 503, and lib/config.ts refuses to
  // start on the contradiction (§3.7).
  const base = dexcomBaseUrl(which);
  if (!clientId || !secret || !redirectUri) {
    throw new Error(`Dexcom ${which} configuration is incomplete.`);
  }
  const callback = new URL(redirectUri);
  if (callback.pathname !== "/api/dexcom/callback" || callback.search || callback.hash ||
      (callback.protocol !== "https:" && !(callback.protocol === "http:" && callback.hostname === "localhost"))) {
    throw new Error("Dexcom callback must use HTTPS or localhost and /api/dexcom/callback.");
  }
  // The localhost exemption above is for developing against synthetic data. Production returns a real
  // person's glucose, so the callback it is handed has to be a real HTTPS origin (§10.1).
  if (which === "production" && callback.protocol !== "https:") {
    throw new Error("Dexcom production requires an https:// callback (design §10.1).");
  }
  return { env: which, clientId, secret, redirectUri, base, origin: callback.origin, secure: callback.protocol === "https:" };
}

export function configured() {
  try { dexcomConfig(); return true; } catch { return false; }
}

export function authorizationUrl(state: string) {
  const c = dexcomConfig();
  const url = new URL(`${c.base}/v3/oauth2/login`);
  url.search = new URLSearchParams({ client_id: c.clientId, redirect_uri: c.redirectUri, response_type: "code", scope: "offline_access", state }).toString();
  return url;
}

export type Tokens = { access_token: string; refresh_token: string; expires_in: number };

export async function exchangeCode(code: string): Promise<Tokens> {
  const c = dexcomConfig();
  const res = await fetch(`${c.base}/v3/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.secret, code, grant_type: "authorization_code", redirect_uri: c.redirectUri }),
    cache: "no-store", signal: AbortSignal.timeout(20000), redirect: "error",
  });
  if (!res.ok) throw new Error("Dexcom authorization exchange failed.");
  const tokens = await res.json() as Partial<Tokens>;
  if (typeof tokens.access_token !== "string" || !tokens.access_token || typeof tokens.refresh_token !== "string" || !tokens.refresh_token ||
      typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
    throw new Error("Invalid Dexcom token response.");
  }
  return tokens as Tokens;
}

// ---- Tokens at rest (design §4.10, §10.1) ----------------------------------------------------------------
//
// `DexcomConnection.encryptedTokens` holds a refresh token, which is a standing key to a patient's glucose
// history — longer lived than any session in this app and not revocable from here. §4.10 and §10.1 both ask
// for it to be encrypted with a KMS-backed key, and a deployment is refused at boot without one
// (lib/config.ts, the same way lib/auth.ts leaves its production refusal to the §3.7 gate).
//
// Two key sources, picked by whether DEXCOM_TOKEN_KMS_KEY_ID is set, the way lib/storage.ts picks a backend:
//
//   kms    KMS encrypts the JSON itself. The tokens are a few hundred bytes, far inside KMS's 4 KB limit,
//          so there is no data key to wrap and nothing on this host that can decrypt anything on its own:
//          an instance role that is allowed to Encrypt but not Decrypt cannot read back what it stored, and
//          every use of the key is a CloudTrail record.
//   local  development and the demo: a key derived from the client secret, which never leaves the server.
//
// Either way the patient id is authenticated as additional data — the KMS encryption context, GCM's AAD
// locally. A ciphertext lifted from one patient's row into another's therefore fails to decrypt instead of
// handing back a working token for the wrong person.
//
// The stored string names its own key source, so a deployment that moves from the local key to KMS can tell
// what it is holding. Rows written before this format (three dot-separated parts, local key, no patient
// binding) are not readable and were never read: nothing in the app has ever decrypted a token, and the
// recovery is the one it always was for a rotated key — the patient reconnects.

export type TokenKeySource = "kms" | "local";

/** `kms` wherever a key is configured, `local` otherwise. */
export function tokenKeySource(): TokenKeySource {
  return process.env.DEXCOM_TOKEN_KMS_KEY_ID ? "kms" : "local";
}

/** A key id, alias or ARN. The SDK needs a region; an ARN carries its own, which saves a variable.
 *  Exported so a test can check that a key in another region is not asked for in this one. */
export function kmsKey(): { keyId: string; region: string } {
  const keyId = process.env.DEXCOM_TOKEN_KMS_KEY_ID;
  if (!keyId) throw new Error("DEXCOM_TOKEN_KMS_KEY_ID must be set to use the KMS key source.");
  const arn = /^arn:aws[a-z-]*:kms:([a-z0-9-]+):/.exec(keyId);
  const region = arn?.[1] ?? process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1";
  return { keyId, region };
}

async function kmsClient(region: string) {
  const { KMSClient } = await import("@aws-sdk/client-kms");
  return new KMSClient({ region });
}

/** The local key. Derived from the client secret, so there is nothing extra to configure for a demo, and
 *  rotating the Dexcom application means every patient reconnects — which is true of the secret anyway. */
const localKey = () => scryptSync(dexcomConfig().secret, "sweetspot-dexcom-tokens-v2", 32);

export async function encryptTokens(tokens: Tokens, patientId: string): Promise<string> {
  const plaintext = JSON.stringify(tokens);
  if (tokenKeySource() === "kms") {
    const { keyId, region } = kmsKey();
    const { EncryptCommand } = await import("@aws-sdk/client-kms");
    const client = await kmsClient(region);
    const out = await client.send(new EncryptCommand({
      KeyId: keyId,
      Plaintext: new TextEncoder().encode(plaintext),
      EncryptionContext: { patientId },
    }));
    if (!out.CiphertextBlob) throw new Error("KMS returned no ciphertext for the Dexcom tokens.");
    return `kms.${Buffer.from(out.CiphertextBlob).toString("base64url")}`;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", localKey(), iv);
  cipher.setAAD(Buffer.from(patientId, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["local", iv, cipher.getAuthTag(), encrypted].map((x) => (typeof x === "string" ? x : x.toString("base64url"))).join(".");
}

/** The other half, for the refresh path and for proving in a test that the ciphertext is really the tokens.
 *  A ciphertext written for another patient, under another key, or in the pre-switch format throws. */
export async function decryptTokens(stored: string, patientId: string): Promise<Tokens> {
  const parts = stored.split(".");
  let plaintext: string;
  if (parts[0] === "kms" && parts.length === 2) {
    const { region } = kmsKey();
    const { DecryptCommand } = await import("@aws-sdk/client-kms");
    const client = await kmsClient(region);
    // KeyId is passed as well: for a symmetric key KMS would otherwise take the key from the ciphertext,
    // and decrypting under whatever key the blob names is not the same as decrypting under ours.
    const out = await client.send(new DecryptCommand({
      CiphertextBlob: Buffer.from(parts[1], "base64url"),
      KeyId: kmsKey().keyId,
      EncryptionContext: { patientId },
    }));
    plaintext = new TextDecoder().decode(out.Plaintext ?? new Uint8Array());
  } else if (parts[0] === "local" && parts.length === 4) {
    const [, iv, tag, body] = parts.map((x) => Buffer.from(x, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", localKey(), iv);
    decipher.setAAD(Buffer.from(patientId, "utf8"));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } else {
    throw new Error("Stored Dexcom tokens are not in a format this build can read; the patient must reconnect.");
  }
  const tokens = JSON.parse(plaintext) as Partial<Tokens>;
  if (typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string" || typeof tokens.expires_in !== "number") {
    throw new Error("Stored Dexcom tokens are malformed.");
  }
  return tokens as Tokens;
}

export function systemTime(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return NaN;
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`);
}

export function importWindow(range: unknown) {
  const r = range as { egvs?: { start?: { systemTime?: unknown }; end?: { systemTime?: unknown } } } | null;
  const first = systemTime(r?.egvs?.start?.systemTime);
  const last = systemTime(r?.egvs?.end?.systemTime);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) throw new Error("no_data");
  // Dexcom endDate is exclusive; include the last available sample.
  const end = last + 1000;
  return { start: Math.max(first, end - 7 * 86400000), end };
}

export function parseEgvs(payload: unknown): GlucoseReading[] {
  const records = (payload as { records?: unknown } | null)?.records;
  if (!Array.isArray(records)) throw new Error("Invalid Dexcom EGV response.");
  const readings = new Map<string, GlucoseReading>();
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    const ms = systemTime(r.systemTime);
    // Dexcom v3 documents that numeric EGV values are always mg/dL, even if a device unit differs.
    const mgdl = typeof r.value === "number" ? r.value : r.status === "low" ? 39 : r.status === "high" ? 401 : NaN;
    if (!Number.isFinite(ms) || !Number.isFinite(mgdl) || mgdl < 39 || mgdl > 401) continue;
    const t = new Date(ms).toISOString();
    readings.set(t, { t, mgdl });
  }
  return [...readings.values()].sort((a, b) => a.t.localeCompare(b.t));
}

async function getData(path: string, accessToken: string): Promise<unknown> {
  const res = await fetch(`${dexcomConfig().base}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store",
    signal: AbortSignal.timeout(20000), redirect: "error",
  });
  if (!res.ok) throw new Error("Dexcom data request failed.");
  return res.json();
}

export async function fetchSnapshot(accessToken: string) {
  const window = importWindow(await getData("/v3/users/self/dataRange", accessToken));
  const format = (ms: number) => new Date(ms).toISOString().slice(0, 19);
  const query = new URLSearchParams({ startDate: format(window.start), endDate: format(window.end) });
  const payload = await getData(`/v3/users/self/egvs?${query}`, accessToken);
  const readings = parseEgvs(payload).filter((r) => Date.parse(r.t) >= window.start && Date.parse(r.t) < window.end);
  if (!readings.length) throw new Error("no_data");
  return { readings, raw: JSON.stringify(payload) };
}
