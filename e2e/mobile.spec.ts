import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { csrfToken, postJson } from "./api";
import { signInAsDemo, signOutOfBrowser } from "./auth";
import { LOADED } from "./budget";
import { acceptConsent, enterCode, patientEmail } from "./patient";
import { expectMobileReady, expectNoHorizontalScroll, expectNothingScrollsSideways, expectTapTargets, expectTranscriptUncut } from "./mobile";
import { shot, WHOLE_PAGE } from "./shot";

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

/**
 * Mobile screenshots of every patient screen (design §12.3): e2e/screenshots/mobile-375-<name>.png.
 *
 * The `375-` is not decoration: e2e/verify.spec.ts, e2e/consent.spec.ts and e2e/flows.spec.ts already write
 * `mobile-verify-code.png`, `mobile-consent.png` and `mobile-patient-summary.png` from their own runs, and
 * two specs writing one path means whichever finished last is the one committed.
 */
// WHOLE_PAGE on purpose, against e2e/shot.ts's default: §6.5 is about the whole of a patient screen at
// 375px, which is this file's whole subject, and these pages are bounded by their own content rather than by
// the practice's visit list, so the shots have a fixed height (T57). Nine of the ten are a screenful or two;
// `375-patient-summary-full` is a patient's whole week and comes out around 6,000 pixels, which is the one
// shot in the suite deliberately over the height T57 holds the rest to — scrolling a legible page is the
// point of it. The 480ms card fade is e2e/shot.ts's job, for every shot in the suite (T77).
const SCREEN = WHOLE_PAGE;

/** A booked visit with an address for the code to go to. Booking is staff's job (§5.2), so someone signs in,
 *  books, and signs out, leaving the browser as a patient's. */
