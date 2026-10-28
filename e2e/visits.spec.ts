import { expect, test, type Page } from "@playwright/test";
import { cannotSendYet } from "../lib/delivery";
import { DEMO_ONLY_TEST_ADDRESSES } from "../lib/demo";
import { channelNeeds } from "../lib/visitIntake";
import { SENDABLE_PORT } from "../playwright.config";
import { expectNoFocusRing, expectVisibleFocusRing } from "./a11y";
import { postJson } from "./api";
import { freshEmail, signInAs, signInAsDemo, signOutOfBrowser } from "./auth";
import { LOADED } from "./budget";
import { MODAL, SCREENFUL, shot, type ShotOptions } from "./shot";

// T07 (design §2.2, §4.4, §8.3): the two ways a practice creates visits, driven through the screens staff
// actually use. One at a time in the wizard, with the contact channel and the recorded consent §2.2 asks for;
// a day at a time from a CSV, previewed row by row before anything is written. Then the dashboard, which has
// to show the visit's own §4.4 status and what each channel did with the invite (§8.3).
//
// Nothing here stubs a session: each identity signs in by its own magic link (§5.1, e2e/auth.ts). Every
// state-changing API call goes through postJson, which echoes the CSRF cookie the way the pages do (§10.8).

/**
 * The window the §2.2 import dialog is photographed at: a maximised browser on a 1280 x 1024 desk monitor.
 *
 * The dialog is `max-height: 88svh` (app/globals.css), so how much of it one frame holds is a property of
 * the window and not of the dialog: 720px of desktop project leaves 160px of it behind an edge whatever the
 * shot is anchored on, and what went missing was the two refused rows the test above asserts on (T107).
 * e2e/shot.ts grows the window for the shot and hands it straight back.
 */
const IMPORT_WINDOW = 1000;

/**
 * No card in either of §2.2's radio groups is wearing `:hover` in the frame that was just taken (T167).
 *
 * The wizard's two radio groups hide their input inside the styled card, so everything the group says about
 * which channel is chosen it says with the card's own border: `.visit-type-card-selected` is the cream fill,
 * the gold border and the ticked radio, and `:hover` is that same gold border a shade lighter
 * (app/globals.css). T166 added the third thing a card can paint, a focus ring, and asserted that only the
 * focused card paints one; this is the same claim about the hover. A frame of a radio group shows one card
 * looking chosen, and the one it shows is the one the front desk picked.
 *
 * It is asserted after the shot rather than before it, because the shutter is what moves the pointer off the
 * page (e2e/shot.ts) and the frame is what the claim is about. `mobile-provider-add-visit-step3-scroll-bottom.png`
 * failed it: the wheel below parks the pointer in the middle of the step to make its gesture, and the scroll
 * then slid "Do not message" under it.
 */
async function expectNoCardHovered(page: Page, where: string): Promise<void> {
  await expect(
    page.locator(".visit-type-card:hover"),
    `${where}: a card is wearing :hover in the frame, so the group shows two cards looking chosen (T167, §2.2)`,
  ).toHaveCount(0);
}

/**
 * Step 3 of the booking wizard, framed on the forecast rather than on wherever the last click left it (T151).
 *
 * `MODAL` is one viewport, which at 375px is less than this step: the dialog is `max-height: 94svh` with its
 * rows sized to their content (app/globals.css), so about 300px of it is behind the bottom edge and what the
 * frame held was decided by the browser scrolling the last-clicked radio into view. The three demo frames
 * disagreed with each other because the three cases click different radios — `-demo-real` and `-demo-reserved`
 * caught the note and lost the button, `-demo-mixed` lost both — and a reviewer cannot tell a reframing from a
 * regression in a picture that moves on its own (docs/ROUTINES.md, "What is in a screenshot").
 *
 * The forecast §13.4 is a rule about has two halves, the consent note and the button's label, and the frame
 * has to hold both from any starting scroll. `wholeRows` refuses one that cuts either, which is the check
 * the three frames failed.
 *
 * **The anchor is the note, since T155 made the dialog scroll.** It was the actions row, which was the lower
 * of the two halves and so brought the note with it. That worked only because the dialog did not scroll: the
 * row's `position: sticky; bottom: 0` had no scrolling ancestor to resolve against, so it sat in the flow and
 * `scrollIntoView({ block: "end" })` could move it. Now that `.patient-wizard-content` is the scroller the
 * declaration does what it was written for — **Add patient** is in the frame at every scroll position — and
 * an anchor on it is a no-op: `scrollIntoView` finds it already flush against the bottom edge and scrolls
 * nothing, which handed the frame straight back to whichever radio was clicked last. So the anchor is the
 * half that still moves. `block: "center"` rather than `"end"`, because the sticky row floats over the bottom
 * of the scrollport: a note ended against that edge is a note behind the button.
 *
 * It still costs the step's title, which no 375px frame can hold at the same time as the button: the two are
 * 648px apart in a dialog with 627px to show them in. What T155 adds is that a person can now scroll to it —
 * `expectStepThreeScrolls` above is that, and its own pair of frames is the step's top and its bottom.
 *
 * The desktop frames are unmoved either way: that dialog shows the whole step, so centring the note in it
 * lands where ending the frame on the button did.
 */
const STEP_3: ShotOptions = {
  ...MODAL,
  scrollTo: ".patient-consent-note",
  block: "center",
  wholeRows: ".patient-consent-note, .patient-wizard-actions",
};

/**
 * And the card one press later, anchored for the same reason rather than for the same gap (T151).
 *
 * This step is short enough that one phone frame holds all of it — the heading, the sentence, §8.1's link and
 * the button — so nothing was going missing. What was not settled is *where*: the dialog keeps the scroll
 * position step 3 left it at, clamped to this shorter step, so the frame began mid-word in the hero panel at
 * whatever height the last interaction happened to leave. Anchoring the card itself makes the frame the
 * card's own, from any starting scroll, and leaves the desktop frames alone the way the anchor above does.
 *
 * T177 `.patient-link-card` is not on every card any more — it is withdrawn where handing the link over is
 * not a way in — so the pair in `wholeRows` is read as "whichever of these the card has is whole", which is
 * what `expectWholeRows` already does with a group selector. The card is shorter without it, so the frame
 * holds it either way.
 */
const SUCCESS_CARD: ShotOptions = {
  ...MODAL,
  scrollTo: ".patient-wizard-success",
  block: "end",
  wholeRows: ".patient-link-card, .patient-wizard-success .ss-title",
};

/**
 * Step 3 scrolls under a finger, from its title to its button and back (T155, design §6.5, §2.2).
 *
 * The bug this pins is layout, which is why it is here and not in `lib/`. `.patient-wizard` is a grid, and
 * at 375px `grid-template-columns: 1fr` left its two children in *implicit* rows — and an implicit row is
 * an `auto` track, sized to its own content rather than to what is left of the dialog. So the grid grew
 * past its own `max-height: 94svh` and `overflow: hidden` cut about 300px off: the step's title above the
 * top edge, the **Add patient** row below the bottom one. Meanwhile `.patient-wizard-content`'s
 * `overflow-y: auto` had been handed exactly its content's height and so had nothing to scroll, and
 * `.patient-wizard-actions`' `position: sticky` had no scrolling ancestor to resolve against and did
 * nothing at all. On the step where §2.2 asks staff to confirm the patient, the channel and the consent,
 * most of what they were confirming was behind an edge.
 *
 * Two measurements, because either one alone passes on the broken tree:
 *
 * - **The dialog itself must not be the over-full box.** It is the one with `overflow: hidden`, so what is
 *   past its edge is cut rather than scrolled and no gesture brings it back. 281 to 308 pixels were.
 * - **The gesture is a wheel, not `scrollIntoView`.** `overflow: hidden` keeps a box programmatically and
 *   focus scrollable while refusing touch and wheel, so a programmatic scroll is exactly what a test must
 *   not use here: it moved the broken dialog too, which is how the suite's own anchored frames kept working
 *   while a finger could not reach the button.
 *
 * And the sticky row is asserted where it was written to matter: **Add patient** is in the frame at the top
 * of the scroll as well as at the end of it, so the fields can go past it rather than taking it with them.
 *
 * The wheel and the room are the phone's, because 375px is where §6.5 is and where the step is taller than
 * the dialog by design. **The first measurement is both widths' (T159).** The desktop dialog is two columns
 * in one row, and that row was implicit and `auto` the same way — measured at 1280 x 720 on this step with
 * that rule put back, `.patient-wizard`'s `scrollHeight - clientHeight` is 25 on the step as it stands, so
 * the dialog clipped the last of `.patient-wizard-content`'s own 28px of bottom padding. No content was
 * behind that edge and nothing on screen moved, which is why nobody saw it for as long as the step happened
 * to fit; the phone bug was this one after 300px of growth. T155 was explicit that the desktop layout stayed
 * as it was, so it was reported on the issue and this helper asserted nothing at that width. Now the base
 * rule names its row and the helper holds both widths to the same thing: the box with `overflow: hidden` is
 * not the over-full one.
 *
 * At desktop the helper also sweeps the consent note through one, two and three lines, because the note's
 * height is content the product writes — it wraps on a long practice name — and §2.2's list of things to
 * confirm is not finished growing. A dialog that is 0 only at the height the seed happens to produce is the
 * bug waiting for the next sentence. The sweep writes into the note's text node and puts the original back,
 * so React's next render has nothing to undo and the frame below is the real step's.
 */
