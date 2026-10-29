import assert from "node:assert/strict";
import test from "node:test";
import { DAY_LABELS_FROM, timeAxis } from "./timeAxis";

// T187 (design §2.6, §2.7, §7.4, §6.5, §12.1): the ticks under the one glucose line all three surfaces
// draw. The cases acceptance criterion 5 names — a sub-day span, a span with no midnight in it, a
// one-reading span, a week, a narrow plot — plus the two that let the bug through: the plot nobody has
// measured yet, and a span long enough that one label per day would be a wall.
//
// Timestamps are built with the local `Date` constructor rather than parsed from an ISO string, because
// every decision in the module is about local midnight and local clock times; a UTC literal would make
// this test a statement about the box's time zone. The labels are read for their *shape* rather than
// against written-out strings, for the same reason: `toLocaleTimeString` answers in the reader's locale,
// so what can be asserted everywhere is that two ticks inside one day say different things, that an hour
// axis names hours, and that a week's axis still names weekdays.

/** Local wall-clock time, the way a reader of this chart would say it. */
const at = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month, day, hour, minute).getTime();

/** The plot a provider card or a print sheet gives the line, and the one §6.5's 375px page gives it. */
const DESK = 700;
const PHONE = 230;

/**
 * And the three plots §6.5's 375px page actually hands this chart, measured in the suite's own Chromium on
 * the seven-day sample the demo and the e2e suite both summarize (T190).
 *
 * `PHONE` above is a round number standing in for all three, and that is how T190 got through: at 230px the
 * old width model and the corrected one agree — both allow a week's seven weekdays — so a test written only
 * against it could not see that the brief's card is 21px narrower than that and the printed sheet 25px, nor
 * that the patient's own card is 7px wider. The two cases the three numbers separate are exactly the ones
 * acceptance criteria 1 and 2 are about: the width where all seven arrive, and the width where they must
 * thin rather than have one dropped without saying so.
 *
 * Measured as `wrapper.clientWidth - 80`, which is what components/GlucoseChart.tsx passes: 289, 285 and 317
 * less the y-axis and right margin it takes off first.
 */
const BRIEF_375 = 209;
const PRINT_375 = 205;
const PATIENT_375 = 237;

/**
 * The widest weekday label this axis draws, in pixels at its 11px, and the gap Recharts refuses to paint
 * two labels inside of (T190).
 *
 * 22.56px is `"Wed"` measured in the suite's Chromium the way Recharts measures — a hidden span at
 * `font-size: 11px` with `white-space: pre` — and 5 is `minTickGap`, which `XAxis` defaults to. Together
 * they are the pitch a weekday needs, and the rule `lib/timeAxis.ts` is now written against. Here rather
 * than imported because the module states them as one rounded-up figure per grain with a margin on top:
 * a test that read its own constants back could not tell a corrected model from the old one.
 */
const WIDEST_WEEKDAY = 22.56;
const RECHARTS_MIN_TICK_GAP = 5;

/** What a weekday label looks like, whatever the locale: the reader's own `weekday: "short"`. */
const weekdayOf = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: "short" });
/** And the hour, the reading the chart's own tooltip has always used. */
const hourOf = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric" });
/** And the calendar date, which is the only honest label once a step lands every tick on one weekday. */
const dateOf = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

