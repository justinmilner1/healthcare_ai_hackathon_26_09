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
// that left a deterministic safety flag reading "100 min from Sun, Sep 20, 7:35 PM" sitting
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
// 2. **How many labels fit is a measurement, not a guess.** §6.5's 375px page leaves the plot 209px on the
//    clinician's brief, 205px on the printed sheet and 237px on the patient's own summary, and the marker
//    labels on this same chart are already chosen against the measured width rather than a breakpoint
//    (T23) — the same chart is drawn into a provider card, a phone and a print sheet at three different
//    widths, so a count that suits one overlaps on another. `LABEL_WIDTH` below measures the labels
//    themselves, and T190 is what estimating them cost: three plots that differ by 32px, a rule tuned to
//    the middle of them, and a weekday missing from the narrowest.
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
 * How much room one label of each grain needs, in pixels at the axis's 11px — and why these are widths
 * and not a character count times a per-character estimate, which is what T190 was filed about.
 *
 * **Who drops a label.** This module decides how many ticks to hand Recharts; Recharts then decides for
 * itself which of them to paint. `XAxis` defaults to `interval: "preserveEnd"` and `minTickGap: 5`
 * (recharts/lib/state/selectors/axisSelectors.js), so `getTicksEnd` walks the ticks from the last to the
 * first, measures each label's rendered width with a hidden span at the axis's font size, and **silently
 * drops** any tick whose label would come within 5px of the one it has already kept. Nothing tells this
 * module that happened. So a count this module allows but Recharts refuses is not a near miss — it is an
 * axis missing a day, with its surviving labels still evenly spaced, so nothing on screen says one is
 * absent (§2.6, §6.5). The pitch asked for here therefore has to be at least the widest label the grain
 * draws plus Recharts' own 5px, or the two disagree and Recharts wins.
 *
 * **The measurement**, taken in the suite's own Chromium on the three surfaces' pages, through the span
 * Recharts measures with (`getStringSize`, `position: absolute; white-space: pre; font-size: 11px`), over
 * every label each grain can produce — seven weekdays, twenty-four hours, the minute labels, twelve
 * months of dates:
 *
 * | Grain | Widest label it draws | Measured | Recharts needs | The old rule allowed |
 * |---|---|---|---|---|
 * | `day` | `"Wed"` | 22.56px | 27.56px | **26.5px** |
 * | `hour` | `"10 AM"` | 30.94px | 35.94px | 37.5px |
 * | `minute` | `"10:05 AM"` | 48.39px | 53.39px | 54px |
 * | `date` | `"May 30"` | 38.03px | 43.03px | **43px** |
 *
 * So the honest answer to T190's criterion 4 is yes: a weekday needs more than 26.5px at 11px. It needs
 * 27.56px, and the brief's 375px card gives its seven midnights 26.0px each — which is why `Sun` was not
 * painted there while the spike table under the same card named it twice.
 *
 * **Why a single per-character figure could not get this right.** The rule this replaces was
 * `CHARS[grain] * 5.5 + 10`, a character count times half a character's advance width. Per character the
 * measurements above are 7.52px for a weekday, 6.19px for an hour, 6.05px for a minute label and 6.34px
 * for a date: a weekday is three capital-initial letters with no space and no narrow punctuation in it,
 * so it is the one grain whose characters are all wide. One figure covering all four is either too small
 * for `day` or needlessly large for the rest, and 5.5 was too small for every one of them — the 10px gap
 * was carrying the difference, and only `day` and `date` had drawn down enough of it to fail. Measured
 * widths per grain is the model that cannot have that bug; it also puts the four figures where a reader
 * can check them against the table above.
 *
 * Rounded up to the pixel, because a tick coordinate is a fraction of a plot width and the comparison is
 * made against sub-pixel coordinates at both ends.
 */
const LABEL_WIDTH: Record<Grain, number> = { minute: 49, hour: 31, day: 23, date: 39 };

