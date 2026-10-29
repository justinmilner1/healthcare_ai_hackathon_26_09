import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { csrfToken, postJson } from "./api";
import { signInAsDemo, signOutOfBrowser } from "./auth";
import { LOADED } from "./budget";
import { expectTimeAxisLabelled } from "./charts";
import { acceptConsent, enterCode, expectNoCoordinates, patientEmail } from "./patient";
import { expectMobileReady, expectNoHorizontalScroll, expectNothingScrollsSideways, expectTapTargets, expectTranscriptUncut, OPENING_BUBBLE_ROOM, transcriptCue } from "./mobile";
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
  const opener = await page.locator(".sweetie-message").first().evaluate((element) => Math.round(element.getBoundingClientRect().height));
  expect(
    opener,
    `Sweetie's opening message is ${opener}px, over the ${OPENING_BUBBLE_ROOM}px design §6.5 leaves it on the opening screen (T105)`,
  ).toBeLessThanOrEqual(OPENING_BUBBLE_ROOM);
  // And on this deployment's own chrome, nothing at all is out of sight: no scrolling, and so no cue.
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
  // §2.5 "ends with the patient's summary link" (§2.7) when there is one, second on the card rather than
  // as the headline — and nothing has been uploaded here, so there is not (T141). The card says what did
  // reach the care team instead of sending the patient to the empty summary and back.
  await expect(flaggedCard.getByRole("link", { name: /shared so far/i })).toHaveCount(0);
  await expect(page.locator(`.sweetie-conversation a[href="/patient/${token}"]`)).toHaveCount(0);
  await expect(flaggedCard.locator(".sweetie-flagged-kept")).toContainText(/saved for your care team/i);
  // And the rail no longer reads a percentage next to a finished check-in.
  const progressCard = page.locator(".sweetie-progress-card");
  await expect(progressCard).toContainText(/Check-in stopped/i);
  await expect(progressCard).not.toContainText(/%/);
  await expect(page.locator(".sweetie-progress-track")).toHaveCount(0);
  // With nothing above it, the sentence is the whole card — so the width that drops the sentence leaves a
  // heading over nothing, which is what the shot at the bottom of this test used to show (T147, §6.5).
  await expect(progressCard.locator("small"), "the flagged card is a labelled empty box at 375px").toBeVisible();
  await expect(progressCard.locator("small")).toContainText(/we stopped early/i);
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
      { ...LOADED, message: "the transcript never settled on the newest message" },
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

/**
 * Sweetie's next reply, as long as a model that ignored "one short message" would write it.
 *
 * §6.3 keeps this suite offline, where `scripted()` answers in two lines (lib/sweetie.ts), and nothing else
 * the suite can drive puts a message with hidden *words* in the transcript: the opener is held to
 * OPENING_BUBBLE_ROOM by a test of its own, and the longest thing it quotes is the reason the office
 * recorded, which `MAX_REASON` caps at 280 characters — fifteen lines, which overflow the region by the
 * bubble's own chrome and not by a word (the test under this one measures exactly that state). What is
 * unbounded in a deployment is what the model writes back. So the turn runs for real — the route scans the
 * patient's message, stores it, extracts the field and returns the intake (§6.2) — and only the words of
 * the reply come back longer, which is the one thing about it the product cannot bound.
 */
async function withALongReply(page: Page, reply: string) {
  await page.route("**/api/sweetie", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as { reply?: string };
    await route.fulfill({ response, json: body.reply ? { ...body, reply } : body });
  });
}

const LONG_REPLY =
  "Thank you — that is really helpful, and I have written it down for your doctor in your own words. " +
  "Before we move on there are a few things I would like to be sure I have right, because the more your " +
  "doctor has in front of them when you walk in, the less of the visit you will spend saying it all " +
  "again: when the highs tend to happen, whether they follow a meal or arrive out of nowhere, what you " +
  "had already tried before you booked this appointment, and whether anything you have changed lately " +
  "seemed to make a difference either way. If you would rather not go through all of that now we can " +
  "leave it there — none of it is required, and everything you have told me so far is saved. When you " +
  "are ready, the next question is about how you have been feeling day to day since you last saw them.";

