import assert from "node:assert/strict";
import test from "node:test";
import { fixture, pinUtcTimeZone } from "./fixtures";
import { parseWhoopCsv } from "./sleep";
import { parseClarityCsv } from "./glucose";
import { computeStats } from "./bundle";
import { patientSleepCardSubtitle } from "./sleepRecovery";
import {
  clinicianSleepCardHeading,
  clinicianSleepTileHint,
  patientSleepSpanClause,
  patientSleepTileDetail,
  sleepNightsClause,
  sleepSpanOverruns,
} from "./sleepSpan";
import type { SleepNight } from "./types";

pinUtcTimeZone(); // the fixtures carry device-local timestamps with no offset

/**
 * The pair this ticket is about, read out of the committed fixtures rather than written out here (T218 AC4,
 * AC5): `clarity_window.csv` is 84 readings inside one morning — Sat 19 Sep, 06:00 to 12:55 — and
 * `whoop_cycles.csv` is the three nights of 19→20, 20→21 and 21→22, two of which fall entirely after the
 * only day of glucose the page is about.
 *
 * Through `computeStats` for the glucose side, because `stats.days` is the number the surfaces frame
 * themselves with and deriving the span any other way here would be testing a second implementation of it.
 */
const nights: SleepNight[] = parseWhoopCsv(fixture("whoop_cycles.csv"));
const oneDay = computeStats(parseClarityCsv(fixture("clarity_window.csv")), nights);

test("the fixture pair really is one day of glucose beside three nights of sleep", () => {
  // Asserted rather than assumed: if either export is ever widened, this says so here instead of leaving
  // every test below passing over a pair that no longer mismatches.
  assert.equal(oneDay.days, 1, "clarity_window.csv is one calendar day of readings");
  assert.equal(nights.length, 3, "whoop_cycles.csv is three nights");
  assert.equal(oneDay.sleepAvgHours, 6.8, "averaged over all three, which is the figure the tile prints");
});

test("a sleep series wider than the glucose span is an overrun, and one inside it is not", () => {
  assert.equal(sleepSpanOverruns(nights, oneDay.days), true);
  // The ordinary week: three scored nights of a span the page correctly claims. Not this bug, and the
  // wording must not move for it — every committed §12.3 shot of a week rests on that.
  assert.equal(sleepSpanOverruns(nights, 7), false);
  // Equal is not an overrun either: three nights over three days is the frame the page already names.
  assert.equal(sleepSpanOverruns(nights, 3), false);
  assert.equal(sleepSpanOverruns(nights, 2), true);
  // No nights at all: the tile reads "not connected" and there is nothing to frame.
  assert.equal(sleepSpanOverruns([], 1), false);
  // And no readings: the page makes no span claim for a card to contradict, so the comparison is not made
  // rather than made against a `0 days` nobody is shown. Both surfaces gate the card on `hasDexcom` anyway.
  assert.equal(sleepSpanOverruns(nights, 0), false);
});

test("the nights are named as their own count, with the noun agreeing", () => {
  assert.equal(sleepNightsClause(nights, oneDay.days), "3 nights");
  assert.equal(sleepNightsClause(nights, 7), null);
  // One night over no span of its own: "1 night", not "1 nights" (lib/plural.ts, the rule T60 settled).
  assert.equal(sleepNightsClause([nights[0]], 0), null);
  assert.equal(sleepNightsClause([nights[0], nights[1]], 1), "2 nights");
  assert.equal(sleepNightsClause([{ date: "2026-09-19", hours: 7.3 }], 1), null);
});

test("§2.7's SLEEP tile says how many nights it averaged, and otherwise says what it always said", () => {
  // The frame the ticket was filed on: `6.8 / hours / night` beside a `HISTORY / 1 / day` tile read as one
  // night's sleep, and the figure is an average over three.
  assert.equal(patientSleepTileDetail(nights, oneDay.days), "hours · 3 nights");
  assert.equal(patientSleepTileDetail(nights, 7), "hours / night");
  assert.equal(patientSleepTileDetail([], 1), "hours / night");
});

