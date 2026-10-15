import assert from "node:assert/strict";
import test from "node:test";
import { emailProvider, sendEmail, sesSendInput } from "./email";

// The backend is chosen from the environment, so each case sets the whole of it.
function env(vars: Record<string, string | undefined>) {
  for (const key of ["EMAIL_PROVIDER", "RESEND_API_KEY", "AWS_ACCESS_KEY_ID", "EMAIL_FROM"]) delete process.env[key];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
}

test("the email backend is detected, and an explicit choice wins", () => {
  env({});
  assert.equal(emailProvider(), null);
  env({ RESEND_API_KEY: "re_test" });
  assert.equal(emailProvider(), "resend");
  env({ AWS_ACCESS_KEY_ID: "AKIATEST" });
  assert.equal(emailProvider(), "ses");
  // Resend wins the auto-detection when both are present; EMAIL_PROVIDER overrides either way.
  env({ RESEND_API_KEY: "re_test", AWS_ACCESS_KEY_ID: "AKIATEST" });
  assert.equal(emailProvider(), "resend");
  env({ RESEND_API_KEY: "re_test", AWS_ACCESS_KEY_ID: "AKIATEST", EMAIL_PROVIDER: "ses" });
  assert.equal(emailProvider(), "ses");
  env({ EMAIL_PROVIDER: "nonsense" });
  assert.equal(emailProvider(), null, "an unknown name is not a backend");
});

test("with nothing configured, sending fails soft so the caller can show the link instead", async () => {
  env({});
  const result = await sendEmail("someone@example.com", "subject", "body");
  assert.equal(result.sent, false);
  assert.match(result.error!, /not configured/);
  assert.equal(result.provider, undefined);
});

test("SES without a verified sender says so rather than calling AWS", async () => {
  env({ AWS_ACCESS_KEY_ID: "AKIATEST" });
  const result = await sendEmail("someone@example.com", "subject", "body");
  assert.deepEqual(result, { sent: false, provider: "ses", error: "EMAIL_FROM must be a verified SES identity" });
});

test("an SES send names the configuration set, which is what makes a bounce come back (§8.1)", () => {
  // SES publishes bounce, complaint and delivery events to the topic its *configuration set* names. Without
  // ConfigurationSetName on the send, SES_CONFIGURATION_SET is a variable the operator sets and nothing reads:
  // no event is ever published, POST /api/notifications/sns is never called, and lib/suppression.ts never
  // closes a channel. So the send carries it, and this test is what says it still does.
  delete process.env.SES_CONFIGURATION_SET;
  const plain = sesSendInput({ from: "care@practice.test", to: "sam@example.com", subject: "s", text: "t", html: "<p>t</p>" });
  assert.equal("ConfigurationSetName" in plain, false, "SES refuses a configuration set that does not exist");

  process.env.SES_CONFIGURATION_SET = "sweetspot-events";
  const configured = sesSendInput({ from: "care@practice.test", to: "sam@example.com", subject: "s", text: "t", html: "<p>t</p>" });
  assert.equal(configured.ConfigurationSetName, "sweetspot-events");
  assert.deepEqual(configured.Destination, { ToAddresses: ["sam@example.com"] });
  assert.equal(configured.Source, "care@practice.test");
  delete process.env.SES_CONFIGURATION_SET;
});
