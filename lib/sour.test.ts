import assert from "node:assert/strict";
import test from "node:test";
import { fixture, useUtc } from "./fixtures";
import { detectSpikes, parseClarityCsv } from "./glucose";
import { labelVisits, parseTimeline, parseVisitsCsv } from "./location";
import { matchSpikesToVisits } from "./match";
import { parseWhoopCsv } from "./sleep";
import { buildSourInput, renderSourInput, safetyFlags, summaryTimeZone } from "./sour";
import type { GlucoseReading, Spike, Visit } from "./types";

useUtc();
process.env.SUMMARY_TZ = "UTC"; // every local time the model sees comes from this; pin it or the brief drifts

const glucose = () => parseClarityCsv(fixture("clarity_window.csv"));
const visits = () => labelVisits(parseTimeline(fixture("timeline_android.json")), parseVisitsCsv(fixture("visits.csv")));
const matched = () => matchSpikesToVisits(detectSpikes(glucose()), visits());
const nights = () => parseWhoopCsv(fixture("whoop_cycles.csv"));

function build(over: Partial<Parameters<typeof buildSourInput>[0]> = {}) {
  return buildSourInput({
    glucose: glucose(),
    spikes: matched(),
    sleep: nights(),
    patientNotes: "Tired in the afternoons.",
    visit: { type: "follow_up", reason: "mornings running high" },
    ...over,
  });
}

function series(startIso: string, stepMin: number, values: number[]): GlucoseReading[] {
  const t0 = Date.parse(startIso);
  return values.map((mgdl, i) => ({ t: new Date(t0 + i * stepMin * 60_000).toISOString(), mgdl }));
}

const place = (name: string, start: string, end: string): Visit => ({ start, end, place: name, lat: 37.77, lng: -122.41 });

test("the overall block is computed, not estimated", () => {
  const x = build();
  assert.deepEqual(x.overall, {
    days: 1,
    readings: 84,
    tir: 0.762,
    tbr: 0.107,
    tar: 0.131,
    avg: 117,
    gmi: 6.1, // 3.31 + 0.02392 * 117
  });
  assert.equal(x.timeZone, "UTC");
  assert.deepEqual(x.visit, { type: "follow_up", reason: "mornings running high" });
  assert.equal(x.patientNotes, "Tired in the afternoons.");
});

test("an empty week does not divide by zero", () => {
  const x = build({ glucose: [], spikes: [], sleep: [] });
  assert.deepEqual(x.overall, { days: 0, readings: 0, tir: 0, tbr: 0, tar: 0, avg: 0, gmi: 0 });
  assert.deepEqual(x.days, []);
  assert.deepEqual(x.spikes, []);
  assert.match(renderSourInput(x), /SPIKES \(0;[^)]*\)[\s\S]*\n {2}none/);
});

test("day rows carry the day's crest and its minutes out of range", () => {
  const [day] = build().days;
  assert.equal(day.date, "2026-09-19");
  assert.equal(day.weekday, "Sat");
  assert.equal(day.readings, 84);
  assert.equal(day.max, 214);
  assert.match(day.maxAt, /\b0?8:00/); // 5-minute cadence, so 11 readings above 180 and 9 below 70
  assert.equal(day.min, 48);
  assert.equal(day.minutesAbove180, 55);
  assert.equal(day.minutesBelow70, 45);
});

test("the summary zone decides which calendar day a reading belongs to", () => {
  // 06:00 UTC on the 19th is still the evening of the 18th in California.
  process.env.SUMMARY_TZ = "America/Los_Angeles";
  try {
    assert.equal(summaryTimeZone(), "America/Los_Angeles");
    const dates = build().days.map((d) => d.date);
    assert.deepEqual(dates, ["2026-09-18", "2026-09-19"]);
  } finally {
    process.env.SUMMARY_TZ = "UTC";
  }
  assert.deepEqual(
    build().days.map((d) => d.date),
    ["2026-09-19"],
  );
});

test("time-of-day windows split the day and cover it once", () => {
  const x = build();
  assert.deepEqual(
    x.byTimeOfDay.map((w) => w.window),
    ["overnight 00-06", "morning 06-11", "midday 11-15", "afternoon 15-18", "evening 18-24"],
  );
  assert.equal(
    x.byTimeOfDay.reduce((n, w) => n + w.readings, 0),
    x.overall.readings,
  );
  const morning = x.byTimeOfDay.find((w) => w.window === "morning 06-11")!;
  assert.deepEqual(morning, { window: "morning 06-11", tir: 0.767, avg: 129, readings: 60 });
});

test("a spike row says where the patient was and for how long it stayed high", () => {
  const [s] = build().spikes;
  assert.equal(s.from, 96);
  assert.equal(s.to, 214);
  assert.equal(s.rise, 118);
  assert.equal(s.minutesAbove180, 55);
  assert.equal(s.after, "Fixture Cafe");
  assert.equal(s.placeRelation, "after leaving");
  assert.match(s.placeLeftAt!, /\b0?6:50/);
  assert.match(s.placeArrivedAt!, /\b0?6:10/);
});

