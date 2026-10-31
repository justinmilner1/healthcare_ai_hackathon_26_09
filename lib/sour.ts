// Sour's input assembler. Turns raw readings into the compact, local-time, pre-aggregated brief the model reads.
// Everything numeric is computed here so the model only has to notice relationships, never do arithmetic.
// Owner: Justin (taken over from the scaffold).

import { averageGlucose, timeInRange } from "./glucose";
import { countOf, plural } from "./plural";
import { spikeVisitRelation } from "./spikePlaces";
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

/**
 * The words the brief uses for how a matched place relates to a rise, and the vocabulary lib/prompts.ts
 * tells the model what to do with. `after leaving` is the stop the patient had left; the other three are
 * the overlap lib/match.ts does not split, told apart here. Only `at` of those three is a meal-length
 * association — a stay of up to three hours that was already running when the readings turned. The other
 * two are weak for opposite reasons: a long stay overlaps everything, and an `arrived` climb had already
 * started before the patient got there (T192).
 */
export type SourPlaceRelation = "after leaving" | "at" | "during a long stay at" | "arrived during the rise at" | null;

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
    placeRelation: SourPlaceRelation;
    placeArrivedAt: string | null;
  }[];
  /** Every spike in the readings, not just the rows above: `spikes` is cut to the top few by rise for the
   *  clinician's card, and a pattern citing the cut figure would understate the week (T164, §7.1). */
  spikeTotal: number;
  nights: { nightOf: string; weekday: string; hours: number; recovery: number | null; lateDinnerBefore: string | null }[];
  patientNotes: string;
  glucoseForFlags?: GlucoseReading[]; // kept so renderSourInput can print the safety flags; not sent raw
};

export function buildSourInput(args: {
  glucose: GlucoseReading[];
  spikes: Spike[];
  /** `PatientBundle.spikeTotal`: how many spikes the readings hold, where `spikes` holds the top few.
   *  Required rather than defaulted to `spikes.length`, which is the understatement T164 is about. */
  spikeTotal: number;
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
      placeRelation: relationTo(s),
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
    spikeTotal: args.spikeTotal,
    nights,
    patientNotes: args.patientNotes,
    glucoseForFlags: sorted,
  };
}

