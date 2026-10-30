import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { cannotSendYet } from "../lib/delivery";
import { postJson } from "./api";
import { freshEmail, signInAs, signOutOfBrowser } from "./auth";
import { DRAINED, LOADED } from "./budget";
import { expectTranscriptUncut } from "./mobile";
import { AGREE, COUNTDOWN, enterCode, latestCode, patientEmail } from "./patient";
import { expectChartTooltipsLabelled, expectMarkerLabelsClearOfMarkers } from "./charts";
import { MODAL, SCREENFUL, shot as rawShot, type ShotOptions } from "./shot";

// T26 (design §12.2): "both flows against a seeded database: staff creates a visit, patient verifies and
// completes intake in scripted mode, Sour summary appears, clinician marks reviewed" — as one journey,
// through the screens, in the order a practice lives it.
//
// Every other spec in this directory takes one sentence of the design and tries it hard: e2e/visits.spec.ts
// drives the booking wizard, e2e/consent.spec.ts the consent screen, e2e/review.spec.ts the sign-off,
// e2e/print.spec.ts the sheet. None of them crosses from one flow to the other, and each sets its own stage
// by the shortest route available — usually the seeded admin booking through POST /api/book. That leaves the
// handover untested: the thing a practice actually buys is that what the patient tells Sweetie on their phone
// is on the clinician's screen in the appointment, with the roles of §5.2 in between. This is that one test.
//
// What makes it a different test and not a longer one:
//   - Three identities, each with only its own capabilities (§5.2). Staff books the visit and never sees a
//     summary; the clinician reads and signs off and cannot book. The admin only sets the practice up. No
//     step borrows another role's session, so a capability drifting to the wrong role fails here.
//   - Its own practice, invited into existence through the settings screen, rather than the seeded one. A
//     sign-off is final (§7.3), so marking the demo patient would change what the rest of the suite sees.
//   - The patient's own words are followed from the chat to the clinician's brief and onto the printed sheet,
//     which is the §12.2 claim no single-screen spec can make.
//
// Nothing is stubbed: the sign-in links and the six-digit code are read out of the mailbox the local mailer
// writes (e2e/auth.ts, e2e/patient.ts), the uploads are files picked on the intake screen, and the summary is
// written by the `sour.run` job (§3.4, §7.2) — if the queue never drains, the chip never reads Ready and this
// test fails where that happened.

/** Screenshots are numbered, because the point of these is the order (§12.3). e2e/shot.ts decides how much
 *  of each page is in the shot; the dashboards pass the table card, because on a phone that is what the step
 *  is about and the page is as tall as the practice's visit list (T57). */
const shot = async (page: Page, name: string, options: ShotOptions = {}) => {
  await rawShot(page, `journey-${name}`, options);
};

/** The patient's week, as a patient would have it: files picked on the intake screen (§3.3, §9.1). */
const sample = (name: string) => readFileSync(join(process.cwd(), "data", name));

/** §2.2's "visit date and time", fixed relative to the run: three days out at 09:30, local time. Local
 *  because that is the clock both ends of this read — the wizard's `datetime-local` field holds a wall time
 *  with no zone on it, and `parseScheduledAt` (lib/visitIntake.ts) resolves it in the practice's own zone,
 *  which here is the one zone this container has. Relative to the run so the brief never shows an
 *  appointment in the past; 09:30 so the day cannot drift across midnight when the run is late (T67). */
