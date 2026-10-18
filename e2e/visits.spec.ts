import { expect, test } from "@playwright/test";
import { postJson } from "./api";
import { freshEmail, signInAs, signInAsDemo, signOutOfBrowser } from "./auth";
import { MODAL, shot } from "./shot";

// T07 (design §2.2, §4.4, §8.3): the two ways a practice creates visits, driven through the screens staff
// actually use. One at a time in the wizard, with the contact channel and the recorded consent §2.2 asks for;
// a day at a time from a CSV, previewed row by row before anything is written. Then the dashboard, which has
// to show the visit's own §4.4 status and what each channel did with the invite (§8.3).
//
// Nothing here stubs a session: each identity signs in by its own magic link (§5.1, e2e/auth.ts). Every
// state-changing API call goes through postJson, which echoes the CSRF cookie the way the pages do (§10.8).

// The dashboard paints its shell and fills in from GET /api/provider; a slow runner takes longer than the 5s
// default to come back, so the waits for that data get their own budget.
const LOADED = { timeout: 30_000 };

/** A name nothing else in the run will use: two Playwright projects share one database. */
const uniqueName = (prefix: string) => `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

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
  await shot(page, "provider-add-visit-consent", MODAL);
  await page.getByRole("button", { name: /Add patient & send/i }).click();
  await expect(page.locator(".ss-error")).toContainText(/consent/i, LOADED);

  await page.getByLabel(/How did the patient agree to be contacted/i).selectOption("phone");
  await page.getByRole("button", { name: /Add patient & send/i }).click();

  await expect(page.locator(".patient-wizard-success")).toContainText(/on the way/i, LOADED);
  await expect(page.locator(".patient-link-card")).toContainText("/s/");
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
      { timeout: 30_000 },
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
  // Messages and Actions are off to the right until the shot asks for them (T57).
  await shot(page, "provider-dashboard-visit-statuses", {
    scrollTo: row.locator(".provider-invite"),
    block: "center",
    inline: "center",
  });
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
  // MODAL at either width: this is a dialog over the dashboard, and a full-page shot anchors at the top of
  // a very tall document, which cut the dialog's own header off above the image (T57).
  //
  // MODAL alone is not enough here, though: `.import-scroll` is the dialog's own scrolling body (one
  // scrolling body with the actions fixed under it, app/provider/dashboard.tsx), and pasting the rows
  // leaves it scrolled past its header — so the shot still began mid-sentence at "sends them a code." with
  // the title above the fold of the dialog rather than of the page. The scroller goes back to the top
  // rather than its header being scrolled into view, because `scrollIntoView` aligns the header's box to
  // the scrollport and still cut the eyebrow and the cap-heights off the title.
  await page.locator(".import-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });
  await shot(page, "provider-import-preview", MODAL);

  const beforeImport = (await (await page.request.get("/api/provider")).json()) as { visits: { name: string }[] };
  expect(beforeImport.visits.some((v) => v.name === goodName), "the preview writes nothing").toBeFalsy();

  await page.getByRole("button", { name: /Create 3 visits/i }).click();
  await expect(page.locator(".import-tally")).toContainText("3 created", LOADED);
  await shot(page, "provider-import-created", MODAL);
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