test("a span inside one day gets an axis at all, which is the whole of the bug", () => {
  // data/fixtures/clarity_window.csv: 84 readings, 06:00 to 12:55 on one morning. The loop this replaces
  // walked from that day's midnight in 24-hour steps and kept only candidates at or after the first
  // reading, so the only one inside the span was dropped and the next was past the end: zero ticks.
  const axis = timeAxis(at(8, 19, 6), at(8, 19, 12, 55), DESK);
  assert.ok(axis.ticks.length >= 2, `a morning of readings drew ${axis.ticks.length} ticks`);
  assert.equal(axis.unit, "hour");

  // Every tick is inside the line, or Recharts drops it and the axis is short again by another route.
  for (const t of axis.ticks) {
    assert.ok(t >= at(8, 19, 6) && t <= at(8, 19, 12, 55), `${new Date(t).toISOString()} is outside the span`);
  }

  // And they say the hour. The sharp end of criterion 2: three labels all reading "Sun" would satisfy
  // "not empty" and tell a reader nothing, so the labels have to differ from each other and from the
  // weekday they used to be.
  const labels = axis.ticks.map(axis.format);
  assert.equal(new Set(labels).size, labels.length, `two ticks in one morning read the same: ${labels.join(" | ")}`);
  assert.notEqual(labels[0], weekdayOf(axis.ticks[0]));
  assert.equal(labels[0], hourOf(axis.ticks[0]), "a whole-hour tick reads as the tooltip's own hour");
});

test("the ticks land on the clock, so a reader can place a spike in the day", () => {
  // Criterion 1 is that the chart alone places a rise. That needs the labels to be times a person reads
  // off a clock — 6 AM, 8 AM — rather than 6:03 and 8:03 off the first reading, and it needs the gaps
  // between them to be equal, or the eye cannot interpolate between two of them at all.
  const axis = timeAxis(at(8, 19, 6, 3), at(8, 19, 12, 58), DESK);
  for (const t of axis.ticks) {
    const d = new Date(t);
    assert.equal(d.getSeconds(), 0);
    assert.equal(d.getMilliseconds(), 0);
    assert.equal(d.getMinutes() % 5, 0, `${d.toTimeString()} is not a time anyone reads off a clock`);
  }
  const gaps = new Set(axis.ticks.slice(1).map((t, i) => t - axis.ticks[i]));
  assert.equal(gaps.size, 1, `the ticks are unevenly spaced: ${[...gaps].join(", ")}`);
});

test("a span holding no local midnight still labels its axis", () => {
  // data/fixtures/clarity_sustained_high.csv: 36 readings, 19:00 to 21:55. Criterion 3's first half, and
  // the evening the §7 safety flag on the brief is about — the frame where the flag named 7:35 PM over a
  // line with no time on it.
  const axis = timeAxis(at(8, 20, 19), at(8, 20, 21, 55), DESK);
  assert.ok(axis.ticks.length >= 2);
  assert.ok(
    axis.ticks.every((t) => new Date(t).getHours() !== 0),
    "no midnight is inside this span, so none of its ticks may be one",
  );
  assert.equal(new Set(axis.ticks.map(axis.format)).size, axis.ticks.length);
});

test("a span of one reading labels the moment it happened", () => {
  // Criterion 3's second half. Nothing on the ladder can give two ticks inside a span of zero, so the
  // axis is the single instant — and at a grain that can name it, since a reading at 19:03 does not land
  // on any clock time worth rounding to.
  const only = at(8, 20, 19, 3);
  const axis = timeAxis(only, only, DESK);
  assert.deepEqual(axis.ticks, [only]);
  assert.match(axis.format(only), /\d/, `the one label says nothing about when: ${axis.format(only)}`);
  assert.notEqual(axis.format(only), weekdayOf(only));

  // A span shorter than the finest step is the same case with two ends to name rather than one.
  const twoMinutes = timeAxis(at(8, 20, 19, 1), at(8, 20, 19, 3), DESK);
  assert.deepEqual(twoMinutes.ticks, [at(8, 20, 19, 1), at(8, 20, 19, 3)]);
  assert.equal(new Set(twoMinutes.ticks.map(twoMinutes.format)).size, 2);
});