async function expectStepThreeScrolls(page: Page, name: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Add a booked patient" });
  const content = dialog.locator(".patient-wizard-content");
  const actions = dialog.locator(".patient-wizard-actions");
  const title = dialog.locator(".patient-wizard-step .ss-title");
  const frame: ShotOptions = { ...MODAL, wholeRows: ".patient-wizard-actions" };

  // The top of the step, which is where the title and the patient card are.
  const room = await content.evaluate((element) => {
    element.scrollTop = 0;
    return element.scrollHeight - element.clientHeight;
  });
  await expect(title, "the step's own title, at the top of its scroll").toBeInViewport(LOADED);
  await expect(actions, "the save row is on screen before anything has been scrolled").toBeInViewport(LOADED);
  await shot(page, `${name}-scroll-top`, frame);
  await expectNoCardHovered(page, `${name}-scroll-top`);
  // T158 And the row that is on screen is flush with the dialog, not floating inside it.
  await expectActionsReachScrollportEdges(page, "at the top of the scroll");

  const clipped = await dialog.evaluate((element) => element.scrollHeight - element.clientHeight);
  expect(
    clipped,
    "`.patient-wizard` is the box with overflow: hidden, so whatever is past its edge is cut and no gesture reaches it (T155, T159)",
  ).toBe(0);

  if (test.info().project.name !== "mobile") {
    // The desktop dialog holds the whole step in one 38% / 62% row, so there is nothing here for a finger
    // to move and the frame above is already the bottom of it. The pair is still taken at this width,
    // because §12.3 asks for the step at both and "unchanged" is a claim a picture can carry.
    await expectDialogBoundsLongerNotes(page);
    await shot(page, `${name}-scroll-bottom`, frame);
    await expectNoCardHovered(page, `${name}-scroll-bottom`);
    return;
  }

  expect(
    room,
    "the 375px step is taller than the dialog by its own design, so its content row has to be the scroller (T155)",
  ).toBeGreaterThan(0);

  // A wheel over the dialog: the gesture `overflow: hidden` refuses, and the one a person has.
  const box = await content.boundingBox();
  expect(box, "the step is on screen to be scrolled").toBeTruthy();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, room + 200);
  await expect
    .poll(async () => content.evaluate((element) => element.scrollTop), LOADED)
    .toBeGreaterThanOrEqual(room - 1);
  await expect(actions, "and still on screen at the end of the scroll").toBeInViewport(LOADED);
  await expectActionsReachScrollportEdges(page, "at the end of the scroll");
  await shot(page, `${name}-scroll-bottom`, frame);
  // The frame this ticket was filed against: the wheel above parked the pointer in the middle of the step,
  // and the scroll slid "Do not message" under it (T167).
  await expectNoCardHovered(page, `${name}-scroll-bottom`);

  // And back: the title the frame above cannot hold is a wheel away, which is the half of the §2.2 review
  // a person had no way to return to. The pointer goes back over the step first, because the shot above
  // left it off the page and a wheel is a gesture made wherever the pointer is (T167, e2e/shot.ts).
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -(room + 200));
  await expect
    .poll(async () => content.evaluate((element) => element.scrollTop), LOADED)
    .toBeLessThanOrEqual(1);
  await expect(title, "a wheel back up returns the step's title, which is half of what §2.2 asks staff to confirm").toBeInViewport(LOADED);
}

/**
 * And the desktop dialog stays bounded as the consent note wraps (T159, design §2.2).
 *
 * What was behind the edge grew with the note: 11, 25 and 38 pixels at one, two and three lines, measured at
 * 1280 x 720 with the old implicit row put back. So the number that matters is not one reading but the shape
 * of the box: with its row named `minmax(0, 1fr)` the dialog cannot be the over-full one at any note height,
 * and `.patient-wizard-content`'s `overflow-y: auto` takes the growth instead — 8, 22 and 35 pixels of its
 * own bottom padding, the same division of labour as at 375px and nothing of the step itself.
 *
 * Grown by writing text into the note and measuring, rather than by a fixture with a long practice name: the
 * line count is what the assertion is about, and a sentence that wraps to three lines in this font at this
 * width is a measurement, not a constant to guess. The original text goes back before the function returns,
 * inside the same evaluate, so nothing downstream sees the substitute.
 */
async function expectDialogBoundsLongerNotes(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Add a booked patient" });

  const readings = await dialog.evaluate((element) => {
    const note = element.querySelector(".patient-consent-note") as HTMLElement | null;
    if (!note) return null;
    const original = note.textContent ?? "";
    const lineHeight = Number.parseFloat(getComputedStyle(note).lineHeight);
    const lines = () => Math.round(note.getBoundingClientRect().height / lineHeight);
    const out: { lines: number; clipped: number; room: number }[] = [];
    const content = element.querySelector(".patient-wizard-content") as HTMLElement;

    let text = "The secure link goes to a number.";
    note.textContent = text;
    for (const target of [1, 2, 3]) {
      // One short word at a time, so the note cannot cross two line breaks in one step and skip a count;
      // bounded, so a note that somehow refuses to wrap fails the line assertion below rather than spinning.
      for (let guard = 0; guard < 600 && lines() < target; guard += 1) {
        text += " consent";
        note.textContent = text;
      }
      out.push({
        lines: lines(),
        clipped: element.scrollHeight - element.clientHeight,
        room: content.scrollHeight - content.clientHeight,
      });
    }

    note.textContent = original;
    return out;
  });

  expect(readings, "step 3 carries the §2.2 consent note the sweep grows").toBeTruthy();
  for (const [index, reading] of readings!.entries()) {
    expect(reading.lines, `the note was grown to ${index + 1} line(s)`).toBe(index + 1);
    expect(
      reading.clipped,
      `with the consent note at ${reading.lines} line(s) the dialog is not the over-full box (T159), and its content row has ${reading.room}px to scroll`,
    ).toBe(0);
  }
}

/**
 * And the sticky row reaches the dialog's edges, rather than floating inside them (T158, design §6.5, §2.2).
 *
 * `position: sticky; bottom: 0` resolves against the scroll container's **content** box, so the row T155
 * made stick came to rest `.patient-wizard-content`'s `padding-bottom` above the bottom of the scrollport
 * and inset by its `padding-inline` at each side — 20px and 22px at this width. Nothing was unreachable,
 * which is why T155's own assertions passed over it; what the step looked like was a white bar with the
 * form running past it on three sides, on the one screen §2.2 asks staff to read carefully.
 *
 * Measured against the scrollport's padding box rather than against the viewport, because that is the box
 * `bottom` resolves against and the box the gaps were in. A pixel of slack for sub-pixel layout; the bug
 * this pins was twenty.
 *
 * Phone only: the desktop dialog does not scroll, so the row is in the flow there and T155 left it alone.
 */
async function expectActionsReachScrollportEdges(page: Page, where: string): Promise<void> {
  if (test.info().project.name !== "mobile") return;

  const dialog = page.getByRole("dialog", { name: "Add a booked patient" });
  const content = dialog.locator(".patient-wizard-content");
  const actions = dialog.locator(".patient-wizard-actions");

  const gaps = await content.evaluate((element, selector) => {
    const row = element.querySelector(selector) as HTMLElement;
    const style = getComputedStyle(element);
    const port = element.getBoundingClientRect();
    const bar = row.getBoundingClientRect();
    return {
      left: bar.left - (port.left + parseFloat(style.borderLeftWidth)),
      right: port.right - parseFloat(style.borderRightWidth) - bar.right,
      bottom: port.bottom - parseFloat(style.borderBottomWidth) - bar.bottom,
    };
  }, ".patient-wizard-actions");

  await expect(actions, "the row is the thing being measured").toBeVisible();
  expect(gaps.left, `no gap to the left of the save row (${where})`).toBeLessThanOrEqual(1);
  expect(gaps.right, `no gap to the right of the save row (${where})`).toBeLessThanOrEqual(1);
  expect(gaps.bottom, `no gap under the save row (${where})`).toBeLessThanOrEqual(1);
  expect(gaps.left, `the save row is not pushed past the left edge (${where})`).toBeGreaterThanOrEqual(-1);
  expect(gaps.right, `the save row is not pushed past the right edge (${where})`).toBeGreaterThanOrEqual(-1);
  expect(gaps.bottom, `the save row is not pushed past the bottom edge (${where})`).toBeGreaterThanOrEqual(-1);
}

