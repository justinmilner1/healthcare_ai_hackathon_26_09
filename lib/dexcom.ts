// Sandbox-only Dexcom v3 integration. Never log request URLs, codes, or tokens.
import { createCipheriv, createHash, randomBytes, scryptSync } from "crypto";
import type { GlucoseReading } from "./types";

export const DEXCOM_COOKIE = "sweetspot_dexcom_state";
export const SANDBOX_FILENAME = "dexcom-sandbox.json";
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function dexcomConfig() {
  const clientId = process.env.DEXCOM_CLIENT_ID;
  const secret = process.env.DEXCOM_CLIENT_SECRET;
  const redirectUri = process.env.DEXCOM_REDIRECT_URI;
  const base = process.env.DEXCOM_BASE_URL?.replace(/\/$/, "");
  if (!clientId || !secret || !redirectUri || base !== "https://sandbox-api.dexcom.com") {
    throw new Error("Dexcom sandbox configuration is incomplete.");
  }
  const callback = new URL(redirectUri);
  if (callback.pathname !== "/api/dexcom/callback" || callback.search || callback.hash ||
      (callback.protocol !== "https:" && !(callback.protocol === "http:" && callback.hostname === "localhost"))) {
    throw new Error("Dexcom callback must use HTTPS or localhost and /api/dexcom/callback.");
  }
  return { clientId, secret, redirectUri, base, origin: callback.origin, secure: callback.protocol === "https:" };
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

type Tokens = { access_token: string; refresh_token: string; expires_in: number };

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

// Demo: derive an encryption key from the server-only client secret. Rotating it requires reconnection.
export function encryptTokens(tokens: Tokens): string {
  const key = scryptSync(dexcomConfig().secret, "sweetspot-dexcom-sandbox-v1", 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((x) => x.toString("base64url")).join(".");
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
