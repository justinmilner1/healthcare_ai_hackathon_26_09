import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "./a11y";
import { csrfToken, postJson } from "./api";
import { signInAsDemo, signOutOfBrowser } from "./auth";
import { LOADED } from "./budget";
import { AGREE, acceptConsent, enterCode, patientEmail } from "./patient";
import { shot, WHOLE_PAGE } from "./shot";

// T22, design §6.4 and §12.5: every screen a patient can land on — the code screen, the two dead ends in
// front of it (T98), consent, Sweetie, the intake sources and the summary — judged by axe against WCAG 2.1
// AA, plus the six things §6.4 names by hand because no automated rule can see them: labels, focus order,
// contrast, reduced motion, a keyboard-operable mic, and a live region for state changes.
//
// Nothing is stubbed except the speech engine. Headless Chromium ships no SpeechRecognition, so the mic
// button Sweetie only renders when the browser can both listen and speak is not in the page at all here;
// `withVoice` puts a do-nothing recognizer on the window so the control exists to be driven from the
// keyboard. What is being tested is the control, not the engine (§6.6 keeps voice browser-native).

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

test("the patient summary passes axe, empty and full", async ({ page }) => {
  const { token, email } = await book(page, "E2E A11y Summary");

  await page.goto(`/s/${token}`);
  await enterCode(page, email);
  await acceptConsent(page);
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);

  // Nothing uploaded yet: the invitation to connect Dexcom is a screen in its own right, and the one a
  // patient who opens the link early actually sees.
  await page.goto(`/patient/${token}`);
  await expect(page.getByRole("link", { name: /Talk to Sweetie/i })).toBeVisible(LOADED);
  await expect(page.locator(".patient-report-empty")).toBeVisible(LOADED);
  await expectNoSeriousA11yViolations(page, "patient summary, nothing connected");
  await shot(page, "a11y-summary-empty");

  // And the page the ticket is really about: charts, the spike table, the sleep panel, the week's numbers.
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
  await shot(page, "a11y-summary");
});