/** A name nothing else in the run will use: two Playwright projects share one database. */
const uniqueName = (prefix: string) => `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/**
 * The wizard's submit button, whichever of its two labels it is carrying (T140).
 *
 * It reads **Add patient & send →** where the invite really is going out and **Add patient →** where it is
 * not, because the screen may not offer to send what the note under the radios has just said will not be
 * sent. Matched by the half that does not move, anchored so the dashboard's own **Add a patient** and the
 * button's "Adding patient…" busy label are not it.
 */
const SAVE = /^Add patient/;

/** Anything on step 3 that reads as the invite going out: the lede's verb, and a button offering to send.
 *  The card after the button has its own pattern a few tests down — this is the tense before it. */
const PROMISES_SEND = /\bsends\b|& send/i;

/**
 * A number nothing else in the run will use either — which matters more here than the name does. §2.2 matches
 * an existing patient on phone or email, so a fixed number means the second project to run joins the first
 * project's patient and sees that patient's name on the row. Which is the feature working, and a confusing
 * way to find that out.
 */
const uniquePhone = () => `+1415555${String(Math.floor(Math.random() * 9000) + 1000)}`;

/**
 * The same, from the NANP's fictitious 555-0100 to 555-0199 range (T145).
 *
 * Every test in this file books into the seeded practice, which `npm run seed` marks a demo one (§13.4), and
 * since T145 that means the destination decides whether an invite may go out at all: `uniquePhone` above is
 * outside the reserved range, so it is a number §13.4 refuses. A test about anything *else* on step 3 needs
 * a number the rule lets through, or it is quietly a test about the rule.
 *
 * The *area code* is where the uniqueness comes from, which `uniquePhone` gets from the subscriber digits:
 * the reserved range is only 555-0100 to 555-0199, so one area code holds a hundred numbers, and §2.2
 * matches an existing patient on phone. A caller that presses the button therefore has about a one-in-a-
 * hundred chance of joining another patient per draw — against the seeded `+14155550100`, against
 * e2e/audit.spec.ts's `+14155550199`, and against the other project running the same test — which is a
 * flake rather than a feature. Four area codes are left to the specs that pin them: 415 to the seed and to
 * e2e/audit.spec.ts, 650 to e2e/demo.spec.ts, 206 to e2e/verify.spec.ts, 312 to e2e/invite.spec.ts (T150).
 * Nothing validates an area code
 * beyond its shape (`normalizePhone`, lib/visitIntake.ts), and `isSyntheticPhone` asks only for `[2-9]` and
 * two digits in front of the reserved block (lib/demo.ts).
 */
const PINNED_AREA_CODES = new Set(["415", "650", "206", "312"]);
const reservedPhone = () => {
  let area = "";
  do {
    area = `${Math.floor(Math.random() * 8) + 2}${String(Math.floor(Math.random() * 100)).padStart(2, "0")}`;
  } while (PINNED_AREA_CODES.has(area));
  return `+1${area}55501${String(Math.floor(Math.random() * 100)).padStart(2, "0")}`;
};

test("staff add a visit in the wizard, with a channel and a recorded consent", async ({ page }) => {
  await signInAsDemo(page);
  await expect(page.locator("body")).toContainText("Sam Sample", LOADED);

  const name = uniqueName("Wizard Patient");
  await page.getByRole("button", { name: /Add patient/i }).first().click();

  // Step 1: who the visit is for.
  await page.getByLabel("Patient name").fill(name);
  // A number §13.4 lets through, because this test is about the step's other two answers and not about the
  // rule: it signs in to the seeded demo practice, so `uniquePhone()` here would close the text channel and
  // leave the booking an email one — which is what the assertions below would then be about. T145 moved the
  // sibling test on SENDABLE_PORT for the same reason; this one read correctly until `bookingPlan` began
  // asking the deployment about the channel §13.4 leaves open rather than the one staff picked, which is
  // exactly the narrowing that makes the distinction visible. The address is under `example.com`, reserved too.
  await page.getByLabel("Mobile number").fill(reservedPhone());
  await page.getByLabel("Email", { exact: true }).fill(`${name.replace(/\s+/g, ".").toLowerCase()}@example.com`);
  await page.getByRole("button", { name: /Continue/i }).click();

  // Step 2: the visit itself.
  await page.getByText("Medication check", { exact: true }).click();
  await page.getByLabel(/What did the patient call about/i).fill("new dose, feels shaky");
  await page.getByRole("button", { name: /Continue/i }).click();

  // Step 3 is §2.2's channel and consent. Saving without the consent is refused by the route, which is worth
  // asserting here rather than only in lib/visitIntake.test.ts: the sentence has to reach the screen.
  await expect(page.getByText("Contact channel")).toBeVisible();

  // T140 (§2.2, §8.1) What the step says about the invite *before* the button, which is the screen the
  // channel is chosen on and the last one in this family that promised a send it could not make. This gate
  // configures no sender at all (§11.3) and the wizard's default channel is "Text and email", so the honest
  // note is the line that names neither of the two (lib/delivery.ts, via `inviteSendability`) — and the lede
  // and the button have to agree with it, because the bug was one literal above another.
  const step3 = page.getByRole("dialog", { name: "Add a booked patient" });
  await expect(step3.locator(".ss-lede")).toHaveText(
    "Saving creates the patient and their private Sweetie link, which you hand over yourself.",
  );
  await expect(step3.locator(".patient-consent-note").first()).toHaveText(
    `No invite will be sent: ${cannotSendYet("both")}. Save this patient and copy the link from the dashboard and hand it over yourself.`,
  );
  await expect(step3.locator(".patient-consent-note").first()).toHaveClass(/patient-consent-note-blocked/);
  await expect(step3.getByRole("button", { name: SAVE })).toHaveText("Add patient \u2192");
  // The whole step, because the next literal would be somewhere else on it.
  expect(await step3.innerText(), "nothing on the step offers a send this office cannot make").not.toMatch(PROMISES_SEND);

  // T155 (§6.5, §2.2) And a person on a phone can reach all of it, which the anchored frame below cannot
  // say: it is one viewport of a step that is taller than one, so it chooses. This is the scroll that makes
  // the rest of the step reachable, and the two frames it leaves are the step's top and its bottom.
  await expectStepThreeScrolls(page, "provider-add-visit-step3");

  await shot(page, "provider-add-visit-consent", STEP_3);

  // And "Do not message" is still the practice's own choice rather than a gap in the deployment (T120): the
  // sentence it has always carried, word for word, and unmarked.
  await step3.getByText("Do not message", { exact: true }).click();
  const chosen = step3.locator(".patient-consent-note").first();
  await expect(chosen).toHaveText(
    "Nothing is sent. Copy the link from the dashboard and hand it over yourself; opening it still sends them a code.",
  );
  await expect(chosen).not.toHaveClass(/patient-consent-note-blocked/);
  await step3.getByText("Text and email", { exact: true }).click();
  await page.getByRole("button", { name: SAVE }).click();
  await expect(page.locator(".ss-error")).toContainText(/consent/i, LOADED);

  await page.getByLabel(/How did the patient agree to be contacted/i).selectOption("phone");
  await page.getByRole("button", { name: SAVE }).click();

  // T111 This visit is booked on both channels and this environment can send on neither, so the claim names
  // neither: the line for a visit whose chosen channels have no backend between them (lib/delivery.ts). The
  // journey spec pins the one-channel wording; this pins "both", which is the wizard's default and so the
  // case most bookings land in.
  //
  // T122 And the heading above it, which was a literal promise of motion until this ticket: the whole card
  // is read back here, because the sentence was already honest and the line in the largest type was not.
  const card = page.locator(".patient-wizard-success");
  const claim = card.locator(".ss-lede");
  await expect(claim).toContainText(/No invite sent: Sweet Spot cannot send this message yet/i, LOADED);
  await expect(claim).not.toContainText(/on its way/i);
  await expect(card.locator(".ss-title")).toHaveText(`${name} is ready for Sweetie.`);
  expect(await card.innerText(), "nothing on an unsent card claims the invite is going anywhere").not.toMatch(
    /on (?:the|its) way/i,
  );
  await expect(page.locator(".patient-link-card"), "§8.1's fallback, on the screen that just refused").toContainText("/s/");
  await shot(page, "provider-add-visit-unsent", SUCCESS_CARD);
  await page.getByRole("button", { name: /Back to dashboard/i }).click();

  // The row carries §4.4's status, the chosen channels and the consent behind them.
  const row = page.locator(".provider-table tbody tr", { hasText: name });
  await expect(row).toContainText("Invited", LOADED);
  // §2.2's date and time is part of a visit but not a condition of booking one: this wizard run left it
  // blank, and the schedule column says so rather than inventing a day. e2e/journey.spec.ts books the dated
  // visit (T67); this is the row that keeps the undated one covered.
  await expect(row.locator(".provider-cell-main"), "no date typed, so none shown").toHaveText("Date pending");
  await expect(row).toContainText("Consent: Over the phone");
  await expect(row.locator(".provider-invite")).toContainText("Text");
  await expect(row.locator(".provider-invite")).toContainText("Email");

  // §8.3, through the job: both channels report back, whatever they managed. Which status each lands on is
  // the environment's business — a run with AWS credentials in its environment tries SES and SNS and fails,
  // a run without one never had a backend to try — so what is asserted is that the result was recorded per
  // channel. Polled, because the send is a queued job drained after the response (§3.4).
  await expect
    .poll(
      async () => {
        const data = (await (await page.request.get("/api/provider")).json()) as { visits: { name: string; deliveries: { channel: string; kind: string; status: string }[] }[] };
        const visit = data.visits.find((v) => v.name === name);
        return (visit?.deliveries ?? [])
          .filter((d) => d.kind === "notify.invite" && ["sent", "failed", "skipped"].includes(d.status))
          .map((d) => d.channel)
          .sort();
      },
      LOADED,
    )
    .toEqual(["email", "sms"]);

  // Consent is recorded against the person who took it (§2.2), which is the signed-in user and not a payload.
  const rows = (await (await page.request.get("/api/provider")).json()) as {
    id: string;
    visits: { name: string; status: string; channel: string; consentChannel: string; consentRecordedBy: string; consentRecordedAt: string }[];
  };
  const created = rows.visits.find((v) => v.name === name);
  expect(created).toBeTruthy();
  expect(created!.channel).toBe("both");
  expect(created!.consentChannel).toBe("phone");
  expect(created!.consentRecordedBy).toBe(rows.id);
  expect(created!.consentRecordedAt).toBeTruthy();
  expect(created!.status).toBe("invited");

  // Reloaded so the Invite column shows what the job reported rather than the "queued" the page was painted
  // with: the dashboard reads GET /api/provider once, and the send finished after that.
  await page.reload();
  await expect(row).toContainText("Consent: Over the phone", LOADED);
// The cell this test asserts on, not just the row: the table is wider than a phone, so Stage,
  // Messages and Actions are off to the right until the shot asks for them (T57, T81).
  await shot(page, "provider-dashboard-visit-statuses", {
    ...SCREENFUL,
    scrollTo: row.locator(".provider-invite"),
    block: "center",
    inline: "center",
  });
});

// T168 (design §2.2, §2.3, §5.3, §8.1) The other side of step 3, and the surface this ticket was filed
// about: the patient the front desk has no number and no address for. §2.2 still books that visit — the
// appointment is made today and the number arrives tomorrow — so what the step owes staff is the
// consequence and the way out of it, in a sentence that does not deny the code and promise it in one
// breath. The main wizard test above fills both fields, so until now no frame of this screen had the
// sentence on it at all.
//
// Nothing is saved: the subject is the line under the channel cards, and a booking here is one more row for
// every other spec's shots to grow around (the radio-card test below makes the same choice for the same
// reason). That the draft is creatable is `parseVisitDraft`'s, in lib/visitIntake.test.ts; what this pins is
// that the screen treats it as one — the save row is live beside the warning, and nothing is marked wrong.
test("a patient with nothing on file is still bookable, and the step says what that costs", async ({ page }) => {
  await signInAsDemo(page);
  await expect(page.locator("body")).toContainText("Sam Sample", LOADED);

  await page.getByRole("button", { name: /Add patient/i }).first().click();
  // Scoped to the dialog throughout: the dashboard is still behind it, and every visit type on step 2 is
  // also a `.provider-cell-sub` on some row of the table, so an unscoped "Follow-up" is five elements.
  const wizard = page.getByRole("dialog", { name: "Add a booked patient" });
  await wizard.getByLabel("Patient name").fill(uniqueName("No Contact"));
  // Mobile number and Email left empty on purpose: this is §2.2's gap, and neither field is required.
  await wizard.getByRole("button", { name: /Continue/i }).click();
  await wizard.getByText("Follow-up", { exact: true }).click();
  await wizard.getByRole("button", { name: /Continue/i }).click();

  const warning = wizard.locator(".patient-consent-warning");
  await expect(warning, "one sentence, from lib/visitIntake.ts, on both §2.2 surfaces").toHaveCount(1, LOADED);
  await expect(warning).toHaveText(
    "No phone or email on file, so the six-digit code their link needs has nowhere to go and the link will not open. " +
      "Add a phone number or an email address, or take the intake over the telephone.",
  );
  // The bug: a denial with a present-tense promise after the colon. Neither half may say the code is going
  // anywhere, here or anywhere else on the step.
  expect(await wizard.innerText(), "nothing on the step sends a code this patient cannot receive").not.toMatch(
    /sends? (?:them|you|the patient)/i,
  );
  expect(await wizard.innerText(), "nor any other send this office cannot make").not.toMatch(PROMISES_SEND);
  // It is a warning and not a refusal (§2.2): the visit is still bookable from this step.
  await expect(wizard.getByRole("button", { name: SAVE })).toBeEnabled();

  // Anchored on the warning rather than on the note above it (STEP_3's anchor): the sentence is what this
  // frame is evidence about, and on a phone the step is taller than the dialog's scrollport, so the two
  // differ by exactly the line in question.
  await shot(page, "provider-add-visit-no-contact", {
    ...MODAL,
    scrollTo: ".patient-consent-warning",
    block: "center",
    wholeRows: ".patient-consent-warning, .patient-wizard-actions",
  });

  // T170 The combination the assertions above leave out, and the one that was wrong: the step opens on
  // "Text and email", where the note is the destination's and not the handover's, so no frame of this
  // screen had ever carried the "Do not message" sentence beside the warning. Choose it and the two lines
  // are three apart — `bookingPlan`'s note then `warningsFor`'s warning — and the first used to promise the
  // code the second had just said there was nowhere to send.
  await wizard.getByText("Do not message", { exact: true }).click();
  const note = wizard.locator(".patient-consent-note").first();
  await expect(note).toHaveText("Nothing is sent, and handing the link over will not get this patient in either.");
  // Still the practice's own choice, so nothing on the step is marked as something to fix (T140's class).
  await expect(wizard.locator(".patient-consent-note-blocked")).toHaveCount(0);
  await expect(warning, "and the warning is still the one line that owns §2.2's gap").toHaveCount(1);
  // The whole step again, now that the sentence in question is on it: neither line may put the code in
  // motion, and nothing may offer a send this patient cannot be reached by.
  expect(await wizard.innerText(), "nothing on the step sends a code this patient cannot receive").not.toMatch(
    /sends? (?:them|you|the patient)/i,
  );
  expect(await wizard.innerText(), "nor any other send this office cannot make").not.toMatch(PROMISES_SEND);
  // §2.2 still books it: "Do not message" asks for no consent method, so the save row is live either way.
  await expect(wizard.getByRole("button", { name: SAVE })).toBeEnabled();

  // The pair in one frame, which is the evidence this ticket was filed for: the note, the warning under it
  // and the save row that proves the visit is still bookable.
  await shot(page, "provider-add-visit-no-contact-silent", {
    ...MODAL,
    scrollTo: ".patient-consent-warning",
    block: "center",
    wholeRows: ".patient-consent-note, .patient-consent-warning, .patient-wizard-actions",
  });
});

// T173 (design §2.2, §2.3, §5.3, §8.1) The combination the step *opens* on for that same patient, which no
// frame of this screen had ever carried: "Text and email" with both fields blank. The test above chooses
// away from it to reach the "Do not message" row, so the default went unread — and the default read the
// sending branch. The lede promised "sends their private Sweetie link", the button offered **Add patient &
// send →**, and the note rendered with a hole in it, "The secure link goes to — add a number or address on
// the first step.", three lines above a warning saying the link will not open.
//
// A practice of its own, because this one presses the button: the row it creates is this test's subject
// twice over — the card, and then the dashboard line that row had never carried — and a booking into the
// seeded practice would be one more row in every other spec's table.
//
// What this cannot show is the other half of the ticket, and it is worth saying where: the claim
// `inviteReach` used to make needs a deployment with a sender behind a channel, and this gate configures
// none (§11.3). With none, every surface takes its "cannot send" branch whatever the patient's details are.
// The configured arm is lib/booking.test.ts's and lib/notify.test.ts's, under `withEnv`.
test("a booking with nothing on file promises no send, and the row says the link will not open", async ({ page }) => {
  await signInAs(page, freshEmail("no-contact-admin"));
  const name = uniqueName("Nobody Reachable");

  await page.getByRole("button", { name: /Add patient/i }).first().click();
  const wizard = page.getByRole("dialog", { name: "Add a booked patient" });
  await wizard.getByLabel("Patient name").fill(name);
  // Mobile number and Email left blank, which is all §2.2 requires of step 1.
  await wizard.getByRole("button", { name: /Continue/i }).click();
  await wizard.getByText("Follow-up", { exact: true }).click();
  await wizard.getByRole("button", { name: /Continue/i }).click();

  // Step 3, untouched: still on its "Text and email" default, which is the state this ticket is about.
  const note = wizard.locator(".patient-consent-note").first();
  await expect(note, "the sentence with the hole in it is gone").toHaveText(
    "Nothing is sent, and handing the link over will not get this patient in either.",
    LOADED,
  );
  // T177 The lede over that note, which offered the handover the note withdraws — the two sentences this
  // ticket was filed for, one above the other in the frame T173 committed.
  await expect(wizard.locator(".ss-lede")).toHaveText("Saving creates the patient and their private Sweetie link.");
  await expect(wizard.getByRole("button", { name: SAVE })).toHaveText("Add patient \u2192");
  // Nothing about this is a gap in the deployment, so nothing on the step is marked as something to fix:
  // the two empty fields are the front desk's own and the warning's element is what marks them (T168).
  await expect(wizard.locator(".patient-consent-note-blocked")).toHaveCount(0);
  await expect(wizard.locator(".patient-consent-warning")).toHaveCount(1);
  const step = await wizard.innerText();
  expect(step, "nothing on the step offers a send").not.toMatch(PROMISES_SEND);
  expect(step, "nor a code this patient cannot receive").not.toMatch(/sends? (?:them|you|the patient)/i);
  expect(step, "nor a destination for a link that has none").not.toMatch(/goes to/);
  await shot(page, "provider-add-visit-no-contact-default", {
    ...MODAL,
    scrollTo: ".patient-consent-warning",
    block: "center",
    wholeRows: ".patient-consent-note, .patient-consent-warning, .patient-wizard-actions",
  });

  // T177 And the press on this default, which §2.2 now takes. It used to answer 400 with "A text message
  // needs a mobile number." over a step that had just said "Nothing is sent": the refusal was about a send
  // the step had already stopped promising, and the way through was **Do not message**, three cards up the
  // list, which nothing on the screen pointed at (T168). The channel narrows to nothing instead, which is
  // what the stored visit has always done (`invitableChannels`, `inviteReach`), so the step and the press
  // say one thing about one patient.
  await wizard.getByLabel(/How did the patient agree to be contacted/i).selectOption("phone");
  await wizard.getByRole("button", { name: SAVE }).click();

  const card = page.locator(".patient-wizard-success");
  await expect(card.locator(".ss-title")).toHaveText(`${name} is ready for Sweetie.`, LOADED);
  await expect(wizard.locator(".ss-error"), "the button the step offered is the button that worked").toHaveCount(0);
  // §8.1's fallback is the last clause of this lede for every other patient, and for this one it is not a
  // fallback: the link does not open without a code and there is nowhere to send one. The clause that
  // withdraws it is the note's, one press earlier (lib/delivery.ts), and the reason before it is §2.2's own
  // gap rather than the practice's choice, because this booking chose a channel and had nowhere to send on it.
  await expect(card.locator(".ss-lede")).toHaveText(
    "Patient added. No invite sent: no phone or email on file. Handing the link over will not get this patient in either.",
  );
  // T177 The two things on this screen that are not sentences out of lib/booking.ts, and that said the
  // opposite of the one above until this ticket: the panel beside the card — the largest type on the screen
  // — and §8.1's link, offered one paragraph under the clause withdrawing it.
  await expect(wizard.locator(".patient-wizard-side h2")).toHaveText("The visit is on file.");
  await expect(wizard.locator(".patient-link-card"), "the link is not a thing to hand over here").toHaveCount(0);
  const cardText = await card.innerText();
  expect(cardText, "nothing on the card claims the invite is going anywhere").not.toMatch(/on (?:the|its) way/i);
  expect(cardText, "nor offers the handover it has just withdrawn").not.toMatch(/Share the link below/);
  const dialogText = await wizard.innerText();
  expect(dialogText, "nor says Sweetie has a patient who cannot reach her").not.toMatch(/Sweetie can take it from here/);
  expect(dialogText, "nor shows the link itself as the thing to hand over").not.toMatch(/\/s\/[A-Za-z0-9_-]+/);
  await shot(page, "provider-add-visit-no-contact-card", SUCCESS_CARD);

  // The row, which is the surface staff are on once the creation screen is behind them — and the one that
  // said nothing at all. `codeUnreachable` was guarded by `onFile.length > 0`, so it excluded exactly this
  // patient: **Invited**, a live **Send link**, "No contact on file" beside the name, and no line saying
  // what any of that costs (app/api/provider/route.ts, T173).
  await card.getByRole("button", { name: "Back to dashboard" }).click();
  const row = page.locator(".provider-table tbody tr", { hasText: name });
  await expect(row, "the visit was created (§2.2)").toHaveCount(1, LOADED);
  await expect(row.locator(".provider-no-code")).toHaveText(
    "Nowhere to send their code, so their link will not open \u2014 add a phone number or an email address",
  );
  // The other line of the pair is not also on the row: one is about channels that closed and the other
  // about there being none to close, and the screen says one of them (lib/delivery.ts).
  await expect(row).not.toContainText("No code can reach this patient");

  // And the note under those buttons, which pointed at a Copy intake that hands over a locked door.
  await row.getByRole("button", { name: "Send link" }).click();
  const rowNote = row.locator(".provider-row-note");
  await expect(rowNote).toContainText("Handing the link over will not get this patient in either.", LOADED);
  await expect(rowNote).not.toContainText("Use Copy intake");
  await expect(rowNote, "and no claim of a send").not.toContainText(/Sending/i);
  await shot(page, "provider-dashboard-no-contact-row", {
    ...SCREENFUL,
    scrollTo: row.locator(".provider-invite"),
    block: "center",
    inline: "center",
  });
});

// T175 (design §2.2, §2.3, §5.3, §8.1) The other way to have nowhere to send a code, and the one this gate
// *can* stand in for: the patient has a detail on file and this deployment has no sender behind it.
//
// The test above is about two empty fields, which `channelsFor` sees. This is about one filled field on a
// channel nothing can carry, which `channelsFor` cannot see and `codeReach` always could — the dashboard row
// has read it since T121 and said so: "No code can reach this patient, so their link will not open — call
// them". What the row said on the next line, one press later, was "Use Copy intake to give them the link",
// and step 3 had offered the same handover before the button. One screen, two answers about whether the link
// opens.
//
// The SMS half is the arm with no configuration behind it, which is why it is the one photographed: this
// gate has no SMS backend (§11.3) and no mailbox for a text the way it has one for a code by email
// (`DEV_MAIL_DIR`, T05, T113) — so a patient with only a mobile number is unreachable here exactly as they
// would be in a deployment. The email half needs `DEV_MAIL_DIR` unset, which the gate cannot do while
// e2e/auth.ts reads sign-in links out of it; that arm is lib/booking.test.ts's and lib/notify.test.ts's,
// under `withEnv`.
//
// A practice of its own, like the test above and for the same two reasons: this one presses the button, and
// the row it creates is half the subject.
test("a booking this office cannot text offers neither the invite nor the handover", async ({ page }) => {
  await signInAs(page, freshEmail("no-sender-admin"));
  const name = uniqueName("Unreachable Patient");
  // From the reserved range so §13.4 is not what this measures — this practice is not a demo one, but a
  // reserved number keeps the one fact under test the deployment's missing sender (T145, lib/demo.ts).
  const phone = reservedPhone();

  await page.getByRole("button", { name: /Add patient/i }).first().click();
  const wizard = page.getByRole("dialog", { name: "Add a booked patient" });
  await wizard.getByLabel("Patient name").fill(name);
  await wizard.getByLabel("Mobile number").fill(phone);
  // Email left blank, which is the whole of the case: the one channel this patient has is the one this
  // office cannot serve, so there is no second destination for a code to arrive by.
  await wizard.getByRole("button", { name: /Continue/i }).click();
  await wizard.getByText("Follow-up", { exact: true }).click();
  await wizard.getByRole("button", { name: /Continue/i }).click();

  // Step 3, on the channel the patient has. The reason is the deployment's and is unchanged — somebody can
  // fix it, and the note is still marked as something to fix — and the clause after it is what this ticket
  // withdraws: §8.1's fallback is not a fallback for a link that will not open.
  await wizard.getByText("Text message", { exact: true }).click();
  const note = wizard.locator(".patient-consent-note").first();
  await expect(note).toHaveText(
    `No invite will be sent: ${cannotSendYet("sms")}. Handing the link over will not get this patient in either.`,
    LOADED,
  );
  await expect(note, "the deployment's gap is still somebody's to fix").toHaveClass(/patient-consent-note-blocked/);
  // T177 The lede above that note, which used to end on the handover the note withdraws: it keeps what
  // pressing the button really does and stops there (lib/booking.ts).
  await expect(wizard.locator(".ss-lede")).toHaveText("Saving creates the patient and their private Sweetie link.");
  await expect(wizard.getByRole("button", { name: SAVE })).toHaveText("Add patient \u2192");
  const step = await wizard.innerText();
  expect(step, "nothing on the step offers a send this office cannot make").not.toMatch(PROMISES_SEND);
  expect(step, "nor the handover it has just withdrawn").not.toMatch(/copy the link from the dashboard/i);
  expect(step, "nor a code that has nowhere to arrive").not.toMatch(/sends? (?:them|you|the patient)/i);
  await shot(page, "provider-add-visit-no-sender-for-code", STEP_3);

  // The press, and the card's own tense of the same sentence — out of the same answer, because POST /api/book
  // reads it off the row it has just written (`canHandOver`, lib/notify.ts).
  await wizard.getByLabel(/How did the patient agree to be contacted/i).selectOption("phone");
  await wizard.getByRole("button", { name: SAVE }).click();
  const card = page.locator(".patient-wizard-success");
  await expect(card.locator(".ss-title")).toHaveText(`${name} is ready for Sweetie.`, LOADED);
  await expect(card.locator(".ss-lede")).toHaveText(
    `Patient added. No invite sent: ${cannotSendYet("sms")}. Handing the link over will not get this patient in either.`,
  );
  const cardText = await card.innerText();
  expect(cardText, "nothing on the card claims the invite is going anywhere").not.toMatch(/on (?:the|its) way/i);
  expect(cardText, "nor offers the handover it has just withdrawn").not.toMatch(/Share the link below/);
  // T177 And the two things beside those sentences, which said the opposite of them: the panel is the
  // largest type on the screen and the link card is the object the lede has just withdrawn.
  await expect(wizard.locator(".patient-wizard-side h2")).toHaveText("The visit is on file.");
  await expect(wizard.locator(".patient-link-card")).toHaveCount(0);

  // And the row, which is where the two answers used to sit one line apart.
  await card.getByRole("button", { name: "Back to dashboard" }).click();
  const row = page.locator(".provider-table tbody tr", { hasText: name });
  await expect(row, "the visit was created (§2.2)").toHaveCount(1, LOADED);
  await expect(row.locator(".provider-no-code")).toHaveText(
    "No code can reach this patient, so their link will not open \u2014 call them",
  );
  // The sibling line is not also on the row: this patient has a detail on file, so the gap is not §2.2's and
  // "add a phone number or an email address" is not the remedy (lib/delivery.ts).
  await expect(row).not.toContainText("Nowhere to send their code");

  // Criterion 4: whichever line survives, the row says one thing about whether the link opens. The note
  // under those buttons used to point at a **Copy intake** that hands over a locked door.
  await row.getByRole("button", { name: "Send link" }).click();
  const rowNote = row.locator(".provider-row-note");
  await expect(rowNote).toContainText(`No invite sent: ${cannotSendYet("sms")}`, LOADED);
  await expect(rowNote).toContainText("Handing the link over will not get this patient in either.");
  await expect(rowNote, "the remedy this row cannot offer").not.toContainText("Use Copy intake");
  await expect(rowNote, "and no claim of a send").not.toContainText(/Sending/i);
  // Anchored on the note rather than on the row, and `end` rather than `center`, which is
  // `provider-row-invite-not-sent`'s framing and for its reason (T57, T81): the table is `min-width: 1120px`
  // inside a horizontal scroller, so at 375px the Actions column and this note are off to the right until
  // the shot asks for them. The two lines this ticket is about are in different columns, so no phone frame
  // holds both — and the one that changed is the note, so that is the one anchored. The desktop frame is
  // 1280 against a 1120px table and carries the pair.
  await shot(page, "provider-dashboard-no-sender-for-code-row", {
    ...SCREENFUL,
    scrollTo: rowNote,
    block: "center",
    inline: "end",
  });
});

// T176 (design §2.2, §8.1, §13.4) The combination one field short of the test above, and of T173's: the
// patient has a detail on file and staff picked the channel it is *not* on.
//
// `warningsFor` is silent here — it fires only when both fields are blank — so there was no line beside the
// three this step writes to contradict them, and all three were wrong: the lede promised "sends their
// private Sweetie link", the note rendered "The secure link goes to — add a number or address on the first
// step." (naming a step the front desk had already filled in), and the button read **Add patient & send →**.
//
// The two gaps are told apart on one screen a radio apart, which is the ordering this ticket fixes: *Email*
// with no address is the front desk's own missing field and names it; *Text message*, which this patient
// does have, is the deployment's missing sender and keeps T111's sentence and the mark that says somebody
// can fix it. Nothing is pressed — the subject is the three lines the step writes, and T177 is where the
// press on a channel with no destination is read — so this books into the seeded practice without adding a
// row to it.
test("a channel with no destination names the field it needs, not a send", async ({ page }) => {
  await signInAsDemo(page);
  await expect(page.locator("body")).toContainText("Sam Sample", LOADED);

  await page.getByRole("button", { name: /Add patient/i }).first().click();
  const wizard = page.getByRole("dialog", { name: "Add a booked patient" });
  await wizard.getByLabel("Patient name").fill(uniqueName("One Field Patient"));
  // From the reserved range, so §13.4 is not what this measures: the seeded practice is a demo one, and a
  // number outside that range would close the text channel for the demo rule rather than for the gap under
  // test (T145, lib/demo.ts). The email field is left blank, which is the whole of the case.
  await wizard.getByLabel("Mobile number").fill(reservedPhone());
  await wizard.getByRole("button", { name: /Continue/i }).click();
  await wizard.getByText("Follow-up", { exact: true }).click();
  await wizard.getByRole("button", { name: /Continue/i }).click();

  // The channel this patient has nothing on. The sentence is the one the press refuses with, from the module
  // that owns it (`channelNeeds`, lib/visitIntake.ts), and the clause after it is T175's: this gate has no
  // SMS sender either (§11.3), so the number on file cannot carry the six-digit code the link opens on.
  await wizard.getByText("Email", { exact: true }).click();
  const note = wizard.locator(".patient-consent-note").first();
  await expect(note).toHaveText(
    `${channelNeeds("email")} Handing the link over will not get this patient in either.`,
    LOADED,
  );
  // Not marked: the missing address is the front desk's own field and not a gap in the deployment, which is
  // what `.patient-consent-note-blocked` is for (T131, T140).
  await expect(note, "an empty field is nobody else's to fix").not.toHaveClass(/patient-consent-note-blocked/);
  // T177 This gate can carry no code to the number on file either, so the lede over the note stops offering
  // the handover the note's second sentence withdraws (lib/booking.ts).
  await expect(wizard.locator(".ss-lede")).toHaveText("Saving creates the patient and their private Sweetie link.");
  await expect(wizard.getByRole("button", { name: SAVE })).toHaveText("Add patient \u2192");

  // The whole step, because the next literal would be somewhere else on it: no promise of a send anywhere,
  // and no sentence naming a destination for a channel that has none (criteria 1 and 2).
  const step = await wizard.innerText();
  expect(step, "nothing on the step offers a send with nowhere to send it").not.toMatch(PROMISES_SEND);
  expect(step, "nor names a destination for a channel with none").not.toMatch(/goes to/i);
  expect(step, "nor the half-written sentence this ticket deletes").not.toMatch(/add a number or address on the first step/i);
  // And §2.2's warning is not on the step either, which is why these three lines had nothing to correct them.
  await expect(wizard.locator(".patient-consent-warning")).toHaveCount(0);
  await shot(page, "provider-add-visit-no-destination-for-channel", STEP_3);

  // One radio along, the gap the other sentence is for: this patient does have a number, so what is missing
  // is the sender behind it — the deployment's, marked as something somebody can fix. Two gaps, two
  // sentences, and the order between them is what this ticket settles.
  await wizard.getByText("Text message", { exact: true }).click();
  await expect(note).toHaveText(
    `No invite will be sent: ${cannotSendYet("sms")}. Handing the link over will not get this patient in either.`,
  );
  await expect(note, "a missing sender is somebody's to fix").toHaveClass(/patient-consent-note-blocked/);
});

// T166 (design §2.2, §6.4) Both of the wizard's radio groups hide their input inside the styled card, so
// until this ticket the only non-selected state either card had was `:hover` — which a keyboard never
// reaches. A person arrowing through "what kind of visit is this" saw the group stand still.
//
// Nothing is saved here: the subject is two steps of the dialog, and a booking would be another patient in
// the practice's table for every other spec's shots to grow around. The contrast reference is the dialog's
// own surface (`.ss-card`, white at 94% over a blurred backdrop), and the two frames are what §12.3 asks
// the ticket to leave behind.
test("the wizard's radio cards show a keyboard where it is", async ({ page }) => {
  await signInAsDemo(page);
  await expect(page.locator("body")).toContainText("Sam Sample", LOADED);
  await page.getByRole("button", { name: /Add patient/i }).first().click();

  const wizard = page.getByRole("dialog", { name: "Add a booked patient" });
  // Where each tab walk starts. The dialog is `aria-modal` and does not trap focus, so a walk from the top
  // of the document would cross the dashboard's whole visit list first (e2e/a11y.ts says the same).
  const insideDialog = wizard.locator(".patient-wizard-close");

  await wizard.getByLabel("Patient name").fill(uniqueName("Focus Ring Patient"));
  await wizard.getByLabel("Mobile number").fill(reservedPhone());
  await wizard.getByRole("button", { name: /Continue/i }).click();

  // Step 2, the visit type. Tab enters a radio group at the checked radio, which is the wizard's default
  // "Follow-up" — so this is also the composition §2.2's cards have to get right: the card keeps the gold
  // border and cream fill selection gives it and gains a ring outside both.
  const types = wizard.locator(".visit-type-card");
  await expect(types.first()).toHaveClass(/visit-type-card-selected/);
  await expectVisibleFocusRing(page, types.first(), {
    name: "the selected visit-type card",
    against: "#ffffff",
    from: insideDialog,
  });
  // And the card beside it paints nothing, so a frame of this step cannot be read as two selections.
  await expectNoFocusRing(types.nth(1), "an unfocused visit-type card");
  await shot(page, "provider-add-visit-type-focus", { ...MODAL, scrollTo: ".visit-type-grid", block: "center" });
  // T167: and no card in the frame is wearing `:hover` either, so the ring is the only thing distinguishing
  // the focused card from the selected one.
  await expectNoCardHovered(page, "provider-add-visit-type-focus");

  // Step 3 uses the same card for the contact channel, and got the same fix.
  await wizard.getByLabel(/What did the patient call about/i).fill("mornings running high");
  await wizard.getByRole("button", { name: /Continue/i }).click();
  await expect(wizard.getByText("Contact channel")).toBeVisible(LOADED);
  const channels = wizard.locator(".patient-channel-row .visit-type-card");
  await expectVisibleFocusRing(page, channels.first(), {
    name: "the selected contact-channel card",
    against: "#ffffff",
    from: insideDialog,
  });
  await expectNoFocusRing(channels.nth(1), "an unfocused contact-channel card");
  await shot(page, "provider-add-visit-channel-focus", {
    ...MODAL,
    scrollTo: ".patient-channel-row",
    block: "center",
  });
  await expectNoCardHovered(page, "provider-add-visit-channel-focus");
});

// T140 The other half of the step, on the seventh server in playwright.config.ts — the only one in the suite
// with a sender behind a channel (a registered SNS origination number, so `smsConfig()` resolves to a backend
// and not a reason).
//
// It needs a server of its own, which the success card's configured case a few tests down does not: that one
// rewrites POST /api/book's answer with `page.route`, and this answer never crosses the network. It is
// settled on the server from the environment and handed to the dashboard as a prop (app/provider/page.tsx),
// which is what the ticket asked for — no new route, no fetch — and what leaves a stub nothing to intercept.
//
// Email is left unconfigured on that server on purpose, so the one screen answers differently per channel:
// the office can text and cannot mail, which is the half-configured state most offices are in part way
// through setup and the one a per-channel answer exists for.
//
// The staff member signs in against the main server and walks over, like e2e/teamInvite.spec.ts: a cookie is
// not scoped to a port, both builds share AUTH_SECRET and the database, and nothing here presses the button
// — the step is the subject, and a booking on this server would be the suite's only outbound SNS call.
test("an office that can text is told so on the step, and still told what it cannot mail", async ({ page }) => {
  await signInAsDemo(page);
  await expect(page.locator("body")).toContainText("Sam Sample", LOADED);

  await page.goto(`http://localhost:${SENDABLE_PORT}/provider`);
  await page.getByRole("button", { name: /Add patient/i }).first().click();

  // Scoped to the dialog throughout: this books into the demo practice, whose table behind the wizard
  // carries every visit the run has made, so "Email" and "Follow-up" are two elements unscoped.
  const wizard = page.getByRole("dialog", { name: "Add a booked patient" });
  // From the reserved range, so §13.4 is not what this test measures: the seeded practice is a demo one and
  // a number outside that range is one a demo practice may not write to, whatever the deployment can do
  // (T145, and the test below is that case). The address is under `example.com`, which is reserved too.
  const phone = reservedPhone();
  await wizard.getByLabel("Patient name").fill(uniqueName("Sendable Patient"));
  await wizard.getByLabel("Mobile number").fill(phone);
  await wizard.getByLabel("Email", { exact: true }).fill("sendable.patient@example.com");
  await wizard.getByRole("button", { name: /Continue/i }).click();
  await wizard.getByText("Follow-up", { exact: true }).click();
  await wizard.getByRole("button", { name: /Continue/i }).click();

  // 1. The wizard's default channel, "Text and email", with one of the two behind it: a narrower invite and
  //    not a refused one, so the step reads exactly as it did before T140 — the sentence, the destination
  //    and the button that offers to send.
  const note = wizard.locator(".patient-consent-note").first();
  await expect(wizard.locator(".ss-lede")).toHaveText(
    "Saving creates the patient and sends their private Sweetie link on the channel you choose here.",
  );
  await expect(note).toHaveText(`The secure link goes to ${phone} and sendable.patient@example.com.`);
  await expect(note).not.toHaveClass(/patient-consent-note-blocked/);
  await expect(wizard.getByRole("button", { name: SAVE })).toHaveText("Add patient & send \u2192");
  await shot(page, "provider-add-visit-sendable", STEP_3);

  // 2. And the channel this office has not set up, on the same screen a radio later: the answer is per
  //    channel, which is the whole point of settling it from the environment rather than from a literal.
  await wizard.getByText("Email", { exact: true }).click();
  await expect(note).toHaveText(
    `No invite will be sent: ${cannotSendYet("email")}. Save this patient and copy the link from the dashboard and hand it over yourself.`,
  );
  await expect(note).toHaveClass(/patient-consent-note-blocked/);
  await expect(wizard.getByRole("button", { name: SAVE })).toHaveText("Add patient \u2192");

  // 3. Back to the channel it can send on, and the step is clean again: nothing here is sticky, and the
  //    office is not left reading a fault about a channel it is no longer choosing.
  await wizard.getByText("Text message", { exact: true }).click();
  await expect(note).toHaveText(`The secure link goes to ${phone}.`);
  await expect(note).not.toHaveClass(/patient-consent-note-blocked/);
});

