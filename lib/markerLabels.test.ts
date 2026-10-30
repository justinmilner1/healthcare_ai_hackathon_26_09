import assert from "node:assert/strict";
import test from "node:test";
import { MARKER_DOT, MARKER_REACH, halfLabelWidth, markerLabels, trimMarkerLabel } from "./markerLabels";
import type { Spike } from "./types";

// T197 (design §2.6, §2.7, §7.4, §6.5, §12.1): which rises over the one glucose line all three surfaces
// draw carry a label, and which keep only their marker.
//
// The case the ticket was filed about is a *pair*: a rise whose own label was dropped for being too close,
// whose marker was drawn anyway, over the tail of the label it was too close to. So most of what is below
// is written as pairs at a stated pixel gap — `pair` converts the gap into the timestamps a chart of this
// span would put them at — because the gap in pixels is the whole of the arithmetic and a gap in hours is
// only that gap once you have also said how wide the plot is.
//
// Timestamps are UTC literals, unlike lib/timeAxis.test.ts' local-clock ones: nothing here is a decision
// about a wall clock. A peak is an instant, and the only thing this module asks about one is how far along
// the line it falls.

/** The three plots §6.5's 375px page hands this chart, and a desk's, as lib/timeAxis.test.ts measured them. */
const BRIEF_375 = 209;
const PRINT_375 = 205;
const PATIENT_375 = 237;
const DESK = 680;

const HOUR = 3_600_000;

/** The ends of the line the seeded week draws: data/dexcom_clarity_sample.csv, downsampled as the page gets it. */
const WEEK_FIRST = Date.parse("2026-09-19T00:00:00.000Z");
const WEEK_LAST = Date.parse("2026-09-25T23:40:00.000Z");

/** A rise peaking at `peak` mg/dL `at` milliseconds, with no place on it — so its label is the peak (T128). */
const rise = (at: number, peak: number): Spike => ({
  start: new Date(at - HOUR).toISOString(),
  peak: new Date(at).toISOString(),
  from: 108,
  to: peak,
});

/** A rise that the Timeline export placed, so its label is a place name rather than a number. */
const placedRise = (at: number, peak: number, place: string): Spike => ({
  ...rise(at, peak),
  visit: { start: new Date(at - 2 * HOUR).toISOString(), end: new Date(at - HOUR).toISOString(), place, lat: 37.79, lng: -122.4 },
});

/**
 * Two rises whose markers sit `gapPx` apart on a `plot`-wide drawing of a `span`-long line.
 *
 * The first is placed a quarter of the way along, which keeps both of them and both of their labels clear
 * of the ends of the plot — this module measures nothing against the edges, and a pair hanging off one of
 * them would read as if it did.
 */
function pair(gapPx: number, peaks: [number, number], { plot, span = WEEK_LAST - WEEK_FIRST }: { plot: number; span?: number }) {
  const at = WEEK_FIRST + span * 0.25;
  // Rounded up to the millisecond a timestamp can carry, so a gap asked for in pixels is never handed over
  // a hair short of itself: a peak is an ISO string, and one millisecond of this span is three ten-millionths
  // of a pixel — far below the half-pixel the boundary tests below step by, and far above nothing, which is
  // what the exact-boundary case needs.
  return [rise(at, peaks[0]), rise(at + Math.ceil((gapPx / plot) * span), peaks[1])];
}

/** What a chart would actually paint, in peak order: the label over each rise, or `-` where one was dropped. */
const drawn = (spikes: Spike[], opts: { plot: number; patient?: boolean; first?: number; last?: number }): string[] => {
  const kept = markerLabels(spikes, { first: opts.first ?? WEEK_FIRST, last: opts.last ?? WEEK_LAST, plot: opts.plot, patient: opts.patient ?? false });
  return [...spikes]
    .sort((a, b) => Date.parse(a.peak) - Date.parse(b.peak))
    .map((s) => kept.get(s) ?? "-");
};

/**
 * The property acceptance criterion 1 is: no marker's ink reaches any drawn label.
 *
 * The same comparison e2e/charts.ts makes against the rendered SVG, made here against the arithmetic, so a
 * plot no fixture renders can be held to it too. `DOT_GAP` is deliberately not added: this asks only that
 * nothing *overlaps*, which is the promise, and leaves the module its clearance.
 */
function expectNoMarkerOnALabel(spikes: Spike[], opts: { plot: number; patient?: boolean }): void {
  const ordered = [...spikes].sort((a, b) => Date.parse(a.peak) - Date.parse(b.peak));
  const span = WEEK_LAST - WEEK_FIRST;
  const x = ordered.map((s) => ((Date.parse(s.peak) - WEEK_FIRST) / span) * opts.plot);
  const labels = drawn(spikes, opts);
  labels.forEach((label, i) => {
    if (label === "-") return;
    const half = halfLabelWidth(label);
    x.forEach((other, j) => {
      if (j === i) return;
      const clear = Math.abs(other - x[i]) - (half + MARKER_REACH);
      assert.ok(
        clear >= 0,
        `at ${opts.plot}px the marker at ${other.toFixed(1)}px covers ${(-clear).toFixed(1)}px of the label "${label}" centred at ${x[i].toFixed(1)}px`,
      );
    });
  });
}

