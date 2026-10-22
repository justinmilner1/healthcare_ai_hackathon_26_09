import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { csrfToken, postJson } from "./api";
import { signInAsDemo } from "./auth";
import { DRAINED, LOADED } from "./budget";
import { patientEmail, verifyByApi } from "./patient";
import { shot } from "./shot";

// T108 (design §2.6, §7, §12.3): "Safety flags are at the top in red."
//
// That is the whole of what §2.6 promises about the one-pager in those terms, and until this spec it was the
// only surface in the product no test rendered and no screenshot showed. The computation was well covered —
// lib/sour.test.ts pins each of the three flags down to the sentence it produces — and the *rendering* was
// not, so nothing in the suite would have noticed the block losing its red, moving below the charts, or
// rendering on the brief and not on the sheet a clinician carries into the room. The last four tickets on
// these two surfaces (T60's "1 spikes", T62's place id, T86's "your care team", T99's chart caption) were
// each caught because a screenshot existed to look at; for the flags there was no screenshot to look at.
//
// Both halves of §2.6's sentence are driven here, on one visit, because a clinician meets them together:
//
// - the **intake** red flag (`.sour-safety-flag`), from §2.5's deterministic scan stopping the interview —
//   the patient's half of that path is already driven in e2e/mobile.spec.ts and e2e/flows.spec.ts, and
//   neither ever opens the clinician's side of it;
// - the **glucose** flags (`.sour-glucose-flags`), from `safetyFlags` in lib/sour.ts — code-generated, never
//   the model's ("Flag, don't prescribe", AGENTS.md), which is why the sentence on the screen is asserted
//   against the one in the bundle rather than against a string written out here.
//
// "At the top" is asserted as geometry against the first card, and "in red" as the colour the browser
// actually computes, so neither can drift into being true only of the screenshot. The two surfaces are
// asserted against each other for the same reason: §7.4's sheet is the brief on paper, and a flag that
// reaches one and not the other is the shape of drift this ticket was filed to make visible.

/** A verified patient of their own with one Clarity export shared (§3.3, §5.3), on the demo practice. */
async function visitWithReadings(page: Page, who: string, fixture: string) {
  // Booking is staff's job and needs their session (§5.2); the brief below is read as the clinician.
  const demo = await signInAsDemo(page);
  const email = patientEmail(who);
  const booked = (await (
    await postJson(page.request, "/api/book", { name: who, email, providerId: demo.id, visitType: "follow_up", reason: "highs after dinner", channel: "none" })
  ).json()) as { visitId: string; token: string };
  expect(booked.visitId, `booking ${who}`).toBeTruthy();

  // Through page.request for the reason e2e/flows.spec.ts gives: it shares the browser's cookie jar, so the
  // patient session lands where the upload and the Sweetie turn below need it (§5.3).
  await verifyByApi(page.request, booked.token, email);

  // Multipart, so postJson does not fit; the header is the one it would have added (§10.8).
  const uploaded = await page.request.post("/api/upload", {
    headers: { "x-csrf-token": await csrfToken(page.request) },
    multipart: {
      token: booked.token,
      kind: "dexcom",
      file: { name: "Clarity_export.csv", mimeType: "text/csv", buffer: readFileSync(fixture) },
    },
  });
  expect(uploaded.ok(), `POST /api/upload: ${await uploaded.text()}`).toBeTruthy();
  return { demo, ...booked };
}

/** The flags `lib/sour.ts` computed for this visit, read off the bundle the two surfaces both render. */
async function flagsOf(page: Page, visitId: string): Promise<string[]> {
  const bundle = (await (await page.request.get(`/api/patient/${visitId}`)).json()) as {
    providerSummary: { flags?: string[] } | null;
  };
  return bundle.providerSummary?.flags ?? [];
}

/**
 * The colour the browser computes for this element, as sRGB bytes.
 *
 * Through a canvas rather than by parsing the string, because the two blocks state their red in different
 * places — `.ss-error` in app/globals.css and Tailwind's `text-red-900` on the glucose block — and
 * `getComputedStyle` hands back whichever syntax the stylesheet was written in. Filling a pixel with it is
 * the one reading that is true of both.
 */
async function inkOf(where: Locator): Promise<{ value: string; r: number; g: number; b: number }> {
  return where.evaluate((element) => {
    const value = getComputedStyle(element).color;
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return { value, r, g, b };
  });
}

/** §2.6's "in red", as the browser paints it rather than as a class name promises it. */
async function expectRed(where: Locator, what: string): Promise<void> {
  const ink = await inkOf(where);
  const red = `${what}: the type is ${ink.value}, which is not red (design §2.6)`;
  expect(ink.r, red).toBeGreaterThan(ink.g + 40);
  expect(ink.r, red).toBeGreaterThan(ink.b + 40);
}