test("a meal-length stay is an association; an all-day stay is only a weak one", () => {
  const spike: Spike = { start: "2026-09-19T12:30:00Z", peak: "2026-09-19T13:15:00Z", from: 100, to: 210 };
  const meal = { ...spike, visit: place("Fixture Taqueria", "2026-09-19T12:15:00Z", "2026-09-19T13:00:00Z") };
  const allDay = { ...spike, visit: place("Fixture Office", "2026-09-19T09:00:00Z", "2026-09-19T17:00:00Z") };
  assert.equal(build({ spikes: [meal] }).spikes[0].placeRelation, "at");
  assert.equal(build({ spikes: [allDay] }).spikes[0].placeRelation, "during a long stay at");
  assert.equal(build({ spikes: [spike] }).spikes[0].placeRelation, null);
  assert.equal(build({ spikes: [spike] }).spikes[0].after, null);
  const rendered = renderSourInput(build({ spikes: [spike] }));
  assert.match(rendered, /no visit within 30 min/);
  assert.match(renderSourInput(build({ spikes: [allDay] })), /during a long stay at Fixture Office .*weak association/);
});

test("nights are labelled by the evening before, and a late dinner out is named", () => {
  // WHOOP dates a cycle by the morning it ended; the clinician thinks in evenings.
  const pizzeria = visits().find((v) => v.place === "Fixture Pizzeria")!;
  const dinnerSpike: Spike = { start: "2026-09-19T20:50:00Z", peak: "2026-09-19T21:40:00Z", from: 110, to: 225, visit: pizzeria };
  const x = build({ spikes: [dinnerSpike] });
  assert.deepEqual(
    x.nights.map((n) => n.nightOf),
    ["2026-09-18", "2026-09-19", "2026-09-20"],
  );
  assert.equal(x.nights[1].weekday, "Sat");
  assert.equal(x.nights[1].hours, 5.3); // the short night, 318 min
  assert.equal(x.nights[1].recovery, 41);
  assert.match(x.nights[1].lateDinnerBefore!, /^Fixture Pizzeria until \b0?8:40/);
  assert.equal(x.nights[0].lateDinnerBefore, null);
  // The cafe visit ends in the morning, so it is never a dinner.
  assert.equal(build().nights.every((n) => n.lateDinnerBefore === null), true);
});

test("the rendered brief is a table the model can cite, with no raw readings in it", () => {
  const text = renderSourInput(build());
  for (const heading of ["OVERALL", "BY TIME OF DAY", "BY DAY", "SPIKES", "SLEEP", "SAFETY FLAGS", "PATIENT'S OWN WORDS"]) {
    assert.ok(text.includes(heading), `missing ${heading}`);
  }
  assert.match(text, /All times are local \(UTC\)\./);
  assert.match(text, /TIR 76% · below 70: 11% · above 180: 13% · mean 117 mg\/dL · GMI 6\.1%/);
  assert.match(text, /after leaving Fixture Cafe at \b0?6:50/);
  assert.match(text, /Tired in the afternoons\./);
  // One line per day and per spike, not one per reading.
  assert.ok(text.split("\n").length < 40, "the brief should stay compact");
});

test("a brief with no notes says so rather than leaving a blank", () => {
  assert.match(renderSourInput(build({ patientNotes: "   " })), /\(nothing recorded\)/);
  const noSleep = renderSourInput(build({ sleep: [] }));
  assert.equal(noSleep.includes("SLEEP"), false);
});

test("safety flags fire on a level 2 low, on time below range, and on a sustained high", () => {
  const flags = safetyFlags(glucose());
  assert.equal(flags.length, 2);
  assert.match(flags[0], /^Glucose below 54 mg\/dL on 1 day \(20 min total; lowest 48 at/);
  assert.equal(flags[1], "Time below 70 mg/dL is 11% (target under 4%).");
  const sustained = safetyFlags(parseClarityCsv(fixture("clarity_sustained_high.csv")));
  assert.equal(sustained.length, 1);
  assert.match(sustained[0], /^Above 250 mg\/dL for an hour or more on 1 occasion \(longest 100 min from Sun, Sep 20, \b0?7:35 PM, peak 291\)\.$/);
});

test("safety flags stay quiet when there is nothing to flag", () => {
  assert.deepEqual(safetyFlags([]), []);
  assert.deepEqual(safetyFlags(series("2026-09-19T08:00:00Z", 5, [95, 110, 140, 175, 120, 90])), []);
  // 54 is not below 54, and a single reading below 70 in 30 is 3.3%, under the 4% limit.
  const oneLow = [...Array<number>(29).fill(120), 54];
  assert.deepEqual(safetyFlags(series("2026-09-19T08:00:00Z", 5, oneLow)), []);
  // Above 250 for 45 minutes is not "an hour or more".
  const shortHigh = [160, 200, ...Array<number>(9).fill(270), 200, 160];
  assert.deepEqual(safetyFlags(series("2026-09-19T08:00:00Z", 5, shortHigh)), []);
});

test("safety flags are computed from the readings whatever order they arrive in", () => {
  const forwards = glucose();
  const backwards = [...forwards].reverse();
  assert.deepEqual(safetyFlags(backwards), safetyFlags(forwards));
});
