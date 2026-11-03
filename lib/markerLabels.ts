// Which rises over a glucose line carry a label, and which keep only their marker (design §2.6, §2.7,
// §7.4, §6.5). Owner: sour. The clinician's brief, the printed one-pager and the patient's own summary all
// draw one chart — components/GlucoseChart.tsx — and all three read this for its labels.
//
// The caption over every one of those charts says that the labels on it are the ones that fit: the
// clinician's two in those words, "Labels, where they fit, give the peak mg/dL" (and the place variant on a
// placed week), the patient's in §2.7's own second person, "The labels that fit say where you were around
// then" — all of them from lib/spikePlaces.ts. The patient's sentence was the one that did not say it, over
// a chart that drops labels like the other two, which is T204. "Where they fit" is a claim this module has
// to keep, and keeping it has now failed twice in the same genre:
//
// - **T23** measured labels against labels. Before it, a fixed "5% of the span apart" rule let four labels
//   land inside 60px of each other on §6.5's 375px page; after it, a label is kept only where the gap to
//   the last one kept covers half of each plus `LABEL_GAP`.
// - **T197** is the half that test could not see: the *marker* was not in it. Every spike gets a
//   `ReferenceDot` whether or not its label survives, so a rise too close to be labelled still puts six
//   pixels of red either side of its peak — and nothing kept that dot off the label it was too close to.
//   On the seeded week at 375px the clinician's `202` read with its last digit struck out by the dot of the
//   `214` rise 8h35m later, on the brief, on the patient's summary and on the printed sheet.
//
// - **T223** is the third, and the one neither of those tickets had reason to look at: the chart's own
//   **y-axis tick text**. Labels were held off each other and off the markers, and nothing held them off
//   the `250` under the axis line. At 375px a rise that peaks high and early in the window puts its label
//   straight through that tick — `37.777, -122.423` over the `250` on §7.4's sheet, sixteen characters of
//   place name reaching left out of the plot and into the axis, with neither the tick nor the label left
//   readable.
//
// So a label is kept here only when it clears **all three**: the last label kept, every marker on the chart,
// and the axis text to the left of the plot. A label that loses is dropped, which is what the caption's
// "where they fit" has always meant and what the tooltip and SpikeTable are for (components/SpikeTable.tsx
// carries every rise, labelled or not).
//
// Pure, and in lib/ rather than in the component, for the reason lib/timeAxis.ts is (§12.1, T187): it is
// arithmetic over a span and a width, so it can be held to a unit test at plots no fixture renders — the
// three widths §6.5's page actually hands this chart, a desk, a plot nobody has measured yet — without a
// browser. components/GlucoseChart.tsx is left with no number about a label that a test here could own.

import { markerLabel } from "./spikePlaces";
import type { Spike } from "./types";

/**
 * The marker itself, in the units `ReferenceDot` is handed them in — `r` and `strokeWidth`, exported
 * because the collision test below and the dot Recharts paints have to be the same circle.
 *
 * T197's acceptance criterion 3: these were written in components/GlucoseChart.tsx and nowhere else, so a
 * test that wanted the marker's size had to repeat the figures, and a dot resized in the component would
 * have left the rule measuring the old one. The component reads them from here now.
 */
export const MARKER_DOT = { r: 5, strokeWidth: 2 } as const;

/** The size a marker label is drawn at, which is the size `HALF_CHAR` below is a measurement of. */
export const MARKER_LABEL_FONT_SIZE = 10;

/**
 * How far one marker's ink reaches either side of the peak it sits on.
 *
 * `r` plus half the stroke, because SVG centres a stroke on the path it outlines: a circle of `r: 5` drawn
 * with `strokeWidth: 2` has its outer edge at 6. That is the figure T197 measured on the 984px phone PNG —
 * the dot spanning ±15.7 device pixels at a scale of 2.624 — and it is 6 CSS pixels of red that a label
 * centred 9.5 CSS pixels away cannot share.
 */
