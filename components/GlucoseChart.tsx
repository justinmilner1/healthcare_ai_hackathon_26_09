"use client";

// Glucose line, last 7 days, target band as a wash, spikes as labeled markers. Owner: Justin.
// Single series: no legend; the card title names it. Spike table (SpikeTable) is the table-view twin.

import { useEffect, useRef, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { TOOLTIP_SEPARATOR } from "@/components/chartTooltip";
import { CHART_MARGIN, MARKER_DOT, MARKER_LABEL_FONT_SIZE, Y_AXIS, markerLabels, plotWidth } from "@/lib/markerLabels";
import { timeAxis } from "@/lib/timeAxis";
import type { GlucoseReading, Spike } from "@/lib/types";

const INK2 = "var(--viz-ink-2)";
const MUTED = "var(--viz-muted)";
const GRID = "var(--viz-grid)";
const AXIS = "var(--viz-axis)";
const SERIES = "var(--viz-series)";
const CRITICAL = "var(--viz-critical)";
const SURFACE = "var(--viz-surface)";

/**
 * `patient` is the §2.7 page, and all it changes is what a marker over a placed rise is allowed to say: the
 * place where the Timeline export named one, and the patient's own words where it did not, rather than the
 * coordinates the brief and the printed sheet are right to carry (T128). The decision itself is
 * lib/spikePlaces.ts's `markerLabel`, which is also what SpikeTable's Where column reads, so the marker and
 * the row under it cannot disagree about one spike.
 */
export default function GlucoseChart({ readings, spikes, height = 280, patient = false }: { readings: GlucoseReading[]; spikes: Spike[]; height?: number; patient?: boolean }) {
  // How wide the chart actually got. On a 375px phone the card leaves the plot about 177px for seven days,
  // and the fixed "5% of the span apart" rule below let four labels land inside 60px of each other —
  // unreadable (T23, design §6.5). Measured rather than guessed from a breakpoint, because the same chart
  // is drawn into a provider card and a print sheet at three different widths.
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = wrap.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const data = readings.map((r) => ({ t: Date.parse(r.t), mgdl: r.mgdl }));
  if (data.length === 0) return <p className="text-sm text-[var(--viz-muted)]">No glucose data yet.</p>;

  const first = data[0].t;
  const last = data[data.length - 1].t;

  // Direct labels are selective: a spike whose label would collide with an already-labeled one, with any
  // other rise's marker, or with the y-axis tick text to the left of the plot, keeps its marker but drops
  // its label (tooltip and SpikeTable still carry it). The rule is lib/markerLabels.ts, whole — the widths,
  // the gaps, the trim, the marker's own reach and the axis's — for the reason the time axis below is not
  // written here either (T187, T197, T223, §12.1): it is arithmetic over a span and a measured width, so it
  // belongs where a unit test can reach it at plots no fixture renders.
  //
  // The subtraction that turns the card into the drawing area is there too, and so are the props it is a
  // subtraction from — the `margin` and the `YAxis` below, which the axis rule has to agree with about
  // where the axis is. `PLOT_CHROME` is derived from exactly those props now (T224): it was a literal 80
  // from T23 until then, 28px short of the 108 Recharts lays out, so every number either rule reasoned
  // about named a drawing area wider than the one on screen. `data-axis-plot` below is that figure, and
  // e2e/charts.ts holds it against the plot Recharts actually drew.
  const plot = plotWidth(width);

  // The time axis is lib/timeAxis.ts's, whole: which ticks and how they read, off the span and the plot
  // this chart actually got. It used to be one line here — a tick per local midnight, labelled with the
  // weekday — and a span inside one day holds no midnight at or after its first reading, so the array
  // came out empty and all three surfaces painted an axis line with nothing under it (T187). Nothing in
  // this component chooses a tick any more, for the reason `markerLabel` is not written here either: it
  // is arithmetic over a span, so it belongs where a unit test can reach it (§12.1).
  const axis = timeAxis(first, last, plot);
  const labelFor = markerLabels(spikes, { first, last, plot, patient });

  // `data-axis-ticks` is how the suite checks that every tick this chart chose was painted (T190): Recharts
  // measures each label itself and silently drops the ones it finds too close, so a count chosen in
  // lib/timeAxis.ts and a count under the line are two different numbers and only one of them is in the DOM.
  // `data-axis-plot` is the width that count was chosen against — 0 until the ResizeObserver above has
  // measured, which is the state e2e/charts.ts waits past before it compares the two.
  return (
    <div ref={wrap} style={{ height }} data-axis-ticks={axis.ticks.length} data-axis-plot={Math.round(plot)}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={CHART_MARGIN}>
          <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={[first, last]}
            ticks={axis.ticks}
            tickFormatter={(v) => axis.format(Number(v))}
            stroke={AXIS}
            tick={{ fill: MUTED, fontSize: 11 }}
            tickLine={false}
          />
          <YAxis width={Y_AXIS.width} tickSize={Y_AXIS.tickSize} tickMargin={Y_AXIS.tickMargin} domain={[40, 320]} ticks={[70, 180, 250]} stroke={AXIS} tick={{ fill: MUTED, fontSize: 11 }} tickLine={false} axisLine={false} />
          <ReferenceArea y1={70} y2={180} fill={SERIES} fillOpacity={0.1} stroke="none" />
          <Tooltip
            cursor={{ stroke: AXIS, strokeWidth: 1 }}
            contentStyle={{ borderRadius: 6, border: `1px solid ${GRID}`, background: SURFACE, fontSize: 12, color: INK2 }}
            // Recharts paints the tooltip's name and value in the series colour, which is tuned for a 2px line
            // (3:1 is all WCAG asks of a graphic) and reads as 3.6:1 at 12px. Tooltip text is text (§6.4).
            itemStyle={{ color: INK2 }}
            labelStyle={{ color: INK2 }}
            // The formatter below picks the word and the unit; Recharts picks what goes between them, and
            // its default is " : " — "Glucose : 118 mg/dL" on the patient's page, the clinician's brief and
            // the printed sheet (T87, §2.6, §2.7, §7.4). A space before a colon is not English typography,
            // so the separator is ours too.
            separator={TOOLTIP_SEPARATOR}
            labelFormatter={(v) => new Date(Number(v)).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}
            formatter={(v) => [`${v} mg/dL`, "Glucose"]}
          />
          <Line type="monotone" dataKey="mgdl" stroke={SERIES} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" dot={false} activeDot={{ r: 5, stroke: SURFACE, strokeWidth: 2 }} isAnimationActive={false} />
          {spikes.map((s, i) => (
            <ReferenceDot
              key={i}
              x={Date.parse(s.peak)}
              y={s.to}
              r={MARKER_DOT.r}
              fill={CRITICAL}
              stroke={SURFACE}
              strokeWidth={MARKER_DOT.strokeWidth}
              label={labelFor.has(s) ? { value: labelFor.get(s), position: "top", fontSize: MARKER_LABEL_FONT_SIZE, fill: INK2 } : undefined}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
