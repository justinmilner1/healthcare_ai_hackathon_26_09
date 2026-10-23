import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "./a11y";
import { postJson } from "./api";
import { signInAsDemo, signOutOfBrowser } from "./auth";
import { LOADED } from "./budget";
import { patientEmail, verifyLink } from "./patient";
import { shot, WHOLE_PAGE } from "./shot";

// T84 (design §2.4, §2.5, §6.4): the card at the end of the connections step, in both of the states it has.
//
// The tick on its first row was unconditional while the sentence beside it was not, so a patient who shared
// nothing was shown the flow's own CONNECTED glyph against the words "No data connected yet" — on a screen
// whose eyebrow reads SETUP COMPLETE. §2.5 makes the data panel optional and §2.4 promises the patient that
// sharing is their choice, which only means something if the screen can tell them it did not happen.
//
// T116 (design §2.5, §2.7) is the same bug one line further out. T84 fixed the row and left the four
// strings around it unconditional, so the card reported "No data connected yet" while Sweetie's bubble, the
// lede over the card, the primary button and the hint under it all offered a week to view — and the button
// landed the patient on the empty summary, which asked them to go back and connect something. All four are
// asserted below in both states, so the next change cannot split them from the row again.
//
// T133 (design §2.5, §2.7) is the same bug one condition further out, and the third state of this step.
// T116 fixed the column where nothing was shared; the four strings stayed wrong in the column where
// something was, because `connectedCount > 0` counts a WHOOP CSV and a Timeline export and neither
// produces a glucose reading — while `/patient/<token>` renders on `status.hasDexcom`. The shared column's
// assertions below have always run on a Clarity upload, so the promise happened to be true there and the
// suite could not see the gap. The test after this one is the fixture it never had.
//
// Both states, on both projects, because the fix is a glyph and a colour and the evidence for it is the
// §12.3 screenshot as much as the assertion: the desktop and mobile runs write
// `<project>-connect-done-empty.png` and `<project>-connect-done-connected.png`. The assertions read
// `data-icon` off the glyph itself rather than the class around it, since the class is a hashed CSS module
// name and the thing that regressed is which shape the row draws.

const clarity = () => readFileSync(join(process.cwd(), "data", "fixtures", "clarity_window.csv"));
/** A connection with no glucose in it, which is the state T133 is about. */
const whoop = () => readFileSync(join(process.cwd(), "data", "fixtures", "whoop_cycles.csv"));

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

/** The mark on the first row of the setup-complete card, whichever of the two it is drawing. */
const dataMark = (page: Page) => page.locator("[data-mark]");

/** The active step in the progress nav, whose filled disc carries the step number in 10px white (T104). */
const activeStep = (page: Page) => page.locator('[aria-label="Onboarding progress"] [aria-current="step"] > span');

/**
 * The contrast between an element's own colour and its own background, as the browser paints them.
 *
 * Measured here rather than left to axe, for both of the things it is used on.
 *
 * The mark on the first row is a stroked `<svg>`, and axe's `color-contrast` rule judges text only, so the
 * one thing §6.4 asks about the mark is the one thing an axe pass would not look at. Its bar is WCAG
 * 1.4.11's 3:1 for a graphical object, not the 4.5:1 that is about text.
 *
 * The step number is text, and axe does not report it either — it comes back clean on the brand `--pink`
 * it used to be filled with, which is 3.08:1 under white at 10px. So T104 darkened the disc to
 * `--pink-dark` and this measures it, because the pass alone would not have noticed either way.
 *
 * Both sit alongside an axe pass rather than instead of one: T104 fixed the two serious `color-contrast`
 * findings that kept axe off this screen — `.readyRow small` (#8f858b on #fffafb, 3.44:1) now takes
 * `--muted`, and the "View my week" button rests on `--pink-dark` instead of `--pink` — so the test below
 * scans both states of the step as well.
 */
