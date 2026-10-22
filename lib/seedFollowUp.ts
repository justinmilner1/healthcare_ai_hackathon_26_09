// The one answered follow-up `npm run seed` puts on the demo visit (design §7.5). Owner: Justin (Sour).
//
// §7.5 asks for the Discuss-with-Sour panel to be a log: a question, the answer beside it, the clinician and
// the time. A freshly seeded demo has nothing in it, so the seed writes one answered pair — and because
// lib/llm.ts has no key in a demo (§6.3, §11.3), that answer cannot come from a model. It is scripted, like
// the offline summaries: nothing in a seeded demo is a model's work or a real patient's.
//
// Scripted is not the same as invented, and T112 is what the difference costs. The sentence this module
// replaces was written beside the fixtures rather than from them, and every number in it was wrong: it
// counted four nightly highs where the brief shows five spikes with three of them after 19:00, named Thu and
// Sat as late dinners where both peak in the early afternoon, cited a 2am spike that is in neither sample
// file, and compared 5.8h of sleep against 7.1h when the nights it named had *more* sleep than the rest. It
// sat six lines under "Patterns: Not generated." on the provider's brief, which made the one specific
// clinical claim on the page the one thing nothing had derived — against §7's "patterns must cite data" and
// against the Spikes and Sleep cards immediately above it.
//
// So the answer is generated here, from the same two arrays the page draws those cards from: the spikes the
// brief shows (`PatientBundle.spikes` — matched to places and cut to the five the stat tile counts) and the
// WHOOP nights (`PatientBundle.sleep`). A change to `data/dexcom_clarity_sample.csv` or
// `data/whoop_sample.csv` moves the sentence with it, and lib/seedFollowUp.test.ts fails if any figure in it
// stops being traceable to those files.
//
// Pure: no database, no filesystem, no model, so the test states the rule without a Postgres.
// Only scripts/seed.ts calls it in anger; nothing under app/ imports it.
//
// Two conventions worth stating, because they are what makes the answer checkable against the screen:
//   * Times are 24-hour and the weekday is `en-GB`, pinned rather than taken from the box's locale, so the
//     seeded row reads the same in every demo. The Spikes table formats the same instants with the viewer's
//     locale ("Sun 10:30 PM"); "Sun 22:30" here is the same reading, and a clinician reading one beside the
//     other has no arithmetic to do.
//   * Everything is in the summary zone (lib/sour.ts `summaryTimeZone`), which is the zone the rest of the
//     brief is rendered in.

import { localDate, summaryTimeZone } from "./sour";
import type { SleepNight, Spike } from "./types";

/** The clinician's question on the seeded row. It is the visit's own reason ("my numbers keep going high
 *  overnight and I don't know why") asked as a clinician would ask it, which is why the answer below is
 *  allowed to disagree with its premise: that disagreement is the demo's point. */
export const SEED_FOLLOW_UP_QUESTION = "What is driving the overnight highs?";

/** A peak at or after this local hour is an evening spike. 19:00 rather than 20:00 because that is where the
 *  sample week's own cluster starts (19:40, 22:30, 22:45) and because §7's `byTimeOfDay` already calls 18-24
 *  "evening"; this is the narrower half of it, the part a late meal sits in. */
export const EVENING_FROM_HOUR = 19;

/** A peak before this local hour is an overnight high — the thing the question asks about. Matches the
 *  "overnight 00-06" window lib/sour.ts hands the model. */
export const OVERNIGHT_TO_HOUR = 6;

export type SeedFollowUp = { question: string; answer: string };

/**
 * The seeded pair, derived from what the brief shows.
 *
 * `spikes` is the brief's own set (`PatientBundle.spikes`), so a count in the answer is a count of rows the
 * reader can see in the Spikes card. `sleep` is `PatientBundle.sleep`, whose `date` is the evening the WHOOP
 * cycle began — the same key the Sleep chart labels its columns by, so "those 3 evenings" names three bars.
 *
 * Every sentence is conditional on having the data for it: a week with no spikes, no evening spikes or no
 * WHOOP file says less rather than saying something untrue. Terse, numbers first, no diagnosis and no
 * medication advice (§7, AGENTS.md "The two agents").
 */
export function seedFollowUp(spikes: Spike[], sleep: SleepNight[]): SeedFollowUp {
  return { question: SEED_FOLLOW_UP_QUESTION, answer: seedFollowUpAnswer(spikes, sleep) };
}

