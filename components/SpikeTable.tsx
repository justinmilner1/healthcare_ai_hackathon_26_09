// Spikes linked to places. The table twin of the markers on GlucoseChart.

import { anyPlaceKnown, UNKNOWN_PLACE } from "@/lib/spikePlaces";
import type { Spike } from "@/lib/types";

/**
 * `compact` drops the "left 25 min before" suffix and narrows the heading, for the two places the table is
 * printed in a card rather than read at a desk: the patient's page and the printed sheet (§7.4).
 *
 * `patient` is the §2.7 page only, and is deliberately not `compact`: the printed sheet is compact too and
 * is a clinician's document, where "no matching visit" is a true and useful thing to say (T82). What the
 * patient's copy does differently is in lib/spikePlaces.ts — with no place known anywhere it leaves the
 * column out rather than reporting an absence of data §2.5 made optional, and where some rows do have a
 * place the rest answer in the patient's own words.
 */
export default function SpikeTable({
  spikes,
  compact = false,
  patient = false,
}: {
  spikes: Spike[];
  compact?: boolean;
  patient?: boolean;
}) {
  if (spikes.length === 0) return <p className="text-sm text-[var(--viz-muted)]">No spikes over 180 detected.</p>;
  const places = !patient || anyPlaceKnown(spikes);
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-[var(--viz-ink-2)]">
          <th className="pb-1 font-medium">When</th>
          <th className="pb-1 font-medium">Rise</th>
          {places && <th className="pb-1 font-medium">{compact ? "Where" : "Place"}</th>}
        </tr>
      </thead>
      <tbody className="tabular-nums">
        {spikes.map((s, i) => {
          // "left 25 min before" when the visit ended before the rise began; "while there" when the rise
          // began during the visit, which is normal for a sit-down meal.
          const gapMin = s.visit ? Math.round((Date.parse(s.start) - Date.parse(s.visit.end)) / 60000) : null;
          const relation = gapMin === null ? "" : gapMin > 0 ? `left ${gapMin} min before` : "while there";
          return (
            <tr key={i} className="border-t border-black/5">
              <td className="py-1.5 pr-3 whitespace-nowrap">{fmt(s.peak)}</td>
              <td className="py-1.5 pr-3 whitespace-nowrap">
                {s.from} → <span className="font-medium">{s.to}</span>
              </td>
              {places && (
                <td className="py-1.5">
                  {s.visit ? (
                    <>
                      {s.visit.place}
                      {!compact && relation && <span className="text-[var(--viz-muted)]"> · {relation}</span>}
                    </>
                  ) : (
                    <span className="text-[var(--viz-muted)]">{patient ? UNKNOWN_PLACE : "no matching visit"}</span>
                  )}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
