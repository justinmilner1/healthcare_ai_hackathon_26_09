"use client";

// Glucose line, last 7 days, target band as a wash, spikes as labeled markers. Owner: Justin.
// Single series: no legend; the card title names it. Spike table (SpikeTable) is the table-view twin.

import { useEffect, useRef, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { TOOLTIP_SEPARATOR } from "@/components/chartTooltip";
import { markerLabel } from "@/lib/spikePlaces";
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
  // How wide the chart actually got. On a 375px phone the card leaves the plot about 270px for seven days,
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

  // Direct labels are selective: a spike whose label would collide with an already-labeled one keeps its
  // marker but drops its label (tooltip and SpikeTable still carry it). Long place names are trimmed, and
  // `markerLabel` never hands over anything longer than a real place name to trim (T128).
  //
  // "Collide" is measured in pixels once the width is known: two centred labels clear each other when the
  // gap between their markers covers half of each. Until the first measurement — the server render, and a
  // browser with no ResizeObserver — it falls back to the 5%-of-the-span rule this had before, which is
  // right on a desk and merely generous on a phone.
  const span = Math.max(1, last - first);
  const plot = Math.max(0, width - PLOT_CHROME);

  // The time axis is lib/timeAxis.ts's, whole: which ticks and how they read, off the span and the plot
  // this chart actually got. It used to be one line here — a tick per local midnight, labelled with the
  // weekday — and a span inside one day holds no midnight at or after its first reading, so the array
  // came out empty and all three surfaces painted an axis line with nothing under it (T187). Nothing in
  // this component chooses a tick any more, for the reason `markerLabel` is not written here either: it
  // is arithmetic over a span, so it belongs where a unit test can reach it (§12.1).
  const axis = timeAxis(first, last, plot);
  const ordered = [...spikes].sort((a, b) => Date.parse(a.peak) - Date.parse(b.peak));
  const labelFor = new Map<Spike, string>();
  let lastLabeledAt = -Infinity;
  let lastLabelChars = 0;
  for (const s of ordered) {
    const at = Date.parse(s.peak);
    const label = trim(markerLabel(s, { patient }));
    const apart = plot > 0
      ? ((at - lastLabeledAt) / span) * plot >= (lastLabelChars + label.length) * HALF_CHAR + LABEL_GAP
      : (at - lastLabeledAt) / span >= 0.05;
    if (apart) {
      labelFor.set(s, label);
      lastLabeledAt = at;
      lastLabelChars = label.length;
    }
  }

  return (
    <div ref={wrap} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 20, right: 56, bottom: 4, left: -8 }}>
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
          <YAxis domain={[40, 320]} ticks={[70, 180, 250]} stroke={AXIS} tick={{ fill: MUTED, fontSize: 11 }} tickLine={false} axisLine={false} />
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
              r={5}
              fill={CRITICAL}
              stroke={SURFACE}
              strokeWidth={2}
              label={labelFor.has(s) ? { value: labelFor.get(s), position: "top", fontSize: 10, fill: INK2 } : undefined}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

const trim = (name: string) => (name.length > 16 ? name.slice(0, 15).trimEnd() + "…" : name);

/** The y-axis and the right margin the labels are kept clear of, from the LineChart margin above. */
const PLOT_CHROME = 80;
/** Half the advance width of one character at the 10px label size, and the clear space between two labels. */
const HALF_CHAR = 2.7;
const LABEL_GAP = 10;
