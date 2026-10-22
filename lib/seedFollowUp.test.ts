// What the seeded follow-up (lib/seedFollowUp.ts) may say about the demo's own exports.
//
// T112: the sentence this replaces was scripted beside `data/dexcom_clarity_sample.csv` and
// `data/whoop_sample.csv` rather than from them, and every figure in it was wrong — four nightly highs where
// the brief shows five spikes, Thu and Sat called late dinners when both peak in the early afternoon, a 2am
// spike that is in neither file, and 5.8h against 7.1h of sleep when the nights it named had *more* sleep
// than the rest. Nothing failed, because nothing was checking.
//
// This suite is that check, and it has two halves on purpose:
//
//   * the figures, one assertion each, with the rows they come from written beside them. A sample file edited
//     under the answer fails here, loudly and by name.
//   * a guard that holds for any week: every number in the answer has to be a reading, a clock time, a
//     recovery score, a count of the set, or the mean of some real subset of the nights. That is what stops a
//     later hand-written clause — the thing T112 was — from passing unnoticed.

import assert from "node:assert/strict";
import test from "node:test";
import { fixture, pinUtcTimeZone, sample } from "./fixtures";
import { detectSpikes, parseClarityCsv } from "./glucose";
import { labelVisits, parseTimeline, parseVisitsCsv } from "./location";
import { matchSpikesToVisits } from "./match";
import { EVENING_FROM_HOUR, OVERNIGHT_TO_HOUR, SEED_FOLLOW_UP_QUESTION, seedFollowUp, seedFollowUpAnswer } from "./seedFollowUp";
import { parseWhoopCsv } from "./sleep";
import type { SleepNight, Spike } from "./types";

pinUtcTimeZone();
process.env.SUMMARY_TZ = "UTC"; // the answer's local times come from this; pin it or the assertions drift with the box

/** The demo's spike set exactly as the provider page gets it: matched to Timeline places and cut to five
 *  (lib/bundle.ts). The seed passes `PatientBundle.spikes`, so the counts in the answer are counts of rows a
 *  clinician can see in the Spikes card; this mirrors that one line. */
const briefSpikes = (): Spike[] => {
  const glucose = parseClarityCsv(sample("dexcom_clarity_sample.csv"));
  const visits = labelVisits(parseTimeline(sample("timeline_sample.json")), parseVisitsCsv(sample("visits.csv")));
  return matchSpikesToVisits(detectSpikes(glucose), visits).slice(0, 5);
};
const demoNights = (): SleepNight[] => parseWhoopCsv(sample("whoop_sample.csv"));

const demoAnswer = () => seedFollowUpAnswer(briefSpikes(), demoNights());

test("the seeded pair is the visit's own question, answered", () => {
  const { question, answer } = seedFollowUp(briefSpikes(), demoNights());
  assert.equal(question, SEED_FOLLOW_UP_QUESTION);
  assert.ok(answer.length > 0 && answer.endsWith("."), answer);
});

test("the demo's week is the week the answer describes: five spikes, three of them after 19:00", () => {
  const spikes = briefSpikes();
  // The fixture, so the assertions below are about a known week rather than about whatever it becomes.
  assert.equal(spikes.length, 5, "lib/bundle.ts shows five spikes, which the stat tile counts");
  const peaks = spikes.map((s) => s.peak).sort();
  assert.deepEqual(
    peaks.map((p) => p.slice(0, 16)),
    ["2026-09-19T13:45", "2026-09-20T13:55", "2026-09-20T22:30", "2026-09-22T22:45", "2026-09-25T19:40"],
  );
  assert.equal(peaks.filter((p) => Number(p.slice(11, 13)) >= EVENING_FROM_HOUR).length, 3);
  assert.equal(peaks.filter((p) => Number(p.slice(11, 13)) < OVERNIGHT_TO_HOUR).length, 0);
});

