import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { csrfToken, postJson } from "./api";
import { freshEmail, signInAs, signInAsDemo, signOutOfBrowser } from "./auth";
import { LOADED } from "./budget";
import { patientEmail, verifyByApi } from "./patient";
import { shot } from "./shot";

// T17 (design §7.4): "a clean one-pager with no navigation, used by the Print button and by a
// GET /provider/visit/[id]/print route".
//
// Two halves, one per sentence. The first builds a visit with everything on it — glucose, places, sleep —
// summarizes it through the screen a clinician uses, then opens the sheet and checks that what is on it is
// the summary and nothing else: no sidebar, no patient list, no buttons that change anything, no chat. The
// print CSS is checked the only way that means anything, by asking the browser for the paper: a screenshot
// under print media and a PDF export, whose page count is what "one-pager" has to mean.
//
// The second half is §5.2 on this route. A page is a door and not a lock, so it answers the way
// GET /api/patient/[id] answers: the sign-in page with no session, the dashboard for a staff account, and
// 404 — never 403 — for a visit in another practice.
//
// The uploads go through `request` rather than `page.request`: the patient's credential is the token plus
// the verified session the six-digit code leaves behind (§5.3), and keeping the two contexts apart means the
// provider stays signed in for the half of the test that is the clinician's.