export function seedFollowUpAnswer(spikes: Spike[], sleep: SleepNight[]): string {
  if (spikes.length === 0) return "No spike over 180 in this week's readings, overnight or otherwise.";

  const byTime = [...spikes].sort((a, b) => a.peak.localeCompare(b.peak));
  const evening = byTime.filter((s) => localHour(s.peak) >= EVENING_FROM_HOUR);
  const overnight = byTime.filter((s) => localHour(s.peak) < OVERNIGHT_TO_HOUR);
  const rest = byTime.filter((s) => !evening.includes(s) && !overnight.includes(s));

  const sentences: string[] = [];

  // Where the highs actually are. The question's premise is answered first, by count.
  const set = `${spikes.length} ${spikes.length === 1 ? "spike" : "spikes"} on this brief`;
  // Spikes, and only spikes: the claim is about the set in the Spikes card, not about every reading in the
  // week, so "no spike peaks overnight" is as far as it goes. The close below is what puts the question's
  // premise to the clinician.
  const none = `No spike on this brief peaks between ${hour(0)} and ${hour(OVERNIGHT_TO_HOUR)}`;
  if (overnight.length > 0) {
    sentences.push(`${overnight.length} of the ${set} ${verb(overnight.length)} before ${hour(OVERNIGHT_TO_HOUR)} — ${overnight.map(spikeRef).join(", ")}.`);
  } else if (evening.length > 0) {
    sentences.push(
      `${none}. Of the ${spikes.length}, ${evening.length} ${verb(evening.length)} after ${hour(EVENING_FROM_HOUR)} — ${evening.map(spikeRef).join(", ")}.`,
    );
  } else {
    sentences.push(
      `${none}, or after ${hour(EVENING_FROM_HOUR)}: ` +
        `${byTime.length === 1 ? "the one spike is a daytime excursion" : `all ${count(byTime.length)} are daytime excursions`}, ${timeSpan(byTime)}.`,
    );
  }

  // The rest of the set, as a span rather than a list: five rows of detail is the table's job, not this box's.
  if (rest.length > 0 && (overnight.length > 0 || evening.length > 0)) {
    sentences.push(`The other ${rest.length} ${verb(rest.length)} ${timeSpan(rest)}.`);
  }

  // Sleep, keyed to the evenings just named. Only said when both halves of the comparison exist.
  const named = overnight.length > 0 ? overnight : evening;
  const sleepSentence = sleepLine(named, sleep, spikes);
  if (sleepSentence) sentences.push(sleepSentence);

  // The close: what to ask next. Flag, do not prescribe (§7). Which evening it points at depends on which
  // cluster was named — an overnight high is asked about through the evening before it, an evening spike
  // through the evening it is in.
  if (overnight.length === 1) {
    sentences.push("Worth asking what the evening before that night involved.");
  } else if (overnight.length > 1) {
    sentences.push(`Worth asking what the evening before each of those ${count(overnight.length)} nights involved.`);
  } else if (evening.length === 1) {
    sentences.push("Worth asking what that evening involved before treating this as overnight.");
  } else if (evening.length > 1) {
    sentences.push(`Worth asking what those ${count(evening.length)} evenings involved before treating this as overnight.`);
  }

  return sentences.join(" ");
}

/** "Sun 22:30 (107→214)" — the weekday and time of the peak, and the rise as the Spikes table writes it. */
function spikeRef(s: Spike): string {
  return `${weekday(s.peak)} ${hhmm(s.peak)} (${s.from}→${s.to})`;
}

/** "at 13:45", or "between 13:45 and 13:55" once there is more than one.
 *
 *  Sorted by the time on the clock rather than by the instant: the spikes being spanned are on different
 *  days, so the earliest instant of them is not the earliest hour, and taking the ends in chronological
 *  order produced "between 15:25 and 13:45" the moment a later day peaked earlier. */
function timeSpan(spikes: Spike[]): string {
  const times = spikes.map((s) => hhmm(s.peak)).sort();
  if (times.length === 1) return `at ${times[0]}`;
  return `between ${times[0]} and ${times[times.length - 1]}`;
}

/** "peaks" for one spike, "peak" for several — the subject is the spikes, not the count. */
const verb = (n: number) => (n === 1 ? "peaks" : "peak");

/**
 * The sleep comparison: hours on the nights of the named spikes against hours on the rest of the week, plus
 * the recovery scores of the two biggest spikes' nights.
 *
 * Returns "" rather than a half sentence when the WHOOP file cannot support it — no rows, no night matching a
 * named evening, or nothing left to compare against.
 */
function sleepLine(named: Spike[], sleep: SleepNight[], shown: Spike[]): string {
  if (sleep.length === 0 || named.length === 0) return "";
  const nightOf = new Map(sleep.map((n) => [n.date, n] as const));
  const namedDates = new Set(named.map((s) => localDate(s.peak)));
  const on = sleep.filter((n) => namedDates.has(n.date));
  const off = sleep.filter((n) => !namedDates.has(n.date));
  if (on.length === 0 || off.length === 0) return "";

  const onPart = on.length === 1 ? `Sleep that night is ${on[0].hours}h` : `Sleep on those ${count(on.length)} nights averages ${mean(on)}h`;
  const offPart = off.length === 1 ? `${mean(off)}h on the other night` : `${mean(off)}h on the other ${count(off.length)} nights`;
  let line = `${onPart} against ${offPart}`;

  // The two largest spikes by rise, which is the order the brief itself lists them in (lib/glucose.ts).
  const biggest = [...shown].sort((a, b) => b.to - b.from - (a.to - a.from)).slice(0, 2);
  const recoveries = biggest
    .map((s) => nightOf.get(localDate(s.peak))?.recovery)
    .filter((r): r is number => typeof r === "number");
  if (recoveries.length === 2) line += `, with recovery ${recoveries[0]} and ${recoveries[1]} on the nights of the two largest`;
  return `${line}.`;
}

/** Mean hours asleep, to one decimal — the precision the WHOOP rows themselves carry. */
const mean = (nights: SleepNight[]) => Math.round((nights.reduce((t, n) => t + n.hours, 0) / nights.length) * 10) / 10;

/** Small counts read better as words in a sentence; the figures that matter stay digits. */
const count = (n: number) => (["zero", "one", "two", "three", "four", "five", "six", "seven"][n] ?? String(n));

/** "19:00" for an hour of the clock, so the thresholds are written the way the instants are. */
const hour = (h: number) => `${String(h).padStart(2, "0")}:00`;

const zone = () => summaryTimeZone();

/** 24-hour local time, locale-pinned: a seeded demo should read the same on every box (see the header). */
const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { timeZone: zone(), hour: "2-digit", minute: "2-digit", hour12: false });

const weekday = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { timeZone: zone(), weekday: "short" });

const localHour = (iso: string) => Number(hhmm(iso).slice(0, 2));