test("every figure in the answer is a row of data/dexcom_clarity_sample.csv or data/whoop_sample.csv", () => {
  const answer = demoAnswer();

  // The premise of the question, answered by count: nothing peaks between 00:00 and 06:00. Earliest peak in
  // the file is 13:45.
  assert.match(answer, /^No spike on this brief peaks between 00:00 and 06:00\. Of the 5, /);

  // The three evening spikes, with the rise the Spikes table prints beside each one.
  assert.match(answer, /Of the 5, 3 peak after 19:00/);
  assert.match(answer, /Sun 22:30 \(107→214\)/); // 2026-09-20 22:30, the week's largest rise
  assert.match(answer, /Tue 22:45 \(107→210\)/); // 2026-09-22 22:45
  assert.match(answer, /Fri 19:40 \(104→194\)/); // 2026-09-25 19:40

  // The two the page also lists, as a span: Sat 13:45 (108→206) and Sun 13:55 (108→202).
  assert.match(answer, /The other 2 peak between 13:45 and 13:55/);

  // WHOOP, keyed by the evening the cycle began, which is how the Sleep chart labels its columns:
  // 09-20 5.4h, 09-22 5.9h, 09-25 7.4h -> mean 6.2; 09-19 7.1, 09-21 7.8, 09-23 6.6, 09-24 8.2 -> mean 7.4.
  assert.match(answer, /Sleep on those three nights averages 6\.2h against 7\.4h on the other four nights/);
  // Recovery on the nights of the two largest: 09-20 is 38, 09-22 is 41 — the two lowest in the file.
  assert.match(answer, /recovery 38 and 41 on the nights of the two largest/);

  // And nothing of what T112 found: no dinner anywhere, no 2am, no 5.8h.
  assert.doesNotMatch(answer, /dinner/i);
  assert.doesNotMatch(answer, /2am|02:00/);
  assert.doesNotMatch(answer, /5\.8/);
});

test("it reads as a clinician's follow-up: no diagnosis, no medication, no advice to the patient", () => {
  const answer = demoAnswer();
  assert.doesNotMatch(answer, /insulin|metformin|dose|dosage|mg\b|units?\b|prescrib/i);
  assert.doesNotMatch(answer, /diabet|diagnos|you should|you need to|recommend/i);
  // It closes on a question for the room rather than on a conclusion.
  assert.match(answer, /Worth asking what those three evenings involved/);
  // Numbers first: the first sentence is a count, not a hedge.
  assert.match(answer, /^No spike on this brief peaks between 00:00 and 06:00\./);
});

/**
 * The guard that outlives this week's numbers. Every number in the answer must be one of:
 *   - a count of the spike set or of a subset of the nights (0..n),
 *   - one of the three thresholds the module names,
 *   - an hour or a minute of some shown spike's peak, or one of its two readings,
 *   - a recovery score in the WHOOP file,
 *   - the mean, to one decimal, of some non-empty subset of the nights' hours.
 *
 * The last one is brute-forced over subsets rather than recomputed the way the module groups them, so the
 * check is independent of the grouping: it proves the hours cited are an average of real nights, and the
 * assertions above pin which nights those are.
 */
function assertEveryNumberIsInTheData(answer: string, spikes: Spike[], sleep: SleepNight[]) {
  const allowed = new Set<string>();
  for (let i = 0; i <= Math.max(spikes.length, sleep.length); i++) allowed.add(String(i));
  for (const h of [0, OVERNIGHT_TO_HOUR, EVENING_FROM_HOUR]) allowed.add(String(h).padStart(2, "0"));
  allowed.add("00"); // the minutes of every threshold
  for (const s of spikes) {
    allowed.add(String(s.from));
    allowed.add(String(s.to));
    const peak = new Date(s.peak).toISOString();
    allowed.add(peak.slice(11, 13));
    allowed.add(peak.slice(14, 16));
  }
  for (const n of sleep) if (typeof n.recovery === "number") allowed.add(String(n.recovery));

  // Every subset mean, one decimal. 2^n, so it is capped at a size no export this is used on reaches.
  assert.ok(sleep.length <= 12, "the subset-mean enumeration below is exponential");
  for (let mask = 1; mask < 1 << sleep.length; mask++) {
    const picked = sleep.filter((_, i) => mask & (1 << i));
    allowed.add(String(Math.round((picked.reduce((t, n) => t + n.hours, 0) / picked.length) * 10) / 10));
  }

  for (const token of answer.match(/\d+(?:\.\d+)?/g) ?? []) {
    assert.ok(allowed.has(token), `"${token}" in the answer is not in the data: ${answer}`);
  }
}

test("no number in the answer is one the two sample files cannot account for", () => {
  assertEveryNumberIsInTheData(demoAnswer(), briefSpikes(), demoNights());
});