/** §2.6's "at the top": nothing of `above` is below the start of `below`, in page coordinates. */
async function expectAbove(page: Page, above: string, below: string, what: string): Promise<void> {
  const edges = await page.evaluate(({ a, b }) => {
    const top = document.querySelector(a)?.getBoundingClientRect();
    const next = document.querySelector(b)?.getBoundingClientRect();
    if (!top || !next) return null;
    return { bottom: top.bottom + window.scrollY, start: next.top + window.scrollY };
  }, { a: above, b: below });
  expect(edges, `${what}: ${above} or ${below} is not on the page at all`).not.toBeNull();
  expect(
    edges!.bottom,
    `${what}: ${above} is not above ${below} — a safety flag under the numbers is not "at the top" (design §2.6)`,
  ).toBeLessThanOrEqual(edges!.start + 0.5);
}

test("the brief and the printed sheet both open with the safety flags, in red, above the numbers", async ({ page }) => {
  // data/fixtures/clarity_sustained_high.csv is the fixture lib/sour.test.ts pins the sustained-high flag
  // against, and the only one in the repository whose readings produce exactly one glucose flag — so the
  // list on screen below is a list of one and can be compared element for element.
  const visit = await visitWithReadings(page, "E2E Flagged Brief", "data/fixtures/clarity_sustained_high.csv");

  // §2.5's scan, which is the intake half of §2.6's sentence: a phrase from RED_FLAGS (lib/sweetie.ts)
  // stops the interview, wraps the intake, and leaves the reason on the visit for the clinician to read.
  // The patient's side of this is e2e/mobile.spec.ts and e2e/flows.spec.ts; this is the transport, because
  // what the clinician is shown is the stored flag and not the screen the patient saw.
  const flagged = await (
    await postJson(page.request, "/api/sweetie", { token: visit.token, message: "I had chest pain yesterday evening and it scared me." })
  ).json();
  expect(flagged.intake?.flagged, "the red-flag scan stopped the interview (§2.5)").toBe("cardiac_or_breathing");

  // The brief. Opening a visit with data and no summary generates one (app/provider/[id]/sour.tsx), and the
  // chip reading Ready is the `sour.run` job having reported back (§7.1, §7.2) — which is what carries the
  // flags, since they are written into the summary by code.
  await page.goto(`/provider/${visit.demo.id}?visit=${visit.visitId}`);
  await expect(page.locator(".sour-brief-header")).toContainText("E2E Flagged Brief", LOADED);
  await expect(page.locator(".sour-job-state")).toHaveAttribute("data-phase", "ready", DRAINED);

  // What §7 computed, read from the bundle rather than written out here: the sentence carries a local time,
  // and a literal would be asserting the server's zone instead of the product's promise.
  const flags = await flagsOf(page, visit.visitId);
  expect(flags, "the fixture's one glucose flag (lib/sour.ts safetyFlags)").toHaveLength(1);
  expect(flags[0]).toMatch(/^Above 250 mg\/dL for an hour or more on 1 occasion \(longest 100 min from .+, peak 291\)\.$/);

  const intakeFlag = page.locator(".sour-safety-flag");
  await expect(intakeFlag).toBeVisible();
  await expect(intakeFlag).toContainText("Safety flag during intake:");
  await expect(intakeFlag, "the reason, in words rather than as an id").toContainText("cardiac or breathing");
  await expect(intakeFlag, "and what the patient was told to do (§2.5)").toContainText(/call the office/i);

  const glucoseFlags = page.locator(".sour-glucose-flags");
  await expect(glucoseFlags).toBeVisible();
  await expect(glucoseFlags).toContainText("Glucose safety flags");
  await expect(glucoseFlags, "AGENTS.md: numbers and flags stay code-generated").toContainText(/not by the model/);
  // Element for element, so a flag that is reworded or dropped on the way to the screen fails here.
  await expect(glucoseFlags.locator("li")).toHaveText(flags);

  // §2.6's "at the top in red", on the brief.
  await expectAbove(page, ".sour-safety-flag", ".sour-glucose-flags", "the brief");
  await expectAbove(page, ".sour-glucose-flags", ".sour-overview-card", "the brief");
  await expectRed(intakeFlag, "the brief's intake flag");
  await expectRed(glucoseFlags, "the brief's glucose flags");

  // The per-project default (e2e/shot.ts): the desktop gets the document, the phone one screenful. The
  // phone's own screenful is not enough on this page — the brief opens on a persona header, a title block,
  // four buttons, the job chip and the §6.3 note, so the first frame of it ended at the second line of the
  // glucose block and the flag the shot was taken for was half behind the bottom edge. So the subject is
  // scrolled to the top of the frame on both projects (which a whole-document desktop shot is indifferent
  // to), and `wholeRows` fails the shot rather than letting a half-read flag be committed as evidence
  // (T107). The Summary card stays under them, which is what "above the numbers" looks like in a picture.
  //
  // Both blocks are named, the anchor included. It used to be only the block below it, because the desktop
  // run reported 41 of 41px of the intake banner "in frame" and failed the shot: `scrollIntoView({ block:
  // "start" })` lands the anchor *at* the top edge and a fractional layout lands it a hair above, and the
  // option was judging a whole-document capture against the window's edges. T119 took the window clamp off
  // the capture that has no window edge, so the desktop frame — which holds the anchor whole, and always
  // did — passes. The phone still is one screenful and still is judged against the window; the anchor lands
  // on or below its top edge at 375px, so nothing had to be loosened for it. So the shot now asserts on
  // everything it was taken to show rather than on the half below the anchor.
  await shot(page, "provider-sour-flags", { scrollTo: ".sour-safety-flag", wholeRows: ".sour-safety-flag, .sour-glucose-flags" });

  // §7.4's sheet is the same brief on paper, so the same two blocks are on it, above the same numbers. The
  // sentences are compared with the brief's rather than re-derived: the point of asserting both surfaces is
  // that they cannot say different things.
  const opened = await page.goto(`/provider/visit/${visit.visitId}/print`);
  expect(opened?.status(), "the sheet a clinician may open (§7.4)").toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "E2E Flagged Brief" })).toBeVisible(LOADED);
  const printIntake = page.locator(".sour-safety-flag");
  const printGlucose = page.locator(".sour-glucose-flags");
  await expect(printIntake).toBeVisible();
  await expect(printIntake).toContainText("Safety flag during intake:");
  await expect(printIntake).toContainText("cardiac or breathing");
  await expect(printGlucose).toContainText("Glucose safety flags");
  await expect(printGlucose.locator("li"), "the sheet carries the brief's flags word for word").toHaveText(flags);
  await expectAbove(page, ".sour-safety-flag", ".sour-glucose-flags", "the sheet");
  await expectAbove(page, ".sour-glucose-flags", ".sour-print-numbers", "the sheet");
  await expectRed(printIntake, "the sheet's intake flag");
  await expectRed(printGlucose, "the sheet's glucose flags");
  // Recharts draws after it has measured itself, so the chart is the one thing worth waiting for before the
  // shutter opens — the same wait e2e/print.spec.ts takes before its own shot of this page.
  await expect(page.locator(".recharts-surface").first()).toBeVisible(LOADED);
  // The sheet opens on its header and then the two blocks, so both frames hold them without scrolling —
  // `wholeRows` is here to keep it that way as the header grows rather than to fix anything today.
  await shot(page, "provider-print-flags", { wholeRows: ".sour-safety-flag, .sour-glucose-flags" });
});

