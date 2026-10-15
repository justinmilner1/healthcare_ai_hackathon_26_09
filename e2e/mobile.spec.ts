import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { csrfToken, postJson } from "./api";
import { signInAsDemo, signOutOfBrowser } from "./auth";
import { acceptConsent, enterCode, patientEmail } from "./patient";
import { expectMobileReady, expectNoHorizontalScroll, expectNothingScrollsSideways, expectTapTargets } from "./mobile";

// T23, design §6.5: every screen a patient sees, at the 375px width the section names. One spec rather than
// assertions scattered through the others, because §6.5 is a property of the whole set of patient screens —
// a page that fits today and overflows after the next card is added should fail here, not in whichever spec
// happens to open it.
//
// The whole file is the mobile project's. On desktop these measurements say nothing: a 1280px viewport fits
// anything, and the checks would pass while meaning nothing.
test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "design §6.5 is about the phone");
});

const LOADED = { timeout: 30_000 };

/**
 * Mobile screenshots of every patient screen (design §12.3): e2e/screenshots/mobile-375-<name>.png.
 *
 * The `375-` is not decoration: e2e/verify.spec.ts, e2e/consent.spec.ts and e2e/flows.spec.ts already write
 * `mobile-verify-code.png`, `mobile-consent.png` and `mobile-patient-summary.png` from their own runs, and
 * two specs writing one path means whichever finished last is the one committed.
 */
const shot = async (page: Page, name: string) => {
  await page.screenshot({
    path: `e2e/screenshots/${test.info().project.name}-${name}.png`,
    fullPage: true,
    // The cards fade in over 480ms; a shot taken mid-fade shows nothing about the layout underneath.
    animations: "disabled",
  });
};

/** A booked visit with an address for the code to go to. Booking is staff's job (§5.2), so someone signs in,
 *  books, and signs out, leaving the browser as a patient's. */
async function book(page: Page, name: string) {
  const email = patientEmail(name);
  await signInAsDemo(page);
  const booked = await (
    await postJson(page.request, "/api/book", {
      name,
      email,
      visitType: "follow_up",
      reason: "mornings running high",
      channel: "none",
    })
  ).json();
  expect(booked.token, JSON.stringify(booked)).toBeTruthy();
  await signOutOfBrowser(page);
  return { token: booked.token as string, email };
}

test("the viewport these measurements are taken at is the one §6.5 names", async ({ page }) => {
  expect(page.viewportSize()?.width, "design §6.5: the patient pages are tested at 375px").toBe(375);
});

test("the code screen and the consent screen fit a 375px phone", async ({ page }) => {
  const { token, email } = await book(page, "E2E Mobile Gate");

  await page.goto(`/s/${token}`);
  await expect(page.getByLabel("6-digit code")).toBeVisible(LOADED);
  await expectMobileReady(page, "the code screen");
  await shot(page, "375-verify-code");

  await enterCode(page, email);
  await expect(page.getByRole("button", { name: /I agree/i })).toBeVisible(LOADED);
  await expectMobileReady(page, "the consent screen");
  await shot(page, "375-consent");
});

test("Sweetie fits a 375px phone, and her stepper fits without scrolling", async ({ page }) => {
  const { token, email } = await book(page, "E2E Mobile Chat");

  await page.goto(`/s/${token}`);
  await enterCode(page, email);
  await acceptConsent(page);
  // The stepper is drawn from the field list GET /api/sweetie returns, so it is not in the document until
  // the greeting is. Waiting for the greeting is waiting for both.
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);
  await expect(page.locator(".sweetie-field-progress")).toBeVisible(LOADED);
  await expectMobileReady(page, "Sweetie's first question", ".sweetie-field-progress");

  // The three upload chips share one row of the sidebar, so 375px is where their names run out of chip.
  // Nothing above catches it: the chips clip rather than widen the page, which is why this asks each name
  // whether it fits the box it is drawn in.
  const names = page.locator(".sweetie-upload-card strong");
  await expect(names).toHaveCount(3);
  for (const name of await names.all()) {
    const fits = await name.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
    expect(fits, `the upload chip "${await name.textContent()}" is cut off at 375px (design §6.5)`).toBe(true);
  }

  await shot(page, "375-sweetie-first-question");

  // Mid-conversation is the harder case: the stepper has a current step and a done step, the transcript has
  // the patient's own words in it, and the composer has gained a note under it.
  const reply = page.getByLabel("Reply to Sweetie");
  await reply.fill("Exhausted for six weeks, worse in the afternoons, and my mornings run high.");
  await reply.press("Enter");
  await expect(page.locator(".sweetie-messages")).toContainText(/Exhausted for six weeks/, LOADED);
  await expect(page.locator(".sweetie-field-done, .sweetie-field-current")).not.toHaveCount(0, LOADED);
  await expectMobileReady(page, "Sweetie mid-conversation", ".sweetie-field-progress");
  await shot(page, "375-sweetie-answered");
});