export const MARKER_REACH = MARKER_DOT.r + MARKER_DOT.strokeWidth / 2;

/**
 * The chart's own chrome, in the units components/GlucoseChart.tsx hands Recharts — the `margin` on the
 * `LineChart` and the `width` of the `YAxis` inside it.
 *
 * T223's acceptance criterion 2, and the same move T197 made for the marker: the figures were written in
 * the component and nowhere else, so a rule about where the axis is had no way to ask. They are here now
 * and the component reads them, which is the whole point — a rule that measures the plot from one origin
 * while the component draws it from another is a rule about a chart nobody is looking at.
 *
 * `tickSize` and `tickMargin` are Recharts' own defaults, restated rather than inherited for the reason
 * `MARKER_DOT` restates the dot: `AXIS_TEXT_REACH` below is arithmetic over them, so a default that moved
 * under us would leave the rule measuring the old axis with nothing on screen saying so.
 */
export const Y_AXIS = { width: 60, tickSize: 6, tickMargin: 2 } as const;

/** The `margin` the chart is drawn with. `left` is negative: the y-axis gutter is wider than its labels need. */
export const CHART_MARGIN = { top: 20, right: 56, bottom: 4, left: -8 } as const;

/**
 * How far to the left of the plot the y-axis tick text reaches, in pixels.
 *
 * Recharts lays a left axis out from the plot's edge backwards: the tick line ends `tickSize` short of it
 * and the text is `tickMargin` short of that again, anchored at its end — so the `250`, the `180` and the
 * `70` all finish exactly this far left of where the line starts, and everything further left is empty
 * gutter. Measured off the committed desktop frame as well as read off Recharts: on
 * `docs/screenshots/tickets/t221/desktop-provider-print-one-placed-of-three.png` the `250` ends at 354px
 * and the grid starts at 362px.
 *
 * It is the margin the rule below is allowed to spend rather than a boundary the rule enforces — see
 * `LEFT_LIMIT`.
 */
export const AXIS_TEXT_REACH = Y_AXIS.tickSize + Y_AXIS.tickMargin;

/**
 * What components/GlucoseChart.tsx takes off the card to get `plot`, and what Recharts actually lays out.
 *
 * These are not the same number and this ticket is not the one that reconciles them. `plot` has meant
 * `card - 80` since T23; Recharts puts the plot's left edge at `margin.left + YAxis.width` and its right
 * edge `margin.right` in from the other side, so the chrome it draws is 52 + 56 = 108 and every `plot` in
 * this product is 28px wider than the drawing area it names.
 *
 * Correcting it is lib/timeAxis.ts's ticket, not this one. That module's `LABEL_WIDTH` and `LABEL_GAP`
 * were measured against these same overstated widths (T190), so a `plot` 28px narrower makes its day grain
 * ask for six labels where it asks for seven today — and the patient's 375px card, whose seven weekdays sit
 * a comfortable 29.9px apart on screen against the 27.56px Recharts needs, would thin to four for no reason
 * a reader could see. T223 is only about where a label is painted, so `PLOT_CHROME` stays where T23 left it
 * and `LEFT_LIMIT` below is sized to be right in spite of it.
 */
export const PLOT_CHROME = 80;
export const DRAWN_CHROME = CHART_MARGIN.left + Y_AXIS.width + CHART_MARGIN.right;

/** The drawing area a card `width` pixels wide leaves this chart, which is what `plot` means below. */
export const plotWidth = (width: number): number => Math.max(0, width - PLOT_CHROME);

/**
 * Half the advance width of one character at the label's font size.
 *
 * An estimate, and it stays one: T197 measured `202` on the rendered phone frame at ±21 device pixels,
 * which is ±8.0 CSS pixels against the ±8.1 this gives — a tenth of a pixel over three characters. It is
 * the axis labels under the line that needed real measurements instead (lib/timeAxis.ts' `LABEL_WIDTH`,
 * T190), and for a reason that does not apply here: there Recharts measures the labels itself and silently
 * drops any this product allowed, so an estimate that runs small loses a weekday with nothing on screen
 * saying so. The marker labels are dropped *here* and Recharts paints what it is given, so an estimate's
 * error shows up as clearance rather than as a label gone missing — and `DOT_GAP` below is sized to
 * absorb it.
 */
