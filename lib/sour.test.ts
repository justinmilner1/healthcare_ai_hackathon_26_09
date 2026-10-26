import assert from "node:assert/strict";
import test from "node:test";
import { fixture, pinUtcTimeZone } from "./fixtures";
import { detectSpikes, parseClarityCsv } from "./glucose";
import { labelVisits, parseTimeline, parseVisitsCsv } from "./location";
import { matchSpikesToVisits } from "./match";
import { parseWhoopCsv } from "./sleep";
import { buildSourInput, renderSourInput, safetyFlags, summaryTimeZone } from "./sour";
import type { GlucoseReading, Spike, Visit } from "./types";

pinUtcTimeZone();
process.env.SUMMARY_TZ = "UTC"; // every local time the model sees comes from this; pin it or the brief drifts

const glucose = () => parseClarityCsv(fixture("clarity_window.csv"));
const visits = () => labelVisits(parseTimeline(fixture("timeline_android.json")), parseVisitsCsv(fixture("visits.csv")));
const matched = () => matchSpikesToVisits(detectSpikes(glucose()), visits());
const nights = () => parseWhoopCsv(fixture("whoop_cycles.csv"));

function build(over: Partial<Parameters<typeof buildSourInput>[0]> = {}) {
  const args = {
    glucose: glucose(),
    spikes: matched(),
    sleep: nights(),
    patientNotes: "Tired in the afternoons.",
    visit: { type: "follow_up", reason: "mornings running high" },
    ...over,
  };
  // Uncapped unless a test asks for the cut: `spikeTotal` is the week's count and `spikes` the rows listed,
  // and they part company only where lib/bundle.ts slices to five (T164). An explicit `spikeTotal` in
  // `over` is already in `args` and wins.
  return buildSourInput({ spikeTotal: args.spikes.length, ...args });
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
});

test("a week of readings with nothing over 180 says so under SPIKES", () => {
  // The flat-week case, which used to be asserted on the no-readings input below: a brief with numbers in
  // it and no excursion, where "none" is a fact about the week rather than a fact about the upload.
  const flat = build({ glucose: series("2026-09-19T08:00:00Z", 5, [104, 110, 108, 112, 109, 106]), spikes: [] });
  assert.match(renderSourInput(flat), /SPIKES \(0;[^)]*\)[\s\S]*\n {2}none/);
});

// T164 (design §7.1, §2.6): the count the model is given.
//
// `PatientBundle.spikes` is cut to five for the clinician's card, and the brief used to head its table with
// the length of that cut — so a pattern citing "5 rises over 180" was citing a presentation choice. The
// header now states the week's count, and says in the same breath that the rows below it are the largest
// few, which is the only way the model can have the true figure and a short table at once.

/** A week that genuinely holds more rises than the card lists: eight crests to 210, three hours apart, so
 *  the cut to five is the product's own and the capped case is not staged by the assertion. */
const cappedWeek = () => {
  const cycle = [100, 120, 160, 200, 210, 170, 120, 100, 100, 100, 100, 100]; // 3 h at 15-minute steps
  return series("2026-09-19T00:00:00Z", 15, Array.from({ length: 8 }, () => cycle).flat());
};

test("the SPIKES header counts the week, not the rows, and says which rows those are (T164)", () => {
  const glucose = cappedWeek();
  const every = detectSpikes(glucose);
  assert.equal(every.length, 8, "the fixture's own count, so the cut below is a real one");
  const listed = every.slice(0, 5); // lib/bundle.ts' cut, as the provider page makes it
  const brief = renderSourInput(build({ glucose, spikes: listed, spikeTotal: every.length }));
  assert.match(brief, /^SPIKES \(8; top 5 by rise listed; rise ≥50 to a peak >180\)/m);
  // The understated figure is nowhere in the brief: a pattern cannot cite it if it was never stated.
  assert.doesNotMatch(brief, /^SPIKES \(5[;)]/m);
  // And the table is still the five rows, so the header discloses the cut rather than promising three more.
  assert.equal(brief.match(/^ {2}\w{3}, \w{3} \d+ \|/gm)?.length, listed.length);
});

test("a brief that lists every spike it counted heads the table as it always did (T164)", () => {
  // The common week, and the half of the change that is about nothing changing: with no cut there is no
  // subset to name, and "top 1 by rise listed" over the only rise there is would be noise.
  const all = matched();
  assert.ok(all.length > 0 && all.length <= 5, `fixture should be uncapped, got ${all.length}`);
  const brief = renderSourInput(build({ spikes: all, spikeTotal: all.length }));
  assert.match(brief, new RegExp(`^SPIKES \\(${all.length}; rise ≥50 to a peak >180\\)`, "m"));
  assert.doesNotMatch(brief, /by rise listed/);
});

// T143 (design §2.6, §7.1, §7): the brief a conversation-only run reads.
//
// Until T143 this was reachable only by a clinician pressing Generate on a visit with no glucose; the wrap
// now queues a run for every check-in (lib/sourQueue.ts `wrapQueuesSour`), so it is the brief behind the
// one-page summary Sweetie promises a patient who shared nothing to graph. Every number in it would be a
// zero — `timeInRange([])` and `averageGlucose([])` are both 0 — and the model is asked for patterns that
// cite the brief, so "TIR 0%" over an empty upload is a citable, alarming figure about nothing.
test("no readings: the brief says there are none rather than printing a week of zeros", () => {
  const text = renderSourInput(build({ glucose: [], spikes: [], sleep: [], patientNotes: "Tired in the afternoons." }));
  assert.match(text, /^NO GLUCOSE: the patient shared no CGM readings/m);
  // None of the four glucose blocks, because each one would be made of those zeros.
  for (const heading of [/^OVERALL/m, /^BY TIME OF DAY/m, /^BY DAY/m, /^SPIKES/m]) {
    assert.doesNotMatch(text, heading, String(heading));
  }
  // And no figure anywhere that could be read as a result: no percentage, no mg/dL.
  assert.doesNotMatch(text, /\d+%/);
  assert.doesNotMatch(text, /mg\/dL/);
  // What is left is the visit and the words the summary is actually from.
  assert.match(text, /^Visit: follow_up · patient called about: mornings running high$/m);
  assert.match(text, /PATIENT'S OWN WORDS[\s\S]*Tired in the afternoons\./);
});

test("no readings but a WHOOP export: the sleep table is still the model's to read", () => {
  // A patient can share sleep and no glucose, which is one of the visits §2.5 calls optional-data-only. The
  // no-glucose block replaces the glucose tables and nothing else.
  const text = renderSourInput(build({ glucose: [], spikes: [] }));
  assert.match(text, /^NO GLUCOSE/m);
  assert.match(text, /^SLEEP \(night of\)/m);
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