test("the Print button opens a sheet: the summary, with no navigation on it, on one printed page", async ({ page, request }) => {
  const demo = await signInAsDemo(page);
  const email = patientEmail("E2E Printer");
  // With an appointment on it, so the sheet's header prints the date the visit is for — the one thing on it
  // that is formatted in the reader's own zone rather than the server's (print/localTime.tsx).
  const apptAt = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  const booked = (await (
    await postJson(page.request, "/api/book", { name: "E2E Printer", email, providerId: demo.id, apptAt, visitType: "follow_up", reason: "highs after dinner", channel: "none" })
  ).json()) as { visitId: string; token: string };
  expect(booked.visitId).toBeTruthy();

  await verifyByApi(request, booked.token, email);
  // All three sources, so the sheet has every card on it and the screenshot shows the whole layout.
  const upload = async (kind: string, path: string, name: string, mimeType = "text/csv") => {
    const res = await request.post("/api/upload", {
      headers: { "x-csrf-token": await csrfToken(request) },
      multipart: { token: booked.token, kind, file: { name, mimeType, buffer: readFileSync(path) } },
    });
    expect(res.ok(), `${kind} upload: ${res.status()}`).toBeTruthy();
  };
  await upload("dexcom", "data/dexcom_clarity_sample.csv", "clarity.csv");
  await upload("timeline", "data/timeline_sample.json", "Timeline.json", "application/json");
  await upload("whoop", "data/whoop_sample.csv", "cycles.csv");

  // Opening a visit with data and no summary generates one (app/provider/[id]/sour.tsx); the chip reading
  // Ready is the `sour.run` job having reported back (§7.2), which is what there is to print.
  await page.goto(`/provider/${demo.id}?visit=${booked.visitId}`);
  await expect(page.locator(".sour-brief-header")).toContainText("E2E Printer", LOADED);
  await expect(page.locator(".sour-job-state")).toHaveAttribute("data-phase", "ready", LOADED);

  // §7.4's "used by the Print button": it is a link to the route now, opening in its own tab so the
  // clinician keeps the working summary, and `auto=1` is the dialog they already asked for.
  const printLink = page.getByRole("link", { name: "Print" });
  await expect(printLink).toHaveAttribute("href", `/provider/visit/${booked.visitId}/print?auto=1`);
  await expect(printLink).toHaveAttribute("target", "_blank");

  // §7.4's "GET /provider/visit/[id]/print": the bare URL, which is the one that is safe to screenshot —
  // nothing opens a dialog without the `auto` the button adds.
  const opened = await page.goto(`/provider/visit/${booked.visitId}/print`);
  expect(opened?.status(), "the sheet is a page a signed-in clinician may open").toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "E2E Printer" })).toBeVisible(LOADED);
  await expect(page.locator(".sour-print-sheet")).toBeVisible();

  // "No navigation", item by item: the sidebar and its patient list, the brand that links home, the back
  // link, and every control that would change something.
  for (const gone of [".sour-summary-sidebar", ".sour-patient-list", ".persona-brand", ".sour-brief-actions", ".sour-ask-card", ".sour-job-state"]) {
    await expect(page.locator(gone), `${gone} is screen furniture and does not belong on the sheet`).toHaveCount(0);
  }
  for (const name of [/Generate/, /Regenerate/, /Mark reviewed/, /Send link/, /All patients/]) {
    await expect(page.getByRole("button", { name }), `${name} on the sheet`).toHaveCount(0);
    await expect(page.getByRole("link", { name }), `${name} on the sheet`).toHaveCount(0);
  }
  // Nothing to type into and nothing to tick: the questions are boxes for a pen (§7.4's "clean one-pager").
  await expect(page.locator("input, textarea, select")).toHaveCount(0);

  // What is left is the summary: the numbers, the patterns, the questions, the patient's own words, and the
  // charts the clinician reads off the paper.
  await expect(page.locator(".sour-print-sheet")).toContainText("Follow-up");
  await expect(page.locator(".sour-print-header time").first(), "the appointment date, not 'no visit date'").toHaveAttribute("datetime", apptAt);
  await expect(page.locator(".sour-print-sheet")).toContainText("Called about:");
  await expect(page.locator(".sour-print-numbers")).toContainText("Time in range");
  await expect(page.locator(".sour-print-tir-value")).toContainText("%");
  await expect(page.getByRole("heading", { name: "Patterns" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ask the patient" })).toBeVisible();
  await expect(page.locator(".sour-print-questions li").first()).toBeVisible();
  // T96 (§6.3, §7.4): the sheet carries the same sentence as the screen, out of lib/sourState.ts — and this
  // suite runs with no model key, so this is the one it carries. It says the state and names the person who
  // can act on it; it does not send the clinician holding the paper to a practice setting that is not there.
  const narrativeNote = page.locator(".sour-print-narrative-note");
  await expect(narrativeNote).toContainText(/Assistant not configured/i);
  await expect(narrativeNote).toContainText(/the numbers are complete/i);
  await expect(narrativeNote).toContainText(/ask whoever set Sweet Spot up for your office/i);
  await expect(narrativeNote).not.toContainText(/administrator|turn it on/i);
  await expect(page.getByRole("heading", { name: /Glucose, last \d+ days?/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Spikes linked to places" })).toBeVisible();
  // T62: this visit has a Timeline export and no hand-labelled place list beside it, which is all a patient
  // can actually send (§9.3). Every place on the sheet is therefore the visit's own coordinates — Google's
  // internal place id is not a place name, and a clinician holding this paper cannot read one.
  const sheet = page.locator(".sour-print-sheet");
  await expect(sheet, "a Google place id on the sheet a clinician holds").not.toContainText(/ChIJ/);
  await expect(sheet, "the 'Where' column names each place by its coordinates instead").toContainText(/-?\d+\.\d{3}, -?\d+\.\d{3}/);
  // T99 (§7.4): this visit has a Timeline, so some rises are placed and some are not — and the caption says
  // both, rather than calling every marker a place. It is the brief's own string (lib/spikePlaces.ts).
  const caption = page.locator(".sour-chart-caption");
  await expect(caption).toContainText("the place the patient had just left");
  await expect(caption).toContainText("peak mg/dL");
  await expect(caption, "colliding labels are dropped, so not every marker carries one").toContainText("Labels, where they fit,");
  // Recharts draws after it has measured itself, so the chart is the one thing worth waiting for.
  await expect(page.locator(".recharts-surface").first()).toBeVisible(LOADED);
  await shot(page, "provider-print");

  // The print CSS, as the browser applies it: the toolbar goes, the sheet becomes the page.
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".sour-print-toolbar")).toBeHidden();
  await expect(page.locator(".sour-print-sheet")).toBeVisible();
  await shot(page, "provider-print-media");
  await page.emulateMedia({ media: null });

  // And as paper. page.pdf is headless Chromium's own print pipeline, so this is the acceptance criterion's
  // "print CSS verified in a PDF export" rather than a stand-in for it. Desktop only: the mobile project is
  // a phone profile, and a phone does not print.
  if (test.info().project.name === "desktop") {
    const pdf = await page.pdf({ path: "e2e/screenshots/desktop-provider-print.pdf", format: "A4", printBackground: true });
    expect(pdf.byteLength, "the export should have the sheet in it").toBeGreaterThan(10_000);
    const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pages, "Chromium writes one /Type /Page per sheet").toBeGreaterThan(0);
    expect(pages, "a one-pager: two sides at the very most, charts and all").toBeLessThanOrEqual(2);
  }
});

test("a visit with no clinician's name on it prints the practice's words for that, not the patient's", async ({ page }) => {
  // T86 (§7.4, §5.1). The ordinary sheet, not an edge case: §2.2 never asks the wizard for a clinician, so
  // `POST /api/book` puts the account that booked on the visit, and an account signed in by magic link has
  // no name on its row until someone gives it one (lib/authAdapter.ts) — which is what the front desk an
  // admin invites by email looks like (e2e/journey.spec.ts books through exactly that account, and its
  // printed sheet is where this was found). The patient's own pages call the practice "your care team" in
  // that state (lib/visit.ts CARE_TEAM) and are right to; a one-pager that goes in a chart is read by the
  // practice, and the practice is not the patient.
  const me = await signInAs(page, freshEmail("print-nameless", "nameless-print.com"));
  expect(me.name, "a magic-link account starts with no name of its own (§5.1)").toBeFalsy();
  const email = patientEmail("E2E Nameless Booking");
  const booked = (await (
    await postJson(page.request, "/api/book", { name: "E2E Nameless Booking", email, visitType: "follow_up", reason: "booked by an account with no name", channel: "none" })
  ).json()) as { visitId: string };
  expect(booked.visitId).toBeTruthy();

  const opened = await page.goto(`/provider/visit/${booked.visitId}/print`);
  expect(opened?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "E2E Nameless Booking" })).toBeVisible(LOADED);
  await expect(page.locator(".sour-print-clinician")).toHaveText("No clinician recorded");
  const header = page.locator(".sour-print-header");
  await expect(header, "the patient's words on the clinician's document").not.toContainText(/your care team/i);
  await expect(header, "and nothing else on the header addresses the reader as the patient").not.toContainText(/\byour\b/i);
  // Still §7.4's sheet: the practice above the line, the print stamp below it, and no navigation anywhere.
  await expect(page.locator(".sour-print-meta strong")).toHaveText(me.practice!);
  await expect(page.locator(".sour-print-meta time")).toBeVisible();
  for (const gone of [".sour-summary-sidebar", ".sour-patient-list", ".persona-brand", ".sour-brief-actions"]) {
    await expect(page.locator(gone), `${gone} does not belong on the sheet`).toHaveCount(0);
  }
  await shot(page, "provider-print-no-clinician");
});

