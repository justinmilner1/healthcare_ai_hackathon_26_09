import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  expectNoFocusRing,
  expectNoProhibitedAriaNames,
  expectNoSeriousA11yViolations,
  expectReadableBrandText,
  expectVisibleFocusRing,
} from "./a11y";
import { csrfToken, postJson } from "./api";
import { signInAsDemo, signOutOfBrowser } from "./auth";
import { DRAINED, LOADED } from "./budget";
import { expectTranscriptUncut } from "./mobile";
import {
  AGREE,
  EYEBROW,
  acceptConsent,
  enterCode,
  expectNoWiderSpan,
  expectOrderedNarrative,
  NARRATIVE_QUESTIONS,
  ONE_DAY_NARRATIVE_PATTERNS,
  patchNarrative,
  patientEmail,
  patternsCard,
  questionsCard,
} from "./patient";
import { MODAL, SCREENFUL, shot, WHOLE_PAGE, type ShotOptions } from "./shot";

// T22, design §6.4 and §12.5: every screen a patient can land on — the code screen, the two dead ends in
// front of it (T98), consent, Sweetie, the intake sources and the summary — judged by axe against WCAG 2.1
// AA, plus the six things §6.4 names by hand because no automated rule can see them: labels, focus order,
// contrast, reduced motion, a keyboard-operable mic, and a live region for state changes.
//
// Nothing is stubbed except the speech engine. Headless Chromium ships no SpeechRecognition, so the mic
// button Sweetie only renders when the browser can both listen and speak is not in the page at all here;
// `withVoice` puts a do-nothing recognizer on the window so the control exists to be driven from the
// keyboard. What is being tested is the control, not the engine (§6.6 keeps voice browser-native).

/**
 * The §2.5 data panel, framed on itself at either width (T166).
 *
 * One screenful rather than the project default, because the subject is a 2px ring around one card: the
 * desktop's whole-document shot of this page puts it in a column where nobody can see whether it is there,
 * which is the question the frame is being taken to answer.
 */
const UPLOAD_PANEL: ShotOptions = { fullPage: false, scrollTo: ".sweetie-upload-list", block: "center" };

/** A booked visit with an address for the code to go to. Booking is staff's job (§5.2), so someone signs in,
 *  books, and signs out, leaving the browser as a patient's. `contact: false` books a visit with nothing to
 *  send a code to, which is one of the two dead ends below. */
async function book(page: Page, name: string, contact = true) {
  const email = patientEmail(name);
  await signInAsDemo(page);
  const booked = await (
    await postJson(page.request, "/api/book", {
      name,
      ...(contact ? { email } : {}),
      visitType: "follow_up",
      reason: "mornings running high",
      channel: "none",
    })
  ).json();
  expect(booked.token, JSON.stringify(booked)).toBeTruthy();
  await signOutOfBrowser(page);
  return { token: booked.token as string, email };
}

/**
 * Make the browser look like one that can talk and listen, so Sweetie renders the mic.
 *
 * A stub, deliberately inert: `start()` fires `onend` on the next tick, which is what a recognizer that
 * heard nothing does, so the page returns to its idle state without a transcript appearing from nowhere.
 * Speech synthesis is stubbed the same way — `speak()` calls back `onend` — so `say()` resolves instead of
 * waiting out its own timeout.
 */
async function withVoice(page: Page) {
  await page.addInitScript(() => {
    class StubRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      onresult: unknown = null;
      onend: (() => void) | null = null;
      onerror: unknown = null;
      onspeechstart: unknown = null;
      start() {
        setTimeout(() => this.onend?.(), 10);
      }
      stop() {
        this.onend?.();
      }
      abort() {
        this.onend?.();
      }
    }
    Object.defineProperty(window, "SpeechRecognition", { value: StubRecognition, configurable: true });
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speaking: false,
        pending: false,
        paused: false,
        getVoices: () => [],
        cancel() {},
        pause() {},
        resume() {},
        speak(utterance: { onend?: () => void }) {
          setTimeout(() => utterance.onend?.(), 10);
        },
        onvoiceschanged: null,
      },
    });
  });
}

/** Record every scrollIntoView the page makes, so a test can see which behaviour it asked for (§6.4). */
async function recordScrolls(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __scrollBehaviours: string[] }).__scrollBehaviours = seen;
    const intoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (arg?: boolean | ScrollIntoViewOptions) {
      seen.push(typeof arg === "object" && arg?.behavior ? arg.behavior : "default");
      return intoView.call(this, arg as ScrollIntoViewOptions);
    };
    // Both ways a page can move a scrolling region, because the Sweetie transcript changed from one to the
    // other (T83): it now scrolls itself to the top of the newest message rather than to a sentinel at its
    // end, and §6.4's claim is about the behaviour asked for, not about which call asks for it.
    const scrollTo = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function (...args: [ScrollToOptions?] | [number, number]) {
      const [first] = args;
      seen.push(typeof first === "object" && first?.behavior ? first.behavior : "default");
      return (scrollTo as (...rest: typeof args) => void).apply(this, args);
    };
  });
}

