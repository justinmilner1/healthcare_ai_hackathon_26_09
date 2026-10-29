// What the time axis under a glucose line is allowed to say (design §2.6, §2.7, §7.4, §6.5).
// Owner: sour. The clinician's brief, the printed one-pager and the patient's own summary all draw one
// chart — components/GlucoseChart.tsx — and all three read this for its ticks.
//
// The chart was written for the seven-day export §2.5 asks the patient for, and its axis was one line of
// arithmetic saying so: a tick at every local midnight from the first reading on, labelled with the
// weekday. A span shorter than a day holds no midnight at or after its first reading, so that loop
// produced **nothing** — not a cramped axis, not the wrong unit, an empty tick array under a painted
// axis line (T187). Both fixtures the suite uploads are that span: `clarity_window.csv` is 84 readings
// between 06:00 and 12:55, and `clarity_sustained_high.csv` is 36 between 19:00 and 21:55. On the brief
// that left a deterministic safety flag reading "longest 100 min from Sun, Sep 20, 7:35 PM" sitting
// directly above a curve with no time anywhere on it, and on §2.7's page there is not even flag text to
// read the hour out of.
//
// It is the genre of T100, T123 and T133 — a single-day upload read through a component written for a
// week — and lib/bundle.ts floors the span at one day precisely because that upload is the common case:
// a patient who exports the day before their visit, which is when they are told to.
//
// Two decisions, which is why this is a module and not a `useMemo`:
//
// 1. **The unit is the span's.** Weekdays say nothing about three hours — three labels all reading "Sun"
//    is the other half of the same bug — and an hour says little about a week. The tooltip over this same
//    chart has always known the finer reading (`hour: "numeric"`), but a tooltip is a hover and §7.4's
//    sheet is paper.
// 2. **How many labels fit is a measurement, not a guess.** §6.5's 375px page leaves the plot about 230px,
//    and the marker labels on this same chart are already chosen against the measured width rather than a
//    breakpoint (T23) — the same chart is drawn into a provider card, a phone and a print sheet at three
//    different widths, so a count that suits one overlaps on another.
//
// Pure, and in lib/ rather than in the component, for the reason lib/spikePlaces.ts is (§12.1): it is
// arithmetic over a span, so it can be held to a unit test at spans no fixture holds — a span with no
// midnight in it, a single reading, a narrow plot — without a browser.

/** Which ladder the ticks came off: clock times inside a day, or whole days. */
export type AxisUnit = "hour" | "day";

