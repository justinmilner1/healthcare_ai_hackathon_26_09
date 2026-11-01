import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { GMI_A1C_HINT, GMI_A1C_MIN_DAYS, GMI_SHORT_SPAN_HINT } from "../lib/gmi";
import { csrfToken, postJson } from "./api";
import { signInAsDemo } from "./auth";
import { DRAINED, LOADED } from "./budget";
import { expectMarkerLabelsClearOfMarkers, expectTimeAxisLabelled } from "./charts";
import { patientEmail, verifyByApi } from "./patient";
import { SCREENFUL, shot } from "./shot";

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

/**
 * A verified patient of their own with one Clarity export shared (§3.3, §5.3), on the demo practice.
 *
 * `timeline` shares a Google Maps Timeline export as well, which §2.5 makes optional and which is what
 * decides `hasLocation` and so which of `clinicianPlaceReport`'s three readings the card and the caption
 * take (T184, T200). It goes up first, so the Dexcom upload that follows is the one §7.1 trigger in this
 * path and the run it queues sees both exports (lib/sourQueue.ts `queueSourAfterImport`; a Timeline upload
 * queues nothing).
 */
async function visitWithReadings(page: Page, who: string, fixture: string, timeline?: string) {
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

  if (timeline) await shareTimeline(page, booked.token, readFileSync(timeline));
  await shareReadings(page, booked.token, readFileSync(fixture));
  return { demo, ...booked };
}

/**
 * Hand this visit a Clarity export. `lib/bundle.ts` reads the *latest* dexcom upload, so a second call
 * replaces what the two surfaces summarize — which is how the span test below reads one visit at two spans.
 */
async function shareReadings(page: Page, token: string, csv: string | Buffer) {
  // Multipart, so postJson does not fit; the header is the one it would have added (§10.8).
  const uploaded = await page.request.post("/api/upload", {
    headers: { "x-csrf-token": await csrfToken(page.request) },
    multipart: {
      token,
      kind: "dexcom",
      file: { name: "Clarity_export.csv", mimeType: "text/csv", buffer: Buffer.from(csv) },
    },
  });
  expect(uploaded.ok(), `POST /api/upload: ${await uploaded.text()}`).toBeTruthy();
}

/**
 * A Clarity export of `days` days, hourly, for the one thing no file in the repository holds: a span long
 * enough for GMI to be read as an estimated A1c (T185, lib/gmi.ts).
 *
 * Built here rather than committed under `data/fixtures/`, which is for the parser suites in `lib/*.test.ts`
 * (`data/fixtures/README.md`): nothing about this is a parse to pin, only a span, and a fortnight of real
 * five-minute readings would be four thousand rows of fixture to say it. The shape is `clarity_window.csv`'s
 * — the three metadata rows and then EGV rows with device-local timestamps and no offset — so it goes in
 * through `POST /api/upload` exactly as a patient's own export does.
 *
 * Nothing in it is below 70 or above 180, so it raises none of §7's three safety flags and detects no
 * spike. That keeps it inside the subject of the test that uses it: the visit still has nothing to flag at
 * fifteen days, and the only thing that changes about the two surfaces is the span.
 */
function clarityOfDays(days: number): string {
  // One day, hourly: flat overnight, a rise after each of three meals, the highest of them 173.
  const hourly = [104, 101, 99, 98, 97, 99, 106, 128, 152, 141, 122, 116, 134, 161, 148, 127, 118, 121, 145, 173, 158, 133, 117, 109];
  const header = [
    "Index,Timestamp (YYYY-MM-DDThh:mm:ss),Event Type,Event Subtype,Patient Info,Device Info,Source Device ID,Glucose Value (mg/dL),Insulin Value (u),Carb Value (grams),Duration (hh:mm:ss),Glucose Rate of Change (mg/dL/min),Transmitter Time (Long Integer),Transmitter ID",
    "1,,FirstName,,E2E,,,,,,,,,",
    "2,,LastName,,Span,,,,,,,,,",
    "3,,Device,,,Dexcom G7,SM00000002,,,,,,,",
  ];
  // Ending on the same day as data/dexcom_clarity_sample.csv, so the two exports of one visit differ in
  // their span and in nothing else a reader of the sheet would notice.
  const last = Date.UTC(2026, 8, 25, 23, 0, 0);
  const rows = Array.from({ length: days * 24 }, (_, i) => {
    const at = new Date(last - (days * 24 - 1 - i) * 3600000).toISOString().slice(0, 19);
    return `${i + 4},${at},EGV,,,Dexcom G7,SM00000002,${hourly[i % 24]},,,,,,SPAN01`;
  });
  return [...header, ...rows].join("\n");
}

