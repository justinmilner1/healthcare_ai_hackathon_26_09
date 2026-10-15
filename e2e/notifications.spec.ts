import { expect, test, type Page } from "@playwright/test";
import { signInAsDemo } from "./auth";
import { E2E_TOPIC_ARN } from "../playwright.config";

// T19 (design §8.1, §8.3): the webhook SES and SNS report through, and what staff then see.
//
// Two halves, and the first one is all refusals on purpose. `POST /api/notifications/sns` has no session and
// no shared secret — SNS sends neither — so its authority is the RSA signature on the message, and the
// signature cannot be produced here: AWS holds the key. What *can* be shown end to end, in the real build
// with the real middleware in front of it, is that nothing gets past that check: an unsigned notification, a
// message from a topic nobody configured, and a body that is not an SNS envelope at all. The signature
// verification itself is unit-tested against a real key pair in lib/snsSignature.test.ts.
//
// The second half is §8.3's "shown to staff": the seeded Dana Demo visit carries the delivery rows SES's
// topic would have written — the text arrived, the email came back — and the dashboard has to say so.

const shot = async (page: Page, name: string, fullPage = true) => {
  await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-${name}.png`, fullPage });
};

const LOADED = { timeout: 30_000 };

const envelope = (over: Record<string, unknown> = {}) => ({
  Type: "Notification",
  MessageId: "22b480bf-3f2b-5b0c-a0a1-9d4f1f8d0b3a",
  TopicArn: E2E_TOPIC_ARN,
  Message: JSON.stringify({
    notificationType: "Bounce",
    bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "sam.sample@sweetspot.local" }] },
    mail: { messageId: "forged-message-id" },
  }),
  Timestamp: new Date().toISOString(),
  SignatureVersion: "2",
  Signature: Buffer.from("not a signature").toString("base64"),
  SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-forged.pem",
  ...over,
});

test("the webhook refuses a bounce nobody signed, and says which check failed", async ({ request }) => {
  // No CSRF token on this POST, deliberately: the route is in CSRF_EXEMPT_PATHS because SNS cannot send one
  // (lib/csrf.ts). So the refusal must come from the signature check, not from middleware — if it came from
  // middleware the exemption would be broken and every real bounce would be a 403 too.
  const res = await request.post("/api/notifications/sns", { data: envelope() });
  expect(res.status()).toBe(403);
  expect(res.headers()["x-csrf-blocked"], "the refusal should be the signature check, not middleware").toBeUndefined();
  const body = (await res.json()) as { code?: string };
  // Either the certificate could not be fetched here (no egress to AWS) or the signature did not verify.
  // Both are the check doing its job; what must not happen is a 2xx.
  expect(["bad_signature", "cert_unavailable", "untrusted_cert_url"]).toContain(body.code);
});

test("a notification from a topic nobody configured is refused before anything is verified", async ({ request }) => {
  const res = await request.post("/api/notifications/sns", {
    data: envelope({ TopicArn: "arn:aws:sns:us-east-1:999999999999:somebody-elses-topic" }),
  });
  expect(res.status()).toBe(403);
  expect((await res.json()).code).toBe("topic_not_allowed");
});

test("a body that is not an SNS envelope is a 400, so AWS stops retrying it", async ({ request }) => {
  for (const data of [{ hello: "world" }, { Type: "Something", MessageId: "x" }]) {
    const res = await request.post("/api/notifications/sns", { data });
    expect(res.status(), JSON.stringify(data)).toBe(400);
    expect((await res.json()).code).toBe("not_an_sns_envelope");
  }
});

test("the dashboard shows what each message did, and why a channel is closed", async ({ page }) => {
  await signInAsDemo(page);
  await expect(page.locator("body")).toContainText("Sam Sample", LOADED);

  // §8.3 The seeded visit whose invite text arrived and whose invite email came back permanently.
  const dana = page.locator(".provider-table tbody tr", { hasText: "Dana Demo" });
  await expect(dana).toBeVisible(LOADED);
  await expect(dana.locator(".provider-delivery-sent")).toContainText("Text");
  const bounced = dana.locator(".provider-delivery-bounced");
  await expect(bounced).toContainText("Email");
  // The provider's own words, on the pill rather than in a log: SES's subtype and its message id.
  await expect(bounced).toHaveAttribute("title", /Permanent\/General/);
  // §8.1 And the line that stops a skipped channel reading like a bug in the app.
  await expect(dana.locator(".provider-suppressed")).toContainText("Email bounced");

  // Sam Sample's row is the control: nothing has gone wrong, so no suppression line and no bounce.
  const sam = page.locator(".provider-table tbody tr", { hasText: "Sam Sample" });
  await expect(sam.locator(".provider-suppressed")).toHaveCount(0);

  await shot(page, "provider-dashboard-deliveries");
});
