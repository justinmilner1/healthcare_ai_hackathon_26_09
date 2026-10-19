import { expect, test } from "@playwright/test";
import { signInAsDemo } from "./auth";
import { shot } from "./shot";
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

const LOADED = { timeout: 30_000 };

/** T74 What a delivery tooltip must never contain: a variable name, a credential, the deployment's own
 *  to-do list. Narrower than the guard in lib/delivery.test.ts, which has the senders' real strings behind
 *  it: a tooltip here also carries the provider's message id (§8.3), which is opaque and may spell anything,
 *  so the vendors' own names are left to the unit test. */
const CONFIGURATION = /[A-Z][A-Z0-9]*_[A-Z0-9_]+|api[ _-]?key|credential|verified identity|not configured/i;

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
  // The provider's own words, on the pill rather than in a log: SES's subtype and its message id. Both of
  // them, exactly — §8.1 keeps a bounce's own wording where T74 maps a backend's refusal away, and §8.3 asks
  // for the id a support request to AWS quotes.
  await expect(bounced).toHaveAttribute("title", "Permanent/General · demo-ses-message-id");
  // §8.1 And the line that stops a skipped channel reading like a bug in the app.
  await expect(dana.locator(".provider-suppressed")).toContainText("Email bounced");

  // Sam Sample's row is the control: nothing has gone wrong, so no suppression line and no bounce.
  const sam = page.locator(".provider-table tbody tr", { hasText: "Sam Sample" });
  await expect(sam.locator(".provider-suppressed")).toHaveCount(0);

  // T74 The tooltip is the one place a backend's own message reached a practice's screen, and it is in the
  // DOM rather than in any screenshot, which is how "EMAIL_FROM must be a verified SES identity" sat beside
  // a patient's name through twenty reviewed tickets. So every pill on this dashboard is read, not only the
  // seeded ones: what has to hold is an absence, and the rows other specs booked are the ones whose sends
  // really ran into this environment's missing senders (lib/delivery.ts maps them).
  const titles = await page
    .locator(".provider-table tbody .provider-data-pill")
    .evaluateAll((pills) => pills.map((pill) => pill.getAttribute("title") ?? ""));
  expect(titles.length, "there are delivery pills to read").toBeGreaterThan(0);
  for (const title of titles) {
    expect(title, "a delivery tooltip names no variable, credential or backend (T74, §8.3)").not.toMatch(CONFIGURATION);
  }

  // The Messages cell on Dana's row is what this is about, and on a phone it is both a screen down and a
  // column to the right of what the dashboard opens on (T57).
  await shot(page, "provider-dashboard-deliveries", {
    scrollTo: dana.locator(".provider-invite"),
    block: "center",
    inline: "center",
  });
});