test("the code screen: axe, a labelled field, and focus that starts in it", async ({ page }) => {
  const { token } = await book(page, "E2E A11y Code");

  await page.goto(`/s/${token}`);
  const field = page.getByLabel("6-digit code");
  await expect(field).toBeVisible(LOADED);

  // §6.4 labels: one labelled input, not six boxes, so a password manager and a screen reader both
  // understand it (components/VerifyScreen.tsx says the same in prose).
  await expect(field).toHaveAttribute("autocomplete", "one-time-code");
  await expect(field).toHaveAttribute("inputmode", "numeric");
  // Focus order: the field is where a patient lands, so the first keystroke is the code.
  await expect(field).toBeFocused();
  // The state of the send sits in a live region tied to the field, so "we sent a code" is announced and the
  // field's own description carries it.
  const note = page.locator("#verify-note");
  await expect(note).toHaveAttribute("role", "status");
  await expect(field).toHaveAttribute("aria-describedby", "verify-note");

  await expectNoSeriousA11yViolations(page, "patient code screen");
  await shot(page, "a11y-code");
});

test("a link we do not know: axe, and a heading that says what happened", async ({ page }) => {
  // The first of the two dead ends in front of the code screen (T98). Both used to render the summary
  // page's loading card, whose whole content is one <p>, so there was no `h1` for axe's heading rules — or
  // for a screen reader — to read, and §12.5's pass had never visited either of them.
  await page.goto("/s/not-a-real-token");
  const card = page.locator(".patient-notice-card");
  await expect(card).toBeVisible(LOADED);

  await expect(card.getByRole("heading", { level: 1 })).toHaveText(/didn't work/i);
  // The instruction is the lede the rest of the patient flow reads at, not the 11px caption it used to be.
  await expect(card.locator(".ss-lede")).toContainText(/couldn't find that link/i);
  // And the patient can see which product is talking to them: the wordmark is in the topbar, as on the code
  // screen next door.
  await expect(page.locator(".ss-topbar .persona-brand")).toContainText("Sweet Spot");

  await expectNoSeriousA11yViolations(page, "patient link not found");
  await shot(page, "a11y-notice-not-found", WHOLE_PAGE);
});

test("a link with nothing to send a code to: axe, a heading, and the practice named", async ({ page }) => {
  // The other one. This is the screen that asks the patient to make a telephone call, so the practice is on
  // it (§2.3 allows it: the code screen already carries the practice for a link that resolves).
  const { token } = await book(page, "E2E A11y No Contact", false);

  await page.goto(`/s/${token}`);
  const card = page.locator(".patient-notice-card");
  await expect(card).toBeVisible(LOADED);

  await expect(card.getByRole("heading", { level: 1 })).toHaveText(/can't send you a code/i);
  await expect(card.locator(".ss-eyebrow")).not.toBeEmpty();
  await expect(card.locator(".ss-lede")).toContainText(/no phone number or email address on file/i);
  await expect(page.locator(".ss-topbar .persona-brand")).toContainText("Sweet Spot");

  await expectNoSeriousA11yViolations(page, "patient link with no contact on file");
  await shot(page, "a11y-notice-no-contact", WHOLE_PAGE);
});

test("the consent screen: axe, both answers reachable by keyboard, and focus follows the decline", async ({ page }) => {
  const { token, email } = await book(page, "E2E A11y Consent");

  await page.goto(`/s/${token}`);
  await enterCode(page, email);
  const card = page.locator(".patient-consent-card");
  await expect(card).toBeVisible(LOADED);

  await expectNoSeriousA11yViolations(page, "patient consent screen");
  await shot(page, "a11y-consent");

  // Focus order (§6.4): agree comes before decline in the tab order, and neither needs a mouse.
  await page.locator("body").press("Tab");
  const agree = page.getByRole("button", { name: AGREE });
  const decline = page.getByRole("button", { name: /No thanks/i });
  for (let step = 0; step < 12 && !(await agree.evaluate((node) => node === document.activeElement)); step++) {
    await page.keyboard.press("Tab");
  }
  await expect(agree).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(decline).toBeFocused();

  // Declining swaps the card in place rather than navigating, so focus would otherwise be left on a button
  // that no longer exists. §6.4 wants the change announced: the new card is a live region and the heading
  // takes focus.
  await page.keyboard.press("Enter");
  const declined = page.locator(".patient-consent-declined");
  await expect(declined).toBeVisible(LOADED);
  await expect(declined).toHaveAttribute("role", "status");
  await expect(declined.getByRole("heading", { level: 1 })).toBeFocused();
  await expectNoSeriousA11yViolations(page, "patient consent declined");
});

test("Sweetie: axe, a keyboard-operable mic, live regions, and reduced motion respected", async ({ page }) => {
  const { token, email } = await book(page, "E2E A11y Sweetie");
  await withVoice(page);
  await recordScrolls(page);
  // §6.4's reduced-motion clause, asserted on the screen with the most movement in it.
  await page.emulateMedia({ reducedMotion: "reduce" });

  await page.goto(`/s/${token}`);
  await enterCode(page, email);
  await acceptConsent(page);
  const messages = page.locator(".sweetie-messages");
  await expect(messages).toContainText(/Hi E2E/, LOADED);

  await expectNoSeriousA11yViolations(page, "Sweetie intake");
  await shot(page, "a11y-sweetie");

  // Live region (§6.4): the transcript grows without a navigation, so it announces itself, and so does the
  // step list that tracks it and the line on each upload card that carries that card's state.
  await expect(messages).toHaveAttribute("aria-live", "polite");
  await expect(page.locator(".sweetie-field-progress")).toHaveAttribute("aria-label", "Intake steps");
  const uploadStates = page.locator(".sweetie-upload-card small");
  await expect(uploadStates).toHaveCount(3);
  for (let index = 0; index < 3; index++) {
    await expect(uploadStates.nth(index)).toHaveAttribute("aria-live", "polite");
  }

  // T166 (§2.5, §6.4, §6.5): and a keyboard can see where it is on them. These three cards are the only way
  // §2.5 gives a patient to share an export from this screen, and each hides its file picker inside the
  // label — so the ring the browser draws lands on a 1px `opacity: 0` box and paints nothing. axe has no
  // rule for focus *visibility*, so the pass above was green over a keyboard dead end; the helper tabs to
  // the card and measures what it paints, composited against the sidebar's gradient. Both projects run
  // this, which is the §6.5 half: 375px is the width the indicator has to hold up at.
  const cards = page.locator(".sweetie-upload-card");
  // The lighter stop of `.sweetie-chat-sidebar`'s gradient, which is the worst case for a ring on it.
  await expectVisibleFocusRing(page, cards.first(), { name: "the Dexcom data card", against: "#f76181" });
  // And the ring is focus's alone: the card next to it is in the same state it was and paints nothing.
  await expectNoFocusRing(cards.nth(1), "the Timeline data card");
  await shot(page, "a11y-sweetie-upload-focus", UPLOAD_PANEL);

  // Reduced motion, the CSS half: the entrance animation collapses to nothing. Read as a number of
  // seconds, because the computed value comes back in whichever unit the engine feels like ("1e-05s" in
  // Chromium for the stylesheet's 0.01ms), and the claim is "no perceptible animation", not a spelling.
  const seconds = await page
    .locator(".sweetie-chat-shell")
    .evaluate((node) => Number.parseFloat(getComputedStyle(node).animationDuration));
  expect(seconds).toBeLessThan(0.001);

  // Reduced motion, the JavaScript half: a smooth scroll is motion the media query cannot reach, so the page
  // has to ask for "auto" itself. The transcript has scrolled at least once by now.
  const behaviours = await page.evaluate(() => (window as unknown as { __scrollBehaviours: string[] }).__scrollBehaviours);
  expect(behaviours.length).toBeGreaterThan(0);
  expect(behaviours).not.toContain("smooth");

  // Keyboard-operable mic (§6.4): a real button, reached by Tab from the reply box, toggled with the
  // keyboard, and reporting its own state through aria-pressed.
  const reply = page.getByLabel("Reply to Sweetie");
  await reply.focus();
  await page.keyboard.press("Tab");
  const mic = page.getByRole("button", { name: /Talk to Sweetie/i });
  await expect(mic).toBeFocused();
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /Stop voice/i })).toHaveAttribute("aria-pressed", "true");
  // And off again, from the keyboard, without the focus going anywhere.
  await page.keyboard.press("Enter");
  await expect(mic).toHaveAttribute("aria-pressed", "false");
  await expect(mic).toBeFocused();

  // Send is next, so the tab order runs reply → mic → send: the three controls in the order they are used.
  // With an empty box Send is disabled, and a disabled button is correctly out of the tab order — so this
  // types first, which is also the state a patient is in when they reach for it.
  await reply.fill("Mostly fine, thanks");
  await reply.focus();
  await page.keyboard.press("Tab");
  await expect(mic).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Send message" })).toBeFocused();
});