test("the sheet is a clinician's: signed out, staff, and another practice all get the answer the API gives", async ({ page }) => {
  // Another practice's visit is a 404 and not a 403, because a 403 would confirm it exists (§5.2).
  await signInAsDemo(page);
  const theirs = (await (await page.request.get("/api/provider")).json()) as { visits: { id: string; name: string }[] };
  const sam = theirs.visits.find((v) => v.name === "Sam Sample");
  expect(sam, "npm run seed creates Sam Sample's visit").toBeTruthy();

  await signOutOfBrowser(page);
  await signInAs(page, freshEmail("print-stranger", "elsewhere-print.com"));
  const refused = await page.goto(`/provider/visit/${sam!.id}/print`);
  expect(refused?.status(), "another practice's sheet").toBe(404);

  // A practice of its own, with a visit and a receptionist in it.
  await signOutOfBrowser(page);
  const staffEmail = freshEmail("print-nurse", "northstar-print.com");
  await signInAs(page, freshEmail("print-admin", "northstar-print.com"));
  const booked = (await (await postJson(page.request, "/api/book", { name: "Print Patient", channel: "none" })).json()) as { visitId: string };
  expect(booked.visitId).toBeTruthy();
  expect((await postJson(page.request, "/api/practice/users", { email: staffEmail })).ok(), "the admin invites a colleague").toBeTruthy();

  // Staff books visits and sends invites; reading a summary is clinical, so the sheet is not theirs (§5.2).
  await signOutOfBrowser(page);
  const staff = await signInAs(page, staffEmail);
  expect(staff.role).toBe("staff");
  await page.goto(`/provider/visit/${booked.visitId}/print`);
  await expect(page).toHaveURL(/\/provider(\?|$|\/)/);
  await expect(page, "sent back to the dashboard they may read, not shown a sheet they may not").not.toHaveURL(/print/);

  // And with no session at all, the sign-in page.
  await signOutOfBrowser(page);
  await page.goto(`/provider/visit/${booked.visitId}/print`);
  await expect(page).toHaveURL(/\/provider\/signin/, LOADED);
});
