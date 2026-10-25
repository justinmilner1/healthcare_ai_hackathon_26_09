import { expect, test, type Page } from "@playwright/test";
import { cannotSendYet } from "../lib/delivery";
import { DEMO_ONLY_TEST_ADDRESSES } from "../lib/demo";
import { SENDABLE_PORT } from "../playwright.config";
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
 * Both measurements are the phone's, because 375px is where §6.5 and the bug are. The desktop dialog is
 * two columns in **one** row, and that row is implicit and `auto` the same way — measured on this tree at
 * 1280 x 720 on this step, `.patient-wizard`'s `scrollHeight - clientHeight` is **25**, so the desktop
 * dialog clips 25px of `.patient-wizard-content`'s own 28px of bottom padding. No content is behind that
 * edge and nothing on the screen moves, which is why nobody has seen it, and T155 was explicit that the
 * desktop layout stays as it is — so it is reported on the issue rather than changed here, and this
 * helper's frames are all the desktop gets. The one-line fix, if the finding is taken up, is the same
 * `minmax(0, 1fr)` on the base rule's single row.
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

  if (test.info().project.name !== "mobile") {
    // The desktop dialog holds the whole step in one 38% / 62% row, so there is nothing here for a finger
    // to move and the frame above is already the bottom of it. The pair is still taken at this width,
    // because §12.3 asks for the step at both and "unchanged" is a claim a picture can carry.
    await shot(page, `${name}-scroll-bottom`, frame);
    return;
  }

  expect(
    await dialog.evaluate((element) => element.scrollHeight - element.clientHeight),
    "`.patient-wizard` is the box with overflow: hidden, so whatever is past its edge is cut and no gesture reaches it (T155)",
  ).toBe(0);
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
  await shot(page, `${name}-scroll-bottom`, frame);

  // And back: the title the frame above cannot hold is a wheel away, which is the half of the §2.2 review
  // a person had no way to return to.
  await page.mouse.wheel(0, -(room + 200));
  await expect
    .poll(async () => content.evaluate((element) => element.scrollTop), LOADED)
    .toBeLessThanOrEqual(1);
  await expect(title, "a wheel back up returns the step's title, which is half of what §2.2 asks staff to confirm").toBeInViewport(LOADED);
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
  await expect(blocked).toHaveText(
    `No invite will be sent: ${DEMO_ONLY_TEST_ADDRESSES}. Save this patient and copy the link from the dashboard and hand it over yourself.`,
    LOADED,
  );
  await expect(blocked).toHaveClass(/patient-consent-note-blocked/);
  await expect(wizard.locator(".ss-lede")).toHaveText(
    "Saving creates the patient and their private Sweetie link, which you hand over yourself.",
  );
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
  await expect(card.locator(".ss-lede")).toHaveText(
    `Patient added. No invite sent: ${DEMO_ONLY_TEST_ADDRESSES}. Share the link below.`,
  );
  expect(await card.innerText(), "nothing on the card claims the invite is going anywhere").not.toMatch(
    /on (?:the|its) way/i,
  );
  // §8.1's fallback: the link is on the screen that just refused to send it, which is the whole answer here.
  await expect(page.locator(".patient-link-card")).toContainText("/s/");
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
  // T08 (§5.3) opening the link sends a code, so this visit has no way in until someone adds a number.
  await expect(page.locator(".import-warning")).toContainText(/cannot open their link/i);
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