/** The flags `lib/sour.ts` computed for this visit, read off the bundle the two surfaces both render. */
/** The other optional export of §2.5, through the same route: what makes `hasLocation` true (T184, T200). */
async function shareTimeline(page: Page, token: string, json: string | Buffer) {
  const uploaded = await page.request.post("/api/upload", {
    headers: { "x-csrf-token": await csrfToken(page.request) },
    multipart: {
      token,
      kind: "timeline",
      file: { name: "Timeline.json", mimeType: "application/json", buffer: Buffer.from(json) },
    },
  });
  expect(uploaded.ok(), `POST /api/upload (timeline): ${await uploaded.text()}`).toBeTruthy();
}

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
  // T202: this fixture holds exactly one run above 250, so the parenthetical reports that run instead of
  // electing it the longest of a set of one — a superlative the sentence in front of it has just ruled out
  // ("on 1 occasion"). This assertion read the "longest" string, so the suite was pinning the defect, the
  // way T199's did on the chart caption one card down. Two and above keeps the word, read in
  // lib/sour.test.ts where the count can be arranged.
  expect(flags[0]).toMatch(/^Above 250 mg\/dL for an hour or more on 1 occasion \(100 min from .+, peak 291\)\.$/);

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
  // T202 (§2.6): and the clause the ticket is about, read off the screen rather than only compared with the
  // bundle — the block above would be satisfied by a brief and a sheet that agreed on the wrong sentence.
  await expect(glucoseFlags, "the one run reported, not elected longest").toContainText(/on 1 occasion \(100 min from .+, peak 291\)\./);
  await expect(glucoseFlags, "a superlative over the single occasion this fixture holds").not.toContainText("longest");

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
  // T195: and no composer under them. This suite has no model configured, so the brief says so and then
  // offers no control that would put a question on the visit for nobody to answer (lib/sourState.ts
  // `askSourClosedNote`). T153's placeholder — this was its third combination, readings and no WHOOP — has
  // no placeholder to be read off here any more; that rule is pinned on all four combinations in
  // lib/sourState.test.ts, and read off a live composer on this same combination in e2e/followup.spec.ts.
  await expect(page.locator(".sour-ask-card .sour-ask-closed")).toContainText(/Assistant not configured/i);
  await expect(page.getByLabel("Message Sour")).toHaveCount(0);

  // T160 (§2.6, §2.5): the same visit read one row up. Readings and neither optional source, so the metrics
  // row is the ticket's pair side by side — the Spikes tile names the Timeline it never got, in the register
  // the Sleep tile has always used for WHOOP. It used to report "0 linked to a place" here: a measurement
  // over a file nobody sent, beside a tile naming the same absence (lib/spikePlaces.ts
  // `clinicianSpikePlacesHint`).
  const flaggedMetrics = page.locator(".sour-metrics-card");
  await expect(flaggedMetrics).toContainText("no Timeline data");
  await expect(flaggedMetrics).toContainText("no WHOOP data");
  await expect(flaggedMetrics, "a count of places over an export this visit has not got").not.toContainText(/linked to a place/);
  // T164 (§2.6): the uncapped week, which is the other half of that change. This fixture holds one rise, the
  // card lists it, and so there is no discrepancy to disclose — a tile reading "top 5 shown" over a complete
  // table would invent one. The capped week is asserted in e2e/journey.spec.ts.
  const flaggedSpikeTile = flaggedMetrics.locator(".summary-stat-tile", { hasText: "Spikes > 180" });
  await expect(flaggedSpikeTile.locator(".text-2xl")).toHaveText("1");
  await expect(flaggedSpikeTile, "a cap announced over a table that lists everything").not.toContainText(/shown/);
  // T165 (§2.6): and the chart caption on the same visit, which is the same guard one card down. The
  // marker drawn is the only rise there is, so the caption says nothing about a cap — acceptance
  // criterion 2 (lib/spikePlaces.ts `clinicianChartCaption`). The capped week is asserted in
  // e2e/journey.spec.ts, e2e/flows.spec.ts and e2e/print.spec.ts.
  //
  // T199 (§2.6): and it says it in the singular. This is the screen the ticket was filed on — the tile
  // above reads 1, the card below lists one row, the chart draws one dot — and this assertion read
  // "Red markers are spikes." over it, so the suite was pinning the defect. One marker, one verb, one
  // noun: the agreement is `plural`'s in lib/plural.ts, the way T60 and T198 settled it for the counts on
  // the tiles. Two and above is still the plural, read on the week in e2e/journey.spec.ts.
  const flaggedCaption = page.locator(".sour-chart-caption");
  await expect(flaggedCaption).toContainText("Red marker is a spike.");
  await expect(flaggedCaption, "a plural over the one marker this chart draws").not.toContainText("Red markers");
  await expect(flaggedCaption, "a cut disclosed over a chart that draws every rise").not.toContainText(/largest rises/);
  // T185 (§2.6, §7): the third element of that row asked the same question. This fixture is one evening of
  // readings, and the GMI tile called itself `est. A1c from CGM` over it — a stand-in for a three-month
  // average, stated as flatly as if a fortnight had arrived, on the row whose other two tiles already
  // refuse. The figure stays; the sub-line is what the span decides (lib/gmi.ts).
  const flaggedGmi = flaggedMetrics.locator(".summary-stat-tile", { hasText: "GMI" });
  await expect(flaggedGmi).toContainText(GMI_SHORT_SPAN_HINT);
  await expect(flaggedGmi, "an estimated A1c off a single evening").not.toContainText(GMI_A1C_HINT);
  await expect(page.locator(".sour-overview-line"), "the figure unqualified, on the line read at a glance").not.toContainText(/GMI/);

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
  // T202 (§7.4): the same clause on the paper, read the same way. §2.6 and §7.4 are twins, so the defect
  // was on both surfaces and so is the assertion against it.
  await expect(printGlucose, "the one run reported, not elected longest").toContainText(/on 1 occasion \(100 min from .+, peak 291\)\./);
  await expect(printGlucose, "a superlative over the single occasion this fixture holds").not.toContainText("longest");
  await expectAbove(page, ".sour-safety-flag", ".sour-glucose-flags", "the sheet");
  await expectAbove(page, ".sour-glucose-flags", ".sour-print-numbers", "the sheet");
  await expectRed(printIntake, "the sheet's intake flag");
  await expectRed(printGlucose, "the sheet's glucose flags");
  // T160 (§7.4): and the same row on the paper, out of the same function, so the sheet cannot count places
  // the screen declines to.
  const printMetrics = page.locator(".sour-print-numbers");
  await expect(printMetrics).toContainText("no Timeline data");
  await expect(printMetrics).toContainText("no WHOOP data");
  await expect(printMetrics, "a count of places on a sheet whose visit has no Timeline").not.toContainText(/linked to a place/);
  // T185 (§7.4): and the GMI tile beside them, out of the same function as the screen's, so the paper
  // cannot estimate an A1c the brief declines to.
  const printGmi = printMetrics.locator(".summary-stat-tile", { hasText: "GMI" });
  await expect(printGmi).toContainText(GMI_SHORT_SPAN_HINT);
  await expect(printGmi, "an estimated A1c on paper, off a single evening").not.toContainText(GMI_A1C_HINT);
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

  // T185 (§2.6, §7): seven days is the other side of the sweep's question and the same answer. It is what
  // the Dexcom connection fetches (§9.2) and what the demo sample holds, and it is still half of what GMI
  // needs to stand in for a quarter — so this visit keeps the figure and loses the A1c claim too
  // (lib/gmi.ts). The single-day visits are in the test above and in e2e/review.spec.ts.
  const weekGmi = page.locator(".sour-metrics-card .summary-stat-tile", { hasText: "GMI" });
  await expect(weekGmi).toContainText(GMI_SHORT_SPAN_HINT);
  await expect(weekGmi, "an estimated A1c off a week of readings").not.toContainText(GMI_A1C_HINT);

  // T187 (§2.6): the half of that ticket which is a promise to leave something alone. The seven-day
  // sample is the span the chart was written for, and its axis — one weekday per local midnight — is the
  // one a reader of a week wants and the one the fix must not touch. Asserted beside the single-day
  // charts in e2e/review.spec.ts and e2e/flows.spec.ts, so "the labels are in the unit of the span" is
  // driven in both units rather than only in the one that was broken.
  await expectTimeAxisLabelled(page, "the clinician's brief, a week of readings", "day");
  // T197 (§2.6, §6.5): and the labels over the same line. This is the chart the ticket was measured on —
  // `mobile-provider-sour-week-chart.png` — where the `202` rise kept its label and the `214` rise 8h35m
  // later kept only its marker, which landed on the `202`'s last digit. At 375px two of these five rises
  // go unlabelled, so the state the ticket is about is in this frame.
  await expectMarkerLabelsClearOfMarkers(page, "the clinician's brief, a week of readings", { someDropped: true });
  await shot(page, "provider-sour-week-chart", { ...SCREENFUL, scrollTo: ".sour-chart-card" });

  const opened = await page.goto(`/provider/visit/${visit.visitId}/print`);
  expect(opened?.status()).toBe(200);
  await expect(page.locator(".sour-print-numbers")).toBeVisible(LOADED);
  await expect(page.locator(".sour-glucose-flags")).toHaveCount(0);
  await expect(page.locator(".sour-safety-flag")).toHaveCount(0);

  // T190 (§7.4, §6.5): the week's axis on §7.4's sheet, which is the third of the three surfaces this one
  // chart is drawn into and the one that was worst off — its 375px column is 4px narrower again than the
  // brief's card, and it was asking for seven weekday labels and being painted five. Asserted here rather
  // than in e2e/review.spec.ts, which reads this sheet at a single morning: a week is the span the dropping
  // needed, and this test is already standing on a sheet that holds one.
  await expectTimeAxisLabelled(page, "the printed one-pager, a week of readings", "day");

  // The span that *does* support the estimate, which is the half of T185 that has to be driven for the rule
  // to be more than a withholding: a tile reading the same at one day as at fourteen is the thing the
  // ticket rules out, and so is one that reads `—` for everybody. Nothing committed in this repository
  // holds a fortnight, so the export is built here (`clarityOfDays`) and handed to the visit that is
  // already standing — `lib/bundle.ts` reads the latest dexcom upload, so this is one patient read at two
  // spans and nothing else about the sheet changes. Still nothing to flag at fifteen days, which is this
  // test's own subject: the series stays inside 70 to 180.
  await shareReadings(page, visit.token, clarityOfDays(GMI_A1C_MIN_DAYS + 1));
  await page.goto(`/provider/${visit.demo.id}?visit=${visit.visitId}`);
  // The sub-header is the bundle having been re-read: `computeStats` takes the span off the latest upload
  // (lib/bundle.ts), which is all the tile needs. The saved brief is the week's until someone asks for
  // another — §7.1 keeps it up and marks it stale rather than blanking it — so Regenerate is pressed, and
  // the flags read back below are then the fortnight's rather than the week's.
  await expect(page.locator(".sour-brief")).toContainText("15 days · 360 readings", LOADED);
  await page.getByRole("button", { name: "Regenerate" }).click();
  await expect(page.locator(".sour-job-state")).toHaveAttribute("data-phase", "ready", DRAINED);
  expect(await flagsOf(page, visit.visitId), "a fortnight inside the target band has nothing to flag").toEqual([]);
  await expect(page.locator(".sour-glucose-flags"), "a flags block over a fortnight with nothing in it").toHaveCount(0);
  await expect(weekGmi, "the hint the tile has always carried, where the span supports it").toContainText(GMI_A1C_HINT);
  await expect(weekGmi).not.toContainText(GMI_SHORT_SPAN_HINT);
  // And the clause back on the glance line, out of the same report: the overview drops it only where the
  // tile has to qualify the figure, so the two are the one decision read twice.
  await expect(page.locator(".sour-overview-line")).toContainText(/GMI \d+\.\d%/);
  // The page settled, not mid-run: the chip reaches `ready` a beat before the header button drops
  // "Summarizing…", so a shutter that opens on the chip alone writes a frame carrying both at once — a
  // state the product passes through and is never in, which is what e2e/shot.ts freezes animations to
  // avoid committing (T77, design §12.3).
  await expect(page.getByRole("button", { name: "Regenerate" })).toBeEnabled(DRAINED);
  await shot(page, "provider-sour-gmi-fortnight", { scrollTo: ".sour-metrics-card", wholeRows: ".sour-metrics-card .summary-stat-tile" });
});

