"use client";

// Glucose line with spike markers. Client component because Recharts needs the DOM. Owner: Justin.

import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { GlucoseReading, Spike } from "@/lib/types";

export default function GlucoseChart({ readings, spikes }: { readings: GlucoseReading[]; spikes: Spike[] }) {
  const data = readings.map((r) => ({ t: Date.parse(r.t), mgdl: r.mgdl }));
  if (data.length === 0) return <p className="text-sm text-gray-500">No glucose data yet.</p>;
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { weekday: "short" })} />
        <YAxis domain={[40, 320]} />
        <Tooltip labelFormatter={(v) => new Date(Number(v)).toLocaleString()} formatter={(v) => [`${v} mg/dL`, "glucose"]} />
        <ReferenceArea y1={70} y2={180} fill="#dcfce7" fillOpacity={0.5} />
        <Line type="monotone" dataKey="mgdl" stroke="#111" dot={false} strokeWidth={1.25} isAnimationActive={false} />
        {spikes.map((s, i) => (
          <ReferenceDot key={i} x={Date.parse(s.peak)} y={s.to} r={5} fill="#dc2626" stroke="none" label={{ value: s.visit?.place ?? "", position: "top", fontSize: 10 }} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
