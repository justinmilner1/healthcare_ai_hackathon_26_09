// Sour's input assembler. Turns raw readings into the compact, local-time, pre-aggregated brief the model reads.
// Everything numeric is computed here so the model only has to notice relationships, never do arithmetic.
// Owner: Justin (taken over from the scaffold).

import { averageGlucose, timeInRange } from "./glucose";
import type { GlucoseReading, SleepNight, Spike } from "./types";

const LO = 70;
const HI = 180;

/** IANA zone used for every time the model sees. Defaults to the server's zone (the laptop running the demo). */
export function summaryTimeZone(): string {
  return process.env.SUMMARY_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
}

const tz = () => summaryTimeZone();

export function localDate(iso: string): string {
  // YYYY-MM-DD in the summary zone
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: tz() });
}

export function localTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { timeZone: tz(), hour: "numeric", minute: "2-digit" });
}

export function localDayTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { timeZone: tz(), weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function localHour(iso: string): number {
  return Number(new Date(iso).toLocaleTimeString("en-GB", { timeZone: tz(), hour: "2-digit", hour12: false }).slice(0, 2));
}

export type DayRow = {
  date: string; // YYYY-MM-DD local
  weekday: string;
  readings: number;
  tir: number;
  avg: number;
  max: number;
  maxAt: string; // local time
  min: number;
  minutesAbove180: number;
  minutesBelow70: number;
};

export type SourInput = {
  timeZone: string;
  visit: { type: string | null; reason: string | null };
  overall: { days: number; readings: number; tir: number; tbr: number; tar: number; avg: number; gmi: number };
  byTimeOfDay: { window: string; tir: number; avg: number; readings: number }[];
  days: DayRow[];
  spikes: {
    day: string; // "Tue Sep 22"
    start: string; // local time
    peak: string;
    from: number;
    to: number;
    rise: number;
    minutesAbove180: number;
    after: string | null; // place name or null
    placeLeftAt: string | null; // local time the visit ended
    placeRelation: "after leaving" | "during a stay at" | null; // long stays that merely overlap are not "after"
    placeArrivedAt: string | null;
  }[];
  nights: { nightOf: string; weekday: string; hours: number; recovery: number | null; lateDinnerBefore: string | null }[];
  patientNotes: string;
};

export function buildSourInput(args: {
  glucose: GlucoseReading[];
  spikes: Spike[];
  sleep: SleepNight[];
  patientNotes: string;
  visit: { type?: string | null; reason?: string | null };
}): SourInput {
  const { glucose, spikes, sleep } = args;
  const sorted = [...glucose].sort((a, b) => a.t.localeCompare(b.t));
  const stepMin = medianStepMinutes(sorted);

  // Per-day rows
  const byDay = new Map<string, GlucoseReading[]>();
  for (const r of sorted) {
    const d = localDate(r.t);
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(r);
  }
  const days: DayRow[] = [...byDay.entries()].map(([date, rs]) => {
    const max = rs.reduce((m, r) => (r.mgdl > m.mgdl ? r : m), rs[0]);
    const min = rs.reduce((m, r) => (r.mgdl < m.mgdl ? r : m), rs[0]);
    return {
      date,
      weekday: new Date(rs[0].t).toLocaleDateString(undefined, { timeZone: tz(), weekday: "short" }),
      readings: rs.length,
      tir: round3(timeInRange(rs)),
      avg: averageGlucose(rs),
      max: max.mgdl,
      maxAt: localTime(max.t),
      min: min.mgdl,
      minutesAbove180: rs.filter((r) => r.mgdl > HI).length * stepMin,
      minutesBelow70: rs.filter((r) => r.mgdl < LO).length * stepMin,
    };
  });

  // Time-of-day windows
  const windows: [string, number, number][] = [
    ["overnight 00-06", 0, 6],
    ["morning 06-11", 6, 11],
    ["midday 11-15", 11, 15],
    ["afternoon 15-18", 15, 18],
    ["evening 18-24", 18, 24],
  ];
  const byTimeOfDay = windows.map(([window, a, b]) => {
    const rs = sorted.filter((r) => {
      const h = localHour(r.t);
      return h >= a && h < b;
    });
    return { window, tir: round3(timeInRange(rs)), avg: averageGlucose(rs), readings: rs.length };
  });

  // Spikes with local times and minutes above range after the peak
  const spikeRows = spikes.map((s) => {
    const peakIdx = sorted.findIndex((r) => r.t >= s.peak);
    let above = 0;
    for (let i = Math.max(0, peakIdx); i < sorted.length && sorted[i].mgdl > HI; i++) above += stepMin;
    // Count backwards too, from the first reading above 180 before the peak.
    for (let i = peakIdx - 1; i >= 0 && sorted[i].mgdl > HI; i--) above += stepMin;
    return {
      day: new Date(s.peak).toLocaleDateString(undefined, { timeZone: tz(), weekday: "short", month: "short", day: "numeric" }),
      start: localTime(s.start),
      peak: localTime(s.peak),
      from: s.from,
      to: s.to,
      rise: s.to - s.from,
      minutesAbove180: above,
      after: s.visit?.place ?? null,
      placeLeftAt: s.visit ? localTime(s.visit.end) : null,
      placeRelation: s.visit ? (Date.parse(s.visit.end) <= Date.parse(s.start) ? "after leaving" : "during a stay at") : null,
      placeArrivedAt: s.visit ? localTime(s.visit.start) : null,
    };
  });

  // Nights: WHOOP rows are dated by the morning the cycle ended. Label by the evening before.
  const dinnerSpikesByDate = new Map<string, string>();
  for (const s of spikes) {
    if (s.visit && localHour(s.visit.end) >= 19) dinnerSpikesByDate.set(localDate(s.visit.end), `${s.visit.place} until ${localTime(s.visit.end)}`);
  }
  const nights = sleep.map((n) => {
    const morning = new Date(n.date + "T12:00:00");
    const evening = new Date(morning.getTime() - 86400000);
    const nightOf = evening.toLocaleDateString("en-CA");
    return {
      nightOf,
      weekday: evening.toLocaleDateString(undefined, { weekday: "short" }),
      hours: n.hours,
      recovery: n.recovery ?? null,
      lateDinnerBefore: dinnerSpikesByDate.get(nightOf) ?? null,
    };
  });

  const n = sorted.length;
  const avg = averageGlucose(sorted);
  return {
    timeZone: tz(),
    visit: { type: args.visit.type ?? null, reason: args.visit.reason ?? null },
    overall: {
      days: days.length,
      readings: n,
      tir: round3(timeInRange(sorted)),
      tbr: round3(n ? sorted.filter((r) => r.mgdl < LO).length / n : 0),
      tar: round3(n ? sorted.filter((r) => r.mgdl > HI).length / n : 0),
      avg,
      gmi: n ? Math.round((3.31 + 0.02392 * avg) * 10) / 10 : 0,
    },
    byTimeOfDay,
    days,
    spikes: spikeRows,
    nights,
    patientNotes: args.patientNotes,
  };
}

/** The text the model reads. Compact tables beat JSON for this: fewer tokens, easier to cite. */
export function renderSourInput(x: SourInput): string {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const L: string[] = [];
  L.push(`All times are local (${x.timeZone}).`);
  L.push(`Visit: ${x.visit.type ?? "unspecified"}${x.visit.reason ? ` · patient called about: ${x.visit.reason}` : ""}`);
  L.push("");
  L.push(`OVERALL (${x.overall.days} days, ${x.overall.readings} readings): TIR ${pct(x.overall.tir)} · below 70: ${pct(x.overall.tbr)} · above 180: ${pct(x.overall.tar)} · mean ${x.overall.avg} mg/dL · GMI ${x.overall.gmi}%`);
  L.push("");
  L.push("BY TIME OF DAY: window | TIR | mean");
  for (const w of x.byTimeOfDay) L.push(`  ${w.window} | ${pct(w.tir)} | ${w.avg}`);
  L.push("");
  L.push("BY DAY: day | TIR | mean | peak (time) | low | min above 180 | min below 70");
  for (const d of x.days) L.push(`  ${d.weekday} ${d.date.slice(5)} | ${pct(d.tir)} | ${d.avg} | ${d.max} (${d.maxAt}) | ${d.min} | ${d.minutesAbove180} | ${d.minutesBelow70}`);
  L.push("");
  L.push(`SPIKES (${x.spikes.length}; rise ≥50 to a peak >180): day | start→peak | from→to | min above 180 | place context`);
  if (x.spikes.length === 0) L.push("  none");
  for (const s of x.spikes) {
    const ctx = !s.after
      ? "no visit within 30 min"
      : s.placeRelation === "after leaving"
        ? `after leaving ${s.after} at ${s.placeLeftAt}`
        : `during a stay at ${s.after} (${s.placeArrivedAt}–${s.placeLeftAt}; long stay, weak association)`;
    L.push(`  ${s.day} | ${s.start}→${s.peak} | ${s.from}→${s.to} (+${s.rise}) | ${s.minutesAbove180} | ${ctx}`);
  }
  L.push("");
  if (x.nights.length) {
    L.push("SLEEP (night of): day | hours | recovery | late dinner out that evening");
    for (const nt of x.nights) L.push(`  ${nt.weekday} ${nt.nightOf.slice(5)} | ${nt.hours} h | ${nt.recovery ?? "–"} | ${nt.lateDinnerBefore ?? "–"}`);
    L.push("");
  }
  L.push("PATIENT'S OWN WORDS (from the pre-visit chat):");
  L.push(x.patientNotes.trim() ? x.patientNotes.trim() : "  (nothing recorded)");
  return L.join("\n");
}

function medianStepMinutes(rs: GlucoseReading[]): number {
  if (rs.length < 2) return 5;
  const gaps: number[] = [];
  for (let i = 1; i < Math.min(rs.length, 200); i++) gaps.push((Date.parse(rs[i].t) - Date.parse(rs[i - 1].t)) / 60000);
  gaps.sort((a, b) => a - b);
  const m = gaps[Math.floor(gaps.length / 2)];
  return m > 0 && m < 60 ? Math.round(m) : 5;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