test("a week is the axis it has always been: one weekday per local midnight", () => {
  // Criterion 2's other half, and the thing this ticket must not change. The seven-day export §2.5 asks
  // for, read at both widths and before the plot has been measured at all — the server render, which is
  // where a thinning rule written against a width of zero would show first.
  const monday = at(8, 14, 6);
  const sunday = at(8, 20, 12);
  for (const plot of [DESK, PHONE, 0]) {
    const axis = timeAxis(monday, sunday, plot);
    assert.equal(axis.unit, "day", `a week at plot ${plot}`);
    assert.equal(axis.ticks.length, 6, `a week at plot ${plot} drew ${axis.ticks.length} ticks`);
    for (const t of axis.ticks) {
      const d = new Date(t);
      assert.equal(d.getHours(), 0, "a day's tick is its local midnight");
      assert.equal(d.getMinutes(), 0);
      assert.equal(axis.format(t), weekdayOf(t), "and reads as its weekday");
    }
  }
});

test("the brief's own 375px plot keeps every weekday it asks for, or asks for fewer (T190)", () => {
  // Acceptance criteria 1, 2 and 5. Recharts measures each label itself and silently drops any that would
  // land within its `minTickGap` of 5px of one it has kept, so a count this module allows and Recharts
  // refuses is an axis missing a day with its remaining labels still evenly spaced — nothing on screen says
  // one is absent. The brief at 375px gave its seven midnights 26.0px each, a weekday needs 27.56px there,
  // and `Sun` was the one that went while the spike table under the same card named it twice.
  //
  // The span is the seven-day sample (data/dexcom_clarity_sample.csv runs Sat 00:00 to the following Fri
  // 23:55), so these are the three frames the ticket was filed against, not a constructed width.
  const first = at(8, 19, 0);
  const last = at(8, 25, 23, 55);

  // Every tick is one Recharts will paint: the pitch each label is given clears its measured width plus
  // Recharts' own 5px. This is the assertion the module exists to make true, and it is written as the rule
  // rather than as a count so it holds at every width between.
  for (const plot of [BRIEF_375, PRINT_375, PATIENT_375, 230, 300, 420, DESK, 1400]) {
    const axis = timeAxis(first, last, plot);
    const pitch = axis.ticks.length >= 2 ? (plot * (axis.ticks[1] - axis.ticks[0])) / (last - first) : plot;
    assert.ok(pitch >= WIDEST_WEEKDAY + RECHARTS_MIN_TICK_GAP, `at plot ${plot} the ${axis.ticks.length} weekdays sit ${pitch.toFixed(1)}px apart, and one needs ${WIDEST_WEEKDAY + RECHARTS_MIN_TICK_GAP}px`);
  }

  // Criterion 2: the patient's own summary paints all seven today and keeps them, and so does every desk.
  for (const plot of [PATIENT_375, DESK, 788, 581, 894]) {
    assert.equal(timeAxis(first, last, plot).ticks.length, 7, `a week at plot ${plot}`);
  }

  // Criterion 1's other branch: the two narrower cards thin to a coarser step instead. Both ends of the
  // line are still named, the labels are still distinct weekdays, and the gaps are still equal — which is
  // the difference between an axis that has thinned and one that has lost a day.
  for (const plot of [BRIEF_375, PRINT_375]) {
    const axis = timeAxis(first, last, plot);
    const labels = axis.ticks.map(axis.format);
    assert.ok(axis.ticks.length >= 3 && axis.ticks.length < 7, `a week at plot ${plot} drew ${axis.ticks.length} ticks`);
    assert.equal(axis.unit, "day", `a week at plot ${plot} is still read in days`);
    assert.equal(new Set(labels).size, labels.length, `two labels read the same at plot ${plot}: ${labels.join(" | ")}`);
    for (const t of axis.ticks) assert.equal(axis.format(t), weekdayOf(t), `and each reads as its weekday at plot ${plot}`);
    const gaps = new Set(axis.ticks.slice(1).map((t, i) => Math.round((t - axis.ticks[i]) / 86_400_000)));
    assert.equal(gaps.size, 1, `unevenly spaced at plot ${plot}, in days: ${[...gaps].join(", ")}`);
  }
});

