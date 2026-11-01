"use client";

// Hours asleep per night as columns. Single series, one hue. Shortest and longest nights are direct-labeled;
// the rest live in the tooltip and the table twin below the chart.

import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { TOOLTIP_SEPARATOR } from "@/components/chartTooltip";
import { sleepRecoveryColumn } from "@/lib/sleepRecovery";
import type { SleepNight } from "@/lib/types";

const INK2 = "var(--viz-ink-2)";
const MUTED = "var(--viz-muted)";
const GRID = "var(--viz-grid)";
const AXIS = "var(--viz-axis)";
const SERIES = "var(--viz-series)";
const SURFACE = "var(--viz-surface)";

export default function SleepChart({ nights, height = 200 }: { nights: SleepNight[]; height?: number }) {
  if (nights.length === 0) return <p className="text-sm text-[var(--viz-muted)]">No sleep data.</p>;
  // T205 (§2.7, §6.5): whether this export carries a recovery score at all. A column header is a claim that
  // the data has that field, so a week whose WHOOP export named no recovery column does not get a column of
  // em dashes reporting its own absence — the subtitle over this chart drops the word on the same predicate
  // (lib/sleepRecovery.ts). On a mixed week the column stays and the em dash means that night, not this
  // export, which is also what the tooltip's conditional suffix below has always meant.
  const recovery = sleepRecoveryColumn(nights);
  const hours = nights.map((n) => n.hours);
  const min = Math.min(...hours);
  const max = Math.max(...hours);
  const data = nights.map((n) => ({
    ...n,
    // One bar is the night of `n.date` — the evening the patient went to bed, which is what that field
    // means (lib/sleep.ts, `parseWhoopCsv`). Unshifted, and the brief's SLEEP table reads the same field
    // the same way, so a weekday on this axis and a weekday in the model's table are one night (T212).
    // Midday rather than midnight, and local rather than `Z`, so the viewer's zone cannot roll the day.
    day: new Date(n.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "short" }),
    label: n.hours === min || n.hours === max ? `${n.hours}h` : "",
  }));
  return (
    <div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 18, right: 8, bottom: 0, left: -16 }} barCategoryGap="35%">
            <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
            <XAxis dataKey="day" stroke={AXIS} tick={{ fill: MUTED, fontSize: 11 }} tickLine={false} />
            <YAxis domain={[0, 10]} ticks={[0, 4, 8]} stroke={AXIS} tick={{ fill: MUTED, fontSize: 11 }} tickLine={false} axisLine={false} />
            <Tooltip
              cursor={{ fill: GRID, fillOpacity: 0.5 }}
              contentStyle={{ borderRadius: 6, border: `1px solid ${GRID}`, background: SURFACE, fontSize: 12, color: INK2 }}
              // Recharts paints the tooltip's name and value in the series colour, which is tuned for a 2px line
              // (3:1 is all WCAG asks of a graphic) and reads as 3.6:1 at 12px. Tooltip text is text (§6.4).
              itemStyle={{ color: INK2 }}
              labelStyle={{ color: INK2 }}
              // Ours rather than Recharts' " : ", for the reason in GlucoseChart (T87, §2.6, §2.7, §7.4).
              separator={TOOLTIP_SEPARATOR}
              formatter={(v, _n, item) => {
                const rec = (item?.payload as SleepNight | undefined)?.recovery;
                return [`${v} h${typeof rec === "number" ? ` · recovery ${rec}%` : ""}`, "Asleep"];
              }}
            />
            <Bar dataKey="hours" fill={SERIES} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false}>
              <LabelList dataKey="label" position="top" fill={INK2} fontSize={11} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details className="mt-1 text-xs text-[var(--viz-muted)]">
        {/* The disclosure is a control, and on a phone it is one line of 12px type — 16px of thumb. 44px
            from the first breakpoint down (T23, design §6.5); a mouse pointer does not need the extra. */}
        <summary className="cursor-pointer max-sm:flex max-sm:min-h-11 max-sm:items-center">Table</summary>
        <table className="mt-1 w-full text-left tabular-nums">
          <thead><tr className="text-[var(--viz-ink-2)]"><th className="font-medium">Night</th><th className="font-medium">Asleep</th>{recovery && <th className="font-medium">Recovery</th>}</tr></thead>
          <tbody>
            {nights.map((n) => (
              <tr key={n.date}><td>{n.date}</td><td>{n.hours} h</td>{recovery && <td>{typeof n.recovery === "number" ? `${n.recovery}%` : "—"}</td>}</tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
