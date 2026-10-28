import assert from "node:assert/strict";
import test from "node:test";
import { computeStats } from "./bundle";
import { clinicianGmi, GMI_A1C_HINT, GMI_A1C_MIN_DAYS, GMI_SHORT_SPAN_HINT } from "./gmi";
import type { GlucoseReading } from "./types";

/** Any claim that the figure estimates an A1c, wherever on the tile it is made (T185). */
const A1C_CLAIM = /a1c/i;

test("the span the figure needs is the one the product already asks the patient for", () => {
  // lib/sweetie.ts tells the patient to export "the last 14 days", so the threshold is this repo's own
  // number and not one imported from outside it. Written out in the hint for the no-variable rule
  // (acceptance criterion 4), and tied to the constant here so the two cannot drift apart.
  assert.equal(GMI_A1C_MIN_DAYS, 14);
  assert.ok(
    GMI_SHORT_SPAN_HINT.includes(String(GMI_A1C_MIN_DAYS)),
    `the hint names a different span from the rule: ${GMI_SHORT_SPAN_HINT} against ${GMI_A1C_MIN_DAYS}`,
  );
});

test("a span of 14 days or more reads as an estimated A1c, on both surfaces", () => {
  const fortnight = clinicianGmi({ days: GMI_A1C_MIN_DAYS, gmi: 6.1 });
  assert.equal(fortnight.hint, GMI_A1C_HINT);
  assert.equal(fortnight.value, "6.1");
  // The overview clause the brief's one-line summary prints beside "In range" and "avg".
  assert.equal(fortnight.overview, "GMI 6.1%");

  // And on past it, so the rule is a floor and not an equality.
  assert.equal(clinicianGmi({ days: 90, gmi: 7.4 }).hint, GMI_A1C_HINT);
  assert.equal(clinicianGmi({ days: 90, gmi: 7.4 }).overview, "GMI 7.4%");
});

test("a span under 14 days keeps the number and drops the A1c claim", () => {
  // The frame this was found in: `desktop-provider-print-single-day.png`, one day and 84 readings.
  const oneDay = clinicianGmi({ days: 1, gmi: 6.1 });
  assert.equal(oneDay.value, "6.1", "the figure is computable and true of the readings that arrived");
  assert.equal(oneDay.hint, GMI_SHORT_SPAN_HINT);
  assert.doesNotMatch(oneDay.hint, /est\. A1c/, "and no longer states the figure as an estimated A1c");
  assert.equal(oneDay.overview, null, "the glance line has nowhere to put the qualifier, so it omits the figure");

  // The day under the threshold, which is the half of the boundary the one above does not cover.
  const thirteen = clinicianGmi({ days: GMI_A1C_MIN_DAYS - 1, gmi: 6.1 });
  assert.equal(thirteen.hint, GMI_SHORT_SPAN_HINT);
  assert.equal(thirteen.overview, null);
});

test("the two surfaces cannot read the same at one day as at fourteen", () => {
  // The one thing acceptance criterion 3 rules out, asserted as the inequality it is: whatever the rule
  // becomes, these two spans may not produce the same tile.
  const oneDay = clinicianGmi({ days: 1, gmi: 6.1 });
  const fortnight = clinicianGmi({ days: GMI_A1C_MIN_DAYS, gmi: 6.1 });
  assert.notEqual(oneDay.hint, fortnight.hint);
  assert.match(fortnight.hint, A1C_CLAIM, "fourteen days is the span that does support the estimate");
  assert.doesNotMatch(oneDay.hint, /^est\. A1c/, "one day is the span that does not");
});

test("no readings at all is on the short side, so the rule is not satisfied by withholding from everybody", () => {
  // `computeStats` answers an empty upload with `days: 0, gmi: 0` (lib/bundle.ts), and a "0.0 %" labelled
  // as an estimated A1c is this ticket's overclaim with nothing whatsoever behind it.
  const empty = computeStats([], []);
  assert.deepEqual([empty.days, empty.gmi], [0, 0]);
  assert.equal(clinicianGmi(empty).hint, GMI_SHORT_SPAN_HINT);
  assert.equal(clinicianGmi(empty).overview, null);

  // And the other end of the same assertion: the rule still says yes to somebody, so it cannot be met by a
  // tile that never claims anything. A fortnight of real readings, through the function the pages read.
  const fortnight = computeStats(twoWeeks(), []);
  assert.ok(fortnight.days >= GMI_A1C_MIN_DAYS, `a fortnight of readings spans ${fortnight.days} days`);
  assert.equal(clinicianGmi(fortnight).hint, GMI_A1C_HINT);
  assert.match(clinicianGmi(fortnight).overview ?? "", /^GMI \d+\.\d%$/);
});

/** Fifteen days of hourly readings in range, as a Clarity export of the span Sweetie asks for would parse. */
function twoWeeks(): GlucoseReading[] {
  const start = Date.parse("2026-09-01T00:00:00Z");
  return Array.from({ length: 15 * 24 }, (_, i) => ({
    t: new Date(start + i * 3600000).toISOString(),
    mgdl: 110 + ((i * 7) % 40),
  }));
}