test("a message with words under the composer says there is more to read", async ({ page }) => {
  // T105, design §6.5 and §6.4. The region lands on the top of the newest message (T83), which is right:
  // the patient reads from the first word. What was missing is anything saying that the rest of it is under
  // the composer, with the page otherwise still.
  const { token, email } = await book(page, "E2E Mobile Scroll Cue");
  await withALongReply(page, LONG_REPLY);

  await page.goto(`/s/${token}`);
  await enterCode(page, email);
  await acceptConsent(page);
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);
  await expect(page.locator(".sweetie-field-progress")).toBeVisible(LOADED);

  const reply = page.getByLabel("Reply to Sweetie");
  await reply.fill("Mornings run high, most days from about four, and I sleep badly when they do.");
  await reply.press("Enter");
  await expect(page.locator(".sweetie-messages")).toContainText(/the more your doctor has in front of them/, LOADED);

  // Still the T83 contract: the first line of it is on screen, not a line sliced through the glyphs.
  await expectTranscriptUncut(page, "a message taller than the transcript");
  // The case this test is about, measured rather than assumed: whole lines of type are under the composer.
  const hiding = await transcriptCue(page);
  expect(
    hiding.hiddenLines,
    `the long reply is ${hiding.lines} lines and none of them is under the composer (${hiding.pastFold}px of the row is), so this test is no longer about a message with words out of sight (T105)`,
  ).toBeGreaterThanOrEqual(1);
  // And now the screen says so.
  expect(
    hiding.cue,
    `${hiding.hiddenLines} of ${hiding.lines} lines are under the composer (${hiding.pastFold}px of the row) and nothing on the screen says so (T105, design §6.5)`,
  ).toBe(true);
  await expect(page.locator(".sweetie-more")).toBeVisible(LOADED);
  // The cue is a cue, not a control: it must not be in the tab order, and it must not swallow a tap meant
  // for the composer or the transcript around it (§6.4).
  await expect(page.locator(".sweetie-more input, .sweetie-more button, .sweetie-more a, .sweetie-more [tabindex]")).toHaveCount(0);
  expect(
    await page.locator(".sweetie-more").evaluate((element) => getComputedStyle(element).pointerEvents),
    "the scroll cue takes taps meant for what is around it",
  ).toBe("none");
  // A row of its own, under the region and not over it: what the cue announces is the bottom of a message
  // too tall for the region, so a pill on that edge sat on the words it was talking about (T105 review).
  const overlap = await page.locator(".sweetie-more").evaluate((element) => {
    const cue = element.getBoundingClientRect();
    const region = document.querySelector(".sweetie-messages")!.getBoundingClientRect();
    return Math.round(Math.min(cue.bottom, region.bottom) - Math.max(cue.top, region.top));
  });
  expect(overlap, "the scroll cue is over the transcript, on the words it is announcing (T105, design §6.4)").toBeLessThanOrEqual(0);
  await expectMobileReady(page, "a transcript with more to read", ".sweetie-field-progress");
  await shot(page, "375-sweetie-more-to-read", SCREEN);

  // Scrolled to the end there is nothing left under the composer, and the cue goes with it: what is above
  // the region is ordinary scrollback, not something the patient has to be told about.
  await page.locator(".sweetie-messages").evaluate((element) => element.scrollTo({ top: element.scrollHeight, behavior: "auto" }));
  await expect(page.locator(".sweetie-more")).toHaveCount(0);
  const read = await transcriptCue(page);
  expect(read.hiddenLines, "the transcript is scrolled to its end and still hiding a line of the message").toBe(0);
});