// T145 (§13.4, §8.1, §2.2) The third thing that closes a channel, and the only one on this screen that is
// neither the practice's choice nor the deployment's gap: a demo practice may write only to the reserved
// addresses and numbers nobody can own (lib/demo.ts), and the booking path was never asking.
//
// On the same seventh server, because the bug only exists in an office that *can* send: this gate configures
// no sender (§11.3), so the honest "Sweet Spot cannot send texts yet" won before §13.4 could matter and the
// screen looked right for a month. With a sender behind the channel, a demo practice booking a prospect's
// real mobile number read "The secure link goes to +16505552652." over **Add patient & send →** and
// "<name> is on the way." one press later, and only the delivery row said otherwise.
//
// This one does press the button, which the test above deliberately does not — and it is the §13.4 branch
// that makes that safe: the `notify.invite` job refuses the number before any backend is reached, so the
// suite still makes no outbound SNS call. The reserved arm is read and not pressed, for exactly that reason.
test("a demo practice is told before the button that this number will not be messaged", async ({ page }) => {
  await signInAsDemo(page);
  await expect(page.locator("body")).toContainText("Sam Sample", LOADED);

  // Area code 650 like e2e/demo.spec.ts's, so the two files' patients cannot be matched onto each other by
  // §2.2, and neither is in the 555-01xx range: both are numbers somebody could own.
  const real = `+16505553${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
  const name = uniqueName("Demo Prospect");
  const wizard = page.getByRole("dialog", { name: "Add a booked patient" });

  /** Steps 1 and 2 of the wizard, for one number. Step 3 is the subject, so getting there is not. An
   *  address and a channel are optional, for the "both" booking case 4 below needs: §13.4 is a question
   *  about each destination, so a booking can have one of them refused and the other allowed. */
  const toStep3 = async (phone: string, patient: string, also?: { email: string; channel: string }) => {
    await page.goto(`http://localhost:${SENDABLE_PORT}/provider`);
    await page.getByRole("button", { name: /Add patient/i }).first().click();
    await wizard.getByLabel("Patient name").fill(patient);
    await wizard.getByLabel("Mobile number").fill(phone);
    if (also) await wizard.getByLabel("Email", { exact: true }).fill(also.email);
    await wizard.getByRole("button", { name: /Continue/i }).click();
    await wizard.getByText("Follow-up", { exact: true }).click();
    await wizard.getByRole("button", { name: /Continue/i }).click();
    await wizard.getByText(also?.channel ?? "Text message", { exact: true }).click();
    return wizard.locator(".patient-consent-note").first();
  };

  // 1. The number somebody could own. Nothing is wrong with this office — it can text — so the sentence is
  //    §13.4's own, in lib/demo.ts's words, and it is marked the way a blocked note is.
  const blocked = await toStep3(real, name);
  // T175 The clause this sentence ends on is no longer §8.1's fallback, and the reason is one screen over:
  // §13.4 is `codeReach`'s rule as much as the invite's, so the six-digit code this patient's link needs may
  // not be written to this number either — the link would not open, and handing it over is not a way in
  // (lib/notify.ts `canHandOver`). The reason is untouched; what is withdrawn is the remedy.
  await expect(blocked).toHaveText(
    `No invite will be sent: ${DEMO_ONLY_TEST_ADDRESSES}. Handing the link over will not get this patient in either.`,
    LOADED,
  );
  await expect(blocked).toHaveClass(/patient-consent-note-blocked/);
  // T177 §13.4 closes the code's way in as well as the invite's, so the lede over the note stops offering
  // the handover the note has just withdrawn (lib/booking.ts).
  await expect(wizard.locator(".ss-lede")).toHaveText("Saving creates the patient and their private Sweetie link.");
  await expect(wizard.getByRole("button", { name: SAVE })).toHaveText("Add patient \u2192");
  // The whole step, because the next literal promising a send would be somewhere else on it — and because
  // the number must not be named as a destination by a screen that has just refused it.
  const step = await wizard.innerText();
  expect(step, "nothing on the step offers a send §13.4 forbids").not.toMatch(PROMISES_SEND);
  expect(step, "and the refused number is not named as where the link goes").not.toMatch(/goes to \+1650/);
  // Nobody is sent looking for a sender over a rule: this office has one (§3.7, §10.6).
  expect(step, "not the deployment's sentence").not.toMatch(/cannot send texts yet|ask whoever set/);
  await shot(page, "provider-add-visit-demo-real", STEP_3);

  // 2. And the press, which is the half this ticket is named for: the card used to say the patient was on
  //    the way. `bookedOutcome` was already right — it branches on `queued`, which is what was lying.
  await wizard.getByLabel(/How did the patient agree to be contacted/i).selectOption("phone");
  await wizard.getByRole("button", { name: SAVE }).click();
  const card = page.locator(".patient-wizard-success");
  await expect(card.locator(".ss-title")).toHaveText(`${name} is ready for Sweetie.`, LOADED);
  // T175 And the same withdrawal in the card's own tense, out of the same answer: `POST /api/book` reads
  // `canHandOver` off the row it has just written, so the forecast above and the report here are one fact.
  await expect(card.locator(".ss-lede")).toHaveText(
    `Patient added. No invite sent: ${DEMO_ONLY_TEST_ADDRESSES}. Handing the link over will not get this patient in either.`,
  );
  expect(await card.innerText(), "nothing on the card claims the invite is going anywhere").not.toMatch(
    /on (?:the|its) way/i,
  );
  expect(await card.innerText(), "nor offers the handover it has just withdrawn").not.toMatch(/Share the link below/);
  // T177 The link itself is gone with the sentence that offered it. T175 left it here — "whoever fixes the
  // number can use it; nothing is gained by hiding it" — and what that missed is where it was standing: one
  // paragraph under a lede saying handing this link over gets nobody in, which is the retraction and the
  // offer in consecutive paragraphs that T140, T168 and T170 are each about. It is not lost: the visit's row
  // carries it behind **Copy intake**, for the moment a destination §13.4 allows makes it open.
  await expect(page.locator(".patient-link-card")).toHaveCount(0);
  await shot(page, "provider-add-visit-demo-blocked-card", SUCCESS_CARD);

  // 3. The destination §13.4 does allow, on the same screen in the same practice: this is the walkable demo
  //    a salesperson is on most of the time, and it reads exactly as it did before this ticket. Read and not
  //    pressed, because the forecast is this test's subject; the press on this destination is
  //    e2e/invite.spec.ts's, on the resend path that has no forecast to read instead. The hazard that used
  //    to be the reason here is gone: since T150 this server is given JOBS_SECRET, so `nudge` is a no-op on
  //    it (playwright.config.ts) and nothing drains a send on the one build with an origination number.
  const reserved = reservedPhone();
  const promised = await toStep3(reserved, uniqueName("Demo Reserved"));
  await expect(promised).toHaveText(`The secure link goes to ${reserved}.`, LOADED);
  await expect(promised).not.toHaveClass(/patient-consent-note-blocked/);
  await expect(wizard.locator(".ss-lede")).toHaveText(
    "Saving creates the patient and sends their private Sweetie link on the channel you choose here.",
  );
  await expect(wizard.getByRole("button", { name: SAVE })).toHaveText("Add patient & send \u2192");
  await shot(page, "provider-add-visit-demo-reserved", STEP_3);

  // 4. The intersection of §13.4 and T111, which the first landing of this ticket left open: a booking on
  //    **both** channels where the rule closes the one this office can serve and leaves the one it cannot.
  //    The number is somebody's, so §13.4 refuses the text; the address is reserved, so the invite is down
  //    to email — and this server has no email backend. The step used to ask `inviteSendability("both")`,
  //    which is satisfied by the origination number, and so promised a send on the email half that nothing
  //    could carry; the press then refused it. `bookingPlan` now looks the fault up after its own narrowing,
  //    about what §13.4 actually left (`faults[channelOf(open)]`, lib/booking.ts), so the two agree.
  //
  //    Read and not pressed: the point is the forecast, and `inviteReach` answering the same way is
  //    lib/booking.test.ts's pairing test and lib/notify.test.ts's to hold.
  const mixed = await toStep3(`+16505554${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`, uniqueName("Demo Mixed"), {
    email: `demo.mixed.${Date.now()}@example.com`,
    channel: "Text and email",
  });
  await expect(mixed).toHaveText(
    "No invite will be sent: Sweet Spot cannot send email yet — ask whoever set it up for your office. Save this patient and copy the link from the dashboard and hand it over yourself.",
    LOADED,
  );
  await expect(mixed).toHaveClass(/patient-consent-note-blocked/);
  await expect(wizard.getByRole("button", { name: SAVE })).toHaveText("Add patient \u2192");
  const mixedStep = await wizard.innerText();
  expect(mixedStep, "nothing on the step offers a send neither channel can carry").not.toMatch(PROMISES_SEND);
  expect(mixedStep, "and no destination is named as where the link goes").not.toMatch(/goes to/);
  await shot(page, "provider-add-visit-demo-mixed", STEP_3);
});