test("the same holds for another week's shape: one spike, in the morning, and three nights", () => {
  const spikes = detectSpikes(parseClarityCsv(fixture("clarity_window.csv"))).slice(0, 5);
  const nights = parseWhoopCsv(fixture("whoop_cycles.csv"));
  const answer = seedFollowUpAnswer(spikes, nights);
  assert.equal(spikes.length, 1);
  // No evening spike and no overnight one, so the answer says that rather than naming a cluster.
  assert.match(answer, /^No spike on this brief peaks between 00:00 and 06:00, or after 19:00: /);
  assert.match(answer, /the one spike is a daytime excursion, at 08:00\./);
  // And no sleep comparison: there is no named evening to compare against.
  assert.doesNotMatch(answer, /Sleep on those/);
  assertEveryNumberIsInTheData(answer, spikes, nights);
});

test("a week with nothing in it says so, with no stray number and no NaN", () => {
  const answer = seedFollowUpAnswer([], demoNights());
  assert.equal(answer, "No spike over 180 in this week's readings, overnight or otherwise.");
  assert.doesNotMatch(answer, /NaN|undefined|null/);
});

test("no WHOOP file drops the sleep sentence rather than guessing at it", () => {
  const answer = seedFollowUpAnswer(briefSpikes(), []);
  assert.doesNotMatch(answer, /Sleep|recovery|NaN|undefined/);
  assert.match(answer, /Of the 5, 3 peak after 19:00/);
  assert.match(answer, /Worth asking what those three evenings involved/);
});

test("a night with no matching spike date leaves the comparison unsaid rather than inverted", () => {
  // Spikes in one week, WHOOP rows in another: no night is "one of those nights", so there is nothing to
  // compare and the sentence does not appear.
  const answer = seedFollowUpAnswer(briefSpikes(), [{ date: "2025-01-01", hours: 5, recovery: 30 }]);
  assert.doesNotMatch(answer, /Sleep on those/);
});

test("the span of the spikes not named is taken on the clock, not in chronological order", () => {
  // Two evening spikes to name, then two daytime ones whose later day peaks the earlier hour. Read
  // chronologically the span would print "between 15:25 and 13:45".
  const spikes: Spike[] = [
    { start: "2026-09-20T21:25:00.000Z", peak: "2026-09-20T22:30:00.000Z", from: 107, to: 214 },
    { start: "2026-09-21T14:00:00.000Z", peak: "2026-09-21T15:25:00.000Z", from: 110, to: 199 },
    { start: "2026-09-22T12:40:00.000Z", peak: "2026-09-22T13:45:00.000Z", from: 108, to: 206 },
    { start: "2026-09-22T21:50:00.000Z", peak: "2026-09-22T22:45:00.000Z", from: 107, to: 210 },
  ];
  assert.match(seedFollowUpAnswer(spikes, []), /The other 2 peak between 13:45 and 15:25\./);
});

test("an overnight week is described as one: the question's premise holds and is answered by name", () => {
  const spikes: Spike[] = [
    { start: "2026-09-20T01:10:00.000Z", peak: "2026-09-20T02:20:00.000Z", from: 109, to: 212 },
    { start: "2026-09-21T13:00:00.000Z", peak: "2026-09-21T14:10:00.000Z", from: 104, to: 193 },
  ];
  const nights: SleepNight[] = [
    { date: "2026-09-20", hours: 5.2, recovery: 35 },
    { date: "2026-09-21", hours: 7.6, recovery: 80 },
  ];
  const answer = seedFollowUpAnswer(spikes, nights);
  assert.match(answer, /^1 of the 2 spikes on this brief peaks before 06:00 — Sun 02:20 \(109→212\)\./);
  assert.match(answer, /The other 1 peaks at 14:10\./);
  // One night each side, so the comparison is still made, in the singular: 09-20 is 5.2h, 09-21 is 7.6h.
  assert.match(answer, /Sleep that night is 5\.2h against 7\.6h on the other night, with recovery 35 and 80/);
  assert.match(answer, /Worth asking what the evening before that night involved\./);
  assert.doesNotMatch(answer, /nothing this week is overnight/);
  assertEveryNumberIsInTheData(answer, spikes, nights);
});
