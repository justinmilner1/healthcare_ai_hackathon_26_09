import assert from "node:assert/strict";
import test from "node:test";
import { AXIS_TEXT_REACH, DRAWN_CHROME, MARKER_DOT, MARKER_REACH, PLOT_CHROME, halfLabelWidth, markerLabels, plotWidth, trimMarkerLabel } from "./markerLabels";
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

/**
 * The three plots §6.5's 375px page hands this chart, and a desk's, as lib/timeAxis.test.ts measured them.
 *
 * Re-measured for T224, and 28px narrower than they were: `PLOT_CHROME` was a literal 80 where Recharts
 * lays out 108, so these used to be 209, 205, 237 and 680 — numbers naming a drawing area wider than the
 * one on screen. Taken off the rendered charts rather than computed: `.recharts-cartesian-grid` is
 * 181px wide on the brief at 375px, 177px on §7.4's sheet and 209px on §2.7's page, and 760, 553 and 866
 * at desktop width. `DESK` is a desk's plot in round numbers, between the three of those.
 */
const BRIEF_375 = 181;
const PRINT_375 = 177;
const PATIENT_375 = 209;
const DESK = 652;

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
  //
  // `Math.ceil` alone is not enough for that, and the plots narrowing by 28px in T224 is what showed it:
  // what the rule measures is the gap between two positions it works out separately, and where
  // `gapPx / plot × span` lands on a whole millisecond, that subtraction comes back a float hair short —
  // 18.099999999999994 for the 18.1 asked at the brief's 181px plot, which read as a gap one tick inside
  // the boundary and dropped a label this test had asked to be exactly on it. So the millisecond is
  // raised until the gap the rule will measure is the gap that was asked for, computed the way the rule
  // computes it rather than from `ms` alone.
  const xOf = (t: number) => ((t - WEEK_FIRST) / span) * plot;
  let ms = Math.ceil((gapPx / plot) * span);
  while (xOf(at + ms) - xOf(at) < gapPx) ms += 1;
  return [rise(at, peaks[0]), rise(at + ms, peaks[1])];
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

/**
 * The property acceptance criterion 1 of T223 is: no drawn label reaches into the y-axis tick text.
 *
 * Asserted twice over, and the two have come together (T224). The first is the rule itself — a kept label
 * starts at or inside the plot's left edge. The second is the promise the rule is there to keep: the
 * label's left end is not inside the digits, which end `AXIS_TEXT_REACH` further left again. Until T224
 * the second was a conversion as well as a weaker bound, because `plot` overstated the drawing area by
 * `DRAWN_CHROME - PLOT_CHROME` and a label on the arithmetic's edge was really a little left of the drawn
 * one. That difference is zero now, so what is left is the rule and the gutter it leaves untouched — and
 * the weaker bound is still worth asserting separately, because it is the property, and a rule rewritten
 * to measure back from the tick text rather than from the edge would have to keep it.
 */
function expectNoLabelOnTheAxis(spikes: Spike[], opts: { plot: number; patient?: boolean; first?: number; last?: number }): void {
  const first = opts.first ?? WEEK_FIRST;
  const span = (opts.last ?? WEEK_LAST) - first;
  const ordered = [...spikes].sort((a, b) => Date.parse(a.peak) - Date.parse(b.peak));
  assert.equal(PLOT_CHROME, DRAWN_CHROME, "the plot this is measuring in is the one Recharts draws (T224)");
  drawn(spikes, opts).forEach((label, i) => {
    if (label === "-") return;
    const frac = (Date.parse(ordered[i].peak) - first) / span;
    const half = halfLabelWidth(label);
    const left = frac * opts.plot - half;
    assert.ok(left >= 0, `at ${opts.plot}px the label "${label}" starts ${(-left).toFixed(1)}px outside the plot`);
    assert.ok(
      left >= -AXIS_TEXT_REACH,
      `at ${opts.plot}px the label "${label}" is drawn at ${left.toFixed(1)}px, ` +
        `${(-AXIS_TEXT_REACH - left).toFixed(1)}px inside the y-axis tick text`,
    );
  });
}

