import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { csrfToken, postJson } from "./api";
import { signInAsDemo } from "./auth";
import { LOADED } from "./budget";
import { patientEmail, verifyByApi } from "./patient";
import { SCREENFUL, shot } from "./shot";

// T16 (design §2.6, §7.3): "they see the one-pager, ask follow-ups, print, and mark it reviewed; reviewer and
// time are recorded", and the dashboard shows it. Driven through the screen a clinician uses, so the button,
// the record on the one-pager and the status on the dashboard are all asserted on the running app.
//
// This spec books its own visit rather than using the seeded one. A sign-off moves the visit to `reviewed`
// (§4.4) and nothing takes it back, so marking Sam Sample would change what every other spec and both
// Playwright projects see on the dashboard afterwards.
//
// The uploads go through `request` and not `page.request`: the patient's credential is the token plus the
// verified session the six-digit code leaves behind (§5.3), and keeping them in separate contexts means the
// provider session stays signed in for the half of the test that is the clinician's.

const clarity = () => readFileSync(join(process.cwd(), "data", "fixtures", "clarity_window.csv"), "utf8");

test("a clinician marks a summary reviewed: the record is on the one-pager and the status on the dashboard", async ({ page, request }) => {
  const demo = await signInAsDemo(page);
  const email = patientEmail("E2E Reviewer");
  const booked = (await (
    await postJson(page.request, "/api/book", { name: "E2E Reviewer", email, providerId: demo.id, visitType: "follow_up", reason: "highs after dinner", channel: "none" })
  ).json()) as { visitId: string; token: string };
  expect(booked.visitId).toBeTruthy();

  // Something for Sour to summarize. The patient's own side, in its own context (§5.3).
  await verifyByApi(request, booked.token, email);
  const uploaded = await request.post("/api/upload", {
    multipart: { token: booked.token, kind: "dexcom", file: { name: "Clarity_export.csv", mimeType: "text/csv", buffer: Buffer.from(clarity()) } },
    headers: { "x-csrf-token": await csrfToken(request) },
  });
  expect(uploaded.ok(), `POST /api/upload: ${uploaded.status()}`).toBeTruthy();

  // Opening a visit with data and no summary generates one (app/provider/[id]/sour.tsx); the chip reading
  // Ready is the `sour.run` job having reported back (§7.2), which is what there is to sign off.
  await page.goto(`/provider/${demo.id}?visit=${booked.visitId}`);
  await expect(page.locator(".sour-brief-header")).toContainText("E2E Reviewer", LOADED);
  await expect(page.locator(".sour-job-state")).toHaveAttribute("data-phase", "ready", LOADED);

  // T60: this visit is `clarity_window.csv`, a single day with a single spike on it, so it is the screen
  // where a count that disagrees with its noun shows. §7's brief leads with numbers; "1 days" is the one
  // kind of sloppiness a numbers-first page cannot print (lib/plural.ts).
  const brief = page.locator(".sour-brief");
  await expect(brief).toContainText("1 day · 84 readings");
  await expect(brief, "a count agrees with its noun").not.toContainText(/\b1 (days|spikes|readings)\b/);

  // Before the press: the button is offered and there is no record.
  const markReviewed = page.getByRole("button", { name: "Mark reviewed" });
  await expect(markReviewed).toBeEnabled(LOADED);
  await expect(page.locator(".sour-reviewed")).toHaveCount(0);

  await markReviewed.click();
  // §7.3's "reviewer and time are recorded", on the screen: the clinician who pressed it, by name, and when.
  const record = page.locator(".sour-reviewed");
  await expect(record).toContainText(/Reviewed by/i, LOADED);
  await expect(record).toContainText("Dr. Demo Endo");
  await expect(record).toContainText(/today at/i);
  await expect(markReviewed, "there is no unmarking, so the button goes").toHaveCount(0);
  await shot(page, "provider-sour-reviewed");

  // It is a row and not a piece of page state: a fresh load of the one-pager reads the same record back.
  await page.reload();
  await expect(page.locator(".sour-reviewed")).toContainText("Dr. Demo Endo", LOADED);
  await expect(page.getByRole("button", { name: "Mark reviewed" })).toHaveCount(0);

  // The bundle behind it (§4.4, §4.7): the visit moved to `reviewed`, and the sign-off names the clinician.
  const bundle = (await (await page.request.get(`/api/patient/${booked.visitId}`)).json()) as {
    visitStatus: string;
    review: { at: string; by: string; byName: string } | null;
  };
  expect(bundle.visitStatus).toBe("reviewed");
  expect(bundle.review?.by).toBe(demo.id);
  expect(bundle.review?.byName).toBe("Dr. Demo Endo");

  // §7.3's "shows in the dashboard": the stage pill, and who signed it off underneath.
  await page.goto("/provider");
  // By the address, not the name: the desktop and mobile projects each book their own "E2E Reviewer" against
  // the same database, and only the address is unique to this one (patientEmail, e2e/patient.ts).
  const row = page.locator(".provider-table tbody tr", { hasText: email });
  await expect(row).toContainText("Reviewed", LOADED);
  await expect(row.locator(".provider-reviewed-by")).toContainText("Dr. Demo Endo");
// The cell this test asserts on, not just the row: the table is wider than a phone, so Stage,
  // Messages and Actions are off to the right until the shot asks for them (T57, T81).
  await shot(page, "provider-dashboard-reviewed", {
    ...SCREENFUL,
    scrollTo: row.locator(".provider-stage-cell"),
    block: "center",
    inline: "center",
  });

  // The sheet is the screen's twin (§7.4), so it counts the same single day the same way.
  await page.goto(`/provider/visit/${booked.visitId}/print`);
  const sheet = page.locator(".sour-print-sheet");
  await expect(sheet).toContainText("1 day · 84 readings", LOADED);
  await expect(sheet, "a count agrees with its noun on paper too").not.toContainText(/\b1 (days|spikes|readings)\b/);
  await shot(page, "provider-print-single-day");

  // Pressing again is not an error and does not move the record: the first sign-off is the one that stands.
  const again = await postJson(page.request, "/api/review", { visitId: booked.visitId });
  expect(again.status()).toBe(200);
  const second = (await again.json()) as { already: boolean; review: { at: string; by: string } };
  expect(second.already).toBe(true);
  expect(second.review.at).toBe(bundle.review?.at);
  expect(second.review.by).toBe(demo.id);
});

test("a visit with no summary cannot be marked reviewed, and a bad request is refused before anything is", async ({ page }) => {
  const demo = await signInAsDemo(page);
  const booked = (await (
    await postJson(page.request, "/api/book", { name: "E2E Unreviewable", providerId: demo.id, visitType: "annual", channel: "none" })
  ).json()) as { visitId: string };

  // Nothing has been summarized, so there is nothing to sign off: the status must not run ahead of the
  // one-pager it is a statement about.
  const refused = await postJson(page.request, "/api/review", { visitId: booked.visitId });
  expect(refused.status()).toBe(409);
  const body = (await refused.json()) as { error: string; code: string };
  expect(body.code).toBe("no_summary");
  expect(body.error).toMatch(/no summary to review/i);

  expect((await postJson(page.request, "/api/review", {})).status()).toBe(400);
  expect((await postJson(page.request, "/api/review", { visitId: "not-a-visit" })).status()).toBe(404);

  const after = (await (await page.request.get(`/api/patient/${booked.visitId}`)).json()) as { visitStatus: string; review: unknown };
  expect(after.visitStatus).toBe("invited");
  expect(after.review).toBe(null);
});
