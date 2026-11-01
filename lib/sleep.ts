// WHOOP CSV export parsing. Optional data source. Owner: (unassigned, cut if behind).
// Column names vary by export; match loosely.

import type { SleepNight } from "./types";

/**
 * What `SleepNight.date` means, stated here because this is the parser that decides it, and cited rather
 * than restated by everything downstream (T212): **the calendar date of the evening the sleep cycle
 * started — the night the patient went to bed.**
 *
 * Not the morning the cycle ended. The column this reads is WHOOP's "Cycle start time" (or "Sleep onset",
 * or a plain "Date"), and the first two are evening wall-clock times: `2026-09-19 22:30:00` is Saturday
 * night, and `date` is `2026-09-19`. So a consumer that wants "the night of" already has it and must not
 * shift it; `lib/sour.ts` shifted it by a day for the model while `components/SleepChart.tsx` drew it
 * unshifted, and the brief and the bars named one night two weekdays apart.
 *
 * It is the date the export wrote, taken from the text, so it carries no time zone of its own and does not
 * move with the zone the parse happens in. A row whose cycle-start column is not a `YYYY-MM-DD...` date is
 * dated by the instant it parsed to instead, which is the best the shape allows.
 */
const ISO_DATE = /^(\d{4}-\d{2}-\d{2})/;

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
    const startText = cols[startIdx]?.trim() ?? "";
    const start = new Date(startText);
    const mins = Number(cols[asleepIdx]?.trim());
    if (Number.isNaN(start.getTime()) || !Number.isFinite(mins)) continue;
    const rec = recIdx >= 0 ? Number(cols[recIdx]?.trim()) : NaN;
    out.push({
      // The export's own date, read off the text. `new Date(...)` is kept above as the validity check, but
      // its date is not what this reports: a date-only cell parses as UTC midnight and a cell with a time
      // and no offset parses as process-local, so deriving the day from the instant moves the night with
      // the zone the parse happens in — in one direction for one shape of cell and the other for the other.
      date: ISO_DATE.exec(startText)?.[1] ?? start.toISOString().slice(0, 10),
      hours: Math.round((mins / 60) * 10) / 10,
      recovery: Number.isFinite(rec) ? rec : undefined,
    });
  }
  return out;
}
