"use client";

// Glucose line, last 7 days, target band as a wash, spikes as labeled markers. Owner: Justin.
// Single series: no legend; the card title names it. Spike table (SpikeTable) is the table-view twin.

import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { GlucoseReading, Spike } from "@/lib/types";

const INK2 = "#52514e";
const MUTED = "#898781";
const GRID = "#e1e0d9";
const AXIS = "#c3c2b7";
const SERIES = "#2a78d6";
const CRITICAL = "#d03b3b";
const SURFACE = "#fcfcfb";

export default function GlucoseChart({ readings, spikes, height = 280 }: { readings: GlucoseReading[]; spikes: Spike[]; height?: number }) {
  const data = readings.map((r) => ({ t: Date.parse(r.t), mgdl: r.mgdl }));
  if (data.length === 0) return <p className="text-sm text-[var(--viz-muted)]">No glucose data yet.</p>;

  // One tick per local midnight.
  const first = data[0].t;
  const last = data[data.length - 1].t;
  const ticks: number[] = [];
  const d = new Date(first);
  d.setHours(0, 0, 0, 0);
  for (let t = d.getTime(); t <= last; t += 86400000) if (t >= first) ticks.push(t);

  // Direct labels are selective: a spike within 5% of the span of an already-labeled spike keeps its
  // marker but drops its label (tooltip and SpikeTable still carry it). Long place names are trimmed.
  const span = Math.max(1, last - first);
  const ordered = [...spikes].sort((a, b) => Date.parse(a.peak) - Date.parse(b.peak));
  const labelFor = new Map<Spike, string>();
  let lastLabeledAt = -Infinity;
  for (const s of ordered) {
    const at = Date.parse(s.peak);
    if ((at - lastLabeledAt) / span >= 0.05) {
      labelFor.set(s, trim(s.visit?.place ?? String(s.to)));
      lastLabeledAt = at;
    }
  }

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 20, right: 56, bottom: 4, left: -8 }}>
          <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={[first, last]}
            ticks={ticks}
            tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { weekday: "short" })}
            stroke={AXIS}
            tick={{ fill: MUTED, fontSize: 11 }}
            tickLine={false}
          />
          <YAxis domain={[40, 320]} ticks={[70, 180, 250]} stroke={AXIS} tick={{ fill: MUTED, fontSize: 11 }} tickLine={false} axisLine={false} />
          <ReferenceArea y1={70} y2={180} fill={SERIES} fillOpacity={0.1} stroke="none" />
          <Tooltip
            cursor={{ stroke: AXIS, strokeWidth: 1 }}
            contentStyle={{ borderRadius: 6, border: `1px solid ${GRID}`, background: SURFACE, fontSize: 12, color: INK2 }}
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