test("the connect-your-data screen fits a 375px phone on every step", async ({ page }) => {
  const { token, email } = await book(page, "E2E Mobile Connect");

  await page.goto(`/s/${token}`);
  await enterCode(page, email);
  await acceptConsent(page);
  await page.goto(`/s/${token}/intake`);

  // Step 0: the welcome. Its stepper is the row of numbered dots at the top of the card.
  const started = page.getByRole("button", { name: /Let's get started/i });
  await expect(started).toBeVisible(LOADED);
  await expectMobileReady(page, "the connect screen, welcome step", "nav[aria-label='Onboarding progress']");
  await shot(page, "375-connect-welcome");

  // Step 1: the three data sources, which is the widest thing on the patient side of the app.
  await started.click();
  await expect(page.getByLabel(/Upload Dexcom file/i)).toBeAttached(LOADED);
  await expectMobileReady(page, "the connect screen, data sources", "nav[aria-label='Onboarding progress']");
  await shot(page, "375-connect-sources");

  // Step 2: the hand-off back to Sweetie.
  await page.getByRole("button", { name: /^Continue$/ }).click();
  await expect(page.getByRole("heading", { name: /You.re all set/i })).toBeVisible(LOADED);
  await expectMobileReady(page, "the connect screen, finished", "nav[aria-label='Onboarding progress']");
  await shot(page, "375-connect-done");
});

test("the patient summary fits a 375px phone, empty and full", async ({ page }) => {
  const { token, email } = await book(page, "E2E Mobile Summary");

  await page.goto(`/s/${token}`);
  await enterCode(page, email);
  await acceptConsent(page);
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);

  // Nothing uploaded and nothing answered: the summary's empty state, which is a screen in its own right.
  await page.goto(`/patient/${token}`);
  await expect(page.getByRole("link", { name: /Talk to Sweetie/i })).toBeVisible(LOADED);
  await expectMobileReady(page, "the patient summary, empty");
  await shot(page, "375-patient-summary-empty");

  // And the full one, which is where the charts, the spike table and the stat tiles are — the widest things
  // on the patient side. The three sample exports are uploaded to this same visit rather than borrowing the
  // seeded demo patient, because /patient/<id> answers for the patient whose session the browser holds
  // (§5.3) and that session belongs to the visit booked above.
  for (const [kind, path, name, type] of [
    ["dexcom", "data/dexcom_clarity_sample.csv", "clarity.csv", "text/csv"],
    ["whoop", "data/whoop_sample.csv", "cycles.csv", "text/csv"],
    ["timeline", "data/timeline_sample.json", "timeline.json", "application/json"],
  ] as const) {
    // Multipart, so postJson does not fit; the CSRF header is the one it would have added (§10.8).
    const uploaded = await page.request.post("/api/upload", {
      headers: { "x-csrf-token": await csrfToken(page.request) },
      multipart: { token, kind, file: { name, mimeType: type, buffer: readFileSync(path) } },
    });
    expect(uploaded.ok(), `${kind} upload: ${await uploaded.text()}`).toBeTruthy();
  }

  await page.goto(`/patient/${token}`);
  await expect(page.locator(".patient-overview")).toBeVisible(LOADED);
  await expectNoHorizontalScroll(page, "the patient summary, full");
  await expectNothingScrollsSideways(page, "the patient summary, full");
  await expectTapTargets(page, "the patient summary, full");
  await shot(page, "375-patient-summary-full");
});