// T111 The other half of that sentence: an office whose deployment *can* send is still told the invite is on
// its way, by the channel that is sending it. What stands in for such a deployment is the one thing stubbed
// here, and only because the alternative is worse: this gate configures no sender at all (§11.3), and a
// server that did would have every booking in the suite attempt a real SES or SNS send — the outbound calls
// T94 and T110 took out of it, on a box with ambient AWS credentials.
//
// So the route runs for real and the visit is really created; only `queued` and `channel` are rewritten to
// what POST /api/book answers where `emailConfig()` resolves to a backend instead of a reason. That it does
// answer that is lib/notify.test.ts's to assert, on the senders themselves. Everything in the frame — the
// card, the sentence, the link, the button — is the product's own.
test("a deployment with a sender still tells staff the invite is on its way", async ({ page }) => {
  await signInAsDemo(page);
  await expect(page.locator("body")).toContainText("Sam Sample", LOADED);

  await page.route("**/api/book", async (route) => {
    const response = await route.fetch();
    const booked = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...booked, queued: true, channel: "email", reason: undefined } });
  });

  const name = uniqueName("Configured Patient");
  await page.getByRole("button", { name: /Add patient/i }).first().click();

  // Every step below is scoped to the dialog, because this test books into the *demo* practice, whose
  // dashboard carries every visit the rest of the run has created. "Follow-up" is a visit type in here and a
  // `.provider-cell-sub` out there, and "Email" is a channel card in here and a delivery pill out there, so
  // a bare `getByText` is two elements and a strict-mode violation as soon as the table behind has a row of
  // the right shape. The specs that do this unscoped (the test above, e2e/journey.spec.ts) each book into a
  // practice of their own with nothing in its table yet.
  const wizard = page.getByRole("dialog", { name: "Add a booked patient" });
  await wizard.getByLabel("Patient name").fill(name);
  await wizard.getByLabel("Email", { exact: true }).fill(`${name.replace(/\s+/g, ".").toLowerCase()}@example.com`);
  await wizard.getByRole("button", { name: /Continue/i }).click();

  await wizard.getByText("Follow-up", { exact: true }).click();
  await wizard.getByRole("button", { name: /Continue/i }).click();

  // Emailed, and the consent §2.2 insists on before anything is sent anywhere.
  await wizard.getByText("Email", { exact: true }).click();
  await wizard.getByLabel(/How did the patient agree to be contacted/i).selectOption("phone");
  await wizard.getByRole("button", { name: SAVE }).click();

  // The channel named is the one that can send, which is why it comes from the route's answer and not from
  // the form: staff who chose "Text and email" where only one backend exists are told about that one.
  const card = page.locator(".patient-wizard-success");
  const claim = card.locator(".ss-lede");
  await expect(claim).toContainText("The invite is on its way by email.", LOADED);
  await expect(claim).not.toContainText(/No invite sent/i);
  // T122 The sent wording is the one this card always had, and the heading is the half of it that used to be
  // printed whatever the answer was: a deployment with a sender still reads "<name> is on the way."
  await expect(card.locator(".ss-title"), "unchanged where a send really is happening").toHaveText(`${name} is on the way.`);
  await expect(page.locator(".patient-link-card"), "§8.1's link is on this screen either way").toContainText("/s/");
  await shot(page, "provider-add-visit-sent", SUCCESS_CARD);
});

