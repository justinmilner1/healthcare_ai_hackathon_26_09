import assert from "node:assert/strict";
import test from "node:test";
import { authorizationUrl, currentDexcomEnv, decryptTokens, dexcomConfig, encryptTokens, fetchSnapshot, importFilename, importWindow, kmsKey, parseEgvs, systemTime, tokenKeySource, visitMatchesEnv } from "./dexcom";

// Tests use dummy credentials only; no external API requests.
process.env.DEXCOM_CLIENT_ID = "test-client";
process.env.DEXCOM_CLIENT_SECRET = "test-secret-not-real";
process.env.DEXCOM_REDIRECT_URI = "http://localhost:3000/api/dexcom/callback";
process.env.DEXCOM_BASE_URL = "https://sandbox-api.dexcom.com";

/** Every test leaves the sandbox configuration above as it found it. */
const withEnv = (vars: Record<string, string | undefined>, body: () => void) => {
  const before = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  Object.assign(process.env, vars);
  for (const [name, value] of Object.entries(vars)) if (value === undefined) delete process.env[name];
  try {
    body();
  } finally {
    Object.assign(process.env, before);
    for (const [name, value] of Object.entries(before)) if (value === undefined) delete process.env[name];
  }
};

test("authorization URL uses v3 sandbox, state and offline access", () => {
  const url = authorizationUrl("random-state");
  assert.equal(url.origin, "https://sandbox-api.dexcom.com");
  assert.equal(url.pathname, "/v3/oauth2/login");
  assert.equal(url.searchParams.get("state"), "random-state");
  assert.equal(url.searchParams.get("scope"), "offline_access");
  assert.equal(url.searchParams.get("redirect_uri"), process.env.DEXCOM_REDIRECT_URI);
  assert.equal(url.searchParams.has("client_secret"), false);
});

test("production and insecure callback configuration are rejected", () => {
  // A production host while the switch says sandbox is a contradiction, not a way into production (§9.2).
  process.env.DEXCOM_BASE_URL = "https://api.dexcom.com";
  assert.throws(dexcomConfig);
  process.env.DEXCOM_BASE_URL = "https://sandbox-api.dexcom.com";
  process.env.DEXCOM_REDIRECT_URI = "http://example.com/api/dexcom/callback";
  assert.throws(dexcomConfig);
  process.env.DEXCOM_REDIRECT_URI = "http://localhost:3000/api/dexcom/callback";
});

// ---- the DEXCOM_ENV switch (design §9.2) ----------------------------------------------------------------

test("sandbox is the default, and DEXCOM_ENV moves the host, the credentials and the filename", () => {
  assert.equal(dexcomConfig().env, "sandbox");
  assert.equal(dexcomConfig().base, "https://sandbox-api.dexcom.com");
  assert.equal(dexcomConfig().clientId, "test-client");
  assert.equal(importFilename(), "dexcom-sandbox.json");

  withEnv({
    DEXCOM_ENV: "production",
    DEXCOM_BASE_URL: undefined,
    DEXCOM_REDIRECT_URI: "https://sweetspot.example.com/api/dexcom/callback",
    DEXCOM_PRODUCTION_CLIENT_ID: "production-client",
    DEXCOM_PRODUCTION_CLIENT_SECRET: "production-secret-not-real",
  }, () => {
    const config = dexcomConfig();
    assert.equal(config.env, "production");
    assert.equal(config.base, "https://api.dexcom.com");
    assert.equal(config.clientId, "production-client");
    assert.equal(authorizationUrl("state").origin, "https://api.dexcom.com");
    assert.equal(importFilename(), "dexcom-production.json");
  });

  // Back to the default the moment the variable is gone: nothing else carries the environment.
  assert.equal(dexcomConfig().base, "https://sandbox-api.dexcom.com");
});

test("the production environment falls back to the unprefixed credentials and demands an https callback", () => {
  withEnv({ DEXCOM_ENV: "production", DEXCOM_BASE_URL: undefined, DEXCOM_REDIRECT_URI: "https://sweetspot.example.com/api/dexcom/callback" }, () => {
    // No DEXCOM_PRODUCTION_* pair: a deployment with one application keeps the variables it already had.
    assert.equal(dexcomConfig().clientId, "test-client");
  });
  // localhost is for developing against synthetic data; real readings need a real origin (§10.1).
  withEnv({ DEXCOM_ENV: "production", DEXCOM_BASE_URL: undefined }, () => {
    assert.throws(dexcomConfig, /https/);
  });
  // An unknown environment is refused rather than guessed at, and reads as sandbox where it only describes.
  withEnv({ DEXCOM_ENV: "staging" }, () => {
    assert.throws(dexcomConfig, /DEXCOM_ENV/);
    assert.equal(currentDexcomEnv(), "sandbox");
  });
});

test("a visit may only connect to the Dexcom its data could have come from", () => {
  assert.equal(visitMatchesEnv({ isSandbox: true }, "sandbox"), true);
  assert.equal(visitMatchesEnv({ isSandbox: false }, "sandbox"), false);
  assert.equal(visitMatchesEnv({ isSandbox: false }, "production"), true);
  assert.equal(visitMatchesEnv({ isSandbox: true }, "production"), false);
});