test("a visit with nothing to flag carries no flag block on either surface", async ({ page }) => {
  // The other half of the pair, so "the flags render" cannot be satisfied by a block that is always there.
  // data/dexcom_clarity_sample.csv is the seven-day sample the rest of the suite summarizes, and it trips
  // none of §7's three thresholds — read from the bundle first rather than assumed, the way
  // e2e/flows.spec.ts reads `placedRises` before asserting on the shape it got.
  const visit = await visitWithReadings(page, "E2E Unflagged Brief", "data/dexcom_clarity_sample.csv");

  await page.goto(`/provider/${visit.demo.id}?visit=${visit.visitId}`);
  await expect(page.locator(".sour-job-state")).toHaveAttribute("data-phase", "ready", DRAINED);
  expect(await flagsOf(page, visit.visitId), "this sample has nothing to flag").toEqual([]);

  await expect(page.locator(".sour-glucose-flags"), "a flags block with no flags in it").toHaveCount(0);
  await expect(page.locator(".sour-safety-flag"), "an intake flag on an interview nothing stopped").toHaveCount(0);
  await expect(page.locator(".sour-overview-card")).toBeVisible();

  const opened = await page.goto(`/provider/visit/${visit.visitId}/print`);
  expect(opened?.status()).toBe(200);
  await expect(page.locator(".sour-print-numbers")).toBeVisible(LOADED);
  await expect(page.locator(".sour-glucose-flags")).toHaveCount(0);
  await expect(page.locator(".sour-safety-flag")).toHaveCount(0);
});