// The ticket's own pair, in both directions. The seeded week's `Sun 1:55 PM 108 → 202` and
// `Sun 10:30 PM 107 → 214` are 8h35m apart, which is 10.7px of the brief's 209px card — and the rule this
// replaced labelled the first of them and then drew the second's marker over its last digit, so a clinician
// read `20`.
//
// Which of the two peaks higher is what made the overlap *visible*: `position: "top"` puts a label about
// 10px above its own marker, so the higher neighbour's dot lands at the label's text height while a lower
// one passes below it. It is deliberately not in the rule. Modelling it would mean knowing the pixels per
// mg/dL, which is the chart's height less Recharts' own margins and axis — numbers this product is never
// handed and would have to estimate, and T190 is what estimating a number Recharts owns costs. A label is
// either clear of the marker or it is dropped; the caption promises only the labels that fit.
test("the pair this ticket is about loses its label whether the neighbour peaks higher or lower", () => {
  const higher = pair(10.7, [202, 214], { plot: BRIEF_375 });
  const lower = pair(10.7, [202, 190], { plot: BRIEF_375 });

  assert.deepEqual(drawn(higher, { plot: BRIEF_375 }), ["-", "-"], "a label 10.7px from the next marker is not a label that fits");
  assert.deepEqual(drawn(lower, { plot: BRIEF_375 }), ["-", "-"], "and the answer does not depend on which of the two peaks higher");

  expectNoMarkerOnALabel(higher, { plot: BRIEF_375 });
  expectNoMarkerOnALabel(lower, { plot: BRIEF_375 });
});

// And the control, which is what says the *marker* is the reason. Same two rises, same labels, same card:
// moved far enough apart that the second's ink clears the first's label, the first label comes back. It is
// still the only one — the label-against-label rule wants 26.2px for two three-character labels and this is
// 20 — so the pair is genuinely one label's worth of room, and the question T197 answers is which one.
test("the same pair keeps the earlier label once the neighbour's marker is clear of it", () => {
  const apart = pair(20, [202, 214], { plot: BRIEF_375 });
  assert.deepEqual(drawn(apart, { plot: BRIEF_375 }), ["202", "-"]);
  expectNoMarkerOnALabel(apart, { plot: BRIEF_375 });
});

// Acceptance criterion 3, as behaviour rather than as a reading of the constants: the gap the rule needs is
// the label's half-width plus the marker's own reach plus the clearance, and the reach is `r` plus half the
// stroke of the dot `ReferenceDot` is actually given. A boundary in each direction, so neither figure can be
// dropped from the sum without this failing.
test("the gap a label needs from a marker is the dot's own radius and stroke", () => {
  assert.equal(MARKER_REACH, MARKER_DOT.r + MARKER_DOT.strokeWidth / 2, "the reach is the circle Recharts paints, stroke included");

  const needed = halfLabelWidth("202") + MARKER_REACH + 4;
  assert.deepEqual(drawn(pair(needed, [202, 214], { plot: BRIEF_375 }), { plot: BRIEF_375 })[0], "202", "exactly the gap it asks for is enough");
  assert.deepEqual(drawn(pair(needed - 0.5, [202, 214], { plot: BRIEF_375 }), { plot: BRIEF_375 })[0], "-", "half a pixel less is not");
});

// A dropped label does not advance the label cursor — that is right, and it is the reason the marker had to
// be measured separately (the ticket's analysis, `:79-81` of the old component). Three rises: the middle one
// is far too close to the first to be labelled, and the third is clear of the first's label but *not* of the
// middle one's marker. So the third is the case no label-against-label rule can see, however it is written.
test("a label is measured against the markers of rises whose own labels were dropped", () => {
  const span = WEEK_LAST - WEEK_FIRST;
  const px = (n: number) => (n / BRIEF_375) * span;
  const at = WEEK_FIRST + span * 0.25;
  const spikes = [rise(at, 206), rise(at + px(8), 214), rise(at + px(26), 210)];

  // 26px from the first marker clears the first label (8.1 + 8.1 + 10 = 26.2 is what two of these need —
  // and it does not clear that either), but 18px from the middle marker is one pixel short of the 18.1 the
  // dot asks for. Nothing is labelled, and no marker sits on a label.
  assert.deepEqual(drawn(spikes, { plot: BRIEF_375 }), ["-", "-", "-"]);
  expectNoMarkerOnALabel(spikes, { plot: BRIEF_375 });
});

// T23, unchanged: where the markers are far enough apart to be out of each other's way, the labels are still
// thinned against each other. Four rises inside 60px of a 209px card is the case that ticket was filed about.
test("labels still clear each other, which is the rule this extends", () => {
  const span = WEEK_LAST - WEEK_FIRST;
  const px = (n: number) => (n / BRIEF_375) * span;
  const at = WEEK_FIRST + span * 0.2;
  const crowded = [rise(at, 206), rise(at + px(20), 202), rise(at + px(40), 214), rise(at + px(60), 210)];

  const labels = drawn(crowded, { plot: BRIEF_375 });
  assert.ok(labels.filter((l) => l !== "-").length < 4, `four labels inside 60px is what T23 refuses, and got ${labels.join(" | ")}`);
  expectNoMarkerOnALabel(crowded, { plot: BRIEF_375 });
});

