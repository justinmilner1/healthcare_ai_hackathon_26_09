import { expect, test, type Page } from "@playwright/test";
import { postJson } from "./api";
import { signInAsDemo, signOutOfBrowser } from "./auth";
import { LOADED } from "./budget";
import { AGREE, enterCode, patientEmail } from "./patient";
import { shot, WHOLE_PAGE } from "./shot";

// T09, design §2.4: the one screen between the code and Sweetie. Shown on first open only; it says what is
// collected, that it is optional, that a clinician reviews it, and how to have it deleted; one tap continues
// and the acceptance is stored on the visit with its time; declining ends the session politely.
//
// Nothing here is stubbed: these open a real link, read the real code out of the mailbox the suite reads
// (e2e/patient.ts), and the consent they give or refuse is the row the gate reads on the next request.

/** A booked visit with an address to send the code to. Booking is staff's job and needs their session
 *  (§5.2), so someone signs in, books, and signs out, leaving the browser as a patient's. */
async function book(page: Page, name: string) {
  const email = patientEmail(name);
  await signInAsDemo(page);
  const booked = await (
    await postJson(page.request, "/api/book", { name, email, visitType: "follow_up", reason: "reading the small print", channel: "none" })
  ).json();
  expect(booked.token, JSON.stringify(booked)).toBeTruthy();
  await signOutOfBrowser(page);
  return { token: booked.token as string, visitId: booked.visitId as string, email };
}

test("the consent screen is what a verified link opens, and one tap goes through to Sweetie", async ({ page }) => {
  const { token, email } = await book(page, "E2E Consent");

  await page.goto(`/s/${token}`);
  await enterCode(page, email);

  // §2.4's four statements. Asserted by what they say rather than by a class, because what they say is the
  // requirement: lib/consent.test.ts checks the same four as data.
  const card = page.locator(".patient-consent-card");
  await expect(card).toBeVisible(LOADED);
  await expect(card).toContainText(/What Sweetie collects/i);
  await expect(card).toContainText(/Dexcom/);
  await expect(card).toContainText(/All of it is optional/i);
  await expect(card).toContainText(/skip any question/i);
  await expect(card).toContainText(/A clinician reviews it/i);
  await expect(card).toContainText(/You can have it deleted/i);
  // The practice the invite came from, so the patient knows who is being agreed with (§2.3 keeps the name of
  // the practice as the one thing a link does say).
  await expect(card).toContainText(/Sweet Spot Endocrinology/);
  // Sweetie is behind it: the chat is not in the page until consent is given.
  await expect(page.locator(".sweetie-messages")).toHaveCount(0);
  // The card's 480ms entrance is finished before the shutter by e2e/shot.ts, for every shot (T77).
  await shot(page, "consent", WHOLE_PAGE);

  // One tap to continue (§2.4).
  await page.getByRole("button", { name: AGREE }).click();
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);

  // Stored on the visit with the time, which is what makes it "first open only": a reload, and the summary
  // page opened afterwards, are not a second ask.
  const bundle = await (await page.request.get(`/api/patient/${token}`)).json();
  expect(bundle.intakeConsentAt, "the acceptance time is on the visit").toBeTruthy();
  expect(Date.now() - Date.parse(bundle.intakeConsentAt)).toBeLessThan(5 * 60_000);

  await page.reload();
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);
  await expect(page.locator(".patient-consent-card")).toHaveCount(0);

  await page.goto(`/patient/${token}`);
  await expect(page.getByRole("link", { name: /Talk to Sweetie/i })).toBeVisible(LOADED);
  await expect(page.locator(".patient-consent-card")).toHaveCount(0);

  // A second acceptance keeps the first one's time: the stored consent is when the patient agreed.
  const again = await postJson(page.request, "/api/consent", { token, accept: true });
  expect(again.status()).toBe(200);
  const second = await (await page.request.get(`/api/patient/${token}`)).json();
  expect(second.intakeConsentAt).toBe(bundle.intakeConsentAt);
});

test("declining ends the session politely, and the pages behind it close", async ({ page }) => {
  const { token, email } = await book(page, "E2E Declines");

  await page.goto(`/s/${token}`);
  await enterCode(page, email);
  await expect(page.locator(".patient-consent-card")).toBeVisible(LOADED);

  await page.getByRole("button", { name: /No thanks/i }).click();

  // Politely: it thanks them, says nothing was collected, and does not ask again on the way out.
  const card = page.locator(".patient-consent-declined");
  await expect(card).toBeVisible(LOADED);
  await expect(card).toContainText(/completely fine/i);
  await expect(card).toContainText(/Nothing has been collected/i);
  await expect(card).toContainText(/appointment goes ahead/i);
  await expect(page.getByRole("button", { name: AGREE })).toHaveCount(0);
  await shot(page, "consent-declined", WHOLE_PAGE);

  // And ended: the session that was verified a moment ago is gone, so the API refuses this browser and the
  // pages behind the gate are back to asking for a code.
  expect((await page.request.get(`/api/patient/${token}`)).status()).toBe(401);
  await page.goto(`/s/${token}`);
  await expect(page.getByLabel("6-digit code")).toBeVisible(LOADED);
  await expect(page.locator(".sweetie-messages")).toHaveCount(0);
});

test("consent cannot be given by a forwarded link alone (§2.3, §5.3)", async ({ page, request }) => {
  const { token } = await book(page, "E2E Consent Forwarded");

  // `request` has verified nothing: exactly the position someone a link was forwarded to is in. The answer
  // is a patient's own to give, so the route refuses it without the session behind the code.
  const refused = await postJson(request, "/api/consent", { token, accept: true });
  expect(refused.status()).toBe(401);
  expect((await refused.json()).error).toMatch(/verify your link/i);

  // An unknown token says only that the link is not valid, the same as POST /api/verify (§5.5).
  const unknown = await postJson(request, "/api/consent", { token: "not-a-token", accept: true });
  expect(unknown.status()).toBe(404);

  // And nothing was written: the gate still asks.
  await page.goto(`/s/${token}`);
  await expect(page.getByLabel("6-digit code")).toBeVisible(LOADED);

  // The CSRF middleware is in front of this route like every other state-changing one (§10.8): the context
  // has the cookie by now (postJson took one above) and this sends no header, which is the shape of the
  // cross-site post the check exists for.
  const forged = await request.post("/api/consent", { data: { token, accept: true } });
  expect(forged.status()).toBe(403);
});
