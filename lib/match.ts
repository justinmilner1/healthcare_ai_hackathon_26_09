// Link spikes to visits. Owner: Robbert.
// A spike matches a visit if the visit ended within 30 minutes before the spike start, or overlaps it. Pick the closest.
//
// `overlaps` is one predicate and two stories, which is T192. A visit can overlap the climb from either
// side: it may have been running when the readings began to rise, or it may have begun after they did, any
// time up to the peak — the patient walked in while their glucose was already going up. Nothing here
// chooses between them. Every overlap scores `gap = 0` and the first one seen wins, so the visit left on a
// spike need not be the one that was running when the rise began, and no reader of this field may take it
// for "the place the patient was at". Which of the three a match is, and the words for it, are
// lib/spikePlaces.ts `spikeVisitRelation`: `after`, `during`, `arrived` (T191, T192).

import type { Spike, Visit } from "./types";

const BEFORE_MS = 30 * 60 * 1000;

export function matchSpikesToVisits(spikes: Spike[], visits: Visit[]): Spike[] {
  return spikes.map((s) => {
    const start = Date.parse(s.start);
    const peak = Date.parse(s.peak);
    let best: Visit | undefined;
    let bestGap = Infinity;
    for (const v of visits) {
      const vStart = Date.parse(v.start);
      const vEnd = Date.parse(v.end);
      const overlaps = vStart <= peak && vEnd >= start;
      const endedJustBefore = vEnd <= start && start - vEnd <= BEFORE_MS;
      if (!overlaps && !endedJustBefore) continue;
      const gap = overlaps ? 0 : start - vEnd;
      if (gap < bestGap) {
        bestGap = gap;
        best = v;
      }
    }
    return best ? { ...s, visit: best } : s;
  });
}