// Acceptance criterion 4, the half of this ticket that is a promise to leave something alone. The seeded
// week is five rises, and on a desk every one of them is labelled — before T197 and after it. The widths
// §6.5 narrows to are where the answers differ, and only by the one label the dot was sitting on.
const SEEDED_WEEK: Spike[] = [
  rise(Date.parse("2026-09-19T13:45:00.000Z"), 206),
  rise(Date.parse("2026-09-20T13:55:00.000Z"), 202),
  rise(Date.parse("2026-09-20T22:30:00.000Z"), 214),
  rise(Date.parse("2026-09-22T22:45:00.000Z"), 210),
  rise(Date.parse("2026-09-25T19:40:00.000Z"), 194),
];

/** The same week once a Timeline export has placed three of its rises, which is what the demo visit holds. */
const SEEDED_WEEK_PLACED: Spike[] = [
  SEEDED_WEEK[0],
  SEEDED_WEEK[1],
  placedRise(Date.parse("2026-09-20T22:30:00.000Z"), 214, "37.790, -122.401"),
  placedRise(Date.parse("2026-09-22T22:45:00.000Z"), 210, "37.790, -122.401"),
  placedRise(Date.parse("2026-09-25T19:40:00.000Z"), 194, "37.760, -122.415"),
];

test("the desk keeps every label the seeded week had before this ticket", () => {
  assert.deepEqual(drawn(SEEDED_WEEK, { plot: DESK }), ["206", "202", "214", "210", "194"]);
  expectNoMarkerOnALabel(SEEDED_WEEK, { plot: DESK });
});

test("the patient's 375px chart keeps the two place labels it draws today", () => {
  const labels = drawn(SEEDED_WEEK_PLACED, { plot: PATIENT_375, patient: true });
  assert.equal(labels.filter((l) => l === "a place you went").length, 2, `the two the page draws today, and got ${labels.join(" | ")}`);
  expectNoMarkerOnALabel(SEEDED_WEEK_PLACED, { plot: PATIENT_375, patient: true });
});

test("no marker sits on a label on any of the three surfaces 375px narrows", () => {
  for (const plot of [BRIEF_375, PRINT_375, PATIENT_375]) {
    for (const spikes of [SEEDED_WEEK, SEEDED_WEEK_PLACED]) {
      for (const patient of [false, true]) {
        expectNoMarkerOnALabel(spikes, { plot, patient });
        assert.ok(
          drawn(spikes, { plot, patient }).some((l) => l !== "-"),
          `a chart of five rises at ${plot}px with nothing labelled at all would keep criterion 1 by saying nothing`,
        );
      }
    }
  }
});

// The frame before the ResizeObserver has run, where there is no width to measure anything against. Both
// pixel tests are unapplicable rather than lenient, so the fallback is the share-of-the-span rule T23
// replaced — and the seeded week's close pair is 5.1% of it, which that rule just allows. One frame of a
// label 10.7px from a marker is the trade; the alternative is a first paint with no labels on it at all.
test("an unmeasured plot falls back to the share-of-the-span rule", () => {
  assert.deepEqual(drawn(SEEDED_WEEK, { plot: 0 }), ["206", "202", "214", "210", "194"]);

  const span = WEEK_LAST - WEEK_FIRST;
  const at = WEEK_FIRST + span * 0.25;
  const tight = [rise(at, 206), rise(at + span * 0.04, 214)];
  assert.deepEqual(drawn(tight, { plot: 0 }), ["206", "-"], "closer than a twentieth of the span is dropped with no width either");
});

test("a place name longer than the label can carry is trimmed, and measured trimmed", () => {
  assert.equal(trimMarkerLabel("37.760, -122.415"), "37.760, -122.415", "sixteen characters fit");
  assert.equal(trimMarkerLabel("37.790, -122.4012"), "37.790, -122.40…", "and seventeen do not");
  assert.equal(trimMarkerLabel("Blue Bottle Coffee Embarcadero").length, 16);

  const long = [placedRise(WEEK_FIRST + (WEEK_LAST - WEEK_FIRST) * 0.5, 214, "Blue Bottle Coffee Embarcadero")];
  assert.deepEqual(drawn(long, { plot: BRIEF_375 }), ["Blue Bottle Cof…"], "the drawn label is the trimmed one");
});

test("one rise on its own is always labelled, and no rises is no labels", () => {
  assert.deepEqual(drawn([rise(WEEK_FIRST + HOUR, 214)], { plot: BRIEF_375 }), ["214"], "nothing can collide with the only marker there is");
  assert.equal(markerLabels([], { first: WEEK_FIRST, last: WEEK_LAST, plot: BRIEF_375, patient: false }).size, 0);
});