test("a message that fits but for its own padding says nothing", async ({ page }) => {
  // T105, design §6.5. The other half of the cue's claim, and the state it got wrong: a bubble whose every
  // word is on screen, hanging past the fold by the 10px of padding and border it keeps under its last line
  // and that line's own leading and descent space. The first implementation measured the row and announced
  // all ~15px of it as "More below ↓" over a message with nothing below — the same cry-wolf the region's
  // own 15px of padding caused one level up.
  //
  // The reason the office recorded is the longest thing the product puts in the opening bubble, and
  // `MAX_REASON` (lib/visitIntake.ts) caps it at 280 characters, so this is as close to the edge of the
  // region as a real visit can bring it.
  const reason =
    "my numbers keep going high overnight and I don't know why, usually from about two in the morning, " +
    "and it happens whether or not I have eaten late, which is the part I would really like to understand " +
    "before we talk about changing anything, and the same happened last winter";
  const { token, email } = await book(page, "E2E Mobile Padding Cue", reason);

  await page.goto(`/s/${token}`);
  await enterCode(page, email);
  await acceptConsent(page);
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);
  await expect(page.locator(".sweetie-field-progress")).toBeVisible(LOADED);

  await expectTranscriptUncut(page, "a message that fits but for its own padding");
  const hiding = await transcriptCue(page);
  // The state this test is about exists: part of the row is past the bottom of the region.
  expect(
    hiding.pastFold,
    `the opening bubble with a ${reason.length}-character reason does not reach past the transcript at all, so this test is no longer about a bubble that overflows by its own chrome (T105)`,
  ).toBeGreaterThan(1);
  // And none of it is text.
  expect(
    hiding.hiddenLines,
    `${hiding.hiddenLines} of the opener's ${hiding.lines} lines are under the composer, so this state is not the chrome-only one (T105)`,
  ).toBe(0);
  expect(hiding.cue, `the cue announces ${hiding.pastFold}px of the bubble's own padding and border over a message with nothing below (T105, design §6.5)`).toBe(false);
  await expect(page.locator(".sweetie-more")).toHaveCount(0);
  await expectMobileReady(page, "a transcript with nothing but padding past the fold", ".sweetie-field-progress");
  await shot(page, "375-sweetie-padding-past-the-fold", SCREEN);
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
  await expect(providerFooter.getByText("Verify every summary before acting on it")).toBeVisible();
  // T178: and it does not tell the reader who wrote them. This is workspace chrome, outside every branch,
  // on a deployment where no model wrote any summary (§6.3, §11.3) — the state this suite runs in.
  await expect(providerFooter, "the claim T178 was filed for").not.toContainText(/AI-generated/i);
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
  // T118: at 375px this is the only control on the screen below the hero, so what it asks for is the whole
  // ask. With no Dexcom credentials the destination can only take the file (§2.5, §2.7).
  const empty = page.locator(".patient-report-empty");
  await expect(empty.getByRole("link", { name: /Upload your Dexcom export/i })).toBeVisible(LOADED);
  await expect(empty.getByRole("link", { name: /Connect Dexcom/i })).toHaveCount(0);
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
  // T128 (§2.7, §6.5): this is the shot the coordinates were found in. The Timeline sample above places
  // some of the week's rises and nothing uploads the hand labels, so every one of them is a stop with no
  // name — the case that used to put a lat/long in the Where column and over the chart's markers.
  await expectNoCoordinates(page, "the patient summary at 375px");
  // T190 (§2.6, §2.7, §6.5): the week's axis on the one 375px card that holds all seven of its weekdays.
  // The brief's card is 28px narrower and thins to every second day rather than losing one; this is the
  // surface the ticket promised to leave alone, so it is asserted at the width where that is a claim —
  // and through the helper, so "all seven" means all seven the chart asked for and not a number written
  // out here.
  await expectTimeAxisLabelled(page, "the patient summary at 375px, a week of readings", "day");
  await expectNoHorizontalScroll(page, "the patient summary, full");
  await expectNothingScrollsSideways(page, "the patient summary, full");
  await expectTapTargets(page, "the patient summary, full");
  await shot(page, "375-patient-summary-full", SCREEN);
});