const HALF_CHAR = 2.7;

/**
 * The clear space asked for between two labels, in pixels (T23).
 *
 * Legibility rather than overlap: two numbers over two rises have to read as two labels, and at this font
 * size touching them is already too close. `DOT_GAP` is the other figure and is deliberately smaller.
 */
const LABEL_GAP = 10;

/**
 * And the clear space asked for between a label and somebody else's marker, in pixels (T197).
 *
 * Four, not `LABEL_GAP`'s ten, because the two gaps answer different questions. Ten is how far apart two
 * pieces of text have to be to read as two; a dot four pixels off the end of a label is plainly not part of
 * it, and asking ten here would start dropping labels that are not in anybody's way — the brief's 375px
 * card holds its fourth label 60.1px from the nearest other marker, and that label needs 49.2 of it for its
 * own half-width and the dot's reach.
 *
 * It is not nothing, either, for `HALF_CHAR`'s sake: zero would put the model exactly on the boundary it is
 * estimating, which is the mistake lib/timeAxis.ts' `LABEL_GAP` comment is about. Four covers a couple of
 * pixels of error on a sixteen-character place name and the sub-pixel rounding at both ends.
 */
const DOT_GAP = 4;

/**
 * The leftmost a label's left end may sit, in plot pixels (T223): the plot's own left edge.
 *
 * Which is the whole rule — **a label starts inside the plot or it is dropped** — and it is stated as that
 * edge rather than as a gap measured back to the tick text, because the gutter between the two is doing a
 * second job that a tighter boundary would spend.
 *
 * The tick text ends `AXIS_TEXT_REACH` further left again, so a label that only just keeps this is still
 * eight pixels clear of the digits. That eight is not spare change, it is what pays for `PLOT_CHROME`:
 * `plot` is 28px wider than the area Recharts draws into, so a label the arithmetic here puts exactly on
 * the plot's edge is really `half × 28 / plot` to the *left* of it. At the longest label this product
 * draws (sixteen characters, 43.2px of half-width) over the narrowest plot it draws (205px, §7.4's sheet
 * at 375px) that is 5.9px — inside the eight, with room to spare, and the test below holds the bound.
 *
 * So the rule is right about the chart on screen even though the number it is handed is not, and it says
 * so in its own terms rather than carrying the discrepancy into the arithmetic. Zero also needs no
 * `LABEL_GAP`-style clearance constant beside it: the clearance is the gutter, already measured.
 */
const LEFT_LIMIT = 0;

/**
 * The longest a label may be before it is trimmed, in characters.
 *
 * `markerLabel` never hands over anything longer than a real place name (T128), and sixteen is what the
 * longest the fixtures hold come to — `a place you went` on the patient's page, `37.760, -122.415` on the
 * clinician's.
 */
const LABEL_CHARS = 16;

/**
 * How far apart two labels must be before the plot has been measured, as a share of the span.
 *
 * The rule T23 replaced, kept for the one frame that has no width to reason about: the server render, and a
 * browser with no `ResizeObserver`. Pixels are what both tests above are written in, so neither can be
 * applied here at all — which is the same trade lib/timeAxis.ts' `UNMEASURED_LABELS` makes, and it lasts
 * exactly as long: one frame, which e2e/charts.ts waits past (`data-axis-plot`) before it reads a chart.
 */
const UNMEASURED_APART = 0.05;

/**
 * A place name cut to `LABEL_CHARS`, with an ellipsis where something was taken off.
 *
 * Exported for the test, which is the only other thing that needs to know how long a drawn label is.
 */