test("the intake page passes axe and labels every file picker", async ({ page }) => {
  const { token, email } = await book(page, "E2E A11y Intake");

  await page.goto(`/s/${token}`);
  await enterCode(page, email);
  await acceptConsent(page);
  await page.goto(`/s/${token}/intake`);
  // The screen opens on its welcome step; the data sources are the step after it.
  await page.getByRole("button", { name: /Let's get started/i }).click();
  await expect(page.getByLabel(/Upload Dexcom file/i)).toBeAttached(LOADED);

  // §6.4 labels: a file input is invisible by design here — the card around it is what a patient clicks —
  // so the accessible name is the only thing a screen reader has to go on.
  for (const source of [/Upload Dexcom file/i, /Upload WHOOP file/i, /Upload Google Timeline file/i]) {
    await expect(page.getByLabel(source)).toBeAttached();
  }

  await expectNoSeriousA11yViolations(page, "patient intake");
  await shot(page, "a11y-intake");
});

test("the patient summary passes axe, empty and full", async ({ page, browser }) => {
  const { token, email } = await book(page, "E2E A11y Summary");

  await page.goto(`/s/${token}`);
  await enterCode(page, email);
  await acceptConsent(page);
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);

  // Nothing uploaded yet: the invitation to connect Dexcom is a screen in its own right, and the one a
  // patient who opens the link early actually sees.
  await page.goto(`/patient/${token}`);
  await expect(page.getByRole("link", { name: /Talk to Sweetie/i })).toBeVisible(LOADED);
  const empty = page.locator(".patient-report-empty");
  await expect(empty).toBeVisible(LOADED);
  // T118 (§2.5, §2.7): this suite runs with no Dexcom credentials, so /s/<token> has no Dexcom connection
  // on it — only the file upload. The one button here leads there, so it asks for the upload and never for
  // a connection, and says nothing about why (the T71 rule).
  await expect(empty.getByRole("link", { name: /Upload your Dexcom export/i })).toBeVisible();
  await expect(empty.getByRole("link", { name: /Connect Dexcom/i })).toHaveCount(0);
  await expect(empty).not.toContainText(/not configured|demo mode|credential/i);

  // T123 (§2.5, §2.7): the empty half of the eyebrow pair in e2e/flows.spec.ts. This visit has shared
  // nothing, so the hero names no span — it read "YOUR WEEK WITH SWEETIE" directly above "Your glucose
  // story is ready for its first chapter", promising a week to a patient who had given no data at all,
  // which is the shape T116 settled for the step before this one. The negative assertion on the card
  // below it is the other half: its invitation presumed a week too ("turn the past week into a clear
  // picture", lib/dexcomHint.ts), and a visit with nothing in it has no number to justify either. The
  // card rather than the page, because the hero's own countdown to the appointment legitimately counts
  // days ("3 days until your visit with …") and that is a fact about the calendar, not about the data.
  await expect(EYEBROW(page), "nothing shared, so no span is named").toHaveText("YOUR CHECK-IN WITH SWEETIE");
  await expect(
    empty,
    "a patient who shared nothing is not told what span to expect",
  ).not.toContainText(/\b(hours?|days?|weeks?|months?)\b/i);

  await expectNoSeriousA11yViolations(page, "patient summary, nothing connected");
  await shot(page, "a11y-summary-empty");

  // And the page the ticket is really about: charts, the spike table, the sleep panel, the week's numbers,
  // and — since T208 — §2.7's two narrative cards, "What your week showed" and "Things you might ask your
  // doctor". Those two are the half this test could not reach: both render on `length ?`, this suite has no
  // model gateway, and `degradedPair` (lib/sourRun.ts) writes `patterns: []` and `questions: []` — so axe
  // had never read either card, at any count, on any run. That is how one of them stayed a `<ul>` drawing
  // 1, 2, 3 over content §7 orders, while the other said its numeral on top of the position its `<ol>`
  // already gave it. They are put on the page below the way T206's test does it (patchNarrative,
  // e2e/patient.ts).
  // Uploaded through the real route, as the intake screen does, so what axe reads is the rendered data.
  const headers = { "x-csrf-token": await csrfToken(page.request) };
  for (const [kind, name, type, file] of [
    ["dexcom", "Clarity_export.csv", "text/csv", "clarity_window.csv"],
    ["whoop", "whoop_cycles.csv", "text/csv", "whoop_cycles.csv"],
    ["timeline", "Timeline.json", "application/json", "timeline_android.json"],
  ] as const) {
    const uploaded = await page.request.post("/api/upload", {
      headers,
      multipart: {
        token,
        kind,
        file: { name, mimeType: type, buffer: readFileSync(join(process.cwd(), "data", "fixtures", file)) },
      },
    });
    expect(uploaded.status(), `uploading ${kind}: ${await uploaded.text()}`).toBe(200);
  }

  await page.goto(`/patient/${token}`);
  await expect(page.locator(".patient-range-card")).toBeVisible(LOADED);
  await expect(page.locator(".recharts-surface").first()).toBeVisible(LOADED);
  await expectNoSeriousA11yViolations(page, "patient summary");
  // "TIME IN RANGE" is on screen from the moment there is a percentage to put above it, which is before
  // either narrative card exists (T210, §6.4, §2.7).
  await expectReadableBrandText(page, "the patient summary");

  // T218 (§2.7, §7): and the one thing about this frame that no axe rule and no contrast check can see —
  // that the sleep card and the page around it are about the same span. This is the pair the ticket was
  // filed on and the pair this test has uploaded since T206: `clarity_window.csv` is one morning and
  // `whoop_cycles.csv` is three nights, two of which fall entirely after the only day of glucose here. So
  // the page said "day" in four places and plotted Sat, Sun and Mon beside a `HISTORY / 1 / day` tile,
  // with `SLEEP / 6.8 / hours / night` averaging all three — and the frame was in this suite's own output,
  // at both widths, on every run.
  //
  // Read off the bundle rather than written out here, so a fixture that is ever widened fails this and
  // names the reason instead of leaving the assertions passing over a pair that no longer mismatches.
  const framed = (await (await page.request.get(`/api/patient/${token}`)).json()) as {
    stats: { days: number };
    sleep: unknown[];
  };
  expect(framed.stats.days, "clarity_window.csv is one calendar day of readings").toBe(1);
  expect(framed.sleep.length, "beside whoop_cycles.csv's three nights").toBe(3);

  const sleepStat = page.locator(".patient-mini-stat", { hasText: "Sleep" });
  await expect(sleepStat, "the SLEEP tile says how many nights it averaged").toContainText("3 nights");
  await expect(
    sleepStat,
    "and no longer offers the bare rate, which read as one night's sleep beside a HISTORY tile of 1 day",
  ).not.toContainText("hours / night");

  const sleep = page
    .locator(".patient-report-card")
    .filter({ has: page.getByRole("heading", { name: "Your sleep" }) });
  await expect(sleep.locator(".patient-report-subtitle"), "the card names its own span (AC1)").toHaveText(
    "Nightly sleep and recovery from your connected data. These 3 nights cover more than the day of glucose above.",
  );
  // The negative the narrative cards are already held to over this same visit (expectNoWiderSpan, T217),
  // against the card's *own* span rather than the page's: three nights is what it may name, so a week, a
  // month or a year on it would be the same overclaim read from the other side.
  await expectNoWiderSpan(sleep, framed.sleep.length, "the sleep card");

  // The card on its own, which is the §6.5 half: `desktop-a11y-summary.png` below carries the whole frame
  // — hero, `HISTORY / 1 / day`, `SLEEP / 6.8 / hours · 3 nights` and these bars together — but a phone
  // shoots one screenful, so on `mobile` that shot is the hero and this card has never been in a frame at
  // 375px. The subtitle is a sentence longer than it was, and where it wraps is the thing to look at.
  await shot(page, "a11y-summary-sleep", { ...SCREENFUL, scrollTo: sleep });

  await shot(page, "a11y-summary");

  // A real `sour.run`, so the pair the narrative lands on is one the product saved (§7.1). Generating is a
  // clinician's job (§5.2) and `book` above signed this browser out on purpose, so the request comes from a
  // staff browser of its own — the shape e2e/ratelimit.spec.ts's second patient uses, one page, used and
  // closed — rather than by signing back in here and leaving the patient's session behind.
  const visitId = (await (await page.request.get(`/api/patient/${token}`)).json()).visitId as string;
  expect(visitId, "the visit behind the patient token").toBeTruthy();
  const staff = await browser.newPage();
  await signInAsDemo(staff);
  expect((await postJson(staff.request, "/api/sour", { visitId })).ok(), "POST /api/sour").toBeTruthy();
  await staff.close();
  await expect
    .poll(async () => (await (await page.request.get(`/api/patient/${token}`)).json()).patientSummary !== null, DRAINED)
    .toBe(true);
  // Stated rather than assumed, as in the T206 test: no model wrote this pair, so both cards are gated out
  // and everything below rests on the patch really being what put them on screen.
  const saved = await (await page.request.get(`/api/patient/${token}`)).json();
  expect(saved.patientSummary.patterns, "no model gateway, so no narrative (§6.3, §11.3)").toEqual([]);
  expect(saved.patientSummary.questions, "the same for the questions").toEqual([]);

  // The span the patterns below are written for, read off the bundle rather than presumed (T217).
  // `clarity_window.csv` is one calendar day, so the heading is `What your day showed`, and the week's
  // narrative e2e/flows.spec.ts renders contradicts every frame it appears over — which is what it did
  // here until a reviewer read the PNG. If this fixture is ever widened, this line fails first and names
  // the reason.
  const days = saved.stats.days as number;
  expect(days, "clarity_window.csv is one calendar day of readings").toBe(1);

  await patchNarrative(page, () => ({ patterns: ONE_DAY_NARRATIVE_PATTERNS, questions: NARRATIVE_QUESTIONS }));
  await page.goto(`/patient/${token}`);
  const patterns = patternsCard(page);
  const questions = questionsCard(page);
  await expect(patterns, "the patch reached the page").toBeVisible(LOADED);
  await expect(questions).toBeVisible();

  // The §12.5 judgement, now over a page that has both cards on it.
  await expectNoSeriousA11yViolations(page, "patient summary, both narrative cards");

  // And the semantics by name, because axe has no rule for either half of T208: a `<ul>` whose order is
  // meaningful is valid markup, and a numeral said twice is valid markup read badly. Both cards, the same
  // way, since §7 orders both arrays "most important first" (lib/prompts.ts).
  await expectOrderedNarrative(patterns, ONE_DAY_NARRATIVE_PATTERNS, "the patterns card");
  await expectOrderedNarrative(questions, NARRATIVE_QUESTIONS, "the questions card");

  // T217 (§2.7, §7): and the one thing about these cards that is not markup — that what they say fits
  // the visit they are drawn over. This is the assertion the frame was missing: the heading is computed
  // from `days` and the sentences under it were not, so the card could and did say "the week" over a day.
  await expectNoWiderSpan(patterns, days, "the patterns card");
  await expectNoWiderSpan(questions, days, "the questions card");

  // T210 (§6.4): and the colour those numerals are drawn in. This is the page that holds both of the
  // sites that ticket measured — the 1 / 2 / 3 chip on either card, and "TIME IN RANGE" under the big
  // percentage — and the axe pass three lines above it was green over both for two tickets.
  await expectReadableBrandText(page, "the patient summary, both narrative cards");

  await shot(page, "a11y-summary-narrative", { ...SCREENFUL, scrollTo: patternsCard(page) });
});

// T209 (design §2.5, §6.4, §12.5): the typing indicator, in the only state it exists in.
//
// This is the gap that let the bug through rather than a second opinion on it. §6.4 asks for
// "screen-reader text for state changes" and the indicator is the only thing on the page that says a reply
// is coming — but it is on screen for as long as one model call takes, so every axe pass in this file ran
// against a page that did not contain it. What was there, unseen, was `aria-label="Sweetie is typing"` on a
// role-less `<div>` holding three empty `<i>`: ARIA prohibits naming a `generic` element, and with no text
// inside it for axe to wonder about it is a **serious violation** and not an incomplete. So a patient
// driving §2.5 by voice got silence between their own turn and the reply landing, with no way to tell
// whether the send went through, and §12.5's pass was green over it.
//
// Holding the turn open is what makes the state assertable: the POST is parked in a route handler until the
// assertions are done, which is the same device e2e/durability.spec.ts uses to read a turn mid-flight.
test("Sweetie mid-reply: the indicator is a live region that says a reply is coming", async ({ page }) => {
  const { token, email } = await book(page, "E2E A11y Typing");
  await page.goto(`/s/${token}`);
  await enterCode(page, email);
  await acceptConsent(page);
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);

  // Park the turn. `release` is called once the indicator has been read, so the test leaves the page in the
  // ordinary state rather than with a request outstanding.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/sweetie", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await held;
    await route.fallback();
  });

  const reply = page.getByLabel("Reply to Sweetie");
  await reply.fill("Evenings are the bad ones, mornings are fine.");
  await reply.press("Enter");

  const typing = page.locator(".sweetie-typing");
  await expect(typing, "the indicator is on screen while the reply is being composed").toBeVisible(LOADED);

  // Both halves of what makes it heard. The role is the one ARIA gives a polite live region whose subject is
  // not the user's own doing — and, unlike the `generic` it was, one that may be named.
  await expect(typing, "a name on a role-less div is dropped, so the role has to allow one").toHaveRole("status");
  // The name itself. `toHaveAccessibleName` rather than the attribute, because `status` is "Name From:
  // author" — contents are not consulted — so this is the assertion that fails if the label is ever moved
  // onto the hidden words below and the region is left anonymous.
  await expect(typing, "and the patient is told what the region is").toHaveAccessibleName("Sweetie is typing");
  // The words are also *in* it, which is the half a label alone would have got wrong: a live region
  // announces what changed, not what it is called, so a labelled region holding three empty <i> is a fix
  // that passes axe and leaves the patient in exactly the silence this ticket is about.
  await expect(typing, "a live region announces its content, so the content has to be the words").toHaveText(
    "Sweetie is typing",
  );

  // One region, so one announcement (§6.4). The indicator used to be the last row inside the transcript,
  // which is itself a `role="log"` live region — and ARIA computes an announcement against the nearest
  // live-region ancestor, so whether a nested region speaks once or twice is a property of the screen
  // reader rather than of the product. Out here the question does not arise. Asserted structurally because
  // "exactly once" is not something a browser can be asked.
  await expect(
    page.locator(".sweetie-messages .sweetie-typing"),
    "a live region nested in a live region is how one state change becomes two announcements",
  ).toHaveCount(0);
  const log = page.locator(".sweetie-messages");
  await expect(log, "the transcript is still the log it was").toHaveRole("log");
  await expect(typing.locator("xpath=ancestor::*[@aria-live or @role='log' or @role='status'][1]")).toHaveCount(0);

  // And the gate, over the state that was never scanned. Both of them: the full §12.5 pass, which now reads
  // `aria-prohibited-attr` incompletes as findings (T207), and the narrow rule below, which is what reaches
  // the surfaces the pass does not.
  await expectNoSeriousA11yViolations(page, "Sweetie mid-reply");
  await expectNoProhibitedAriaNames(page, "Sweetie mid-reply");

  // And where the dots are, which is the other half of the row T209 gave them (T211, design §2.5). The slot
  // is outside the transcript, asserted above; what this asks is that being outside it does not mean being
  // at the bottom of the card. `.sweetie-messages` used to grow to fill the column, so every row under it
  // was pinned over the composer however little was in the thread — and the thread this test stages, two
  // messages, is the common case for the indicator, since it is most often up on the patient's first reply.
  // The desktop frame of it measured about 180px of blank card between the message and the dots.
  //
  // Measured against the region's own bottom padding rather than against a number of this test's choosing:
  // that padding is the breathing room the transcript already keeps under its newest message, so "the dots
  // follow the last message" is exactly "the only thing between them is that padding", at either width and
  // whatever the stylesheet sets it to (22px here, 15px at 375px). The ~180px gap fails it by either
  // reading, and so would a slot that drifted back down to the composer.
  //
  // After the suite's own wait for the transcript to stop moving, because this is a rect measurement and
  // `busy` flipping is what sends the region gliding to the newest message (app/s/[token]/page.tsx). The
  // scans above take long enough that the glide is over by now on any box, which is exactly the reasoning
  // T89 and T95 say not to leave implicit in a measurement that would otherwise name the product.
  await expectTranscriptUncut(page, "Sweetie mid-reply");
  const placement = await page.evaluate(() => {
    const region = document.querySelector<HTMLElement>(".sweetie-messages")!;
    const rows = region.querySelectorAll(".sweetie-message-row");
    const last = rows[rows.length - 1]!.getBoundingClientRect();
    // The slot's own edge, not the bubble's inside it: the bubble sits 3px down the row because the row is
    // `align-items: end` against a 36px avatar, and the animated row itself is a rect worth not reading.
    const slot = document.querySelector(".sweetie-typing-slot")!.getBoundingClientRect();
    // The gutter is read off one of Sweetie's own rows rather than off the patient's: a patient row is
    // `align-self: flex-end`, so its left edge is wherever its words ran out. The typing row is one of
    // hers — avatar, gap, bubble — so the two line up exactly when both are drawn in the same gutter.
    const hers = region.querySelector(".sweetie-message-row:not(.sweetie-message-patient)")!.getBoundingClientRect();
    const row = document.querySelector(".sweetie-typing-slot .sweetie-message-row")!.getBoundingClientRect();
    return {
      rows: rows.length,
      gap: Math.round(slot.top - last.bottom),
      padding: Math.round(Number.parseFloat(getComputedStyle(region).paddingBottom)),
      indent: Math.round(row.left - hers.left),
    };
  });
  // The short thread the gap only arises on, named so that a staging change cannot quietly make this test
  // about something else.
  expect(placement.rows, "the thread this is measured on is Sweetie's opener and the patient's reply").toBe(2);
  expect(
    placement.gap,
    `the typing slot sits ${placement.gap}px under the patient's own message, past the ${placement.padding}px the transcript keeps below it — a short thread is pushing the indicator to the bottom of the card (T211, design §2.5)`,
  ).toBeLessThanOrEqual(placement.padding + 2);
  // Horizontally too: the slot and the region share one gutter (`--sweetie-gutter`), which they did not at
  // 375px, where the region's 13px met the slot's 20px.
  expect(
    placement.indent,
    `the typing row is indented ${placement.indent}px from Sweetie's own rows, so the slot is not drawn in the transcript's gutter (T211)`,
  ).toBe(0);

  await shot(page, "a11y-sweetie-typing", { scrollTo: ".sweetie-typing-slot", block: "end" });

  // The row goes back to the conversation when the reply lands, which is the trade the slot makes.
  release();
  await expect(typing, "the indicator is gone once there is a reply to read").toHaveCount(0, LOADED);
  await expect(page.locator(".sweetie-typing-slot")).toBeHidden();
});

