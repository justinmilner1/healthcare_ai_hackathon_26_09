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

/** What a weekday label looks like, whatever the locale: the reader's own `weekday: "short"`. */
const weekdayOf = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: "short" });
/** And the hour, the reading the chart's own tooltip has always used. */
const hourOf = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric" });

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
