// Spikes linked to places. The table twin of the markers on GlucoseChart.

import type { Spike } from "@/lib/types";

export default function SpikeTable({ spikes, compact = false }: { spikes: Spike[]; compact?: boolean }) {
  if (spikes.length === 0) return <p className="text-sm text-[var(--viz-muted)]">No spikes over 180 detected.</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-[var(--viz-ink-2)]">
          <th className="pb-1 font-medium">When</th>
          <th className="pb-1 font-medium">Rise</th>
          <th className="pb-1 font-medium">{compact ? "Where" : "After being at"}</th>
        </tr>
      </thead>
      <tbody className="tabular-nums">
        {spikes.map((s, i) => {
          const gapMin = s.visit ? Math.max(0, Math.round((Date.parse(s.start) - Date.parse(s.visit.end)) / 60000)) : null;
          return (
            <tr key={i} className="border-t border-black/5">
              <td className="py-1.5 pr-3 whitespace-nowrap">{fmt(s.peak)}</td>
              <td className="py-1.5 pr-3 whitespace-nowrap">
                {s.from} → <span className="font-medium">{s.to}</span>
              </td>
              <td className="py-1.5">
                {s.visit ? (
                  <>
                    {s.visit.place}
                    {!compact && gapMin !== null && <span className="text-[var(--viz-muted)]"> · left {gapMin === 0 ? "during" : `${gapMin} min before`}</span>}
                  </>
                ) : (
                  <span className="text-[var(--viz-muted)]">no matching visit</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