test("a day of visits imports from a CSV, one error per bad row", async ({ page }, testInfo) => {
  // Desktop only, because the control is: the top bar fits one action on a phone and importing a scheduler's
  // CSV is desk work, so app/globals.css hides `.provider-import-button` there. The route itself is covered
  // on both projects by the refusals test below, and by lib/visitIntake.test.ts.
  testInfo.skip(testInfo.project.name === "mobile", "the CSV import control is desktop-only by design");
  await signInAsDemo(page);
  await expect(page.locator("body")).toContainText("Sam Sample", LOADED);

  const goodName = uniqueName("CSV Good");
  const silentName = uniqueName("CSV Quiet");
  const unreachableName = uniqueName("CSV Unreachable");
  // Five rows: one to message, one to create without messaging, one with nothing on file at all, and two the
  // preview has to refuse for
  // different reasons. The file is handed over the way a receptionist hands it over — as a file.
  const csv = [
    "Patient Name,Mobile,Email,Appointment,Type,Called about,Channel,Consent",
    `${goodName},${uniquePhone()},,2026-11-02 09:30,Follow-up,"mornings running high, every day",sms,phone`,
    `${silentName},${uniquePhone()},,2026-11-02 10:00,annual,,,`,
    `${unreachableName},,,2026-11-02 10:45,follow_up,nothing on file,,`,
    `,${uniquePhone()},,2026-11-02 10:30,follow_up,no name at all,sms,phone`,
    `${uniqueName("CSV Bad")},${uniquePhone()},,2026-11-02 11:00,screening,unknown visit type,sms,phone`,
  ].join("\n");

  await page.getByRole("button", { name: /Import a day/i }).click();
  await page.getByLabel("CSV file").setInputFiles({ name: "tomorrow.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: /Check the rows/i }).click();

  // §2.2's preview: three ready, two named problems, and nothing created yet.
  await expect(page.locator(".import-tally")).toContainText("3 ready to create, 2 to fix", LOADED);
  await expect(page.locator(".import-table")).toContainText(/name is required/i);
  await expect(page.locator(".import-table")).toContainText(/Visit type must be one of/);
  await expect(page.locator(".import-table")).toContainText("Text message · Over the phone");
  // A row with a blank channel column is created and not messaged, which the preview says out loud.
  await expect(page.locator(".import-table")).toContainText("Do not message");
  // And a row with nothing to reach the patient on is still importable, with what that costs on it: after
  // T08 (§5.3) opening the link sends a code, so this visit has no way in until someone adds a number — and
  // since T168 the row says that once, and says what the front desk can do about it, rather than denying the
  // send and promising it in the same sentence.
  const importWarning = page.locator(".import-warning");
  await expect(importWarning).toContainText(/the six-digit code their link needs has nowhere to go/i);
  await expect(importWarning).toContainText(/Add a phone number or an email address, or take the intake over the telephone/i);
  expect(await importWarning.innerText(), "the row no longer promises the code it has just denied").not.toMatch(
    /sends? (?:them|you|the patient)/i,
  );
  // T170 And nor does the paragraph above the preview, which made the same promise of *every* blank-channel
  // row — line 4 of this very file among them. One frame holds both (the shot below), so the rule is about
  // the whole dialog and not about the row that happens to contradict it.
  expect(await page.locator(".import-dialog").innerText(), "nothing in the dialog promises a code the file cannot reach").not.toMatch(
    /sends? (?:them|you|the patient)/i,
  );
  await expect(page.locator(".import-dialog .ss-lede")).toContainText(
    "a row with a blank channel is created without an invite — hand those patients the link yourself.",
  );
  // T135 One of the three creatable rows asked for a text and this deployment has no SMS backend, so the
  // screen the decision is made on says so — before the button, in the future tense, and naming what
  // pressing it will cost. The same single line the committed screen gets below, for the same reason: it is
  // one fact about the deployment, so the two "Do not message" rows add none of their own.
  const previewFault = page.locator(".import-invite-fault");
  await expect(previewFault).toHaveCount(1, LOADED);
  await expect(previewFault).toContainText(/No invites will be sent: Sweet Spot cannot send texts yet/i);
  await expect(previewFault).toContainText(/copy each link from the dashboard/i);
  // Nothing has happened yet, and this screen must not read as though it had (T111's sentence is the other
  // tense, asserted after the press).
  await expect(previewFault).not.toContainText(/No invites sent:/i);
  // MODAL at either width: this is a dialog over the dashboard, and a full-page shot anchors at the top of
  // a very tall document, which cut the dialog's own header off above the image (T57).
  //
  // MODAL alone was not enough, and nor was scrolling (T107). The refusals asserted just above are the
  // whole point of the preview, and neither of them was in the picture: at 720px the dialog gets 525px of
  // scrolling body for 685px of content, so the frame held the title, the paste box and the rows that
  // passed, with line 5 and line 6 below the bottom edge of `.import-scroll` and line 4 clipped mid-name on
  // it. Pinning the scroller to the top — which is what this did before — chooses that framing rather than
  // fixing it, and no other scroll position holds the title as well.
  //
  // So the shot asks for the window the dialog's own `max-height: 88svh` is written against, and gets the
  // whole dialog in one frame: the title, the tally, and all five rows with their errors and the warning.
  // `wholeRows` is the assertion that keeps it true — a row half in the frame fails here rather than being
  // committed as evidence about a validator nobody can see working.
  await shot(page, "provider-import-preview", { ...MODAL, viewportHeight: IMPORT_WINDOW, wholeRows: ".import-table tr" });

  const beforeImport = (await (await page.request.get("/api/provider")).json()) as { visits: { name: string }[] };
  expect(beforeImport.visits.some((v) => v.name === goodName), "the preview writes nothing").toBeFalsy();

  await page.getByRole("button", { name: /Create 3 visits/i }).click();
  await expect(page.locator(".import-tally")).toContainText("3 created", LOADED);
  // T111 One of the three rows asked for a text and this deployment has no SMS backend, so the screen says
  // the invites did not go out and what staff can do instead. One line for the file rather than one per row,
  // because it is a fact about the deployment: the two rows with a blank channel asked for nothing and add
  // no line of their own, and a second texted row would add no second line either.
  const faults = page.locator(".import-invite-fault");
  await expect(faults).toHaveCount(1);
  await expect(faults).toContainText(/No invites sent: Sweet Spot cannot send texts yet/i);
  // T135 And it has changed tense: the forecast asserted on the preview above is now a report on rows that
  // exist. lib/importNote.test.ts holds both sentences word for word.
  await expect(faults).not.toContainText(/will be sent|will have to/i);
  await shot(page, "provider-import-created", { ...MODAL, viewportHeight: IMPORT_WINDOW, wholeRows: ".import-table tr" });
  await page.getByRole("button", { name: /Back to dashboard/i }).click();

  // Both rows are on the dashboard, and the one with no channel says it is not being messaged (§8.3).
  await expect(page.locator(".provider-table tbody tr", { hasText: goodName })).toContainText("Invited", LOADED);
  const quiet = page.locator(".provider-table tbody tr", { hasText: silentName });
  await expect(quiet).toContainText("Not messaged");
  await expect(quiet).toContainText("No consent recorded");

  const after = (await (await page.request.get("/api/provider")).json()) as { visits: { name: string; visitType: string; channel: string; reason: string | null }[] };
  const imported = after.visits.find((v) => v.name === goodName);
  expect(imported).toBeTruthy();
  expect(imported!.visitType).toBe("follow_up");
  expect(imported!.channel).toBe("sms");
  expect(imported!.reason).toBe("mornings running high, every day");
  expect(after.visits.find((v) => v.name === silentName)?.channel).toBe("none");
  expect(after.visits.find((v) => v.name === unreachableName), "a row with nothing on file still imports").toBeTruthy();
});

// T135 The other half of the preview's sentence: an office whose deployment *can* send reads a clean
// preview, and nothing on it hints at a gap that is not there. What stands in for such a deployment is the
// one thing stubbed here, for the reason T111 gives above and e2e/invite.spec.ts gives again: this gate
// configures no sender at all (§11.3), and a server that did would have every invite in the suite attempt a
// real SES or SNS send on a box with ambient AWS credentials — the outbound calls T94 and T110 took out.
//
// So the route runs for real, parses the file for real and writes nothing, as a preview must; only
// `inviteFaults` is rewritten to the empty array a deployment with a sender behind the channel answers
// with. That it does answer that is lib/notify.test.ts's to assert, on the senders themselves.
test("a deployment with a sender previews a day of invites with nothing to warn about", async ({ page }, testInfo) => {
  testInfo.skip(testInfo.project.name === "mobile", "the CSV import control is desktop-only by design");
  await signInAsDemo(page);
  await expect(page.locator("body")).toContainText("Sam Sample", LOADED);

  await page.route("**/api/visits/import", async (route) => {
    const response = await route.fetch();
    const answer = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...answer, inviteFaults: [] } });
  });

  const csv = [
    "name,phone,email,scheduled_at,visit_type,reason,channel,consent",
    `${uniqueName("CSV Sendable")},${uniquePhone()},,2026-11-03 09:30,follow_up,mornings running high,sms,phone`,
    `${uniqueName("CSV Quiet Sendable")},${uniquePhone()},,2026-11-03 10:00,annual,,,`,
  ].join("\n");

  await page.getByRole("button", { name: /Import a day/i }).click();
  await page.getByLabel("CSV file").setInputFiles({ name: "sendable.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: /Check the rows/i }).click();

  await expect(page.locator(".import-tally")).toContainText("2 ready to create", LOADED);
  await expect(page.locator(".import-invite-fault")).toHaveCount(0);
  // Not just the one line: nothing on this screen says anything cannot be sent, which is the criterion a
  // warning rendered somewhere else on the row would also have to meet.
  await expect(page.locator(".import-preview")).not.toContainText(/cannot send/i);
  await shot(page, "provider-import-preview-sendable", { ...MODAL, viewportHeight: IMPORT_WINDOW, wholeRows: ".import-table tr" });

  // And it is still a preview: a stubbed answer about the environment must not have written a visit.
  const rows = (await (await page.request.get("/api/provider")).json()) as { visits: { name: string }[] };
  expect(rows.visits.some((v) => v.name.startsWith("CSV Sendable")), "the preview writes nothing").toBeFalsy();
});

test("a second visit for the same person reuses the patient, matched on phone", async ({ page }) => {
  // §2.2: "patient (new or existing by phone/email)". A practice of its own, so the match is being made
  // inside this practice and not against the seeded one.
  const me = await signInAs(page, freshEmail("reuse-admin"));
  const phone = uniquePhone();
  const name = uniqueName("Repeat Patient");

  const first = await (await postJson(page.request, "/api/book", { name, phone, channel: "sms", consentMethod: "phone", visitType: "follow_up" })).json();
  expect(first.patientReused).toBe(false);

  // The same number, a different name spelling and a new appointment: one patient, two visits.
  const second = await (await postJson(page.request, "/api/book", { name: `${name} Jr`, phone, channel: "sms", consentMethod: "in_person", visitType: "annual" })).json();
  expect(second.patientReused).toBe(true);
  expect(second.patientId).toBe(first.patientId);
  expect(second.visitId).not.toBe(first.visitId);
  // Each visit has its own invite token (§5.3): the second link must not open the first visit's intake.
  expect(second.token).not.toBe(first.token);

  const rows = (await (await page.request.get("/api/provider")).json()) as { practiceId: string; visits: { id: string; patientId: string }[] };
  expect(rows.practiceId).toBe(me.practiceId);
  expect(rows.visits.filter((v) => v.patientId === first.patientId)).toHaveLength(2);

  // The match is scoped to the practice (§5.2): the same number booked by the seeded clinic is their own new
  // patient, not this one. Otherwise a shared mobile number would be a way to reach into another practice.
  await signOutOfBrowser(page);
  await signInAsDemo(page);
  const elsewhere = await (await postJson(page.request, "/api/book", { name, phone, channel: "sms", consentMethod: "phone" })).json();
  expect(elsewhere.patientReused).toBe(false);
  expect(elsewhere.patientId).not.toBe(first.patientId);
});

test("the import refuses what it cannot read, and refuses a role that cannot book", async ({ page, request }) => {
  const demo = await signInAsDemo(page);

  // A file with no name column cannot be an import, and says which header it wanted.
  const noHeader = await (await postJson(page.request, "/api/visits/import", { csv: "mrn,room\n1,2\n" })).json();
  expect(noHeader.error).toMatch(/No patient name column/);
  expect(noHeader.rows).toHaveLength(0);

  // Nothing to import at all is a 400 with a sentence, not a stack trace.
  const empty = await postJson(page.request, "/api/visits/import", { csv: "   " });
  expect(empty.status()).toBe(400);

  // §5.2: importing is booking. A clinician does not book, and gets the role's 403 rather than a parse error.
  const clinicianEmail = freshEmail("import-clinician");
  expect(
    (
      await postJson(page.request, "/api/practice/users", { email: clinicianEmail, role: "clinician", name: "Dr Import" })
    ).ok(),
  ).toBeTruthy();
  await signOutOfBrowser(page);
  await signInAs(page, clinicianEmail);
  const refused = await postJson(page.request, "/api/visits/import", { csv: "name\nNope\n" });
  expect(refused.status()).toBe(403);

  // And with no session at all it is a 401, like every other provider route (lib/guard.ts).
  expect((await postJson(request, "/api/visits/import", { csv: "name\nNope\n" })).status()).toBe(401);
  expect(demo.id).toBeTruthy();
});