/**
 * The clear space asked for between two labels, in pixels.
 *
 * Eight, not Recharts' own five, because five is the figure a label is dropped *at* rather than a figure
 * it is safe to plan against. The brief's seven weekdays sat 26.0px apart where the pairwise rule asks
 * for 25.95 — inside a tenth of a pixel — and Recharts dropped one anyway: its walk measures and clamps
 * in device pixels from the end of the axis, so a model sitting on the boundary is a coin toss, and the
 * one it lost is a missing weekday on a clinician's brief. Three pixels buys the margin. It is not
 * generosity that costs an axis anything: `day` at 23 + 8 is 31px, and the three surfaces that keep all
 * seven weekdays give them 30px (the patient's page at 375px) to 125px each.
 *
 * `lib/markerLabels.ts` has a `LABEL_GAP` of its own, for the 10px marker labels over the rises (T23,
 * T197). That one is a gap in a collision test this product performs itself and then obeys, so nothing
 * downstream can overrule it; this one has to leave room for a test Recharts performs after we have
 * answered. They are not the same number and there is no reason they should be.
 */
const LABEL_GAP = 8;

/**
 * How many labels to allow before the plot has been measured — the server render, and a browser with no
 * `ResizeObserver`.
 *
 * Eight, which is one more than the week this chart was written for, so the first paint of the seven-day
 * export is the axis it has always had rather than a thinned one that fills in on the next frame.
 *
 * It is the one place T190's correction cannot reach, and deliberately: a count allowed before any width is
 * known is a guess either way, and the two surfaces §6.5 narrows below seven weekdays settle on the right
 * count as soon as the observer fires — one frame, which e2e/charts.ts waits past before it reads the axis
 * (`data-axis-plot`). Lowering it to the narrowest card's six would thin every desk's first paint to buy
 * that frame on a phone, which is the trade the other direction.
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

/**
 * How many of this label the plot holds. Always at least two: a line has two ends to name.
 *
 * `MOST_LABELS` is a ceiling on density and `LABEL_WIDTH + LABEL_GAP` is the pitch Recharts will paint
 * at, so a count this returns is one every chosen tick survives — which is the whole of T190: a tick
 * chosen here and dropped there leaves a gap no reader can see.
 */
function labelsThatFit(plot: number, grain: Grain): number {
  if (plot <= 0) return UNMEASURED_LABELS;
  return Math.max(2, Math.min(MOST_LABELS, Math.floor(plot / (LABEL_WIDTH[grain] + LABEL_GAP))));
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

  // Nothing on the ladder gave two readable labels, and that happens at *both* ends of the span range.
  const coarsest = ladder[ladder.length - 1];
  const grain = grainOf(coarsest);
  const sparse = ticksEvery(coarsest, first, last);

  // Too long for a finer step and too short for two of the coarsest — a week and a half against
  // `DAY_STEPS`' four weeks. One true label beats both ends of a line barely longer than the gap.
  if (sparse.length === 1) return axis(sparse, grain);

  // Too long for every step on the ladder, which is the other direction and the one the ends of the line
  // cannot answer. `DAY_STEPS` tops out at four weeks, so past about six months even that step has more
  // ticks than fit and every step is rejected — and falling through to `[first, last]` labelled a year of
  // readings "7:23 AM · 7:23 AM": two identical clock times under a chart spanning twelve months, which is
  // this ticket's empty axis wearing its other disguise. Nothing caps the span a patient may upload —
  // lib/bundle.ts downsamples the *count* and leaves the span alone — so a long Clarity export reaches
  // here. Thin the coarsest step instead of abandoning it: every nth of an evenly spaced walk is still
  // evenly spaced, still inside the line, and still reads as a date.
  if (sparse.length >= 2) {
    const every = Math.ceil(sparse.length / labelsThatFit(plot, grain));
    return axis(
      sparse.filter((_, i) => i % every === 0),
      grain,
    );
  }

  // The ends of the line, at the one grain that can name any instant: a span this short is minutes wide,
  // or a single reading, and neither lands on a clock time worth rounding to.
  return axis(first === last ? [first] : [first, last], "minute");
}
