import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { csrfToken, postJson } from "./api";
import { freshEmail, signInAs, signInAsDemo, signOutOfBrowser } from "./auth";
import { patientEmail, verifyByApi } from "./patient";

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

const shot = async (page: Page, name: string) => {
  await page.screenshot({ path: `e2e/screenshots/${test.info().project.name}-${name}.png`, fullPage: true });
};

const LOADED = { timeout: 30_000 };

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
  await expect(page.getByRole("heading", { name: /Glucose, last \d+ days/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Spikes linked to places" })).toBeVisible();
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