// T223's own case, which is T221's fixture: `clarity_three_rises.csv` is one day from 06:00 to 23:55 whose
// first rise peaks at 08:00, two hours in — 11.2% of the span — and carries the longest label this product
// draws, a sixteen-character coordinate pair. Its half-width is 43.2px and the rise is 19.8px along the
// 177px the sheet draws at 375px, so the label began 23.4px *left of the plot itself* and ran back from
// there through the `250`. Those are the units the rule is kept in now that `plot` is that same 177px
// (T224); T223 had to state the frame and the arithmetic separately, because the two differed by 28px.
// Reproduced here as the arithmetic rather than as the fixture, so the numbers are legible: what matters
// is a long label over a rise early in a window, and the fixture is one instance of it.
const DAY_FIRST = Date.parse("2026-09-19T06:00:00.000Z");
const DAY_LAST = Date.parse("2026-09-19T23:55:00.000Z");

/** The three rises of that fixture, the first of them placed, as the chart is handed them. */
const THREE_RISES: Spike[] = [
  placedRise(Date.parse("2026-09-19T08:00:00.000Z"), 214, "37.777, -122.423"),
  rise(Date.parse("2026-09-19T19:00:00.000Z"), 196),
  rise(Date.parse("2026-09-19T22:30:00.000Z"), 188),
];

test("a long label over a rise early in the window is dropped rather than drawn through the axis", () => {
  for (const plot of [BRIEF_375, PRINT_375]) {
    const labels = drawn(THREE_RISES, { plot, first: DAY_FIRST, last: DAY_LAST });
    assert.deepEqual(
      labels,
      ["-", "196", "188"],
      `at ${plot}px the place label cannot clear the axis and the two that can are kept, and got ${labels.join(" | ")}`,
    );
  }
});

test("the same label on the same rise is kept once the chart is wide enough to hold it clear", () => {
  // A desk, where 11.2% of the span is 73px of plot and the label's 43.2px half still starts well inside
  // it — 72.8px along the 652px plot here, 29.6px clear of the edge. This is T223's acceptance criterion
  // 4 at the surface that ticket promises to leave alone: the rule drops a label because it does not fit,
  // never because it is long.
  const labels = drawn(THREE_RISES, { plot: DESK, first: DAY_FIRST, last: DAY_LAST });
  assert.deepEqual(labels, ["37.777, -122.423", "196", "188"]);
});

test("the edge a label is held to is the plot's own, and the gutter beyond it is the margin", () => {
  // A label centred exactly its own half-width along starts on the plot's left edge and is kept; half a
  // pixel earlier it does not and is dropped. Half a pixel is the tolerance e2e/charts.ts reads the
  // rendered boxes at, so this is the finest step worth asserting.
  const span = DAY_LAST - DAY_FIRST;
  const at = (px: number) => DAY_FIRST + Math.ceil((px / PRINT_375) * span);
  const half = halfLabelWidth("37.777, -122.423");
  const only = (centre: number) => [placedRise(at(centre), 214, "37.777, -122.423")];
  const window = { plot: PRINT_375, first: DAY_FIRST, last: DAY_LAST };

  assert.deepEqual(drawn(only(half), window), ["37.777, -122.423"], "on the edge is inside it");
  assert.deepEqual(drawn(only(half - 0.5), window), ["-"], "and half a pixel short of it is not");

  // And the margin that makes the edge the right place to put the boundary, restated now that none of it
  // is spent (T224 criterion 4). T223 had to show that a label sitting on the arithmetic's edge was still
  // clear of the digits although it was really drawn `half × (DRAWN_CHROME - PLOT_CHROME) / plot` further
  // left: at the longest label this product draws over the narrowest plot it draws that was 5.9px of the
  // 8px gutter, and a `LABEL_CHARS` of 22 would have spent 8.1px of it and put a label back on the `250`
  // with every test still passing. The drift is zero, so the bound is about `AXIS_TEXT_REACH` and nothing
  // else: the whole gutter is clearance, at every label length and every plot.
  const drift = (halfLabelWidth("a place you went") * (DRAWN_CHROME - PLOT_CHROME)) / PRINT_375;
  assert.equal(drift, 0, `a label on the plot's edge is drawn ${drift.toFixed(1)}px left of it`);
  assert.ok(AXIS_TEXT_REACH > 0, "and the gutter the rule leaves untouched is the clearance it relies on");
  expectNoLabelOnTheAxis(only(half), window);
});