test("a week with no rise over 180 claims no marker on any of the three surfaces (T199)", async ({ page }) => {
  // The reading the ticket calls the worse of the two, because it is not a disagreement about number but a
  // claim about something that is not drawn. The chart card is gated on `hasDexcom` alone on the
  // clinician's two surfaces (app/provider/[id]/sour.tsx, app/provider/visit/[id]/print/page.tsx) and on
  // nothing at all on the patient's (app/patient/[id]/page.tsx), so a week that never crossed 180 still
  // gets a chart — and every caption over it promised red markers, and labels giving the peak mg/dL, over
  // a chart that draws neither. That is the *well-controlled* week, the best outcome §7 has to report, and
  // with no rises there is no rises table under it to contradict the sentence either.
  //
  // `provider-sour-conversation-only` is not this case: with no glucose at all the card is replaced
  // outright. The gap is glucose shared and nothing over 180, which is what data/fixtures/clarity_flat.csv
  // is for (AC5 and AC6) — 168 hourly readings between 88 and 174, so time in range is 100%, none of §7's
  // three thresholds trips and `detectSpikes` finds nothing. It goes in through `POST /api/upload` exactly
  // as a patient's own export does, so the three surfaces below are reading a parsed week and not a
  // hand-built empty array; the array itself is read in lib/spikePlaces.test.ts.
  //
  // Here rather than in a spec of its own because `visitWithReadings` above is the one helper in the suite
  // that books a visit and hands it a Clarity file, and because the sibling reading — the singular, over
  // the one-rise brief — is asserted on the flagged visit at the top of this file.
  const visit = await visitWithReadings(page, "E2E Flat Week", "data/fixtures/clarity_flat.csv");

  await page.goto(`/provider/${visit.demo.id}?visit=${visit.visitId}`);
  await expect(page.locator(".sour-job-state")).toHaveAttribute("data-phase", "ready", DRAINED);
  expect(await flagsOf(page, visit.visitId), "a week inside the band has nothing to flag").toEqual([]);

  // The tile and the card first, so what the caption is being read against is on the record: nought rises
  // is the state, not an absence of readings.
  const flatMetrics = page.locator(".sour-metrics-card");
  const flatSpikeTile = flatMetrics.locator(".summary-stat-tile", { hasText: "Spikes > 180" });
  await expect(flatSpikeTile.locator(".text-2xl")).toHaveText("0");
  // T157's third heading, over a card with no rows: naming the threshold above it would read as though
  // some had cleared it (lib/spikePlaces.ts `clinicianSpikeCardHeading`). The same filter-by-heading shape
  // e2e/journey.spec.ts reads the other two with.
  const flatSpikeCard = page.locator(".sour-card").filter({ has: page.getByRole("heading", { name: "Spikes", exact: true }) });
  await expect(flatSpikeCard.getByRole("heading")).toHaveText("Spikes");
  await expect(flatSpikeCard).toContainText("No spikes over 180 detected.");

  // §2.6's caption, which is the subject. The band sentence is true of a chart with nothing on it and
  // stays; what used to follow it was two claims about an empty set.
  const flatCaption = page.locator(".sour-chart-caption");
  await expect(flatCaption).toContainText("Shaded band is 70–180 mg/dL.");
  await expect(flatCaption).toContainText("No rises over 180 to mark.");
  await expect(flatCaption, "red markers promised over a chart that draws none").not.toContainText(/marker/i);
  await expect(flatCaption, "labels promised over markers that do not exist").not.toContainText(/Labels|peak mg\/dL/);
  const briefCaption = (await flatCaption.textContent())?.trim();
  expect(briefCaption, "the brief's caption").toBeTruthy();
  // The chart is still drawn and still has its axis, so the sentence is about an empty set of markers and
  // not about an empty card (T187's labelling, on the span this fixture holds).
  await expect(page.locator(".recharts-surface").first()).toBeVisible(LOADED);
  await expectTimeAxisLabelled(page, "the clinician's brief, a week with no rise in it", "day");
  await shot(page, "provider-sour-flat-week", { ...SCREENFUL, scrollTo: ".sour-chart-card" });

  // §7.4's sheet is the brief on paper and reads this caption out of the one `clinicianChartCaption` that
  // exists to keep the two from drifting (T99), so it is compared with the brief's string rather than
  // re-derived here — the same way the flag blocks are compared in the test at the top of this file.
  const opened = await page.goto(`/provider/visit/${visit.visitId}/print`);
  expect(opened?.status(), "the sheet a clinician may open (§7.4)").toBe(200);
  await expect(page.locator(".sour-print-numbers")).toBeVisible(LOADED);
  await expect(page.locator(".recharts-surface").first()).toBeVisible(LOADED);
  await expect(page.locator(".sour-chart-caption"), "the sheet captions this chart differently from the brief").toHaveText(briefCaption!);
  await shot(page, "provider-print-flat-week", { ...SCREENFUL, scrollTo: ".sour-chart-caption" });

  // §2.7's page, in the patient's own second person. "Markers show your biggest rises." was false here in
  // the same way and had even less under it to contradict it: the rises table below is gated on there
  // being a rise, so the caption was the only thing on the screen saying anything about markers at all.
  await page.goto(`/patient/${visit.token}`);
  const glucoseCard = page
    .locator("section.patient-report-card")
    .filter({ has: page.getByRole("heading", { level: 2, name: "Your glucose" }) });
  await expect(glucoseCard).toBeVisible(LOADED);
  const patientCaption = glucoseCard.locator(".patient-report-subtitle");
  await expect(patientCaption).toHaveText("You had no rises over 180, so the chart shows no markers.");
  // None of the clinician's three surfaces' vocabulary, and nothing about places: with no rise there is no
  // matched one either, so the clause T193 decides does not arise (T82's rule, read at nought).
  await expect(patientCaption, "the matcher's words on §2.7's page").not.toContainText(/matched|linked|mg\/dL|spike/i);
  await expect(page.locator(".patient-spikes"), "a rises card over a week with no rises").toHaveCount(0);
  // Anchored rather than shot whole: this page is long by its own design at 375px — the one standing entry
  // in e2e/screenshot-exceptions.json is a full-page phone shot of it — and the subject here is the
  // sentence over the chart (T109's rule for a shot of a long page). The anchor is the heading block the
  // sentence is in, so the caption is in the frame rather than scrolled off the top of it.
  await shot(page, "patient-summary-flat-week", { ...SCREENFUL, scrollTo: ".patient-card-heading" });
});

