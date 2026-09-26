// WHOOP CSV export parsing. Optional data source. Owner: (unassigned, cut if behind).
// Column names vary by export; match loosely.

import type { SleepNight } from "./types";

export function parseWhoopCsv(text: string): SleepNight[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const startIdx = header.findIndex((h) => h.includes("cycle start") || h.includes("sleep onset") || h === "date");
  const asleepIdx = header.findIndex((h) => h.includes("asleep duration") || h.includes("sleep duration") || h.includes("time in bed"));
  const recIdx = header.findIndex((h) => h.includes("recovery"));
  if (startIdx < 0 || asleepIdx < 0) return [];

  const out: SleepNight[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const start = new Date(cols[startIdx]?.trim() ?? "");
    const mins = Number(cols[asleepIdx]?.trim());
    if (Number.isNaN(start.getTime()) || !Number.isFinite(mins)) continue;
    const rec = recIdx >= 0 ? Number(cols[recIdx]?.trim()) : NaN;
    out.push({
      date: start.toISOString().slice(0, 10),
      hours: Math.round((mins / 60) * 10) / 10,
      recovery: Number.isFinite(rec) ? rec : undefined,
    });
  }
  return out;
}