test("no label sits on the axis on any of the three surfaces 375px narrows", () => {
  for (const plot of [BRIEF_375, PRINT_375, PATIENT_375, 190, 240, 300, DESK]) {
    for (const spikes of [SEEDED_WEEK, SEEDED_WEEK_PLACED]) {
      for (const patient of [false, true]) {
        expectNoLabelOnTheAxis(spikes, { plot, patient });
      }
    }
    expectNoLabelOnTheAxis(THREE_RISES, { plot, first: DAY_FIRST, last: DAY_LAST });
  }
});

test("the drawing area the component passes is the one Recharts draws", () => {
  // T223's acceptance criterion 2: one function, called by the component and read by the rule, so neither
  // can measure a chart the other is not looking at.
  assert.equal(plotWidth(285), 285 - PLOT_CHROME, "the printed sheet's card at 375px");
  assert.equal(plotWidth(285), PRINT_375, "which is the 177px the grid on that frame measures");
  assert.equal(plotWidth(289), BRIEF_375, "the clinician's brief at 375px");
  assert.equal(plotWidth(317), PATIENT_375, "and §2.7's own page at 375px");
  assert.equal(plotWidth(0), 0, "nothing measured yet is no plot, not a negative one");
  assert.equal(plotWidth(40), 0, "and a card narrower than its own chrome is not a negative plot either");
  assert.equal(plotWidth(108), 0, "a card exactly its own chrome wide has no plot left");

  // T224's acceptance criterion 1, and what this test asserted the opposite of until that ticket: the
  // chrome the component takes off the card *is* the chrome Recharts lays out. One figure, derived from
  // the `margin` and the `YAxis` the component passes, so the two cannot drift apart again — a literal
  // here was 28px short of the drawing area for every frame between T23 and T224.
  assert.equal(DRAWN_CHROME, 108);
  assert.equal(PLOT_CHROME, DRAWN_CHROME);
  assert.equal(AXIS_TEXT_REACH, 8);
});

// T224 (§12.1): the two properties the corrected width is supposed to buy, at plots no fixture renders.
//
// The first is that the plot is the drawing area at every card width and not only at the six the suite
// draws — a sweep, because the figure used to be a literal and a literal is right at no width at all.
// The second is the gutter: with `plot` corrected, a label the rule keeps starts inside the plot, so the
// `AXIS_TEXT_REACH` between that edge and the `250` is clearance in full, at every label length this
// product can produce and every width it can be drawn at. T223 could only say that of the lengths and
// widths whose `half × 28 / plot` drift stayed inside the eight, which is what made a longer
// `LABEL_CHARS` able to re-open it silently.
test("the plot is the drawing area at every card width, not only the six that are drawn (T224)", () => {
  for (let card = 0; card <= 1600; card += 1) {
    assert.equal(plotWidth(card), Math.max(0, card - DRAWN_CHROME), `a card ${card}px wide`);
  }
});

test("the axis gutter is clearance in full, at every label length and plot (T224)", () => {
  // One rise, placed early enough in the window that a label over it is the case T223 is about, swept
  // over every label length `trimMarkerLabel` can hand over and every plot between a print column and a
  // wide desk. Whatever survives starts inside the plot; whatever does not is dropped. Either way nothing
  // is drawn into the digits, and the margin is not being spent by the arithmetic.
  const span = DAY_LAST - DAY_FIRST;
  for (let chars = 1; chars <= 16; chars += 1) {
    const name = "x".repeat(chars);
    assert.equal(trimMarkerLabel(name), name, `${chars} characters are drawn whole`);
    for (const plot of [120, 150, 177, 181, 209, 240, 300, 420, 553, 652, 760, 866, 1400]) {
      for (const frac of [0.02, 0.05, 0.112, 0.2, 0.5]) {
        const peak = DAY_FIRST + Math.round(span * frac);
        const spikes = [placedRise(peak, 214, name)];
        const labels = drawn(spikes, { plot, first: DAY_FIRST, last: DAY_LAST });
        const left = frac * plot - halfLabelWidth(name);
        if (labels[0] === "-") {
          assert.ok(left < 0, `at ${plot}px a label of ${chars} characters ${frac} along starts at ${left.toFixed(1)}px and was dropped anyway`);
          continue;
        }
        expectNoLabelOnTheAxis(spikes, { plot, first: DAY_FIRST, last: DAY_LAST });
      }
    }
  }
});

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