test("§2.7's sleep card names both spans, so the bars are read against the glucose above them", () => {
  assert.equal(
    patientSleepSpanClause(nights, oneDay.days),
    "These 3 nights cover more than the day of glucose above.",
  );
  // The glucose side is `spanNoun`'s noun, like the four sentences the page composes from it, so this clause
  // and the hero over it cannot disagree about what arrived (T100, T114).
  assert.equal(
    patientSleepSpanClause(nights, 2),
    "These 3 nights cover more than the 2 days of glucose above.",
  );
  assert.equal(patientSleepSpanClause(nights, 7), null);
  // Nothing on the clause names a span wider than the data, which is what e2e/patient.ts's
  // `expectNoWiderSpan` holds the narrative cards to over the same visit (T217).
  assert.doesNotMatch(patientSleepSpanClause(nights, oneDay.days) ?? "", /\b(weeks?|months?|years?)\b/i);
});

test("the whole subtitle over the mismatched pair, as the page renders it (AC1)", () => {
  // `whoop_cycles.csv` scores every night, so this is the recovery branch plus the span clause — the
  // sentence `desktop-a11y-summary.png` and `mobile-a11y-summary.png` now show.
  assert.equal(
    patientSleepCardSubtitle(nights, oneDay.days),
    "Nightly sleep and recovery from your connected data. These 3 nights cover more than the day of glucose above.",
  );
});

test("the clinician's sleep card counts its nights where they outrun the glucose heading beside it (AC3)", () => {
  // Parallel to `Glucose, last 1 day` on the card above it, which is the register §7 asks for.
  assert.equal(clinicianSleepCardHeading(nights, oneDay.days), "Sleep, 3 nights");
  // And one word over the week the two surfaces were laid out around.
  assert.equal(clinicianSleepCardHeading(nights, 7), "Sleep");
  assert.equal(clinicianSleepCardHeading([], 1), "Sleep");
});

test("the clinician's Sleep tile hint joins the nights to the recovery score it already carried", () => {
  assert.equal(clinicianSleepTileHint(nights, oneDay.days, oneDay.recoveryAvg), "3 nights · recovery 61%");
  // The recovery half is unchanged where the nights fit, which is what every committed brief shot shows.
  assert.equal(clinicianSleepTileHint(nights, 7, oneDay.recoveryAvg), "recovery 61%");
  // An export whose header names no recovery column (lib/sleep.ts): the nights alone, and no empty clause
  // or stray separator left where the score would have been.
  assert.equal(clinicianSleepTileHint(nights, oneDay.days, null), "3 nights");
  assert.doesNotMatch(clinicianSleepTileHint(nights, oneDay.days, null) ?? "", /·/);
  // Neither fact to report: `undefined` and not `""`, because StatTile draws the hint element only when
  // there is one, and an empty div is a gap under the tile.
  assert.equal(clinicianSleepTileHint(nights, 7, null), undefined);
  assert.equal(clinicianSleepTileHint([], 1, null), undefined);
  // A zero recovery average is a reading and not an absence, like `recoveryScores` keeping a zero score.
  assert.equal(clinicianSleepTileHint(nights, 7, 0), "recovery 0%");
});

test("the three surfaces reach one conclusion about one upload (AC2)", () => {
  // The point of the module: the patient's sentence, the patient's tile, the clinician's heading and the
  // clinician's hint are all `sleepNightsClause` and cannot drift apart. Driven over the spans either
  // fixture can produce rather than over the one the bug was found at.
  for (const days of [0, 1, 2, 3, 4, 7, 14]) {
    const counted = sleepNightsClause(nights, days) !== null;
    assert.equal(patientSleepTileDetail(nights, days).includes("nights"), counted, `patient tile at ${days}`);
    assert.equal(patientSleepSpanClause(nights, days) !== null, counted, `patient card at ${days}`);
    assert.equal(clinicianSleepCardHeading(nights, days) !== "Sleep", counted, `clinician heading at ${days}`);
    assert.equal(
      (clinicianSleepTileHint(nights, days, null) ?? "") !== "",
      counted,
      `clinician hint at ${days}`,
    );
  }
});