async function book(page: Page, name: string, reason = "mornings running high") {
  const email = patientEmail(name);
  await signInAsDemo(page);
  const booked = await (
    await postJson(page.request, "/api/book", {
      name,
      email,
      visitType: "follow_up",
      reason,
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
  await shot(page, "375-verify-code", SCREEN);

  await enterCode(page, email);
  await expect(page.getByRole("button", { name: /I agree/i })).toBeVisible(LOADED);
  await expectMobileReady(page, "the consent screen");
  await shot(page, "375-consent", SCREEN);
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
  // T83: the screen a patient sees first, with one message in it. The transcript was 103px of this phone
  // and the greeting about 300, so what they met was Sweetie's own introduction cut through the middle of a
  // line of it — in this shot, in mobile-sweetie-done.png and in mobile-journey-09-sweetie-complete.png,
  // and invisible to the gate because everything measured here measures width.
  await expectTranscriptUncut(page, "Sweetie's first question");

  // T105: and the whole of her opening message is in the region, not merely its top. `expectTranscriptUncut`
  // above asks that the newest message starts where the patient starts reading; this asks that it also ends
  // where they stop, which is what T83 could not reach without shortening the message (lib/sweetie.ts). The
  // transcript is the only scrolling box on this screen, so "nothing is hidden" is "nothing to scroll".
  const hidden = await page.locator(".sweetie-messages").evaluate((element) => element.scrollHeight - element.clientHeight);
  expect(hidden, `Sweetie's opening message runs ${hidden}px past the transcript at 375px (T105, design §6.5)`).toBeLessThanOrEqual(1);
  await expect(page.locator(".sweetie-more")).toHaveCount(0);

  // The three upload chips share one row of the sidebar, so 375px is where their names run out of chip.
  // Nothing above catches it: the chips clip rather than widen the page, which is why this asks each name
  // whether it fits the box it is drawn in.
  const names = page.locator(".sweetie-upload-card strong");
  await expect(names).toHaveCount(3);
  for (const name of await names.all()) {
    const fits = await name.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
    expect(fits, `the upload chip "${await name.textContent()}" is cut off at 375px (design §6.5)`).toBe(true);
  }

  await shot(page, "375-sweetie-first-question", SCREEN);

  // Mid-conversation is the harder case: the stepper has a current step and a done step, the transcript has
  // the patient's own words in it, and the composer has gained a note under it.
  const reply = page.getByLabel("Reply to Sweetie");
  await reply.fill("Exhausted for six weeks, worse in the afternoons, and my mornings run high.");
  await reply.press("Enter");
  await expect(page.locator(".sweetie-messages")).toContainText(/Exhausted for six weeks/, LOADED);
  await expect(page.locator(".sweetie-field-done, .sweetie-field-current")).not.toHaveCount(0, LOADED);
  await expectMobileReady(page, "Sweetie mid-conversation", ".sweetie-field-progress");
  // And once the patient's own words and Sweetie's next question are both in it (T83).
  await expectTranscriptUncut(page, "Sweetie mid-conversation");
  await shot(page, "375-sweetie-answered", SCREEN);

  // The widest the bar ever gets: a red flag adds a fourth pill whose label is a phrase, on top of the
  // three steps fieldsFor() always produces (lib/sweetie.ts). The stepper wraps rather than scrolls now,
  // so "fits" is about staying a bar: two rows of pills at most, not a stack down the screen.
  await reply.fill("I had chest pain yesterday evening and it scared me.");
  await reply.press("Enter");
  await expect(page.locator(".sweetie-field-flagged")).toBeVisible(LOADED);
  await expectMobileReady(page, "Sweetie with a flagged answer", ".sweetie-field-progress");
  const bar = await page.locator(".sweetie-field-progress").evaluate((element) => element.getBoundingClientRect().height);
  expect(bar, "the stepper has become a stack rather than a bar (design §6.5)").toBeLessThanOrEqual(80);

  // T66, design §2.5: the scan stops the interview, so the intake is wrapped — but the patient has just
  // been told to call someone, and the screen underneath that message used to congratulate them on a
  // complete check-in beside a 67% bar. The two wrap reasons are one boolean away from collapsing back
  // into each other, so each half of what §2.5 asks for is asserted here.
  const flaggedCard = page.locator(".sweetie-flagged-card");
  await expect(flaggedCard).toBeVisible(LOADED);
  await expect(page.locator(".sweetie-done-card")).toHaveCount(0);
  await expect(page.locator(".sweetie-messages")).not.toContainText(/check-in is complete/i);
  // The instruction is the headline, with the same name and the same two actions as Sweetie's own message
  // (redFlagReply, lib/sweetie.ts).
  const headline = flaggedCard.locator("strong");
  await expect(headline).toContainText(/call .+'s office today/i);
  await expect(headline).toContainText(/911/);
  // §2.5 still "ends with the patient's summary link" (§2.7) — second on the card, not the headline.
  await expect(flaggedCard.getByRole("link", { name: /shared so far/i })).toHaveAttribute("href", `/patient/${token}`);
  // And the rail no longer reads a percentage next to a finished check-in.
  const progressCard = page.locator(".sweetie-progress-card");
  await expect(progressCard).toContainText(/Check-in stopped/i);
  await expect(progressCard).not.toContainText(/%/);
  await expect(page.locator(".sweetie-progress-track")).toHaveCount(0);
  const lastStep = page.locator('.sweetie-field-progress > li[title*="stopped early"]');
  await expect(lastStep).toHaveCount(1);
  await expect(lastStep).not.toHaveClass(/sweetie-field-done/);
  await expect(page.locator(".sweetie-field-progress")).not.toContainText(/Done/);

  // The transcript is its own scrolling region and glides to the newest message (§6.4), so the card being in
  // the document is not the same moment as all of it being on screen — and this card is taller than the one
  // it replaced, so the shot caught it cut off at the composer. Jump the region to its end (instantly: the
  // stylesheet's `scroll-behavior: smooth` is not a CSS animation and survives `animations: "disabled"`) and
  // wait for the whole card, so the committed PNG is evidence about the card and not about the scroll.
  const transcript = page.locator(".sweetie-messages");
  // Measure, then jump: the first pass reads whatever the glide has reached and asks for the end, and a
  // later pass reads 0 once the glide is over and no longer pulls the region back off it.
  await expect
    .poll(
      () =>
        transcript.evaluate((element) => {
          const gap = element.scrollHeight - element.scrollTop - element.clientHeight;
          element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
          return gap;
        }),
      { message: "the transcript never settled on the newest message" },
    )
    .toBeLessThanOrEqual(2);
  const fit = await transcript.evaluate((element) => {
    const region = element.getBoundingClientRect();
    const card = element.querySelector(".sweetie-flagged-card")!.getBoundingClientRect();
    return {
      atEnd: element.scrollHeight - element.scrollTop - element.clientHeight <= 2,
      cut: Math.round(Math.max(0, region.top - card.top) + Math.max(0, card.bottom - region.bottom)),
      card: Math.round(card.height),
      region: Math.round(region.height),
    };
  });
  expect(fit.atEnd, "the transcript did not scroll to its end").toBe(true);
  expect(
    fit.cut,
    `the flagged card (${fit.card}px) does not fit the transcript (${fit.region}px) at 375px, so the patient has to scroll for the instruction`,
  ).toBe(0);
  // T97, design §2.5: the flag stops the interview, so the composer stops with it. The screenshot was the
  // only evidence about this corner of the screen before, and it showed a live input, a live mic and a live
  // Send under "please call the office today" — the one screen in the flow where being asked another
  // question reads as the instruction being withdrawn.
  await expect(page.locator(".sweetie-composer input")).toHaveCount(0);
  await expect(page.getByLabel("Reply to Sweetie")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Send message/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Talk to Sweetie|Stop voice/i })).toHaveCount(0);
  // Replaced rather than hidden, and announced: a patient who meets a composer that has simply gone needs
  // the reason on screen, and a screen reader needs to be told (§6.4).
  const stopped = page.locator(".sweetie-composer-stopped");
  await expect(stopped).toBeVisible();
  await expect(stopped).toHaveAttribute("role", "status");
  await expect(stopped).toContainText(/check-in has stopped/i);
  await expect(stopped).toContainText(/call .+'s office today/i);
  // Nothing operable is left behind in the tab order where the three controls were.
  await expect(stopped.locator("input, button, a, [tabindex]")).toHaveCount(0);

  // The third state of this screen: the skip link is gone, the stepper has a fourth pill, and the card the
  // patient has to act on is the newest thing in the transcript. Measured here too for the T83 floor.
  await expectTranscriptUncut(page, "Sweetie with a flagged answer");

  await shot(page, "375-sweetie-flagged", SCREEN);
});

test("a message taller than the transcript says there is more to read", async ({ page }) => {
  // T105, design §6.5. Sweetie's opener fits the region now, but nothing bounds what the patient types or
  // how long a reason the office recorded — `MAX_REASON` is 280 characters (lib/visitIntake.ts), and the
  // first question quotes it — so a bubble taller than the 251px the phone leaves the region is still
  // reachable. The region lands on the top of the newest message (T83), which is right: the patient reads
  // from the first word. What was missing is anything saying that the rest of it is under the composer.
  const reason =
    "my numbers keep going high overnight and I don't know why, usually from about two in the morning, " +
    "and it happens whether or not I have eaten late, which is the part I would really like to understand " +
    "before we talk about changing anything";
  const { token, email } = await book(page, "E2E Mobile Scroll Cue", reason);

  await page.goto(`/s/${token}`);
  await enterCode(page, email);
  await acceptConsent(page);
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);
  await expect(page.locator(".sweetie-field-progress")).toBeVisible(LOADED);

  // Still the T83 contract: the first line of it is on screen, not a line sliced through the glyphs.
  await expectTranscriptUncut(page, "a message taller than the transcript");
  // And now the screen says so, at the end the hidden words are past.
  await expect(page.locator(".sweetie-more-below")).toBeVisible(LOADED);
  await expect(page.locator(".sweetie-more-above")).toHaveCount(0);
  // The cue is a cue, not a control: it must not be in the tab order and must not swallow a tap meant for
  // the message under it (§6.4).
  await expect(page.locator(".sweetie-more input, .sweetie-more button, .sweetie-more a, .sweetie-more [tabindex]")).toHaveCount(0);
  expect(
    await page.locator(".sweetie-more-below").evaluate((element) => getComputedStyle(element).pointerEvents),
    "the scroll cue takes taps meant for the message underneath it",
  ).toBe("none");
  await expectMobileReady(page, "a transcript with more to read", ".sweetie-field-progress");
  await shot(page, "375-sweetie-more-to-read", SCREEN);

  // Scrolled to the end, the hidden words are the ones above instead, and the cue moves with them.
  await page.locator(".sweetie-messages").evaluate((element) => element.scrollTo({ top: element.scrollHeight, behavior: "auto" }));
  await expect(page.locator(".sweetie-more-above")).toBeVisible(LOADED);
  await expect(page.locator(".sweetie-more-below")).toHaveCount(0);
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
  await shot(page, "375-connect-welcome", SCREEN);

  // Step 1: the three data sources, which is the widest thing on the patient side of the app.
  await started.click();
  await expect(page.getByLabel(/Upload Dexcom file/i)).toBeAttached(LOADED);
  await expectMobileReady(page, "the connect screen, data sources", "nav[aria-label='Onboarding progress']");
  await shot(page, "375-connect-sources", SCREEN);

  // Step 2: the hand-off back to Sweetie.
  await page.getByRole("button", { name: /^Continue$/ }).click();
  await expect(page.getByRole("heading", { name: /You.re all set/i })).toBeVisible(LOADED);
  await expectMobileReady(page, "the connect screen, finished", "nav[aria-label='Onboarding progress']");
  await shot(page, "375-connect-done", SCREEN);
});

/**
 * T73 (design §6.5, §2.5, §6.4): the caveat is in the footer, and the footer is where a narrow viewport
 * used to lose it. All three footers were a two-span flex row with `span:last-child { display: none }`
 * below 680px, and on all three the second span is the caveat — so the phone, which §2.3 makes the device
 * a patient's link is opened on, was the one width that never said "Not medical advice".
 *
 * Asserted rather than left to the screenshots: the bug survived T23's mobile pass and T37's rewording of
 * that very span because nothing measured it, and only a PNG showed it. `toBeVisible` is the right
 * assertion for exactly that reason — the text was in the document the whole time.
 */
test("the three footers keep their caveat at 375px", async ({ page }) => {
  // Each shot is a screenful with the footer scrolled into it, rather than a whole page: the footer is the
  // subject, and the three pages it sits on are the landing page, the dashboard (as tall as the practice's
  // visit list) and the intake card. The whole-page shots of those screens are taken elsewhere.
  const footerShot = (name: string, selector: string) => shot(page, name, { scrollTo: selector });

  // The landing page, which is public and is where a curious patient arrives first.
  await page.goto("/");
  const homeFooter = page.locator(".home-footer");
  await expect(homeFooter).toContainText("Sweet Spot · Diabetes visit preparation", LOADED);
  await expect(homeFooter.getByText("Not medical advice")).toBeVisible();
  await expectNoHorizontalScroll(page, "the landing page footer");
  await footerShot("375-footer-landing", ".home-footer");

  // The provider dashboard, whose caveat is the instruction a clinician is being held to (§2.6).
  await signInAsDemo(page);
  await page.goto("/provider");
  const providerFooter = page.locator(".provider-footer");
  await expect(providerFooter).toContainText("Sweet Spot · Provider workspace", LOADED);
  await expect(providerFooter.getByText("Verify all AI-generated summaries")).toBeVisible();
  await expectNoHorizontalScroll(page, "the provider dashboard footer");
  await footerShot("375-footer-provider", ".provider-footer");
  await signOutOfBrowser(page);

  // And the patient's own intake page, the one §6.5 names and the one this mattered most on.
  const { token, email } = await book(page, "E2E Mobile Caveat");
  await page.goto(`/s/${token}`);
  await enterCode(page, email);
  await acceptConsent(page);
  await page.goto(`/s/${token}/intake`);
  await expect(page.getByRole("button", { name: /Let's get started/i })).toBeVisible(LOADED);
  const intakeFooter = page.locator("footer", { hasText: "not replace" });
  await expect(intakeFooter).toContainText("Sweet Spot is designed to support", LOADED);
  await expect(intakeFooter.getByText("Not medical advice")).toBeVisible();
  await expectNoHorizontalScroll(page, "the patient intake page footer");
  await footerShot("375-footer-intake", "footer");
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
  await shot(page, "375-patient-summary-empty", SCREEN);

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
  await shot(page, "375-patient-summary-full", SCREEN);
});