/** The ticks a chart passes to Recharts, and the formatter that labels them. */
export type TimeAxis = {
  /** Epoch milliseconds, ascending, every one of them inside `[first, last]`, and never empty. */
  ticks: number[];
  unit: AxisUnit;
  /** What goes under one tick. */
  format: (t: number) => string;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The span at which the labels become days.
 *
 * Two days rather than one. The span is what the reader is looking at, so it is what picks the unit, and
 * between one and two days a weekday axis has at most two labels on it — a chart of Monday evening into
 * Tuesday morning would carry "Mon" and "Tue" and nothing about where in either the line is. Under the
 * threshold the hour labels name the day themselves wherever one turns over (`labelAt` below), so nothing
 * is lost by reading that span in hours.
 */
export const DAY_LABELS_FROM = 2 * DAY;

/**
 * The steps an hour axis may use, coarsest last, each a time a person reads off a clock.
 *
 * Minutes are in the ladder because a span can be shorter than an hour: a patient who shares a Clarity
 * window of a single meal, or the tail of an export. Nothing finer than five minutes, which is the
 * interval a Dexcom sensor reads at — an axis denser than the data is labelling gaps.
 */
const HOUR_STEPS = [5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR, 6 * HOUR, 12 * HOUR];

/**
 * And the steps a day axis may use. One per day is what the seven-day export has always drawn and what
 * T187 leaves alone; the rest are there so that a longer upload thins rather than overlaps — a Clarity
 * export offers ninety days, and lib/gmi.ts expects a real one to carry at least fourteen.
 */
const DAY_STEPS = [DAY, 2 * DAY, 3 * DAY, 7 * DAY, 14 * DAY, 28 * DAY];

/**
 * How finely a label reads, which follows from the step rather than from the ladder.
 *
 * `date` is why this is not just `AxisUnit`. A step of a week or more lands every tick on the same
 * weekday, so a ninety-day export labelled in weekdays reads "Mon · Mon · Mon · Mon" — the empty axis of
 * this ticket with the labels filled in and still saying nothing. Past a week the calendar date is the
 * only honest label; under it the weekday is the one a reader of a week wants, and the one T187 leaves
 * alone.
 */
type Grain = "minute" | "hour" | "day" | "date";

const grainOf = (step: number): Grain =>
  step >= 7 * DAY ? "date" : step >= DAY ? "day" : step % HOUR === 0 ? "hour" : "minute";

/**
 * Half the advance width of one character at the axis's 11px, and the clear space between two labels.
 *
 * The sibling of `HALF_CHAR` in components/GlucoseChart.tsx, which measures the 10px marker labels the
 * same way (T23). Tuned against the shortest label this draws, because that is the case the week must
 * survive unchanged: seven weekdays on §6.5's 375px page have about 230px of plot, or 33px each, and a
 * rule that asked for more than that would thin an axis nobody has complained about.
 */
const CHAR = 5.5;
const LABEL_GAP = 10;

/** "6:30 AM", "6 AM", "Mon", "Sep 21", in characters. */
const CHARS: Record<Grain, number> = { minute: 8, hour: 5, day: 3, date: 6 };

/**
 * How many labels to allow before the plot has been measured — the server render, and a browser with no
 * `ResizeObserver`.
 *
 * Eight, which is one more than the week this chart was written for, so the first paint of the seven-day
 * export is the axis it has always had rather than a thinned one that fills in on the next frame.
 */
const UNMEASURED_LABELS = 8;

/**
 * An axis nobody wants to read is as useless as no axis, however wide the plot.
 *
 * The width test below is about overlap; this is about density. A 700px brief fits twelve quarter-hour
 * labels across three hours without any two touching, and a clinician reading that card is being handed
 * a ruler rather than a time axis. Eight is the week's own seven plus one, so the ceiling never binds on
 * the span the chart was written for.
 */
const MOST_LABELS = 8;

/** How many of this label the plot holds. Always at least two: a line has two ends to name. */
function labelsThatFit(plot: number, grain: Grain): number {
  if (plot <= 0) return UNMEASURED_LABELS;
  return Math.max(2, Math.min(MOST_LABELS, Math.floor(plot / (CHARS[grain] * CHAR + LABEL_GAP))));
}

/**
 * Every tick of this step inside `[first, last]`, aligned to the local midnight at or before `first`.
 *
 * Aligned rather than started at the first reading, so the labels land on times a person reads off a
 * clock — 6 AM and 8 AM rather than 6:03 and 8:03 — and so a step that divides the day puts a tick on
 * midnight itself, which is what lets `labelAt` name the day where one turns over.
 *
 * The cursor is walked with `setDate`/`setMinutes` rather than by adding milliseconds, which is the one
 * thing the loop this replaces got wrong beyond the empty array: both normalize through local time, so an
 * axis that crosses a daylight-saving change keeps its ticks on the clock instead of sliding an hour off
 * it for the rest of the span.
 */
function ticksEvery(step: number, first: number, last: number): number[] {
  const out: number[] = [];
  const cursor = new Date(first);
  cursor.setHours(0, 0, 0, 0);
  // A ceiling on a walk whose bounds come from parsed data: the longest span the finest step is ever
  // offered is two days, plus a day of lead-in before `first`, which is 864 ticks.
  for (let guard = 0; guard < 4096; guard++) {
    const t = cursor.getTime();
    if (t > last) break;
    if (t >= first) out.push(t);
    if (step >= DAY) cursor.setDate(cursor.getDate() + Math.round(step / DAY));
    else cursor.setMinutes(cursor.getMinutes() + Math.round(step / MINUTE));
  }
  return out;
}

/**
 * What goes under one tick.
 *
 * Midnight is labelled with its weekday on every grain finer than a day, which is what makes the hour
 * unit safe on a span that crosses one: "11 PM · Tue · 1 AM" reads as a night, where three bare hours
 * would read as an hour axis that had wrapped. The two time formats are the tooltip's own —
 * `labelFormatter` in components/GlucoseChart.tsx has always spelled the hour and the minute — so the
 * label a reader sees under the line and the one they get by hovering it are in one vocabulary.
 *
 * Locale-aware, like every other date on these three surfaces: `undefined` is the reader's own.
 */
function labelAt(t: number, grain: Grain): string {
  const d = new Date(t);
  if (grain === "date") return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const midnight = d.getHours() === 0 && d.getMinutes() === 0;
  if (grain === "day" || midnight) return d.toLocaleDateString(undefined, { weekday: "short" });
  if (d.getMinutes() === 0) return d.toLocaleTimeString(undefined, { hour: "numeric" });
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * The ticks for a glucose line running from `first` to `last`, in a plot `plot` pixels wide.
 *
 * `plot` is the drawing area rather than the card: components/GlucoseChart.tsx measures itself and takes
 * its own chrome off before calling. Zero means "not measured yet", which is the server render.
 *
 * The step is the first on its ladder whose ticks both number at least two and fit the plot — coarse
 * enough to read, fine enough to place a spike. Where no step manages two (a span of a single reading, or
 * one shorter than the finest step), the ends of the line are the axis: criterion 3 of T187 is that no
 * span renders an empty axis, and the two ends are the least a chart can say about when it happened.
 */
export function timeAxis(first: number, last: number, plot: number): TimeAxis {
  const unit: AxisUnit = last - first >= DAY_LABELS_FROM ? "day" : "hour";
  const ladder = unit === "day" ? DAY_STEPS : HOUR_STEPS;
  const axis = (ticks: number[], grain: Grain): TimeAxis => ({ ticks, unit, format: (t) => labelAt(t, grain) });

  for (const step of ladder) {
    const ticks = ticksEvery(step, first, last);
    if (ticks.length >= 2 && ticks.length <= labelsThatFit(plot, grainOf(step))) return axis(ticks, grainOf(step));
  }

  // Nothing on the ladder gave two readable labels. The coarsest step can still have landed one inside the
  // span — a week and a half against `DAY_STEPS`' four weeks — and one true label beats both ends of a
  // line that is barely longer than the gap between them.
  const coarsest = ladder[ladder.length - 1];
  const sparse = ticksEvery(coarsest, first, last);
  if (sparse.length === 1) return axis(sparse, grainOf(coarsest));
  // The ends of the line, at the one grain that can name any instant: a span this short is minutes wide,
  // or a single reading, and neither lands on a clock time worth rounding to.
  return axis(first === last ? [first] : [first, last], "minute");
}