test("the sub-day hour axis T187 added is the one it was (T190 criterion 3)", () => {
  // Correcting the day grain's width must not move the hour grain's, and the counts below are the frames
  // T187 is judged on: data/fixtures/clarity_window.csv, 06:00 to 12:55, at the widths the three surfaces
  // give it. Seven hourly labels on a desk, four two-hourly on any of the three 375px cards.
  const first = at(8, 19, 6);
  const last = at(8, 19, 12, 55);
  for (const plot of [BRIEF_375, PRINT_375, PATIENT_375]) {
    const axis = timeAxis(first, last, plot);
    assert.equal(axis.unit, "hour", `a morning at plot ${plot}`);
    assert.equal(axis.ticks.length, 4, `a morning at plot ${plot} drew ${axis.ticks.map(axis.format).join(" · ")}`);
    assert.equal(axis.format(axis.ticks[0]), hourOf(axis.ticks[0]));
  }
  for (const plot of [788, 581, 894, DESK]) {
    const axis = timeAxis(first, last, plot);
    assert.equal(axis.unit, "hour", `a morning at plot ${plot}`);
    assert.equal(axis.ticks.length, 7, `a morning at plot ${plot} drew ${axis.ticks.map(axis.format).join(" · ")}`);
    for (const t of axis.ticks) assert.equal(axis.format(t), hourOf(t), "and every one of them is a whole hour");
  }
});

test("the span picks the unit, at the boundary and on either side of it", () => {
  // Written against the exported threshold rather than a literal, so the rule and the test cannot drift.
  const start = at(8, 14, 9);
  assert.equal(timeAxis(start, start + DAY_LABELS_FROM, DESK).unit, "day");
  assert.equal(timeAxis(start, start + DAY_LABELS_FROM - 1, DESK).unit, "hour");

  // And the one the hour unit has to carry: a span under the threshold that crosses a midnight. The day
  // is named where it turns over, so the labels either side of it cannot be read as one evening.
  const night = timeAxis(at(8, 20, 23), at(8, 21, 5), DESK);
  assert.equal(night.unit, "hour");
  const midnight = night.ticks.find((t) => new Date(t).getHours() === 0);
  assert.ok(midnight, "a span from 23:00 to 05:00 has a midnight in it and the axis should land on it");
  assert.equal(night.format(midnight), weekdayOf(midnight), "and name the day there");
});

test("a narrow plot gets fewer labels, not overlapping ones", () => {
  // Criterion 4, and the measurement §6.5 asks for: the same morning at the two widths this chart is
  // actually drawn at. The phone's labels are a subset of the desk's rather than a different set, which
  // is what makes the two frames readings of one chart.
  const first = at(8, 19, 6);
  const last = at(8, 19, 12, 55);
  const desk = timeAxis(first, last, DESK);
  const phone = timeAxis(first, last, PHONE);
  assert.ok(phone.ticks.length >= 2, "a 375px page still names both ends of the morning");
  assert.ok(phone.ticks.length < desk.ticks.length, `${phone.ticks.length} labels on a phone against ${desk.ticks.length} on a desk`);
  for (const t of phone.ticks) assert.ok(desk.ticks.includes(t), "the phone's ticks are the desk's, thinned");

  // The width is a measurement and not a breakpoint, so it holds at the widths between: nothing anywhere
  // asks for more labels than the plot has room for at about 40px each.
  for (let plot = 120; plot <= 1400; plot += 20) {
    const axis = timeAxis(first, last, plot);
    assert.ok(axis.ticks.length <= Math.max(2, Math.floor(plot / 40)), `${axis.ticks.length} labels in ${plot}px`);
  }
});

test("a span of months thins to dates rather than repeating one weekday", () => {
  // The failure mode a weekday label has on a coarse step: every tick of a 7- or 14-day step falls on the
  // same day of the week, so a quarter of Clarity data labelled in weekdays reads "Mon · Mon · Mon" —
  // this ticket's empty axis with the labels filled in. Nothing committed holds that span, which is
  // exactly why it is here and not in the e2e suite.
  const axis = timeAxis(at(5, 1, 6), at(8, 20, 12), DESK);
  assert.equal(axis.unit, "day");
  const labels = axis.ticks.map(axis.format);
  assert.ok(labels.length >= 2);
  assert.equal(new Set(labels).size, labels.length, `two ticks across a quarter read the same: ${labels.join(" | ")}`);
});

