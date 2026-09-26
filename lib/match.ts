// Link spikes to visits. Owner: Robbert.
// A spike matches a visit if the visit ended within 30 minutes before the spike start, or overlaps it. Pick the closest.

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
