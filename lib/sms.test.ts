import assert from "node:assert/strict";
import test from "node:test";
import { intakeLink, sendSms, smsProvider } from "./sms";

function env(vars: Record<string, string | undefined>) {
  for (const key of ["SMS_PROVIDER", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM", "AWS_ACCESS_KEY_ID"]) delete process.env[key];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
}

test("the SMS backend is detected, and an explicit choice wins", () => {
  env({});
  assert.equal(smsProvider(), null);
  env({ TWILIO_ACCOUNT_SID: "AC_test" });
  assert.equal(smsProvider(), "twilio");
  env({ AWS_ACCESS_KEY_ID: "AKIATEST" });
  assert.equal(smsProvider(), "sns");
  env({ TWILIO_ACCOUNT_SID: "AC_test", AWS_ACCESS_KEY_ID: "AKIATEST" });
  assert.equal(smsProvider(), "twilio");
  env({ TWILIO_ACCOUNT_SID: "AC_test", AWS_ACCESS_KEY_ID: "AKIATEST", SMS_PROVIDER: "sns" });
  assert.equal(smsProvider(), "sns");
  env({ SMS_PROVIDER: "nonsense" });
  assert.equal(smsProvider(), null);
});

test("with nothing configured, sending fails soft so the caller can show the link instead", async () => {
  env({});
  const result = await sendSms("+15555550100", "body");
  assert.equal(result.sent, false);
  assert.match(result.error!, /not configured/);
});

test("a half-configured Twilio says what is missing rather than calling out", async () => {
  env({ TWILIO_ACCOUNT_SID: "AC_test" });
  const result = await sendSms("+15555550100", "body");
  assert.deepEqual(result, { sent: false, provider: "twilio", error: "TWILIO_AUTH_TOKEN and TWILIO_FROM are required" });
});

test("the intake link is APP_URL plus the token, with one slash", () => {
  process.env.APP_URL = "https://sweetspot.example";
  assert.equal(intakeLink("tok_abc"), "https://sweetspot.example/s/tok_abc");
  process.env.APP_URL = "https://sweetspot.example/";
  assert.equal(intakeLink("tok_abc"), "https://sweetspot.example/s/tok_abc");
  delete process.env.APP_URL;
  assert.equal(intakeLink("tok_abc"), "http://localhost:3000/s/tok_abc");
});
