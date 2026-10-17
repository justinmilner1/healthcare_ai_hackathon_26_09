import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { postJson } from "./api";
import { freshEmail, signInAs, signOutOfBrowser } from "./auth";
import { AGREE, enterCode, latestCode, patientEmail } from "./patient";

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

/** Screenshots are numbered, because the point of these is the order (§12.3). */
const shot = async (page: Page, name: string) => {
  await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-journey-${name}.png`, fullPage: true });
};

// Waits for a client fetch to paint, not for app logic: these pages render a shell and fill it in after.
const LOADED = { timeout: 30_000 };

/** The patient's week, as a patient would have it: files picked on the intake screen (§3.3, §9.1). */
const sample = (name: string) => readFileSync(join(process.cwd(), "data", name));

test("the whole journey: staff books, the patient checks in, the clinician signs it off and prints it", async ({ page }) => {
  // Eleven screens across three identities and two flows, each sign-in waiting on a mailbox. The per-test
  // default of 60s is for a test that drives one of them; this one needs the budget of the journey it is.
  test.setTimeout(240_000);

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
  await shot(page, "02-staff-dashboard");

  // The wizard, step by step, because this is the screen the appointment is made on (e2e/visits.spec.ts
  // drives its refusals; this is the path through it).
  const patientName = `Journey Patient ${Date.now().toString(36)}`;
  const email = patientEmail("journey patient");
  await page.getByRole("button", { name: /Add patient/i }).first().click();
  await page.getByLabel("Patient name").fill(patientName);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: /Continue/i }).click();

  await page.getByText("Follow-up", { exact: true }).click();
  await page.getByLabel(/What did the patient call about/i).fill("highs after dinner since the new job");
  await page.getByRole("button", { name: /Continue/i }).click();

  // §2.2's channel and the consent behind it: the link is emailed, so there has to be a record of the patient
  // agreeing to be emailed. Nothing is sent without one — the route refuses it (lib/visitIntake.ts).
  await expect(page.getByText("Contact channel")).toBeVisible();
  // By the card's own words, exactly: the radio inside it is `opacity: 0`, and `hasText` would take
  // "Text and email" as well, since it matches a case-insensitive substring.
  await page.getByText("Email", { exact: true }).click();
  await page.getByLabel(/How did the patient agree to be contacted/i).selectOption("phone");
  await shot(page, "03-add-visit");
  await page.getByRole("button", { name: /Add patient & send/i }).click();

  // The link on the success card is the one that was emailed, and it is the patient's way in from here on.
  await expect(page.locator(".patient-wizard-success")).toContainText(/on the way/i, LOADED);
  const link = await page.locator(".patient-link-card a").innerText();
  const token = link.split("/s/")[1]?.trim();
  expect(token, `a /s/<token> link on the success card, got ${link}`).toBeTruthy();
  await shot(page, "04-invite-sent");

  await page.getByRole("button", { name: /Back to dashboard/i }).click();
  const row = page.locator(".provider-table tbody tr", { hasText: email });
  await expect(row, "§4.4's first stage").toContainText("Invited", LOADED);

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
  await shot(page, "09-sweetie-complete");

  // §2.7's patient view of the same week.
  await page.goto(`/patient/${token}`);
  await expect(page.getByRole("link", { name: /Talk to Sweetie/i })).toBeVisible(LOADED);
  // T63 (§2.7, §6.3): no model key here, so Sour saved this week's numbers with no narrative. Waiting for the
  // patient's own saved summary first, because the claim is about a summary that exists: the page omits the
  // two narrative sections the way it does for any empty pair, rather than rendering the reason as a pattern,
  // and nothing on it names a variable or is addressed to whoever deploys the app.
  await expect
    .poll(async () => (await (await page.request.get(`/api/patient/${token}`)).json()).patientSummary !== null, { timeout: 60_000 })
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
  await shot(page, "10-patient-summary");

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
  await shot(page, "11-clinician-dashboard");

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
  await expect(brief).toContainText(/In range \d+%/);
  await expect(page.getByRole("heading", { name: /Glucose, last \d+ days/ })).toBeVisible();
  // Recharts draws after it has measured itself, so the chart is the one thing worth waiting for.
  await expect(page.locator(".recharts-surface").first()).toBeVisible(LOADED);
  await shot(page, "12-sour-brief");

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
  await shot(page, "14-dashboard-reviewed");

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
  await expect(page.locator(".sour-print-sheet")).toContainText("new job in August");
  await expect(page.locator(".sour-print-numbers")).toContainText("Time in range");
  await expect(page.locator(".recharts-surface").first()).toBeVisible(LOADED);
  await shot(page, "15-print-sheet");

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

  // The invite really was emailed (§2.2's channel, §8.1's sender): the patient's mailbox holds the link the
  // staff member sent as well as the code they asked for by opening it. Sent, not merely offered on screen.
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
