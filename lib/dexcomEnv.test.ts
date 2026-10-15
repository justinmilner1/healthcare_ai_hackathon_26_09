import assert from "node:assert/strict";
import test from "node:test";
import {
  DEXCOM_BASE_URL,
  DEXCOM_IMPORT_FILENAME,
  dexcomBaseUrl,
  dexcomCredentialNames,
  dexcomCredentials,
  dexcomEnv,
  dexcomFormActions,
  isDexcomEnv,
} from "./dexcomEnv";

test("sandbox is the default, and only the two environments are accepted", () => {
  assert.equal(dexcomEnv(undefined), "sandbox");
  assert.equal(dexcomEnv(""), "sandbox");
  assert.equal(dexcomEnv("  "), "sandbox");
  assert.equal(dexcomEnv("sandbox"), "sandbox");
  assert.equal(dexcomEnv("production"), "production");
  // Not a typo this module is willing to interpret: "prod" would otherwise read as sandbox and a deployment
  // that meant production would quietly import synthetic readings (design §9.2).
  assert.throws(() => dexcomEnv("prod"), /DEXCOM_ENV/);
  assert.throws(() => dexcomEnv("PRODUCTION"), /DEXCOM_ENV/);
  assert.equal(isDexcomEnv("production"), true);
  assert.equal(isDexcomEnv("staging"), false);
});

test("each environment has its own host and its own import filename", () => {
  assert.equal(DEXCOM_BASE_URL.sandbox, "https://sandbox-api.dexcom.com");
  assert.equal(DEXCOM_BASE_URL.production, "https://api.dexcom.com");
  assert.notEqual(DEXCOM_IMPORT_FILENAME.sandbox, DEXCOM_IMPORT_FILENAME.production);
  assert.equal(dexcomBaseUrl("production", undefined), "https://api.dexcom.com");
  // A trailing slash is the same URL, and the only thing DEXCOM_BASE_URL may still say.
  assert.equal(dexcomBaseUrl("sandbox", "https://sandbox-api.dexcom.com/"), "https://sandbox-api.dexcom.com");
  assert.throws(() => dexcomBaseUrl("sandbox", "https://api.dexcom.com"), /DEXCOM_ENV=sandbox/);
  assert.throws(() => dexcomBaseUrl("production", "https://sandbox-api.dexcom.com"), /DEXCOM_ENV=production/);
});

test("credentials come from the environment's own names, falling back to the unprefixed pair", () => {
  const both = {
    DEXCOM_CLIENT_ID: "shared-id",
    DEXCOM_CLIENT_SECRET: "shared-secret",
    DEXCOM_SANDBOX_CLIENT_ID: "sandbox-id",
    DEXCOM_PRODUCTION_CLIENT_ID: "production-id",
    DEXCOM_PRODUCTION_CLIENT_SECRET: "production-secret",
  };
  assert.deepEqual(dexcomCredentials("sandbox", both), { clientId: "sandbox-id", secret: "shared-secret" });
  assert.deepEqual(dexcomCredentials("production", both), { clientId: "production-id", secret: "production-secret" });
  // One application, the four variables the app has always had: nothing to change on a sandbox deployment.
  assert.deepEqual(dexcomCredentials("sandbox", { DEXCOM_CLIENT_ID: "only-id", DEXCOM_CLIENT_SECRET: "only-secret" }),
    { clientId: "only-id", secret: "only-secret" });
  // Blank is unset, as everywhere else in the configuration, so an emptied override is not a credential.
  assert.deepEqual(dexcomCredentials("production", { DEXCOM_PRODUCTION_CLIENT_ID: "  ", DEXCOM_CLIENT_ID: "shared-id" }),
    { clientId: "shared-id", secret: undefined });
  assert.deepEqual(dexcomCredentials("production", {}), { clientId: undefined, secret: undefined });
  assert.deepEqual(dexcomCredentialNames("production", "CLIENT_SECRET"), ["DEXCOM_PRODUCTION_CLIENT_SECRET", "DEXCOM_CLIENT_SECRET"]);
});

test("form-action lists the selected environment's origin, and nothing when Dexcom is not configured", () => {
  // §10.8 middleware.ts: the authorization page is the one place a form in this app may be redirected to.
  assert.deepEqual(dexcomFormActions({ DEXCOM_CLIENT_ID: "id" }), ["https://sandbox-api.dexcom.com"]);
  assert.deepEqual(dexcomFormActions({ DEXCOM_ENV: "production", DEXCOM_PRODUCTION_CLIENT_ID: "id" }), ["https://api.dexcom.com"]);
  assert.deepEqual(dexcomFormActions({}), [], "no credentials, no button, nothing to allow");
  // Credentials for the other environment are not credentials for this one.
  assert.deepEqual(dexcomFormActions({ DEXCOM_ENV: "production", DEXCOM_SANDBOX_CLIENT_ID: "id" }), []);
  // A bad value is a configuration problem for lib/config.ts to refuse, not a header to widen.
  assert.deepEqual(dexcomFormActions({ DEXCOM_ENV: "staging", DEXCOM_CLIENT_ID: "id" }), []);
  assert.deepEqual(dexcomFormActions({ DEXCOM_CLIENT_ID: "id", DEXCOM_BASE_URL: "https://api.dexcom.com" }), []);
});