test("the one-rise week reads in the singular on the patient's page too (T199)", async ({ page }) => {
  // §2.7's half of acceptance criterion 3, and the surface the ticket's one-rise reading was never read
  // on: "Markers show your biggest rises." over a chart carrying one dot, with a "Your biggest rises" card
  // under it listing one row. The clinician's side of the same count is asserted on the flagged brief at
  // the top of this file.
  //
  // data/fixtures/clarity_window.csv is the committed week with exactly one rise over 180 (96 → 214) —
  // `data/fixtures/README.md` — so the count is the fixture's and not something this test arranges.
  const visit = await visitWithReadings(page, "E2E One Rise", "data/fixtures/clarity_window.csv");

  await page.goto(`/patient/${visit.token}`);
  const glucoseCard = page
    .locator("section.patient-report-card")
    .filter({ has: page.getByRole("heading", { level: 2, name: "Your glucose" }) });
  await expect(glucoseCard).toBeVisible(LOADED);
  const caption = glucoseCard.locator(".patient-report-subtitle");
  await expect(caption).toHaveText("Marker shows your biggest rise.");
  await expect(caption, "a plural over the one marker this chart draws").not.toContainText("Markers");
  // And the card under it, which is the element the sentence has to agree with: one row, one rise.
  const rises = page.locator(".patient-spikes");
  await expect(rises.locator("tbody tr")).toHaveCount(1);
  // T203 (§2.7): and its heading, which until that ticket was the literal "Your biggest rises" over that
  // one row — the plural the caption two lines above has just been asserted not to carry, in the same
  // frame, about the same rise. Both read `patientRiseNoun` in lib/spikePlaces.ts off `bundle.spikes` now,
  // so this assertion and the caption's cannot drift apart.
  await expect(rises.getByRole("heading", { level: 2 }), "a plural over the one rise this card lists").toHaveText(
    "Your biggest rise",
  );
  // No Timeline was shared, so there is no place clause to carry either (T82, T193) — the sentence stops.
  await expect(caption).not.toContainText(/where you/);
  // Anchored on the card's heading block and not on the chart under it: the subject is the sentence, and
  // `.patient-chart-wrap` puts the chart's own top at the top of the frame with the caption scrolled off
  // above it. `.patient-card-heading` is the glucose card's alone on this page.
  await shot(page, "patient-summary-one-rise", { ...SCREENFUL, scrollTo: ".patient-card-heading" });
});

