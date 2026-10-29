// The spikes a visit's readings hold, with the place each one was matched to where there is one. The table
// twin of the markers on GlucoseChart. The card's heading is not written here: it is a function of these
// same spikes on the clinician's surfaces (lib/spikePlaces.ts `clinicianSpikeCardHeading`, T157) and the
// patient's own words on theirs ("Your biggest rises", §2.7).

import { anyPlaceKnown, clinicianPlaceColumn, NO_MATCH_CELL, patientPlaceName, placeIsUnnamed, spikeRelationCell, UNKNOWN_PLACE } from "@/lib/spikePlaces";
import type { Spike } from "@/lib/types";

/**
 * `compact` drops the "left 25 min before" suffix and narrows the heading, for the two places the table is
 * printed in a card rather than read at a desk: the patient's page and the printed sheet (§7.4).
 *
 * `patient` is the §2.7 page only, and is not what `compact` means: the printed sheet is compact too and is
 * a clinician's document, where "no matching visit" is a true and useful thing to say (T82). What the
 * patient's copy does differently is in lib/spikePlaces.ts — with no place known anywhere it leaves the
 * column out rather than reporting an absence of data §2.5 made optional; where some rows do have a place
 * the rest answer in the patient's own words; and a place the export never named answers in them too
 * rather than in the coordinates the clinician's surfaces are right to carry (T128).
 *
 * The clinician's surfaces drop the column one case later, which is what `status` is for (T184). A visit
 * that shared a Timeline and matched nothing keeps its rows of "no matching visit" — that is the matcher
 * reporting, and T160 settled that such a zero is a reading taken. A visit that shared no Timeline has had
 * nothing looked up, so there is no column to report it in, and the stat tile above the card is the one
 * element that names the absent source. `clinicianPlaceColumn` is that answer, and the heading over this
 * card and the caption over the chart read the same report behind it, so none of the three can contradict
 * another.
 *
 * It is required on every surface rather than optional so that a clinician page cannot leave out the one
 * thing that decides its column. The `patient` branch does not read it: §2.7 drops the column whenever no
 * row has a place to show, whether or not an export was shared (T82), which is a stricter test than this
 * one and needs nothing from the bundle.
 */
export default function SpikeTable({
  spikes,
  compact = false,
  patient = false,
  status,
}: {
  spikes: Spike[];
  compact?: boolean;
  patient?: boolean;
  status: { hasLocation: boolean };
}) {
  if (spikes.length === 0) return <p className="text-sm text-[var(--viz-muted)]">No spikes over 180 detected.</p>;
  const places = patient ? anyPlaceKnown(spikes) : clinicianPlaceColumn(spikes, status);
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
          // One cell per story the match can be, all three from lib/spikePlaces.ts `spikeVisitRelation`:
          // "left 25 min before" when the visit ended before the rise began; "while there" when the visit
          // was already running as it began, which is normal for a sit-down meal; and "arrived 10 min
          // after" when the visit began after the rise did and the patient walked in partway up the climb
          // (T192). The derivation is in lib/spikePlaces.ts because the caption over this card is written
          // off the same relation, and the two used to disagree: it called every label on the chart a
          // place the patient had left, over rows saying "while there" (T191).
          const relation = spikeRelationCell(s);
          // Muted like "not sure" below it, and for the same reason: both are the page saying what it does
          // not know, which is not the same kind of cell as "Pizzeria Delfina" (T128).
          const unnamed = patient && s.visit !== undefined && placeIsUnnamed(s.visit);
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
                      {unnamed ? (
                        <span className="text-[var(--viz-muted)]">{patientPlaceName(s.visit)}</span>
                      ) : (
                        s.visit.place
                      )}
                      {!compact && relation && <span className="text-[var(--viz-muted)]"> · {relation}</span>}
                    </>
                  ) : (
                    <span className="text-[var(--viz-muted)]">{patient ? UNKNOWN_PLACE : NO_MATCH_CELL}</span>
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