test("a span past the coarsest step thins it rather than falling back to the ends of the line", () => {
  // Criterion 3's other direction, and the one the fallback below the ladder cannot answer. `DAY_STEPS`
  // tops out at four weeks, so past about six months even that step has more ticks than fit, every step
  // on the ladder is rejected, and the fallback used to hand back the two ends of the line at the finest
  // grain there is: a year of readings labelled "7:23 AM · 7:23 AM", two identical clock times under a
  // chart spanning twelve months. That is this ticket's own complaint — an axis that says nothing about
  // when — reached from the long end instead of the short one, and nothing caps what a patient may
  // upload: lib/bundle.ts downsamples the count and leaves the span alone.
  const start = at(0, 5, 7, 23);
  for (const days of [180, 365, 730]) {
    for (const plot of [PHONE, DESK, 1400]) {
      const where = `${days} days at plot ${plot}`;
      const axis = timeAxis(start, start + days * 86_400_000, plot);
      const labels = axis.ticks.map(axis.format);

      assert.equal(axis.unit, "day", where);
      assert.ok(labels.length >= 2, `${where} drew ${labels.length} labels`);
      assert.equal(new Set(labels).size, labels.length, `${where}: two labels read the same: ${labels.join(" | ")}`);
      // A date and not a clock time, which is what the abandoned fallback got wrong.
      for (const t of axis.ticks) {
        assert.equal(axis.format(t), dateOf(t), `${where}: a span of months is labelled by its dates`);
        assert.equal(new Date(t).getHours(), 0, `${where}: a date's tick is its local midnight`);
      }
      // Thinned by taking every nth of one even walk, so the eye can still interpolate between two of
      // them. Compared as whole days rather than as milliseconds: the walk keeps each tick on local
      // midnight, so a gap spanning a daylight-saving change is an hour short of the others in `ms`.
      const gaps = new Set(axis.ticks.slice(1).map((t, i) => Math.round((t - axis.ticks[i]) / 86_400_000)));
      assert.equal(gaps.size, 1, `${where}: unevenly spaced, in days: ${[...gaps].join(", ")}`);
      assert.ok(axis.ticks.length <= 8, `${where}: ${axis.ticks.length} labels is a wall, not an axis`);
    }
  }
});

test("no span renders an empty axis", () => {
  // Criterion 3 as the invariant it is, over every span and width the three surfaces can put in front of
  // it: a minute to a year, a print column to a phone. The bug was one branch of one loop, and what
  // stops the next one is a test that does not have to have thought of it.
  const start = at(8, 14, 7, 23);
  const spans = [0, 1_000, 60_000, 11 * 60_000, 3_600_000, 7 * 3_600_000, 25 * 3_600_000, 86_400_000, 3 * 86_400_000, 7 * 86_400_000, 30 * 86_400_000, 365 * 86_400_000];
  for (const span of spans) {
    for (const plot of [0, 90, 230, 375, 700, 1400]) {
      const axis = timeAxis(start, start + span, plot);
      assert.ok(axis.ticks.length >= 1, `span ${span}ms at plot ${plot} drew no ticks`);
      for (const t of axis.ticks) {
        assert.ok(t >= start && t <= start + span, `span ${span}ms at plot ${plot}: a tick outside the line`);
        assert.ok(axis.format(t).length > 0, `span ${span}ms at plot ${plot}: a tick with no label`);
      }
      const ascending = axis.ticks.every((t, i) => i === 0 || t > axis.ticks[i - 1]);
      assert.ok(ascending, `span ${span}ms at plot ${plot}: ticks out of order`);
    }
  }
});
