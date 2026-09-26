import assert from "node:assert/strict";
import test from "node:test";
import { authorizationUrl, dexcomConfig, encryptTokens, fetchSnapshot, importWindow, parseEgvs, systemTime } from "./dexcom";

// Tests use dummy credentials only; no external API requests.
process.env.DEXCOM_CLIENT_ID = "test-client";
process.env.DEXCOM_CLIENT_SECRET = "test-secret-not-real";
process.env.DEXCOM_REDIRECT_URI = "http://localhost:3000/api/dexcom/callback";
process.env.DEXCOM_BASE_URL = "https://sandbox-api.dexcom.com";

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
  process.env.DEXCOM_BASE_URL = "https://api.dexcom.com";
  assert.throws(dexcomConfig);
  process.env.DEXCOM_BASE_URL = "https://sandbox-api.dexcom.com";
  process.env.DEXCOM_REDIRECT_URI = "http://example.com/api/dexcom/callback";
  assert.throws(dexcomConfig);
  process.env.DEXCOM_REDIRECT_URI = "http://localhost:3000/api/dexcom/callback";
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

test("stored token ciphertext is randomized and contains no raw tokens", () => {
  const tokens = { access_token: "private-access", refresh_token: "private-refresh", expires_in: 7200 };
  const first = encryptTokens(tokens);
  assert.notEqual(first, encryptTokens(tokens));
  assert.equal(first.includes(tokens.access_token), false);
  assert.equal(first.split(".").length, 3);
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
