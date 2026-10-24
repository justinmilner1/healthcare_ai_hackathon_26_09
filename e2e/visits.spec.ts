import { expect, test } from "@playwright/test";
import { cannotSendYet } from "../lib/delivery";
import { SENDABLE_PORT } from "../playwright.config";
import { postJson } from "./api";
import { freshEmail, signInAs, signInAsDemo, signOutOfBrowser } from "./auth";
import { LOADED } from "./budget";
import { MODAL, SCREENFUL, shot } from "./shot";

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

test("staff add a visit in the wizard, with a channel and a recorded consent", async ({ page }) => {
  await signInAsDemo(page);
  await expect(page.locator("body")).toContainText("Sam Sample", LOADED);

  const name = uniqueName("Wizard Patient");
  await page.getByRole("button", { name: /Add patient/i }).first().click();

  // Step 1: who the visit is for.
  await page.getByLabel("Patient name").fill(name);
  await page.getByLabel("Mobile number").fill(uniquePhone());
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
  await shot(page, "provider-add-visit-consent", MODAL);

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
  await shot(page, "provider-add-visit-unsent", MODAL);
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
  const phone = uniquePhone();
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
  await shot(page, "provider-add-visit-sendable", MODAL);

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
  await shot(page, "provider-add-visit-sent", MODAL);
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
