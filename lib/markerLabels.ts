// Which rises over a glucose line carry a label, and which keep only their marker (design §2.6, §2.7,
// §7.4, §6.5). Owner: sour. The clinician's brief, the printed one-pager and the patient's own summary all
// draw one chart — components/GlucoseChart.tsx — and all three read this for its labels.
//
// The caption over every one of those charts promises "Labels, where they fit, give the peak mg/dL" (and
// the place variant on a placed week, lib/spikePlaces.ts). "Where they fit" is a claim this module has to
// keep, and keeping it has now failed twice in the same genre:
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
// So a label is kept here only when it clears **both**: the last label kept, and every marker on the chart.
// A label that loses is dropped, which is what the caption's "where they fit" has always meant and what the
// tooltip and SpikeTable are for (components/SpikeTable.tsx carries every rise, labelled or not).
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
 * Two tests, and they look in different directions on purpose. The labels are chosen left to right, so a
 * label can only be measured against the ones already kept — that is T23's rule, unchanged. The *markers*
 * are not chosen at all: every spike has one before this function runs, so each candidate label is measured
 * against all of them, on both sides, including the markers of rises whose own labels this loop has just
 * dropped. That asymmetry is the whole of T197: a dropped label does not advance the label cursor, which is
 * right, and used to mean its dot was accounted for nowhere.
 *
 * A spike's own marker is excluded, and only its own: `position: "top"` puts a label above the dot it
 * belongs to, which is the one dot it can never collide with.
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
    if (x[i] - half < lastLabelEnds) return;
    if (x.some((other, j) => j !== i && Math.abs(other - x[i]) < half + MARKER_REACH + DOT_GAP)) return;
    kept.set(spike, labels[i]);
    lastLabelEnds = x[i] + half + LABEL_GAP;
  });
  return kept;
}