test("the one unplaced rise is singular in the clause after the colon too (T200)", async ({ page }) => {
  // The branch T199 left behind, on the two clinician surfaces that share this caption (§2.6, §7.4). T199
  // made the marker half of it agree with the count and left the half after the colon a fixed plural, so a
  // week with one unplaced rise read "Red marker is a spike … no place matched any of these rises" — the
  // same one rise in both numbers, eleven words apart, in one sentence pair.
  //
  // `clinicianPlaceReport` returns `unmatched` only where a Timeline was shared and nothing in it matched,
  // so the reading needs a pairing data/fixtures/ did not hold until this ticket (AC6): clarity_window.csv's
  // single rise (96 → 214, 07:00 to 08:00) with timeline_no_match.json, whose three stops each fall outside
  // lib/match.ts's window — a gym ending an hour before the climb, and the office and the pizzeria both
  // starting after the peak. That is why T199's own screenshots could not show the defect. Both files go in
  // through `POST /api/upload` as a patient's own exports do, so what is read below is a parsed export and a
  // real `matchSpikesToVisits` result; the arrays themselves are read in lib/spikePlaces.test.ts and the
  // three near misses in lib/match.test.ts.
  const visit = await visitWithReadings(page, "E2E One Rise Unplaced", "data/fixtures/clarity_window.csv", "data/fixtures/timeline_no_match.json");

  await page.goto(`/provider/${visit.demo.id}?visit=${visit.visitId}`);
  await expect(page.locator(".sour-job-state")).toHaveAttribute("data-phase", "ready", DRAINED);

  // What the caption is being read against, on the record first: one rise, a Timeline shared, nothing
  // linked. Without the Timeline this visit is the `no-timeline` branch, whose string carries no such
  // clause at all — which is the state the one-rise brief was asserted in before this ticket.
  const metrics = page.locator(".sour-metrics-card");
  const spikeTile = metrics.locator(".summary-stat-tile", { hasText: "Spikes > 180" });
  await expect(spikeTile.locator(".text-2xl")).toHaveText("1");
  await expect(spikeTile, "a measured zero over a Timeline that was shared (T160, T184)").toContainText("0 linked to a place");
  // T213 (§2.6): the heading over that one row, which counted to nought and to some but not to one until
  // then — "Spikes over 180", in the same frame as the caption asserted below and about the same rise.
  // `exact` because "Spike over 180" is a substring match for the plural: without it this locator would
  // pass again the day the heading regressed.
  const spikeCard = page.locator(".sour-card").filter({ has: page.getByRole("heading", { name: "Spike over 180", exact: true }) });
  await expect(spikeCard.getByRole("heading")).toHaveText("Spike over 180");
  const rows = spikeCard.locator("tbody tr");
  await expect(rows, "the row the clause counts").toHaveCount(1);
  await expect(rows, "the Place column's cell, where a lookup was run and found nothing (T82)").toContainText("no matching visit");

  // §2.6's caption, which is the subject.
  const caption = page.locator(".sour-chart-caption");
  await expect(caption).toHaveText(
    "Shaded band is 70–180 mg/dL. Red marker is a spike. Labels, where they fit, give the peak mg/dL: no place matched this rise.",
  );
  await expect(caption, "a plural over the one rise this chart draws").not.toContainText("these rises");
  await expect(caption, "the marker half T199 made singular, still singular").not.toContainText("Red markers");
  const briefCaption = (await caption.textContent())?.trim();
  expect(briefCaption, "the brief's caption").toBeTruthy();
  await expect(page.locator(".recharts-surface").first()).toBeVisible(LOADED);
  await shot(page, "provider-sour-one-rise-unplaced", { ...SCREENFUL, scrollTo: ".sour-chart-card" });

  // §7.4's sheet reads the same string out of the one `clinicianChartCaption` (T99), so it is compared with
  // the brief's rather than re-derived — the way the flat week above and the flag blocks at the top of this
  // file are.
  const opened = await page.goto(`/provider/visit/${visit.visitId}/print`);
  expect(opened?.status(), "the sheet a clinician may open (§7.4)").toBe(200);
  await expect(page.locator(".sour-print-numbers")).toBeVisible(LOADED);
  await expect(page.locator(".recharts-surface").first()).toBeVisible(LOADED);
  await expect(page.locator(".sour-chart-caption"), "the sheet captions this chart differently from the brief").toHaveText(briefCaption!);
  // T213 (§7.4): the heading on paper too, which is the copy a clinician carries into the room. One
  // `clinicianSpikeCardHeading` behind both surfaces (T99, T157), so this is the same string as the
  // brief's — asserted here rather than inferred, because the sheet is the half the ticket was also
  // filed on (`desktop-provider-print-one-rise-unplaced.png`).
  await expect(page.getByRole("heading", { name: "Spike over 180", exact: true })).toBeVisible();
  await shot(page, "provider-print-one-rise-unplaced", { ...SCREENFUL, scrollTo: ".sour-chart-caption" });
});