/** The text the model reads. Compact tables beat JSON for this: fewer tokens, easier to cite. */
export function renderSourInput(x: SourInput): string {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const L: string[] = [];
  L.push(`All times are local (${x.timeZone}).`);
  L.push(`Visit: ${x.visit.type ?? "unspecified"}${x.visit.reason ? ` · patient called about: ${x.visit.reason}` : ""}`);
  L.push("");
  if (x.overall.readings === 0) {
    // No readings, so no numbers — and emphatically not this brief's numbers for no readings, which are
    // every one of them a zero: `timeInRange([])` is 0 and `averageGlucose([])` is 0 (lib/glucose.ts), so
    // the OVERALL line below would read "TIR 0% · mean 0 mg/dL" over an empty week. The model is asked for
    // patterns that cite the brief, and 0% in range is a citable, alarming, invented figure.
    //
    // Reachable on every conversation-only run: T143 made the wrap queue one for a check-in that shared no
    // glucose (lib/sourQueue.ts `wrapQueuesSour`), which until then only the provider page's Generate button
    // could produce by hand. The page says the same thing to the clinician in its own words ("No glucose
    // data was shared. This summary is from the conversation only."); this is that sentence for the model.
    L.push("NO GLUCOSE: the patient shared no CGM readings for this visit, so there are no glucose numbers,");
    L.push("no per-day or time-of-day tables and no spikes. Do not state or imply any glucose figure, and do");
    L.push("not read the absence as a result. Write from the patient's own words below, and where they are");
    L.push("thin say so in one pattern rather than inventing one.");
    L.push("");
  } else {
    L.push(`OVERALL (${x.overall.days} days, ${x.overall.readings} readings): TIR ${pct(x.overall.tir)} · below 70: ${pct(x.overall.tbr)} · above 180: ${pct(x.overall.tar)} · mean ${x.overall.avg} mg/dL · GMI ${x.overall.gmi}%`);
    L.push("");
    L.push("BY TIME OF DAY: window | TIR | mean");
    for (const w of x.byTimeOfDay) L.push(`  ${w.window} | ${pct(w.tir)} | ${w.avg}`);
    L.push("");
    L.push("BY DAY: day | TIR | mean | peak (time) | low | min above 180 | min below 70");
    for (const d of x.days) L.push(`  ${d.weekday} ${d.date.slice(5)} | ${pct(d.tir)} | ${d.avg} | ${d.max} (${d.maxAt}) | ${d.min} | ${d.minutesAbove180} | ${d.minutesBelow70}`);
    L.push("");
    // The count is the week's, the rows are the brief's. When the rows are a subset the header says so in
    // the same breath, so a pattern can cite "7 rises over 180" without the model having to infer it from a
    // five-row table — and cannot cite the five as though that were the week (T164).
    // "top N by rise listed" is the wording the clinician's own tile uses for the same cut ("top 5 shown",
    // lib/spikePlaces.ts), so the brief and the screen describe one cut in one vocabulary.
    const listed = x.spikeTotal > x.spikes.length ? `; top ${x.spikes.length} by rise listed` : "";
    L.push(`SPIKES (${x.spikeTotal}${listed}; rise ≥50 to a peak >180): day | start→peak | from→to | min above 180 | place context`);
    if (x.spikes.length === 0) L.push("  none");
    for (const s of x.spikes) {
      L.push(`  ${s.day} | ${s.start}→${s.peak} | ${s.from}→${s.to} (+${s.rise}) | ${s.minutesAbove180} | ${placeContext(s)}`);
    }
    L.push("");
  }
  if (x.nights.length) {
    L.push("SLEEP (night of): day | hours | recovery | late dinner out that evening");
    for (const nt of x.nights) L.push(`  ${nt.weekday} ${nt.nightOf.slice(5)} | ${nt.hours} h | ${nt.recovery ?? "–"} | ${nt.lateDinnerBefore ?? "–"}`);
    L.push("");
  }
  const flags = safetyFlags(x.glucoseForFlags ?? []);
  if (flags.length) {
    L.push("SAFETY FLAGS (computed, already shown to the clinician; reference them, do not restate as a pattern):");
    for (const f of flags) L.push(`  ! ${f}`);
    L.push("");
  }
  L.push("PATIENT'S OWN WORDS (from the pre-visit chat):");
  L.push(x.patientNotes.trim() ? x.patientNotes.trim() : "  (nothing recorded)");
  return L.join("\n");
}

/**
 * The "place context" column of the SPIKES table: the matched place with the relation `relationTo` gave it.
 *
 * A `switch` rather than the chain of ternaries this was, because T192 made it a fourth case and because
 * the compiler can then say so when a fifth is added: every word `SourPlaceRelation` carries has to be
 * rendered somewhere, or the model reads a row the brief never explained. The two weak overlaps say so in
 * the row itself, in the same parenthesis, so a pattern that leans on one has been warned off in the one
 * place the model is reading.
 */
function placeContext(s: SourInput["spikes"][number]): string {
  const stay = `${s.placeArrivedAt}–${s.placeLeftAt}`;
  switch (s.after ? s.placeRelation : null) {
    case "after leaving":
      return `after leaving ${s.after} at ${s.placeLeftAt}`;
    case "at":
      return `at ${s.after} (${stay})`;
    case "arrived during the rise at":
      return `arrived during the rise at ${s.after} (${stay}; weak association — the climb had started before the patient got there)`;
    case "during a long stay at":
      return `during a long stay at ${s.after} (${stay}; weak association)`;
    case null:
      return "no visit within 30 min";
  }
}

// ---------------------------------------------------------------------------------------------
// Safety flags. Deterministic, computed from the readings, shown to the clinician regardless of what the
// narrative says. Thresholds follow the international CGM consensus targets: level 2 hypoglycemia <54,
// time below 70 over 4%, and sustained time above 250. The model never decides these.

const URGENT_LOW = 54;
const HIGH_SUSTAINED = 250;
const HIGH_SUSTAINED_MIN = 60;
const TBR_LIMIT = 0.04;