async function contrastOf(target: Locator): Promise<number> {
  return target.evaluate((span) => {
    const channel = (value: number) => {
      const unit = value / 255;
      return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (color: string) => {
      const [red, green, blue] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
    };
    const style = getComputedStyle(span);
    // The svg is `stroke: currentColor` over the badge's own background, so those two are the pair.
    const glyph = luminance(style.color);
    const badge = luminance(style.backgroundColor);
    return (Math.max(glyph, badge) + 0.05) / (Math.min(glyph, badge) + 0.05);
  });
}

test("the setup-complete card marks nothing-shared differently from something-shared", async ({ page }) => {
  const { token, email } = await book(page, "E2E Connections");
  await verifyLink(page, token, email);
  await page.goto(`/s/${token}/intake`);
  await page.getByRole("button", { name: /Let's get started/i }).click();
  const dexcomInput = page.getByLabel(/Upload Dexcom file/i);
  await expect(dexcomInput).toBeAttached(LOADED);

  // Nothing shared: the path the ticket was filed from, and the one a patient who got lost ends up on.
  await page.getByRole("button", { name: /Skip connections/i }).click();
  await expect(page.getByRole("heading", { name: /You.re all set/i })).toBeVisible(LOADED);
  await expect(page.getByText("No data connected yet")).toBeVisible();
  // The sentence under it follows the state too: "add more data" under "No data connected yet" offered to
  // add to nothing, which is the mark's own confusion in words.
  await expect(page.getByText("You can return to connections to add your data.")).toBeVisible();
  await expect(dataMark(page)).toHaveAttribute("data-mark", "none");
  // The glyph, not just the state: the tick is what the step before this one uses for CONNECTED, so the row
  // reporting that nothing arrived must not be drawing it.
  await expect(dataMark(page).locator('svg[data-icon="check"]')).toHaveCount(0);
  await expect(dataMark(page).locator('svg[data-icon="info"]')).toHaveCount(1);

  // T116: the four strings around the row, in the state the ticket was filed from. Each one names
  // something that is true with nothing shared, and the two actions offered are the two that lead
  // somewhere real — Sweetie, now the primary, and the way back to connections.
  await expect(page.getByText("Nothing shared yet. We can still talk it through.")).toBeVisible();
  await expect(page.getByText(/nothing to show you yet/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Chat with Sweetie", exact: true })).toBeVisible();
  await expect(
    page.getByText("A short chat still gives your clinician something to work from."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Back to connections/i })).toBeVisible();
  // And the promises are gone rather than outnumbered. The button that landed on the empty summary is not
  // on the screen at all, and neither is the noun that made the step a promise: step 2 has no other use
  // for "week", so the whole frame is the right scope for the negative — the bubble sits outside the card.
  await expect(page.getByRole("button", { name: /View my week/i })).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(/week/i);

  // §6.4: the neutral mark has to clear the same bar as the one it replaced.
  expect(
    await contrastOf(dataMark(page)),
    "§6.4, WCAG 1.4.11: the neutral mark against its badge",
  ).toBeGreaterThanOrEqual(3);
  // T104: and the step number on the "Ready" disc, which is 10px of white on the flow's pink. Text, so
  // WCAG 1.4.3's 4.5:1 — and asserted by hand because the axe pass above does not report this node.
  expect(
    await contrastOf(activeStep(page)),
    "§6.4, WCAG 1.4.3: the active step number against its disc",
  ).toBeGreaterThanOrEqual(4.5);
  // T104 (§6.4, §12.5): the step itself, by the same helper every other patient screen is held to. Both of
  // its states are scanned, because the two rows differ by glyph, by colour and by the sentence under them.
  await expectNoSeriousA11yViolations(page, "patient setup complete, nothing shared");
  await shot(page, "connect-done-empty", WHOLE_PAGE);

  // One source shared: unchanged, tick and count, which is the half of the screen that was always right.
  await page.getByRole("button", { name: /Back to connections/i }).click();
  await expect(dexcomInput).toBeAttached(LOADED);
  await dexcomInput.setInputFiles({ name: "Clarity_export.csv", mimeType: "text/csv", buffer: clarity() });
  await expect(page.getByText(/records securely added/i)).toBeVisible(LOADED);
  await page.getByRole("button", { name: /^Continue$/ }).click();
  await expect(page.getByRole("heading", { name: /You.re all set/i })).toBeVisible(LOADED);
  await expect(page.getByText("1 data source connected")).toBeVisible();
  await expect(page.getByText("You can return to connections to add more data.")).toBeVisible();
  await expect(dataMark(page)).toHaveAttribute("data-mark", "connected");
  await expect(dataMark(page).locator('svg[data-icon="check"]')).toHaveCount(1);

  // T116: the same four, and T133's wording for them. This upload is glucose, so the step may offer the
  // summary — and it names what the destination opens that data with ("Your glucose", the chart card's own
  // heading) rather than a span, which this step cannot know and used to claim twice over. The chat drops
  // back to a secondary action, which is what the absent exact-named button says.
  await expect(page.getByText("Your glucose is ready to view. Questions are optional.")).toBeVisible();
  await expect(page.getByText(/^Go straight to your glucose without answering questions\./)).toBeVisible();
  await expect(page.getByRole("button", { name: /View my glucose/i })).toBeVisible();
  await expect(page.getByText("Skip the questions. Your shared data stays saved.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Chat with Sweetie", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Chat with Sweetie instead/i })).toBeVisible();
  // T133: and the span is gone from this column too, over the whole frame for the reason given above —
  // step 2 has no other use for the word, so there is nothing here for a frame-wide negative to catch
  // except the promise itself.
  await expect(page.locator("main")).not.toContainText(/week/i);

  expect(
    await contrastOf(dataMark(page)),
    "§6.4, WCAG 1.4.11: the tick against its badge",
  ).toBeGreaterThanOrEqual(3);
  await expectNoSeriousA11yViolations(page, "patient setup complete, one source shared");
  await shot(page, "connect-done-connected", WHOLE_PAGE);
});

/**
 * The setup-complete step for a patient who shared something with no glucose in it (T133, design §2.5, §2.7).
 *
 * The case the suite has never had. T116 pinned the column where nothing was shared and the test above
 * pins the column where a Clarity export was, and between them they left out the state that is neither:
 * §2.5 offers three sources and two of them — WHOOP and Timeline — produce no glucose reading at all. A
 * patient who uploads only their sleep history satisfied `connectedCount > 0`, was told "Your week is
 * ready to view", pressed "View my week" and landed on the empty summary asking them to go back and share
 * a Dexcom export. They shared data, were promised their week, and arrived at a screen telling them they
 * had shared nothing to show.
 *
 * So this asserts the two halves of the fix together: the words say what this patient actually has, and
 * the primary action goes somewhere that does not contradict them. Pressing it is the assertion — the
 * destination is checked rather than the label, because the label was not the thing that cost the patient
 * their time.
 *
 * The first row of the card is the one thing that does not change here: something *was* shared, so it
 * keeps T84's tick and its count. That is the point of the state — the row and the strings answer two
 * different questions, and T133 is what happens when the strings are given the row's.
 *
 * Both projects, so the §12.3 evidence is this step at 1280px and at 375px.
 */
test("the setup-complete step offers no summary to a connection with no glucose in it", async ({ page }) => {
  const { token, email } = await book(page, "E2E No Glucose");
  await verifyLink(page, token, email);
  await page.goto(`/s/${token}/intake`);
  await page.getByRole("button", { name: /Let's get started/i }).click();

  // WHOOP only. The Dexcom picker is waited on rather than the WHOOP one because the whole panel arrives
  // with the status fetch, and the Dexcom card is the one the other tests here wait on.
  await expect(page.getByLabel(/Upload Dexcom file/i)).toBeAttached(LOADED);
  await page
    .getByLabel(/Upload WHOOP file/i)
    .setInputFiles({ name: "whoop_cycles.csv", mimeType: "text/csv", buffer: whoop() });
  await expect(page.getByText(/records securely added/i)).toBeVisible(LOADED);
  await page.getByRole("button", { name: /^Continue$/ }).click();
  await expect(page.getByRole("heading", { name: /You.re all set/i })).toBeVisible(LOADED);

  // The row still reports what arrived: one source, with the tick. T133 changes nothing about this half.
  await expect(page.getByText("1 data source connected")).toBeVisible();
  await expect(dataMark(page)).toHaveAttribute("data-mark", "connected");
  await expect(dataMark(page).locator('svg[data-icon="check"]')).toHaveCount(1);

  // And the strings around it answer the other question. Each one is true of a patient who has shared
  // their sleep and nothing else: the upload is saved, and there is nothing to look at.
  await expect(page.getByText("Your data is saved. There's nothing to view without glucose.")).toBeVisible();
  await expect(page.getByText(/saved for your care team/)).toBeVisible();
  await expect(page.getByText(/nothing to show you yet without your glucose readings/)).toBeVisible();
  await expect(
    page.getByText("A short chat still gives your clinician something to work from."),
  ).toBeVisible();
  // The promise and the button that carried it are not on the screen — in any wording, which is what the
  // frame-wide negative is for: this step cannot know a span in any of its three states.
  await expect(page.getByRole("button", { name: /View my (week|glucose)/i })).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(/week/i);
  // Nor is the summary offered under another name. The patient page is reached from the chat, which is
  // where the two things that lead somewhere real now are.
  await expect(page.locator(`main a[href="/patient/${token}"]`)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Back to connections/i })).toBeVisible();
  // One "Chat with Sweetie", as the primary: the secondary copy of it belongs to the column that has a
  // summary to make it second to.
  await expect(page.getByRole("button", { name: /Chat with Sweetie instead/i })).toHaveCount(0);
  const chat = page.getByRole("button", { name: "Chat with Sweetie", exact: true });
  await expect(chat).toBeVisible();

  // §6.4, §12.5: the third state of this step is scanned like the other two.
  await expectNoSeriousA11yViolations(page, "patient setup complete, a connection with no glucose");
  await shot(page, "connect-done-no-glucose", WHOLE_PAGE);

  // The half of the ticket a string cannot show: following the primary action does not land the patient on
  // the empty summary. It goes to Sweetie, and the summary's own empty state is somebody else's test.
  await chat.click();
  await expect(page).toHaveURL(new RegExp(`/s/${token}$`), LOADED);
  await expect(page.locator(".sweetie-messages")).toContainText(/Hi E2E/, LOADED);
});

/**
 * The connect step before anything is uploaded, where every word is written against a file that does not
 * exist yet (T132, design §2.5).
 *
 * T100 → T114 → T116 → T123 took one rule off the patient path a screen at a time: the span comes from the
 * data, not from the brand. This step was the last place that still broke it in the state it is always in
 * on arrival — the heading read "Bring the last 7 days into focus", the Dexcom card promised "your last 7
 * days of glucose" and the WHOOP card "the past week", all three about files whose range the patient picks.
 * Clarity exports whatever window they choose and `lib/whoop.ts` clips nothing.
 *
 * Scoped to the three strings rather than swept over the frame, which is the opposite of what the
 * setup-complete assertion above does, and deliberately: step 2 has no other use for the word, so there a
 * negative over `main` is the right scope. Here the art column beside the panel carries "Your week, / in
 * one picture." — brand copy of the same shape as the landing page's, which T132 put out of scope rather
 * than settle in passing, so a frame-wide negative here would be asserting a decision nobody has made.
 * The three strings the ticket is about are named one by one instead, each by a selector that is not a
 * hashed CSS module class.
 *
 * Both projects, so the §12.3 evidence is the step at 1280px and at 375px.
 */
test("the connect step names no span before anything is shared", async ({ page }) => {
  const { token, email } = await book(page, "E2E Connect Span");
  await verifyLink(page, token, email);
  await page.goto(`/s/${token}/intake`);
  await page.getByRole("button", { name: /Let's get started/i }).click();

  // The cards are rendered off `dexcomStatus`, so the step is not settled until they are in: asserting on
  // the heading alone could pass against a panel still reading "Checking data connections…".
  const dexcomCard = page.locator('[data-source-description="dexcom"]');
  const whoopCard = page.locator('[data-source-description="whoop"]');
  await expect(dexcomCard).toBeVisible(LOADED);
  await expect(whoopCard).toBeVisible();
  // Nothing has been uploaded yet, which is the state the three strings are wrong in. Asserted rather than
  // assumed, so this test cannot quietly become one about the post-upload copy.
  await expect(page.getByText(/records securely added/i)).toHaveCount(0);

  // The same noun pattern the unit sweeps use (lib/dexcomHint.test.ts): an article or a tense is what a
  // reword changes, so the noun is what gets pinned — "a week", "the past week", "7 days" all fail.
  const SPAN = /\b(hours?|days?|weeks?|months?)\b/i;

  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText("Bring your data into focus.");
  expect(await heading.textContent(), "the connect step's heading").not.toMatch(SPAN);

  // The Dexcom card, in the state a deployment with no credentials is permanently in — which is the one
  // the check script itself runs in, so this is the sentence every run of the suite puts on screen.
  await expect(dexcomCard).toHaveText("Glucose trends, time in range, and recent highs");
  expect(await dexcomCard.textContent(), "the Dexcom card's description").not.toMatch(SPAN);

  await expect(whoopCard).toHaveText("Sleep, recovery, and strain");
  expect(await whoopCard.textContent(), "the WHOOP card's description").not.toMatch(SPAN);

  // The sentence under the Dexcom card is lib/dexcomHint.ts's, and the states it has are swept there. What
  // this adds is that the string really does reach the patient's screen: the unit test holds the function,
  // this holds the wiring, and the defect was in the words either way.
  await expect(page.getByText("Upload your Clarity CSV export to share your glucose readings.")).toBeVisible();

  // No axe pass here: this exact step is already scanned, in the state this test leaves it in, by
  // e2e/a11y.spec.ts's "the intake page passes axe and labels every file picker" (§12.5). A second scan of
  // one screen would cost every run time and tell the next reader nothing the first does not.
  await shot(page, "connect-step-no-span", WHOLE_PAGE);
});