// T209 (design §6.4): the three surfaces §12.5's axe pass does not reach, held to the one rule that found
// five sites of the same bug.
//
// §12.5 puts axe on the *patient* pages, and every call site of `expectNoSeriousA11yViolations` is one —
// correctly, since that is where the bar is set. The consequence is that the same prohibited attribute on
// a provider wizard or on the landing page is invisible to the suite, and three of them sat there until
// this ticket. A full WCAG pass on each would be a different ticket's worth of work and a different
// ticket's worth of findings, so what is asserted here is the narrow claim: nothing on these pages carries
// an accessible name ARIA will not let it have (`lib/ariaName.ts`, unit-tested in `lib/ariaName.test.ts`).
test("the landing page and both provider wizards name nothing that cannot be named", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: /Open the practice dashboard/i })).toBeVisible(LOADED);
  // `.home-visual` wore "Meet Sweetie and Sour" here. Removed rather than relocated: two <figure>s whose
  // alt text and <figcaption> each name both characters and both jobs already.
  await expectNoProhibitedAriaNames(page, "the landing page");
  // T210 (§6.4): three of this page's eyebrows are the same `--sweetie-dark` §2.7's small print is, and
  // were the same defect — 3.85:1, 3.67:1 and 3.83:1, measured off this test's own committed frames.
  // §12.5 puts axe on the patient pages, so nothing in this suite had ever looked at them.
  await expectReadableBrandText(page, "the landing page");

  await page.goto("/provider/signup");
  const stepper = page.locator(".ss-stepper");
  await expect(stepper, "the §2.1 sign-up strip").toBeVisible(LOADED);
  await expectNoProhibitedAriaNames(page, "the practice sign-up wizard");
  // The strip is an <ol> now, which is a `list` — a role ARIA allows a name on, so "Setup progress" is
  // announced instead of dropped — and the step being asked about says so rather than only looking so.
  await expect(stepper).toHaveRole("list");
  await expect(stepper).toHaveAccessibleName("Setup progress");
  await expect(stepper.locator("li")).toHaveCount(2);
  await expect(stepper.locator("[aria-current='step']"), "one current step, the first").toHaveText(/1\s*You/);
  // And the step's own name survives the width §6.5 names. The phone's top bar has no room for two labels
  // beside the wordmark, so they come off it — but with `display: none` they came out of the accessibility
  // tree too, and a strip announced as "Setup progress, 2 items, 1, 2" is a name over nothing. Clipped
  // instead, which is what §2.5's strip does with its own labels at this width. One assertion for both
  // wizards, because one stylesheet rule and one component serve both.
  const stepName = stepper.locator("li em").first();
  await expect(stepName, "the first step is still called something").toHaveText("You");
  await expect(stepName, "hidden from the eye is not hidden from a screen reader").not.toHaveCSS(
    "display",
    "none",
  );
  await shot(page, "a11y-signup-stepper", { scrollTo: ".ss-topbar" });

  // And §2.2's, which is the same component: the bug was that this markup existed twice and the label was
  // wrong in both copies, so the fix being one component is itself part of the ticket.
  await signInAsDemo(page);
  await page.getByRole("button", { name: /Add patient/i }).first().click();
  const wizard = page.locator(".patient-wizard-top .ss-stepper");
  await expect(wizard, "the Add-patient strip").toBeVisible(LOADED);
  await expectNoProhibitedAriaNames(page, "the Add-patient wizard");
  await expect(wizard).toHaveRole("list");
  await expect(wizard).toHaveAccessibleName("Add patient progress");
  await expect(wizard.locator("li")).toHaveCount(3);
  await expect(wizard.locator("[aria-current='step']")).toHaveText(/1\s*Contact/);
  await shot(page, "a11y-wizard-stepper", MODAL);
});
