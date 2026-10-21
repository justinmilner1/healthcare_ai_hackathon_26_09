import assert from "node:assert/strict";
import test from "node:test";
import { emailConfig, emailProvider, sendEmail, sesSendInput } from "./email";

/** Every variable that can decide what this module does, so one case cannot leak into the next — and so the
 *  ambient AWS credentials of a CI runner or this repo's cloud sandbox are not part of any case's input. */
const KEYS = ["EMAIL_PROVIDER", "EMAIL_FROM", "RESEND_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];

function env(vars: Record<string, string | undefined>) {
  for (const key of KEYS) delete process.env[key];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
}

test("the email backend comes from the setting it cannot send without, and an explicit choice wins", () => {
  env({});
  assert.equal(emailProvider(), null);
  env({ RESEND_API_KEY: "re_test" });
  assert.equal(emailProvider(), "resend");
  env({ EMAIL_FROM: "care@practice.test" });
  assert.equal(emailProvider(), "ses");
  // Resend is the local alternative (§8.4), so it wins the detection where both are set; EMAIL_PROVIDER
  // overrides either way.
  env({ RESEND_API_KEY: "re_test", EMAIL_FROM: "care@practice.test" });
  assert.equal(emailProvider(), "resend");
  env({ RESEND_API_KEY: "re_test", EMAIL_FROM: "care@practice.test", EMAIL_PROVIDER: "ses" });
  assert.equal(emailProvider(), "ses");
  env({ RESEND_API_KEY: "re_test", EMAIL_FROM: "care@practice.test", EMAIL_PROVIDER: "resend" });
  assert.equal(emailProvider(), "resend");
  env({ EMAIL_PROVIDER: "nonsense", RESEND_API_KEY: "re_test" });
  assert.equal(emailProvider(), "resend", "an unknown name forces nothing and the detection still runs");
  env({ EMAIL_PROVIDER: "nonsense" });
  assert.equal(emailProvider(), null, "an unknown name is not a backend");
  env({ EMAIL_FROM: "   " });
  assert.equal(emailProvider(), null, "a blank identity is not one");
});

test("an AWS credential on its own is not an email backend (T110)", async () => {
  // The cloud sandbox's ambient pair, and nothing else. This used to select SES, so every invite in a run of
  // the gate resolved to a backend that could not send and was retried (§11.3: the check runs the product
  // offline).
  env({ AWS_ACCESS_KEY_ID: "AKIATEST", AWS_SECRET_ACCESS_KEY: "secret" });
  assert.equal(emailProvider(), null);
  const result = await sendEmail("someone@example.com", "subject", "body");
  // No `provider`: nothing was chosen, so no client was built and no request left this process. That is also
  // what makes the send `skipped` rather than three failed attempts (lib/jobHandlers.ts assertSendable).
  assert.deepEqual(result, { sent: false, error: "email not configured (set EMAIL_FROM, RESEND_API_KEY, or EMAIL_PROVIDER)" });
  // A deployment on ECS or EC2 has a task role and no key at all, and is detected on the identity alone.
  env({ EMAIL_FROM: "care@practice.test" });
  assert.equal(emailProvider(), "ses", "the verified identity is the signal, and it is enough on its own");
});

test("SES forced without the identity it sends from is unconfigured, not an attempt", async () => {
  // §8.1 sends from a verified identity; AWS credentials do not stand in for one. Reported before a client
  // exists, the way smsConfig checks SNS_ORIGINATION_NUMBER (lib/sms.ts).
  env({ EMAIL_PROVIDER: "ses", AWS_ACCESS_KEY_ID: "AKIATEST" });
  const config = emailConfig();
  assert.ok("reason" in config);
  assert.match(config.reason, /EMAIL_FROM/);
  const result = await sendEmail("someone@example.com", "subject", "body");
  assert.equal(result.sent, false);
  assert.equal(result.provider, undefined, "nothing was reached, so there is no backend to name or to retry");
  assert.match(result.error!, /not configured/);
});

test("Resend forced without its key is unconfigured too", async () => {
  env({ EMAIL_PROVIDER: "resend", EMAIL_FROM: "care@practice.test" });
  const config = emailConfig();
  assert.ok("reason" in config);
  assert.match(config.reason, /RESEND_API_KEY/);
  const result = await sendEmail("someone@example.com", "subject", "body");
  assert.equal(result.provider, undefined);
});

test("the settings a chosen backend sends with are resolved once, before any client", () => {
  env({ EMAIL_FROM: "care@practice.test" });
  assert.deepEqual(emailConfig(), { provider: "ses", from: "care@practice.test" });
  env({ RESEND_API_KEY: "re_test", EMAIL_FROM: "care@practice.test" });
  assert.deepEqual(emailConfig(), { provider: "resend", key: "re_test", from: "care@practice.test" });
  // Resend's free sender needs no identity of its own, which is why EMAIL_FROM selects SES and not Resend.
  env({ RESEND_API_KEY: "re_test" });
  assert.deepEqual(emailConfig(), { provider: "resend", key: "re_test", from: "Sweet Spot <onboarding@resend.dev>" });
});

test("with nothing configured, sending fails soft so the caller can show the link instead", async () => {
  env({});
  const result = await sendEmail("someone@example.com", "subject", "body");
  assert.equal(result.sent, false);
  assert.match(result.error!, /not configured/);
  assert.equal(result.provider, undefined);
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