test("receiver times without offsets are UTC; device offsets preserved", () => {
  assert.equal(systemTime("2024-01-01T08:00:00"), Date.parse("2024-01-01T08:00:00Z"));
  assert.equal(systemTime("2024-01-01T08:00:00-08:00"), Date.parse("2024-01-01T16:00:00Z"));
  assert.ok(Number.isNaN(systemTime(null)));
});

test("window follows historical sandbox data, not today's date", () => {
  const window = importWindow({ egvs: { start: { systemTime: "2020-01-01T00:00:00" }, end: { systemTime: "2020-02-01T00:00:00" } } });
  assert.equal(window.end, Date.parse("2020-02-01T00:00:01Z"));
  assert.equal(window.end - window.start, 7 * 86400000);
  assert.throws(() => importWindow({}), /no_data/);
});

test("EGVs are sorted, deduplicated and filtered; v3 numeric values stay mg/dL", () => {
  const readings = parseEgvs({ records: [
    { systemTime: "2020-01-01T01:00:00", value: 120, unit: "mmol/L" },
    { systemTime: "2020-01-01T00:00:00Z", value: null, status: "low" },
    { systemTime: "2020-01-01T01:00:00Z", value: 120 },
    { systemTime: "invalid", value: 100 },
    { systemTime: "2020-01-01T02:00:00Z", value: null },
    { systemTime: "2020-01-01T03:00:00Z", value: null, status: "high" },
  ] });
  assert.deepEqual(readings.map((r) => r.mgdl), [39, 120, 401]);
  assert.equal(readings[0].t, "2020-01-01T00:00:00.000Z");
  assert.throws(() => parseEgvs({}), /Invalid/);
});

test("stored token ciphertext is randomized and contains no raw tokens", async () => {
  const tokens = { access_token: "private-access", refresh_token: "private-refresh", expires_in: 7200 };
  const first = await encryptTokens(tokens, "patient-1");
  assert.equal(tokenKeySource(), "local", "no KMS key is configured here");
  assert.notEqual(first, await encryptTokens(tokens, "patient-1"));
  assert.equal(first.includes(tokens.access_token), false);
  assert.equal(first.includes(tokens.refresh_token), false);
  assert.equal(first.split(".").length, 4);
  assert.equal(first.startsWith("local."), true, "the stored value names its own key source");
});

test("tokens round-trip, and only for the patient they were stored for (design §4.10)", async () => {
  const tokens = { access_token: "private-access", refresh_token: "private-refresh", expires_in: 7200 };
  const stored = await encryptTokens(tokens, "patient-1");
  assert.deepEqual(await decryptTokens(stored, "patient-1"), tokens);
  // The patient id is authenticated data, so a row copied into another patient's record does not open.
  await assert.rejects(() => decryptTokens(stored, "patient-2"));
  // Neither does the pre-switch format, nor anything else that is not one of the two this build writes.
  await assert.rejects(() => decryptTokens("aaaa.bbbb.cccc", "patient-1"), /reconnect/);
  await assert.rejects(() => decryptTokens("kms.not-a-blob.extra", "patient-1"), /reconnect/);
});

test("a configured KMS key is what decides the key source (design §10.1)", () => {
  assert.equal(tokenKeySource(), "local");
  withEnv({ DEXCOM_TOKEN_KMS_KEY_ID: "arn:aws:kms:eu-west-1:000000000000:key/not-a-real-key", AWS_REGION: "us-east-1" }, () => {
    assert.equal(tokenKeySource(), "kms");
    // The key's own region, not the deployment's: KMS refuses a key that is not in the region asked.
    assert.equal(kmsKey().region, "eu-west-1");
  });
  withEnv({ DEXCOM_TOKEN_KMS_KEY_ID: "alias/sweetspot-dexcom-tokens", AWS_REGION: "us-west-2", AWS_DEFAULT_REGION: undefined }, () => {
    assert.equal(kmsKey().region, "us-west-2");
  });
  assert.equal(tokenKeySource(), "local");
  assert.throws(kmsKey, /DEXCOM_TOKEN_KMS_KEY_ID/);
});

test("snapshot requests range then seven-day EGVs and excludes out-of-window data", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    assert.deepEqual(init?.headers, { Authorization: "Bearer mock-token" });
    return Response.json(url.includes("dataRange") ? {
      egvs: { start: { systemTime: "2020-01-01T00:00:00" }, end: { systemTime: "2020-02-01T00:00:00" } },
    } : { records: [
      { systemTime: "2020-02-01T00:00:00", value: 120 },
      { systemTime: "2020-01-01T00:00:00", value: 200 },
    ] });
  };
  try {
    const snapshot = await fetchSnapshot("mock-token");
    assert.equal(snapshot.readings.length, 1);
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[1]).searchParams.get("endDate"), "2020-02-01T00:00:01");
  } finally { globalThis.fetch = original; }
});
