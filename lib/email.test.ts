import assert from "node:assert/strict";
import test from "node:test";
import { emailProvider, sendEmail } from "./email";

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