export const trimMarkerLabel = (name: string): string =>
  name.length > LABEL_CHARS ? name.slice(0, LABEL_CHARS - 1).trimEnd() + "…" : name;

/** Half the width one drawn label takes, in pixels. */
export const halfLabelWidth = (label: string): number => label.length * HALF_CHAR;

/**
 * The labels to draw over a set of rises, keyed by the spike each belongs to.
 *
 * `first` and `last` are the ends of the line the chart is drawing and `plot` is the drawing area in
 * pixels — the card less the y-axis and the right margin, which components/GlucoseChart.tsx measures and
 * takes off before calling. Zero means "not measured yet". `patient` is §2.7's page, and all it changes is
 * what a label over a placed rise is allowed to say (lib/spikePlaces.ts' `markerLabel`, T128).
 *
 * The first two tests look in different directions on purpose. The labels are chosen left to right, so a
 * label can only be measured against the ones already kept — that is T23's rule, unchanged. The *markers*
 * are not chosen at all: every spike has one before this function runs, so each candidate label is measured
 * against all of them, on both sides, including the markers of rises whose own labels this loop has just
 * dropped. That asymmetry is the whole of T197: a dropped label does not advance the label cursor, which is
 * right, and used to mean its dot was accounted for nowhere.
 *
 * A spike's own marker is excluded, and only its own: `position: "top"` puts a label above the dot it
 * belongs to, which is the one dot it can never collide with.
 *
 * The third test looks in neither direction, because the axis does not move: it is the plot's own left
 * edge, in the same pixels everything else here is in, so a label is measured against a fixed boundary
 * rather than against anything on the line (`LEFT_LIMIT`).
 *
 * Horizontal only, and deliberately. The ticks sit at 70, 180 and 250 and every marker label is drawn
 * above a peak over 180, so a label that reaches back into the gutter is beside one of them more often
 * than not — and a rule that also asked *which* tick would have to model the plot's height, the y domain
 * and the offset Recharts chooses for `position: "top"`, none of which this module is handed, and T190 is
 * what estimating a number Recharts owns costs. Clearing the column outright is the answer that cannot be
 * wrong about a chart it cannot see.
 *
 * It costs the one case the other two tests cannot reach: a rise so early in the window that its label is
 * drawn mostly in the gutter is dropped even when it is the only rise on the chart. That is the caption's
 * promise applied to the one piece of text on this chart that cannot be moved to make room (T223).
 */
export function markerLabels(
  spikes: Spike[],
  { first, last, plot, patient }: { first: number; last: number; plot: number; patient: boolean },
): Map<Spike, string> {
  const span = Math.max(1, last - first);
  const ordered = [...spikes].sort((a, b) => Date.parse(a.peak) - Date.parse(b.peak));
  const peaks = ordered.map((s) => Date.parse(s.peak));
  const labels = ordered.map((s) => trimMarkerLabel(markerLabel(s, { patient })));
  const kept = new Map<Spike, string>();

  if (plot <= 0) {
    let lastLabeledAt = -Infinity;
    ordered.forEach((spike, i) => {
      if ((peaks[i] - lastLabeledAt) / span < UNMEASURED_APART) return;
      kept.set(spike, labels[i]);
      lastLabeledAt = peaks[i];
    });
    return kept;
  }

  const x = peaks.map((t) => ((t - first) / span) * plot);
  // The right-hand edge the next label has to start clear of: the last one kept, plus its own half-width
  // and the gap. Nothing is kept yet, so the first candidate clears it by construction.
  let lastLabelEnds = -Infinity;
  ordered.forEach((spike, i) => {
    const half = halfLabelWidth(labels[i]);
    if (x[i] - half < LEFT_LIMIT) return;
    if (x[i] - half < lastLabelEnds) return;
    if (x.some((other, j) => j !== i && Math.abs(other - x[i]) < half + MARKER_REACH + DOT_GAP)) return;
    kept.set(spike, labels[i]);
    lastLabelEnds = x[i] + half + LABEL_GAP;
  });
  return kept;
}