test("one matched rise is one place on both clinician surfaces (T213)", async ({ page }) => {
  // The other half of the heading's bug, and the reading no screen in the suite held: over a card with one
  // matched row, `clinicianSpikeCardHeading` returned "Spikes linked to places" — two plural nouns over
  // one rise at one place. The seeded demo and e2e/flows.spec.ts both read that heading on a week with
  // three matched rises, where the plural is right, so the suite had the reading pinned and not covered.
  //
  // `clarity_window.csv`'s single rise (96 → 214, climb from 07:00) with `timeline_android.json`, whose
  // cafe ends at 06:50 — ten minutes inside lib/match.ts's 30-minute window, so the one rise carries one
  // place and `clinicianPlaceReport` reads `matched` at a count of one. Both files go in through
  // `POST /api/upload` as a patient's own exports do (data/fixtures/README.md); the parsed pair is read in
  // lib/spikePlaces.test.ts.
  const visit = await visitWithReadings(page, "E2E One Rise Placed", "data/fixtures/clarity_window.csv", "data/fixtures/timeline_android.json");

  await page.goto(`/provider/${visit.demo.id}?visit=${visit.visitId}`);
  await expect(page.locator(".sour-job-state")).toHaveAttribute("data-phase", "ready", DRAINED);

  // What the heading is being read against, on the record first: one rise, and the match that puts the
  // card in its `matched` shape (T184's tile, which counts where a Timeline was shared).
  const metrics = page.locator(".sour-metrics-card");
  const spikeTile = metrics.locator(".summary-stat-tile", { hasText: "Spikes > 180" });
  await expect(spikeTile.locator(".text-2xl")).toHaveText("1");
  await expect(spikeTile, "the one rise linked to the one place").toContainText("1 linked to a place");

  // The subject. `exact`, for the reason the unplaced brief above gives: the singular is a substring of
  // the plural this ticket replaced, so a loose match would pass over the bug.
  const spikeCard = page.locator(".sour-card").filter({ has: page.getByRole("heading", { name: "Spike linked to a place", exact: true }) });
  await expect(spikeCard.getByRole("heading")).toHaveText("Spike linked to a place");
  await expect(spikeCard.locator("tbody tr"), "the row the heading counts").toHaveCount(1);
  // And the caption one card above it, which is the other element in the frame (criterion 2): singular
  // since T199, and naming the place the rise was linked to since T191.
  const caption = page.locator(".sour-chart-caption");
  await expect(caption).toContainText("Red marker is a spike.");
  await expect(caption, "a plural over the one rise this chart draws").not.toContainText(/Red markers|these rises/);
  await expect(page.locator(".recharts-surface").first()).toBeVisible(LOADED);
  await shot(page, "provider-sour-one-rise-placed", { ...SCREENFUL, scrollTo: ".sour-chart-card" });

  // §7.4's sheet, where one function serves both headings (T99, T157).
  const opened = await page.goto(`/provider/visit/${visit.visitId}/print`);
  expect(opened?.status(), "the sheet a clinician may open (§7.4)").toBe(200);
  await expect(page.locator(".sour-print-numbers")).toBeVisible(LOADED);
  await expect(page.locator(".recharts-surface").first()).toBeVisible(LOADED);
  await expect(page.getByRole("heading", { name: "Spike linked to a place", exact: true })).toBeVisible();
  await shot(page, "provider-print-one-rise-placed", { ...SCREENFUL, scrollTo: ".sour-chart-caption" });
});
