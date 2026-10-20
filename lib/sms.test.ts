import assert from "node:assert/strict";
import test from "node:test";
import { intakeLink, sendSms, smsConfig, smsProvider } from "./sms";

/** Every variable that can decide what this module does, so one case cannot leak into the next — and so the
 *  ambient AWS credentials of a CI runner or this repo's cloud sandbox are not part of any case's input. */
const KEYS = [
  "SMS_PROVIDER",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM",
  "SNS_ORIGINATION_NUMBER",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
];

function env(vars: Record<string, string | undefined>) {
  for (const key of KEYS) delete process.env[key];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
}

const TWILIO = { TWILIO_ACCOUNT_SID: "AC_test", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM: "+14155550123" };

test("the SMS backend comes from the setting it cannot send without, and an explicit choice wins", () => {
  env({});
  assert.equal(smsProvider(), null);
  env(TWILIO);
  assert.equal(smsProvider(), "twilio");
  env({ SNS_ORIGINATION_NUMBER: "+14155550199" });
  assert.equal(smsProvider(), "sns");
  env({ ...TWILIO, SNS_ORIGINATION_NUMBER: "+14155550199" });
  assert.equal(smsProvider(), "twilio", "Twilio is the local alternative, so it wins where both are set (§8.4)");
  env({ ...TWILIO, SNS_ORIGINATION_NUMBER: "+14155550199", SMS_PROVIDER: "sns" });
  assert.equal(smsProvider(), "sns");
  env({ ...TWILIO, SNS_ORIGINATION_NUMBER: "+14155550199", SMS_PROVIDER: "twilio" });
  assert.equal(smsProvider(), "twilio");
  env({ SMS_PROVIDER: "nonsense", ...TWILIO });
  assert.equal(smsProvider(), "twilio", "an unknown name forces nothing and the detection still runs");
  env({ SMS_PROVIDER: "nonsense" });
  assert.equal(smsProvider(), null);
});

test("an AWS credential on its own is not an SMS backend (T94)", async () => {
  // The cloud sandbox's ambient pair, and nothing else. This used to select SNS, so the gate published every
  // invite to AWS with a key that cannot work (§11.3 says the check runs the product offline).
  env({ AWS_ACCESS_KEY_ID: "AKIATEST", AWS_SECRET_ACCESS_KEY: "secret" });
  assert.equal(smsProvider(), null);
  const result = await sendSms("+14155550100", "body");
  // No `provider`: nothing was chosen, so no client was built and no request left this process. That is also
  // what makes the send `skipped` rather than three failed attempts (lib/jobHandlers.ts assertSendable).
  assert.deepEqual(result, { sent: false, error: "SMS not configured (set SNS_ORIGINATION_NUMBER, a Twilio account, or SMS_PROVIDER)" });
  // Even where the region is spelled out, which is the other thing an AWS environment tends to carry.
  env({ AWS_ACCESS_KEY_ID: "AKIATEST", AWS_SECRET_ACCESS_KEY: "secret", SNS_ORIGINATION_NUMBER: "+14155550199" });
  assert.equal(smsProvider(), "sns", "the origination number is the signal, and it is enough on its own");
});

test("SNS forced without the number it sends through is unconfigured, not an attempt", async () => {
  // §8.1 sends through a registered origination number; AWS credentials do not stand in for one. Reported
  // before a client exists, the way viaSes checks EMAIL_FROM (lib/email.ts).
  env({ SMS_PROVIDER: "sns", AWS_ACCESS_KEY_ID: "AKIATEST" });
  const config = smsConfig();
  assert.ok("reason" in config);
  assert.match(config.reason, /SNS_ORIGINATION_NUMBER/);
  const result = await sendSms("+14155550100", "body");
  assert.equal(result.sent, false);
  assert.equal(result.provider, undefined, "nothing was reached, so there is no backend to name or to retry");
  assert.match(result.error!, /not configured/);
});

test("the settings a chosen backend sends with are resolved once, before any client", () => {
  env({ ...TWILIO });
  assert.deepEqual(smsConfig(), { provider: "twilio", sid: "AC_test", token: "tok", from: "+14155550123" });
  env({ SNS_ORIGINATION_NUMBER: "+14155550199" });
  assert.deepEqual(smsConfig(), { provider: "sns", origination: "+14155550199" });
});

test("with nothing configured, sending fails soft so the caller can show the link instead", async () => {
  env({});
  const result = await sendSms("+15555550100", "body");
  assert.equal(result.sent, false);
  assert.match(result.error!, /not configured/);
});

test("a half-configured Twilio says what is missing rather than calling out", async () => {
  // No `provider` here either: a token that was never set is the same on the third attempt as on the first,
  // so this is a channel that cannot send rather than a send that failed.
  env({ TWILIO_ACCOUNT_SID: "AC_test" });
  const result = await sendSms("+15555550100", "body");
  assert.deepEqual(result, { sent: false, error: "SMS not configured: TWILIO_AUTH_TOKEN and TWILIO_FROM are required" });
  env({ SMS_PROVIDER: "twilio" });
  assert.match((await sendSms("+15555550100", "body")).error!, /TWILIO_ACCOUNT_SID/);
});

test("the intake link is APP_URL plus the token, with one slash", () => {
  process.env.APP_URL = "https://sweetspot.example";
  assert.equal(intakeLink("tok_abc"), "https://sweetspot.example/s/tok_abc");
  process.env.APP_URL = "https://sweetspot.example/";
  assert.equal(intakeLink("tok_abc"), "https://sweetspot.example/s/tok_abc");
  delete process.env.APP_URL;
  assert.equal(intakeLink("tok_abc"), "http://localhost:3000/s/tok_abc");
});