const bookedFor = () => {
  const at = new Date();
  at.setDate(at.getDate() + 3);
  at.setHours(9, 30, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    iso: at.toISOString(),
    /** What the field holds and what the wizard posts (app/provider/dashboard.tsx). */
    field: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`,
  };
};

/** That date as a page writes it, formatted in the browser by the same `Intl` call the component makes, so
 *  an assertion cannot fail over a locale or a zone this process and Chromium disagree about. Each screen
 *  picks its own options: the dashboard row abbreviates the weekday, the brief and the sheet spell it out. */
const asRendered = (page: Page, iso: string, call: "date" | "dateTime", options: Intl.DateTimeFormatOptions) =>
  page.evaluate(
    ([at, which, opts]) =>
      which === "date" ? new Date(at).toLocaleDateString(undefined, opts) : new Date(at).toLocaleString(undefined, opts),
    [iso, call, options] as [string, "date" | "dateTime", Intl.DateTimeFormatOptions],
  );

test("the whole journey: staff books, the patient checks in, the clinician signs it off and prints it", async ({ page }) => {
  // Eleven screens across three identities and two flows, each sign-in waiting on a mailbox. The per-test
  // ceiling is for a test that drives one of them; this one needs the budget of the journey it is. The
  // suite's keep-alive is derived from this floor being the largest one (playwright.config.ts).
  test.setTimeout(Math.max(240_000, test.info().timeout));

  // ---- The practice, as an admin sets it up (§2.1, §5.2) ------------------------------------------------
  // A fresh address signs in and gets a practice of its own, as its admin. The colleagues below are invited
  // into it, which is what puts them in this practice rather than in one each.
  const adminEmail = freshEmail("journey-admin", "journey-endo.com");
  const staffEmail = freshEmail("journey-front-desk", "journey-endo.com");
  const clinicianEmail = freshEmail("journey-doctor", "journey-endo.com");
  const clinicianName = "Dr. Journey Okafor";

  const admin = await signInAs(page, adminEmail);
  expect(admin.role, "the first account in a practice is its admin").toBe("admin");

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Users and roles." })).toBeVisible(LOADED);
  await page.getByLabel("Practice name").fill("Journey Endocrinology");
  await page.getByRole("button", { name: "Save practice" }).click();
  await expect(page.getByText("Saved.")).toBeVisible(LOADED);

  // Two colleagues, each invited with the role their job needs. Staff is the default; the clinician's role is
  // chosen, and their name is given here so the sign-off at the end of the journey has someone to name.
  await page.getByLabel("Work email").fill(staffEmail);
  await page.getByRole("button", { name: /Send invite/i }).click();
  await expect(page.locator(".provider-table")).toContainText(staffEmail, LOADED);

  await page.getByLabel("Work email").fill(clinicianEmail);
  await page.getByLabel(/Their name/i).fill(clinicianName);
  await page.getByRole("radio", { name: /Clinician/ }).check();
  await page.getByRole("button", { name: /Send invite/i }).click();
  await expect(page.locator(".provider-table")).toContainText(clinicianEmail, LOADED);
  await shot(page, "01-practice-users");

  // ---- Staff books the visit (§2.2, §5.2) --------------------------------------------------------------
  await signOutOfBrowser(page);
  const staff = await signInAs(page, staffEmail);
  expect(staff.role, "invited as staff, so staff is what they are").toBe("staff");
  expect(staff.practice).toBe("Journey Endocrinology");
  // The front desk sees the practice's visits and nothing clinical: no summary buttons on the dashboard, no
  // settings link. Both are asserted exhaustively in e2e/roles.spec.ts; here they are the state of the screen
  // the next screenshot is of.
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
  await shot(page, "02-staff-dashboard", { scrollTo: ".provider-table-card" });

  // The wizard, step by step, because this is the screen the appointment is made on (e2e/visits.spec.ts
  // drives its refusals; this is the path through it).
  const patientName = `Journey Patient ${Date.now().toString(36)}`;
  const email = patientEmail("journey patient");
  await page.getByRole("button", { name: /Add patient/i }).first().click();
  await page.getByLabel("Patient name").fill(patientName);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: /Continue/i }).click();

  await page.getByText("Follow-up", { exact: true }).click();
  // §2.2 lists the date and time as part of creating a visit, so the journey books a dated one (T67). The
  // field stays optional — a visit with no date is a visit, and e2e/visits.spec.ts is where that row and its
  // "Date pending" keep being covered.
  const appt = bookedFor();
  await page.getByLabel("Visit date and time").fill(appt.field);
  await page.getByLabel(/What did the patient call about/i).fill("highs after dinner since the new job");
  await page.getByRole("button", { name: /Continue/i }).click();

  // §2.2's channel and the consent behind it: the link is emailed, so there has to be a record of the patient
  // agreeing to be emailed. Nothing is sent without one — the route refuses it (lib/visitIntake.ts).
  await expect(page.getByText("Contact channel")).toBeVisible();
  // By the card's own words, exactly: the radio inside it is `opacity: 0`, and `hasText` would take
  // "Text and email" as well, since it matches a case-insensitive substring.
  await page.getByText("Email", { exact: true }).click();
  await page.getByLabel(/How did the patient agree to be contacted/i).selectOption("phone");
  // The card reads the booking back before anything is written, the appointment included.
  await expect(page.locator(".patient-review-card"), "the date staff just typed, not 'Date pending'").toContainText(
    await asRendered(page, appt.iso, "dateTime", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
  );
  // T140 (§2.2, §8.1) The same claim the card below makes, one press earlier, on the frame this ticket was
  // filed from: this environment has no email backend, so the step says the emailed invite is not going out
  // *before* the button and offers to add the patient rather than to send. `cannotSendYet("email")` is the
  // sentence, from the module that owns it; e2e/visits.spec.ts reads the whole step for the "both" default.
  const beforeTheButton = page.getByRole("dialog", { name: "Add a booked patient" });
  await expect(beforeTheButton.locator(".patient-consent-note").first()).toContainText(
    `No invite will be sent: ${cannotSendYet("email")}.`,
  );
  await expect(beforeTheButton.locator(".ss-lede")).not.toContainText(/sends their private Sweetie link/);
  // Anchored on the consent note, because at 375px this step is taller than the dialog can show and the
  // frame otherwise began wherever the last radio click scrolled it (T151). It was anchored on the actions
  // row, which only worked while the dialog did not scroll: since T155 that row's `position: sticky` has a
  // scroller to resolve against, so it is in the frame at every scroll position and `scrollIntoView` finds
  // nothing to move. The note is the half that still moves, centred rather than ended because the sticky
  // row floats over the bottom edge. e2e/visits.spec.ts' STEP_3 is the same anchor with the measurements
  // behind it.
  await shot(page, "03-add-visit", {
    ...MODAL,
    scrollTo: ".patient-consent-note",
    block: "center",
    wholeRows: ".patient-consent-note, .patient-wizard-actions",
  });
  await page.getByRole("button", { name: /^Add patient/ }).click();

  // T111 (§2.2, §2.3, §8.1) The wizard's own claim about the send, which is the first thing staff are told
  // about it. This environment has no email backend — the suite runs the product offline (§11.3) and that is
  // the state a fresh `.env` is in too — so the honest screen is the branch the no-consent case has always
  // had: no invite sent, the reason in the practice's words, and §8.1's fallback, the link, in the card
  // right below it. Before this ticket the same screen read "The invite is on its way by email." while the
  // dashboard cell twelve steps down this test said email cannot be sent.
  //
  // T122 (§2.3, §8.1) The heading over that sentence was a literal — "<name> is on the way." — so this card
  // used to promise motion in its largest type and retract it one line down. Both lines now come out of
  // `bookedOutcome` (lib/booking.ts), so the card is held whole here: nothing on it claims a send.
  const card = page.locator(".patient-wizard-success");
  await expect(card.locator(".ss-title"), "the heading says what happened, not what T111 ruled out").toHaveText(
    `${patientName} is ready for Sweetie.`,
    LOADED,
  );
  const claim = card.locator(".ss-lede");
  await expect(claim).toContainText(/No invite sent: Sweet Spot cannot send email yet/i, LOADED);
  await expect(claim, "and not the promise a row in `Job` used to imply").not.toContainText(/on its way/i);
  expect(await card.innerText(), "no line of the card claims the invite is going anywhere").not.toMatch(
    /on (?:the|its) way/i,
  );
  expect(await claim.innerText(), "no variable, credential or backend on a practice's screen").not.toMatch(
    /[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bSES\b|\bAWS\b|credential|verified identity/,
  );
  const link = await page.locator(".patient-link-card a").innerText();
  const token = link.split("/s/")[1]?.trim();
  expect(token, `a /s/<token> link on the success card, got ${link}`).toBeTruthy();
  // Anchored on the card for the same reason the step above it is, rather than for the same gap (T151):
  // this step is short enough that one 375px frame holds all of it, but the dialog keeps the scroll
  // position step 3 left it at, so the frame began mid-word in the hero at whatever height the last
  // interaction happened to leave. e2e/visits.spec.ts' SUCCESS_CARD is this anchor with the measurements
  // behind it; it is the last shot of this dialog that was still taking a bare MODAL.
  await shot(page, "04-invite-sent", {
    ...MODAL,
    scrollTo: ".patient-wizard-success",
    block: "end",
    wholeRows: ".patient-link-card, .patient-wizard-success .ss-title",
  });

  await page.getByRole("button", { name: /Back to dashboard/i }).click();
  const row = page.locator(".provider-table tbody tr", { hasText: email });
  await expect(row, "§4.4's first stage").toContainText("Invited", LOADED);
  // And §2.2's date in the column the front desk schedules by.
  await expect(row.locator(".provider-cell-main"), "the booked date, not 'Date pending'").toHaveText(
    await asRendered(page, appt.iso, "date", { weekday: "short", month: "short", day: "numeric" }),
  );

  // ---- The patient checks in (§2.3, §2.4, §2.5, §5.3) --------------------------------------------------
  // From here the browser is the patient's: the staff session is dropped, and the only credential in play is
  // the link plus the code sent to the address on file.
  await signOutOfBrowser(page);
  await page.goto(`/s/${token}`);
  await expect(page.getByLabel("6-digit code")).toBeVisible(LOADED);
  await shot(page, "05-verify-code");
  await enterCode(page, email);

  // §2.4's one screen between the code and Sweetie, on first open only. e2e/consent.spec.ts checks each
  // sentence on it; what matters here is that it is unavoidable and that one tap goes through.
  const consent = page.locator(".patient-consent-card");
  await expect(consent).toBeVisible(LOADED);
  await expect(consent).toContainText("Journey Endocrinology");
  await shot(page, "06-consent");
  await page.getByRole("button", { name: AGREE }).click();

  const firstName = patientName.split(" ")[0];
  await expect(page.locator(".sweetie-messages")).toContainText(new RegExp(`Hi ${firstName}`), LOADED);
  await shot(page, "07-sweetie-greeting");

  // §2.5's optional sharing, on the screen that offers it. Two of the three sources, so the brief at the end
  // has the glucose it is mostly made of and the sleep card beside it.
  await page.goto(`/s/${token}/intake`);
  await page.getByRole("button", { name: /Let's get started/i }).click();
  await page
    .getByLabel(/Upload Dexcom file/i)
    .setInputFiles({ name: "Clarity_export.csv", mimeType: "text/csv", buffer: sample("dexcom_clarity_sample.csv") });
  await expect(page.getByText(/records securely added/i), "the route parsed the file and the adapter stored it").toHaveCount(1, LOADED);
  await page
    .getByLabel(/Upload WHOOP file/i)
    .setInputFiles({ name: "whoop_cycles.csv", mimeType: "text/csv", buffer: sample("whoop_sample.csv") });
  // Both cards say it now, so the assertion is on how many do: one sentence per connected source.
  await expect(page.getByText(/records securely added/i)).toHaveCount(2, LOADED);
  await shot(page, "08-intake-connections");

  // Back to the conversation, and through it. Two substantive answers fill the two required fields of a
  // follow-up template (lib/sweetie.ts), which is what "completes intake" means in scripted mode: the model
  // is unreachable here, so the deterministic backstop is what records them.
  const SAID = {
    purpose: "My sugars run high after dinner, maybe four nights a week since I started the new job in August.",
    update: "Nothing else changed except the hours. No lows, but I am sleeping about six hours and feel wrung out by Friday.",
  };
  await page.goto(`/s/${token}`);
  const input = page.locator("input[type='text'], input:not([type]), textarea").first();
  for (const answer of [SAID.purpose, SAID.update]) {
    await expect(input).toBeEnabled(LOADED);
    await input.fill(answer);
    await input.press("Enter");
    await expect(page.locator(".sweetie-messages")).toContainText(answer.slice(0, 24), LOADED);
  }

  // §2.5's end: the check-in is complete, which is the intake status the provider side reads (lib/bundle.ts).
  const doneCard = page.locator(".sweetie-done-card");
  await expect(doneCard, "both required fields answered").toBeVisible(LOADED);
  // The transcript scrolls itself as messages land, and the card is the last thing in it; without this the
  // committed screenshot is of the middle of the conversation and shows nothing about the end of it.
  await doneCard.scrollIntoViewIfNeeded();
  // The same frame T83's second criterion names, in the spec that writes it (§6.5).
  await expectTranscriptUncut(page, "the end of the check-in");
  await shot(page, "09-sweetie-complete");

  // §2.7's patient view of the same week.
  await page.goto(`/patient/${token}`);
  await expect(page.getByRole("link", { name: /Talk to Sweetie/i })).toBeVisible(LOADED);
  // T63 (§2.7, §6.3): no model key here, so Sour saved this week's numbers with no narrative. Waiting for the
  // patient's own saved summary first, because the claim is about a summary that exists: the page omits the
  // two narrative sections the way it does for any empty pair, rather than rendering the reason as a pattern,
  // and nothing on it names a variable or is addressed to whoever deploys the app.
  await expect
    .poll(async () => (await (await page.request.get(`/api/patient/${token}`)).json()).patientSummary !== null, DRAINED)
    .toBe(true);
  // And the response itself, not just the page: a patient's token gets their own summary and none of the
  // clinician's half of the bundle (§5.2, §10.6, lib/bundle.ts `patientView`). The clinician's copy of this
  // same visit, with its summary and its sign-off, is read further down with a provider session.
  const patientBundle = await (await page.request.get(`/api/patient/${token}`)).json();
  expect(patientBundle.patientSummary, "their own summary is theirs").toBeTruthy();
  expect(patientBundle.providerSummary, "the clinician's narrative and safety flags are not").toBeNull();
  expect(patientBundle.sourJob).toBeNull();
  expect(patientBundle.review).toBeNull();
  await page.reload();
  await expect(page.getByRole("link", { name: /Talk to Sweetie/i })).toBeVisible(LOADED);
  await expect(page.locator(".patient-summary-content")).not.toContainText(/OPENAI|API_KEY/i);
  await expect(page.getByRole("heading", { name: "What your week showed" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Things you might ask your doctor" })).toHaveCount(0);

  // T82 (§2.5, §2.7): this patient shared Dexcom and WHOOP and never a Timeline, which §2.5 allows and
  // Sweetie stops asking about once declined. So there is no place to report against any of their rises,
  // and the page says nothing about places rather than printing the matcher's "no matching visit" down a
  // column that cannot ever say anything else. Asserted on the whole page, not just the table: the glucose
  // card's caption promised "where you had just been" over the same absence.
  const rises = page.locator(".patient-spikes");
  await expect(rises, "the rises this patient did have").toContainText(/\d+ → \d+/);
  await expect(rises.getByRole("columnheader"), "When and Rise, with no Where to draw").toHaveText(["When", "Rise"]);
  await expect(page.locator(".patient-summary-content"), "the matcher's vocabulary on the patient's page")
    .not.toContainText(/no matching visit/i);
  // Matched on "where you" rather than on one clause of it: since T193 the caption's promise is worded
  // from the relations the labelled rises have, and this patient has none at all — so what must not be on
  // the page is any of the three, not just the one it used to be (T193).
  await expect(page.locator(".patient-summary-content"), "a caption promising a column that is not there")
    .not.toContainText(/where you /i);

  // T162 (§2.7): the hero's countdown, pinned to the booking this test made. `bookedFor()` is three
  // calendar days out, so the sentence is "3 days until your visit with …" — it read "4 days" in this
  // spec's own `desktop-journey-10-patient-summary.png` for weeks, because the page divided the gap by
  // 86400000 and ceiled it. Nothing asserted the string, so a wrong number sat in a screenshot both
  // routines read every run. The provider's name comes off the bundle rather than being spelled out: §2.2
  // never asks the wizard for a clinician, so this visit carries lib/visit.ts's fallback, and the claim
  // here is about the count and the wording, not about who the visit is with.
  await expect(COUNTDOWN(page), "three calendar days out, counted as three").toHaveText(
    `3 days until your visit with ${patientBundle.patient.provider.name}.`,
  );
  await shot(page, "10-patient-summary");
  // T87 (§2.7): the charts on this page are read by hovering them, and until this ticket every tooltip
  // read "Glucose : 118 mg/dL" — Recharts' default separator, on a page written in plain English.
  // `pointer: "kept"` because the tooltip is only open while the pointer is on the chart: this is the one
  // subject in the suite that a parked pointer would take out of the frame (T167, e2e/shot.ts).
  await expectChartTooltipsLabelled(page, "the patient's own summary", (chart) =>
    shot(page, `10-patient-summary-tooltip-${chart}`, { ...SCREENFUL, pointer: "kept" }),
  );

  // ---- The clinician reads it, signs it off, prints it (§7.2, §7.3, §7.4) ------------------------------
  await signOutOfBrowser(page);
  const clinician = await signInAs(page, clinicianEmail);
  expect(clinician.role).toBe("clinician");
  expect(clinician.name).toBe(clinicianName);
  // Booking is not a clinician's (§5.2), so the wizard is not on their dashboard; the visit the front desk
  // booked is, with the patient's work on it.
  await expect(page.getByRole("button", { name: /Add patient/i })).toHaveCount(0);
  const clinicianRow = page.locator(".provider-table tbody tr", { hasText: email });
  await expect(clinicianRow).toContainText(patientName, LOADED);

  // T110 (§8.3) The visit was booked on the email channel, and this environment has no email backend: the
  // suite runs the product offline (§11.3), and the ambient AWS credentials of the agents' sandbox are a
  // credential and not a sender. So the invite's one pill is `skipped` — nothing was reached, so there is
  // nothing to retry and nothing to call a failure — and the line under it is the first of T74's pair.
  // Before this ticket the same cell read EMAIL ✕ and "The email did not go out", which was false, and the
  // job behind it spent three attempts getting there. This is the cell the ticket's screenshot is of.
  const invite = clinicianRow.locator(".provider-invite .provider-data-pill").first();
  await expect(invite, "skipped, not failed: there is nothing to retry").toHaveClass(/provider-delivery-skipped/, LOADED);
  await expect(clinicianRow.locator(".provider-delivery-fault")).toContainText(/Sweet Spot cannot send email yet/i);
  expect(await invite.getAttribute("title"), "no variable, credential or backend on a practice's screen").not.toMatch(
    /[A-Z][A-Z0-9]*_[A-Z0-9_]+|\bSES\b|\bAWS\b|credential|verified identity/,
  );

  // Anchored on the Messages cell rather than on the row: the table is `min-width: 1120px` inside an
  // `overflow-x: auto` card, so at 375px a row anchored on itself shows PATIENT and VISIT and leaves this
  // column — the one the step above is about — off the right-hand edge (e2e/shot.ts, `inline`). The desktop
  // project shoots the whole document, so its frame is unchanged.
  await shot(page, "11-clinician-dashboard", { scrollTo: clinicianRow.locator(".provider-invite"), block: "center", inline: "center" });

  // The row offers Sour because there is data and answers to summarize, and no summary yet. Clicking it is
  // what asks for one: the page queues a `sour.run` job and waits for it (§3.4, §7.2).
  await clinicianRow.getByRole("link", { name: /Summarize|Open in Sour/ }).click();
  await expect(page.locator(".sour-brief-header")).toContainText(patientName, LOADED);
  const chip = page.locator(".sour-job-state");
  await expect(chip, "the job reported back").toHaveAttribute("data-phase", "ready", LOADED);
  await expect(chip).toContainText(/Ready/);

  // §12.2's handover, which is the whole journey in one assertion: what the patient typed into Sweetie on
  // their phone is on the clinician's screen, under the numbers from the file they uploaded.
  const brief = page.locator(".sour-brief");
  await expect(brief, "the patient's own words (lib/sweetie.ts renderNotes)").toContainText("new job in August");
  await expect(brief).toContainText("Called about: highs after dinner since the new job");
  // The appointment this brief is for, under the patient's name (§2.2, §7.2).
  await expect(page.locator(".sour-brief-header"), "the booked date, not 'no visit date'").toContainText(
    await asRendered(page, appt.iso, "date", { weekday: "long", month: "short", day: "numeric" }),
  );
  await expect(brief).toContainText(/In range \d+%/);
  await expect(page.getByRole("heading", { name: /Glucose, last \d+ days?/ })).toBeVisible();
  // Recharts draws after it has measured itself, so the chart is the one thing worth waiting for.
  await expect(page.locator(".recharts-surface").first()).toBeVisible(LOADED);
  // T157 (§2.6): the heading over the spike card, which was the constant "Spikes linked to places" over
  // five rows that matched none, beside a stat tile then reading "0 linked to a place" — which T160 below
  // turned into a statement about the missing source. It is a function of the spikes now, so the card is
  // found by that heading (lib/spikePlaces.ts `clinicianSpikeCardHeading`).
  const places = page.locator(".sour-card").filter({ has: page.getByRole("heading", { name: "Spikes over 180" }) });
  await expect(places.getByRole("heading")).toHaveText("Spikes over 180");
  await expect(places.getByRole("heading"), "a link no rise in this card has").not.toContainText(/linked/i);
  // T184 (§2.5, §2.6, §7): and the rows under it, which were the last element of this card to report a
  // lookup on a visit that shared no Timeline. T82 kept "no matching visit" here because it is a true and
  // useful thing to tell a reader who knows what lib/match.ts does — true of a visit whose export was read
  // and matched nothing, which this one is not. So the column is not drawn, the way the patient's page has
  // not drawn it since T82, and the stat tile below is the one element that names the absent source.
  await expect(places.getByRole("columnheader"), "a Place column over an export this visit never had").toHaveText(["When", "Rise"]);
  await expect(places, "the matcher reporting on a search nobody ran").not.toContainText("no matching visit");
  // The card is still the card it was: five of the week's rises, with when and how far each one climbed.
  await expect(places.locator("tbody tr")).toHaveCount(5);
  // T160 (§2.6, §2.5): and the stat tile beside it, which was the last element of that row to state
  // something about places without asking first. This patient shared Dexcom and WHOOP and no Timeline, so
  // the hint names the missing source the way the Sleep tile names its own — it does not report a zero over
  // a file nobody sent. The matched count is asserted on the seeded visit, which has a Timeline
  // (e2e/print.spec.ts).
  const metrics = page.locator(".sour-metrics-card");
  await expect(metrics).toContainText("no Timeline data");
  await expect(metrics, "a count of places over an export this visit never had").not.toContainText(/linked to a place/);
  // T164 (§2.6): the number on that tile. data/dexcom_clarity_sample.csv holds seven rises over 180 and the
  // card above lists the top five, and the tile used to report the five — a count of rows presented as a
  // count of the patient's week. So: the week's figure on the tile, the cap disclosed beneath it, and the
  // summary line at the top of the brief saying the same number as the tile rather than the table's.
  const spikeTile = metrics.locator(".summary-stat-tile", { hasText: "Spikes > 180" });
  await expect(spikeTile.locator(".text-2xl")).toHaveText("7");
  await expect(spikeTile, "a clinician reading 7 over five rows is told why").toContainText("top 5 shown");
  await expect(page.locator(".sour-overview-card")).toContainText("7 spikes");
  await expect(page.locator(".sour-overview-card"), "the summary line's old count of the table's rows").not.toContainText("5 spikes");
  // The pair the ticket is about, read across the row: this patient shared WHOOP, so the Sleep tile reports
  // the nights it read. Both branches of the same rule in one row — a source that is there is measured, a
  // source that is not is named. The both-absent pair is asserted on the Dexcom-only visit (e2e/flags.spec.ts).
  await expect(metrics, "the Sleep tile still reports the WHOOP this patient did share").toContainText("h/night");
  // T99 (§2.6): and the chart beside that card says the same thing about the same five rises. The caption
  // used to call every red marker a place; with no Timeline shared, every label on it is a peak mg/dL.
  const caption = page.locator(".sour-chart-caption");
  await expect(caption).toContainText("peak mg/dL");
  await expect(caption, "a place promised over markers that are numbers").not.toContainText("the place the patient had just left");
  // T184 (§2.5, §2.6): the other half of that sentence, which T99 wrote before `hasLocation` was available
  // to it. It reported that a match had been run and come back empty — four inches under a tile saying no
  // Timeline was ever shared. The caption owns what a label is and stops there.
  await expect(caption, "an empty lookup on a visit with nothing to look in").not.toContainText("no place matched");
  await expect(caption, "the tile owns the absent source, and says it once").not.toContainText(/Timeline/i);
  await expect(caption).toContainText("Labels, where they fit, give the peak mg/dL.");
  // T165 (§2.6): and the sentence in front of that one. The chart draws a marker per listed rise — five —
  // under a tile reading 7, so the caption names both numbers rather than calling the five "spikes" and
  // leaving a clinician to count them against the tile.
  await expect(caption, "five markers under a tile reading 7, unexplained").toContainText("the 5 largest rises of 7 spikes");
  // T195: the §12.2 handover reaches a brief with no assistant behind it, so there is no composer on it —
  // the journey's own frame of the change, beside the caveat four cards up that it agrees with
  // (lib/sourState.ts `askSourClosedNote`). T153's placeholder on a visit with both exports is pinned in
  // lib/sourState.test.ts; no brief this suite's servers *save* carries a live composer to read it off,
  // which is the point — e2e/followup.spec.ts reaches one by putting the other state on the wire.
  await expect(page.locator(".sour-ask-card .sour-ask-closed")).toContainText(/Assistant not configured/i);
  await expect(page.getByLabel("Message Sour")).toHaveCount(0);
  // T174 (§6.3, §7, §12.2): the footer of the frame this ticket was filed from. This run has no model key,
  // so Sour saved the numbers with both narrative lists empty — and the line under them may not tell the
  // clinician the page was AI-generated. Every figure above it is code's (lib/sour.ts, lib/glucose.ts), and
  // "AI-generated" over them discounts the one part of the brief that is not a guess (lib/disclaimer.ts).
  await expect(page.locator(".sour-brief")).toContainText("Not generated.");
  const briefCaveat = page.locator(".sour-disclaimer");
  await expect(briefCaveat, "the claim T174 was filed for").not.toContainText(/AI-generated/i);
  await expect(briefCaveat).toContainText("Computed from patient-uploaded data; no model wrote any of it");
  await expect(briefCaveat, "nobody has signed this one off yet — the §7.3 sign-off is two shots below")
    .toContainText("No clinician has reviewed this before you");
  await expect(briefCaveat).toContainText("it flags, it does not diagnose");
  await shot(page, "12-sour-brief");
  // T157 (§12.3): the card itself, at both widths. The desktop project shoots the document, so the brief's
  // own frame already holds it; at 375px it is several screens below the fold, and the heading over those
  // five rises is the subject of the ticket, so it gets a frame of its own. T184 is in the same frame: the
  // card is When and Rise now, with the place column this visit has nothing to fill gone from under it.
  await shot(page, "12-sour-spikes-unplaced", { ...SCREENFUL, scrollTo: places });
  // T160 (§12.3): the metrics row itself, which is the subject of that ticket and is read across rather
  // than down — the Spikes tile and the Sleep tile have to be in one frame to see that they now agree. The
  // desktop project shoots the document, so the brief's own frame holds the row; this gives it a readable
  // one at both widths.
  await shot(page, "12-sour-metrics-no-timeline", { ...SCREENFUL, scrollTo: metrics });
  // T165 (§12.3): the chart card, which is this ticket's subject on the brief. The caption and the five red
  // markers it describes have to be in one frame to see that they agree, and the tile they are reconciled
  // with is the card the frame opens under. The desktop project shoots the document, so the brief's own
  // frame holds the card; at 375px it is below the fold, as the two cards above it are.
  // T197 (§2.6, §6.5): `mobile-journey-12-sour-chart-caption.png` is the second of the four frames the
  // ticket was filed from, and the caption asserted just above is the sentence it broke: labels "where
  // they fit" over a chart that had placed one where it did not.
  await expectMarkerLabelsClearOfMarkers(page, "the journey's brief", { someDropped: true });
  await shot(page, "12-sour-chart-caption", { ...SCREENFUL, scrollTo: ".sour-chart-card" });
  // T87 again, on the second of the three surfaces the same two components are drawn on (§2.6).
  await expectChartTooltipsLabelled(page, "the clinician's brief", (chart) =>
    shot(page, `12-sour-brief-tooltip-${chart}`, { ...SCREENFUL, pointer: "kept" }),
  );

  // §7.3: the sign-off, by the clinician who read it.
  await page.getByRole("button", { name: "Mark reviewed" }).click();
  const record = page.locator(".sour-reviewed");
  await expect(record).toContainText(/Reviewed by/i, LOADED);
  await expect(record).toContainText(clinicianName);
  await shot(page, "13-sour-reviewed");

  // And on the dashboard behind it (§4.4, §7.3), which is where the practice sees it.
  await page.goto("/provider");
  const reviewed = page.locator(".provider-table tbody tr", { hasText: email });
  await expect(reviewed).toContainText("Reviewed", LOADED);
  await expect(reviewed.locator(".provider-reviewed-by")).toContainText(clinicianName);
  // T178: the practice now holds exactly one summary — this one, whose `patterns` and `questions` are
  // empty because the suite runs with no model gateway (§6.3, §11.3) and whose own footer says in as many
  // words that no model wrote it (lib/disclaimer.ts, asserted above). The dashboard's footer is the staff
  // half of that handover — §5.2 never gives the front desk a brief — so it may not sign the practice's
  // summaries off as AI-generated either. What it says instead is true of this summary and of a practice
  // with none (e2e/roles.spec.ts).
  const dashFooter = page.locator(".provider-footer");
  await expect(dashFooter).toContainText("Verify every summary before acting on it");
  await expect(dashFooter, "the claim T178 was filed for").not.toContainText(/AI-generated/i);
  await shot(page, "14-dashboard-reviewed", {
    scrollTo: reviewed.locator(".provider-stage-cell"),
    block: "center",
    inline: "center",
  });

  // §7.4: the sheet for the appointment itself. e2e/print.spec.ts is where the paper is checked; the journey
  // asks the one question it is here to ask — that the sheet carries this patient's week and their own words.
  const visitId = await (async () => {
    const rows = (await (await page.request.get("/api/provider")).json()) as { visits: { id: string; email: string | null }[] };
    return rows.visits.find((v) => v.email === email)?.id;
  })();
  expect(visitId, "the visit the journey booked").toBeTruthy();
  const sheet = await page.goto(`/provider/visit/${visitId}/print`);
  expect(sheet?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: patientName })).toBeVisible(LOADED);
  await expect(page.locator(".sour-print-sheet")).toContainText("Follow-up");
  // The same appointment on paper: the instant for anything machine-read, and the clinician's own zone in
  // the words beside it (app/provider/visit/[id]/print/localTime.tsx).
  await expect(page.locator(".sour-print-header time").first(), "the booked date, not 'no visit date'").toHaveAttribute("datetime", appt.iso);
  await expect(page.locator(".sour-print-header")).toContainText(
    await asRendered(page, appt.iso, "dateTime", { weekday: "long", month: "short", day: "numeric" }),
  );
  // T86 (§7.4, §7.3): the wizard never asked for a clinician (§2.2), so this sheet is the unassigned one —
  // and it still names a clinician of this practice rather than "your care team", the words the patient's own
  // pages use. The banner above names the colleague who signed it off; the header may not answer "nobody" to
  // the same question (lib/visit.ts clinicianLine).
  await expect(page.locator(".sour-print-clinician")).toHaveText(clinicianName);
  await expect(page.locator(".sour-print-header"), "the patient's words on the clinician's document").not.toContainText(/your care team/i);
  // On the block the phone's shot is anchored on below, not just somewhere on the sheet: what the patient
  // told Sweetie is the handover §12.2 is about, so the picture has to hold it (T109).
  await expect(page.locator(".sour-print-words")).toContainText("new job in August");
  await expect(page.locator(".sour-print-numbers")).toContainText("Time in range");
  // T99 (§7.4): the sheet carries the screen's caption, out of lib/spikePlaces.ts, so the paper cannot
  // promise a place the brief does not.
  const printCaption = page.locator(".sour-chart-caption");
  await expect(printCaption).toContainText("peak mg/dL");
  await expect(printCaption).not.toContainText("the place the patient had just left");
  // T184 (§7.4): the same two words off the paper, out of the same function — this is the copy a clinician
  // carries into the room, and it carried all three of the contradicting elements.
  await expect(printCaption).not.toContainText("no place matched");
  await expect(printCaption).toContainText("Labels, where they fit, give the peak mg/dL.");
  // T165 (§7.4): the same disclosure on the copy that leaves the building, out of the same function.
  await expect(printCaption).toContainText("the 5 largest rises of 7 spikes");
  // T157 (§7.4): and the heading over the spike card, which is the half of that bug the brief did not have
  // to itself — this is the copy a clinician carries into the room. Same function as the screen, so the two
  // cannot say different things about the same five rises (lib/spikePlaces.ts).
  const printPlaces = page.locator(".sour-card").filter({ has: page.getByRole("heading", { name: "Spikes over 180" }) });
  await expect(printPlaces.getByRole("heading")).toHaveText("Spikes over 180");
  await expect(printPlaces.getByRole("heading"), "a link no rise on this sheet has").not.toContainText(/linked/i);
  // T184 (§7.4): and the five cells under it, which said the same as the brief's and had to stop for the
  // same reason. Same function behind both surfaces (lib/spikePlaces.ts `clinicianPlaceColumn`).
  await expect(printPlaces.getByRole("columnheader"), "a Where column over an export this visit never had").toHaveText(["When", "Rise"]);
  await expect(printPlaces, "the matcher reporting on a sheet whose visit has no Timeline").not.toContainText("no matching visit");
  await expect(printPlaces.locator("tbody tr")).toHaveCount(5);
  // T160 (§7.4): the stat tile on the paper, for the reason the heading above is asserted here — the sheet
  // is what a clinician carries into the room, and it read the same unconditional count the screen did.
  const printNumbers = page.locator(".sour-print-numbers");
  await expect(printNumbers).toContainText("no Timeline data");
  await expect(printNumbers, "a count of places on a sheet whose visit has no Timeline").not.toContainText(/linked to a place/);
  // T164 (§7.4): the same tile on the paper, which is the copy that leaves the building. Same seven rises,
  // same five rows, one function behind both (lib/spikePlaces.ts) — so the sheet cannot understate a week
  // the screen states correctly.
  const printSpikeTile = printNumbers.locator(".summary-stat-tile", { hasText: "Spikes > 180" });
  await expect(printSpikeTile.locator(".text-2xl")).toHaveText("7");
  await expect(printSpikeTile).toContainText("top 5 shown");
  await expect(printNumbers, "the Sleep tile on paper, over the WHOOP this patient did share").toContainText("h/night");
  await expect(page.locator(".recharts-surface").first()).toBeVisible(LOADED);
  // T174 (§7.4, §7.3): the same sentence at the foot of the sheet, and the branch the brief above could not
  // show — this visit has since been signed off, so the degraded footer still names the clinician who read
  // it. That is the half of §7.3 this ticket had to keep while dropping the claim beside it.
  const sheetCaveat = page.locator(".sour-print-footer");
  await expect(sheetCaveat, "the claim T174 was filed for").not.toContainText(/AI-generated/i);
  await expect(sheetCaveat).toContainText("Computed from patient-uploaded data; no model wrote any of it");
  await expect(sheetCaveat, "§7.3's sign-off crosses this branch too").toContainText(`Reviewed by ${clinicianName}`);
  await expect(sheetCaveat).toContainText("it flags, it does not diagnose");
  // The patient's own words at the bottom of the frame, with the patterns and the questions above them
  // (T109, design §12.3): the sheet at 375px is several phone screens, and unanchored this shot was the
  // title block and two stat tiles — a picture of the one part of the handover nobody is checking.
  await shot(page, "15-print-sheet", { scrollTo: ".sour-print-words", block: "end" });
  // T157 (§12.3), for the reason the brief's own card got a frame: the sheet is anchored on the patient's
  // words above, so at 375px the spike card is off the bottom of that one and the heading this ticket is
  // about is in no committed picture of the paper.
  await shot(page, "15-print-spikes-unplaced", { ...SCREENFUL, scrollTo: printPlaces });
  // T160 (§12.3): the same row on paper, anchored for the same reason the brief's is — the sheet is
  // anchored on the patient's words above, so without this frame the two tiles this ticket is about are in
  // no committed picture of the printed one-pager.
  await shot(page, "15-print-metrics-no-timeline", { ...SCREENFUL, scrollTo: printNumbers });
  // And the third (§7.4). The sheet is read on screen before it is sent to paper, so its charts have
  // tooltips like the other two; nothing here is about what the printer puts on the page.
  await expectChartTooltipsLabelled(page, "the printed sheet");

  // One last look at the state behind all of it: the visit is reviewed, the sign-off names the clinician and
  // not the staff account that booked it, and the intake is recorded as complete.
  const bundle = (await (await page.request.get(`/api/patient/${visitId}`)).json()) as {
    visitStatus: string;
    review: { by: string; byName: string } | null;
    status: { done: boolean; hasDexcom: boolean; hasWhoop: boolean; answered: number };
    intakeConsentAt: string | null;
  };
  expect(bundle.visitStatus).toBe("reviewed");
  expect(bundle.review?.by).toBe(clinician.id);
  expect(bundle.review?.byName).toBe(clinicianName);
  expect(bundle.status).toMatchObject({ done: true, hasDexcom: true, hasWhoop: true });
  expect(bundle.status.answered).toBeGreaterThanOrEqual(2);
  expect(bundle.intakeConsentAt, "§2.4's acceptance, stored on the visit").toBeTruthy();

  // The code really was sent (§2.3, §5.3): it is in the patient's mailbox, not merely offered on screen.
  // The invite is the other half of that pair and this environment could not send it — which is what the
  // wizard said at the top of this test and what the delivery row said in the middle — so the two messages
  // part company here. The code is the one §5.3 cannot continue without, so lib/mailer.ts diverts it to the
  // local mailbox when there is nothing to send with; the invite fails soft and the UI shows the link (§8.1).
  expect(latestCode(email), "the six-digit code went to the address on file").toBeTruthy();
});

// The other half of §5.2 along this journey: the two roles that are not the clinician's cannot do a
// clinician's half of it, through the API rather than the screens. e2e/roles.spec.ts proves this for a
// practice's visits in general; here it is a visit of this journey's own making, in a practice this test
// invites into existence the way the journey above does, so the refusals are checked on the shape of visit
// this spec books rather than on a seeded one.
test("the summary on a journey visit is the clinician's alone", async ({ page }) => {
  const adminEmail = freshEmail("journey-guard-admin", "journey-guard.com");
  const staffEmail = freshEmail("journey-guard-desk", "journey-guard.com");
  await signInAs(page, adminEmail);
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible(LOADED);
  expect((await postJson(page.request, "/api/practice/users", { email: staffEmail })).ok(), "the admin invites the front desk").toBeTruthy();

  const email = patientEmail("journey guarded");
  const booked = (await (
    await postJson(page.request, "/api/book", { name: "Journey Guarded", email, visitType: "follow_up", channel: "none" })
  ).json()) as { visitId: string };
  expect(booked.visitId).toBeTruthy();

  // Staff books and invites, and that is where it stops: a summary is clinical, and so is a sign-off (§7.3).
  await signOutOfBrowser(page);
  const staff = await signInAs(page, staffEmail);
  expect(staff.role).toBe("staff");
  for (const [what, status] of [
    ["GET /api/patient", (await page.request.get(`/api/patient/${booked.visitId}`)).status()],
    ["POST /api/sour", (await postJson(page.request, "/api/sour", { visitId: booked.visitId })).status()],
    ["POST /api/review", (await postJson(page.request, "/api/review", { visitId: booked.visitId })).status()],
  ] as const) {
    expect(status, `${what} as staff on a visit in their own practice`).toBe(403);
  }
  // The sheet is a page, and a page is a door and not a lock (§5.2, T17): staff are sent back to the
  // dashboard they may read rather than shown a sheet they may not.
  await page.goto(`/provider/visit/${booked.visitId}/print`);
  await expect(page).toHaveURL(/\/provider(\?|$|\/)/);
  await expect(page).not.toHaveURL(/print/);
});