export function safetyFlags(glucose: GlucoseReading[]): string[] {
  const rs = [...glucose].sort((a, b) => a.t.localeCompare(b.t));
  if (rs.length === 0) return [];
  const step = medianStepMinutes(rs);
  const flags: string[] = [];

  const lows = rs.filter((r) => r.mgdl < URGENT_LOW);
  if (lows.length) {
    const lowest = lows.reduce((m, r) => (r.mgdl < m.mgdl ? r : m), lows[0]);
    const days = new Set(lows.map((r) => localDate(r.t))).size;
    // `lowest` ranges over `lows`, the readings, while the count in front of it is of distinct local dates:
    // different sets, so one day does not imply one reading and the superlative reads distributively at any
    // count (T202). Only the agreement is `plural`'s here.
    flags.push(`Glucose below ${URGENT_LOW} mg/dL on ${countOf(days, "day")} (${lows.length * step} min total; lowest ${lowest.mgdl} at ${localDayTime(lowest.t)}).`);
  }

  const tbr = rs.filter((r) => r.mgdl < LO).length / rs.length;
  if (tbr > TBR_LIMIT) flags.push(`Time below 70 mg/dL is ${Math.round(tbr * 100)}% (target under 4%).`);

  // Sustained highs: any run above 250 lasting at least an hour.
  let runStart = -1;
  const runs: { start: string; minutes: number; peak: number }[] = [];
  for (let i = 0; i <= rs.length; i++) {
    const above = i < rs.length && rs[i].mgdl > HIGH_SUSTAINED;
    if (above && runStart < 0) runStart = i;
    if (!above && runStart >= 0) {
      const seg = rs.slice(runStart, i);
      const minutes = seg.length * step;
      if (minutes >= HIGH_SUSTAINED_MIN) runs.push({ start: seg[0].t, minutes, peak: Math.max(...seg.map((r) => r.mgdl)) });
      runStart = -1;
    }
  }
  if (runs.length) {
    // The parenthetical reports the worst run, so over a set of one there is nothing for it to be longest
    // among: the sentence has just said "1 occasion" and "longest" over that read as a selection the
    // clinician could not make (T202). Both the noun and the superlative agree through `plural`, not
    // through a ternary written beside the sentence (T198 AC2, T199 AC4, T200 AC2) — a hand-rolled
    // agreement covers the noun it is glued to and leaves the rest of the sentence nobody's decision.
    const longest = runs.reduce((m, r) => (r.minutes > m.minutes ? r : m), runs[0]);
    const worst = `${longest.minutes} min from ${localDayTime(longest.start)}, peak ${longest.peak}`;
    flags.push(`Above ${HIGH_SUSTAINED} mg/dL for an hour or more on ${countOf(runs.length, "occasion")} (${plural(runs.length, worst, `longest ${worst}`)}).`);
  }
  return flags;
}

const MEAL_STAY_MS = 3 * 60 * 60 * 1000;

/**
 * How the matched place relates to the spike, in the words above.
 *
 * The temporal question — had the patient left, were they already there as the climb began, or did they
 * arrive during it — is lib/spikePlaces.ts's `spikeVisitRelation`, the one rule the clinician's own Place
 * column and chart caption read (T191, T192). Asking it there rather than re-deriving the predicate here
 * is what keeps the row the model is handed from disagreeing with the row the clinician reads: this
 * function used to test the sign of the gap to the visit's *end* alone, which answered "at" for a stop the
 * patient walked into ten minutes into the rise, and lib/prompts.ts then invited the model to count it as
 * a meal.
 *
 * What is sour's own is the refinement on top of `during`: a meal-length stay counts as a real association
 * even though the climb begins before the patient leaves, while a long stay (office, home) that merely
 * overlaps is weak. `arrived` gets its own word rather than either of those, because it is weak for a
 * reason neither covers — the climb had already started before the patient got there, so it cannot have
 * started with a meal there however short the stay was.
 */
function relationTo(s: Spike): SourPlaceRelation {
  const relation = spikeVisitRelation(s);
  if (!relation || !s.visit) return null;
  if (relation.kind === "after") return "after leaving";
  if (relation.kind === "arrived") return "arrived during the rise at";
  return Date.parse(s.visit.end) - Date.parse(s.visit.start) <= MEAL_STAY_MS ? "at" : "during a long stay at";
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