// And the one place correcting the width changed what is painted, which is the point of correcting it
// (T224). §2.7's page at 375px drew three labels on the seeded week until this ticket — `206` and both of
// the patient's "a place you went" — chosen against a 237px plot. Measured on that frame, the two place
// labels came out 8.6px apart (left 160.5 to 237.8, and 246.4 to 323.7, in the suite's own Chromium), where
// this module's `LABEL_GAP` asks for 10px of clear space between two labels: the rule was applied to a plot
// 13% wider than the 209px Recharts drew, so every clearance it granted was 13% short on screen. It was the
// second of them that was kept by the margin — half a pixel, on the overstated width — and it is the one
// that goes now. Two labels at 375px, and the third rise keeps its marker and its row in SpikeTable, which
// is what "the labels that fit" has always meant (lib/spikePlaces.ts' caption, T204).
test("the patient's 375px chart keeps the place label that fits the plot Recharts draws", () => {
  const labels = drawn(SEEDED_WEEK_PLACED, { plot: PATIENT_375, patient: true });
  assert.deepEqual(labels, ["206", "-", "-", "a place you went", "-"], `at ${PATIENT_375}px, and got ${labels.join(" | ")}`);
  expectNoMarkerOnALabel(SEEDED_WEEK_PLACED, { plot: PATIENT_375, patient: true });

  // The two that no longer fit together, in the units the rule is in: the gap between their drawn edges is
  // short of the clearance asked for, which is why one of them goes rather than both being painted close.
  const span = WEEK_LAST - WEEK_FIRST;
  const centre = (iso: string) => ((Date.parse(iso) - WEEK_FIRST) / span) * PATIENT_375;
  const gap = centre("2026-09-25T19:40:00.000Z") - centre("2026-09-22T22:45:00.000Z") - 2 * halfLabelWidth("a place you went");
  assert.ok(gap < 10, `the two place labels are ${gap.toFixed(1)}px apart on the drawn plot, and two labels ask for 10px`);

  // Wide enough and both are back, which says the drop is about the width and not about the label.
  assert.deepEqual(
    drawn(SEEDED_WEEK_PLACED, { plot: DESK, patient: true }).filter((l) => l === "a place you went").length,
    2,
    "a desk holds both of them",
  );
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
  const span = WEEK_LAST - WEEK_FIRST;
  assert.deepEqual(drawn([rise(WEEK_FIRST + span * 0.25, 214)], { plot: BRIEF_375 }), ["214"], "nothing can collide with the only marker there is");
  assert.equal(markerLabels([], { first: WEEK_FIRST, last: WEEK_LAST, plot: BRIEF_375, patient: false }).size, 0);

  // Except by the axis, which is the one thing on this chart that is there whether or not anything else is
  // (T223). A rise an hour into a seven-day window sits 1.2px along the brief's plot, so three characters
  // centred on it are drawn almost wholly outside it, over the y-axis gutter and against the `250` — the
  // same reading the caption's "where they fit" refuses between two labels, here against the one piece of
  // text that cannot be dropped to make room. It is the only case in the suite where a chart of one rise
  // draws no label, and no fixture holds it: the earliest rise any of them opens with is 08:00 on a day
  // beginning at 06:00, which is the case tested above.
  assert.deepEqual(drawn([rise(WEEK_FIRST + HOUR, 214)], { plot: BRIEF_375 }), ["-"], "an hour into the week is on top of the axis");
  assert.deepEqual(drawn([rise(WEEK_FIRST + 12 * HOUR, 214)], { plot: BRIEF_375 }), ["214"], "and half a day in is clear of it");
});
