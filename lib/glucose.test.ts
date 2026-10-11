import assert from "node:assert/strict";
import test from "node:test";
import { fixture, useUtc } from "./fixtures";
import { averageGlucose, detectSpikes, downsample, parseClarityCsv, timeInRange } from "./glucose";
import type { GlucoseReading } from "./types";

useUtc(); // the Clarity fixtures carry device-local timestamps with no offset

/** Readings every `stepMin` minutes from `startIso`. Keeps the spike cases readable. */
function series(startIso: string, stepMin: number, values: number[]): GlucoseReading[] {
  const t0 = Date.parse(startIso);
  return values.map((mgdl, i) => ({ t: new Date(t0 + i * stepMin * 60_000).toISOString(), mgdl }));
}

test("Clarity parsing keeps EGV rows and drops everything else", () => {
  const readings = parseClarityCsv(fixture("clarity_edge_cases.csv"));
  // The fixture holds, in this order: two rows out of order, Clarity's Low and High sentinels, a Calibration
  // row, an Insulin row, a row with no value, an unparseable timestamp, a non-numeric value, one more EGV.
  assert.deepEqual(readings, [
    { t: "2026-09-21T08:00:00.000Z", mgdl: 118 },
    { t: "2026-09-21T08:05:00.000Z", mgdl: 40 }, // "Low"
    { t: "2026-09-21T08:10:00.000Z", mgdl: 131 }, // row whose Device Info is a quoted field holding a comma
    { t: "2026-09-21T08:15:00.000Z", mgdl: 400 }, // "High"
    { t: "2026-09-21T08:40:00.000Z", mgdl: 127 },
  ]);
});

test("Clarity parsing returns nothing it cannot understand", () => {
  assert.deepEqual(parseClarityCsv(""), []);
  assert.deepEqual(parseClarityCsv("\n  \n"), []);
  const headerOnly = fixture("clarity_edge_cases.csv").split("\n")[0];
  assert.deepEqual(parseClarityCsv(headerOnly), []);
  assert.deepEqual(parseClarityCsv("a,b,c\n1,2,3"), []); // no timestamp or glucose column
});

test("the window fixture parses to one sorted week-day of readings", () => {
  const readings = parseClarityCsv(fixture("clarity_window.csv"));
  assert.equal(readings.length, 84);
  assert.deepEqual(readings[0], { t: "2026-09-19T06:00:00.000Z", mgdl: 102 });
  assert.deepEqual(readings.at(-1), { t: "2026-09-19T12:55:00.000Z", mgdl: 101 });
  const sorted = [...readings].sort((a, b) => a.t.localeCompare(b.t));
  assert.deepEqual(readings, sorted);
});

test("time in range counts 70 and 180 as in range", () => {
  assert.equal(timeInRange([]), 0);
  assert.equal(timeInRange(series("2026-09-19T00:00:00Z", 5, [70, 180, 69, 181])), 0.5);
  assert.equal(timeInRange(series("2026-09-19T00:00:00Z", 5, [100, 100])), 1);
  assert.equal(timeInRange(parseClarityCsv(fixture("clarity_window.csv"))), 64 / 84);
});

test("average glucose rounds to whole mg/dL", () => {
  assert.equal(averageGlucose([]), 0);
  assert.equal(averageGlucose(series("2026-09-19T00:00:00Z", 5, [100, 101])), 101); // 100.5 rounds up
  assert.equal(averageGlucose(parseClarityCsv(fixture("clarity_window.csv"))), 117);
});

test("a spike needs a 50 mg/dL rise and a peak above 180", () => {
  // Rise of 60 but the peak only reaches 180, which the spec excludes.
  assert.deepEqual(detectSpikes(series("2026-09-19T08:00:00Z", 5, [120, 150, 170, 180, 160, 140])), []);
  // Peak well above 180 but the climb from the trough is only 40.
  assert.deepEqual(detectSpikes(series("2026-09-19T08:00:00Z", 5, [170, 185, 200, 210, 190, 175])), []);
  // Both conditions met.
  const [spike] = detectSpikes(series("2026-09-19T08:00:00Z", 5, [120, 150, 190, 210, 180, 150]));
  assert.deepEqual(spike, { start: "2026-09-19T08:00:00.000Z", peak: "2026-09-19T08:15:00.000Z", from: 120, to: 210 });
});

test("the reported peak is the true crest, even past the two-hour window", () => {
  // Climbs to 187 inside the window and keeps going to 214 half an hour later: the day's max is what the
  // clinician sees, not the window's edge.
  const values = [100, 110, 125, 140, 152, 163, 170, 175, 178, 180, 182, 184, 185, 186, 187];
  const past = [195, 205, 210, 212, 214, 200, 180, 160, 140];
  const [spike] = detectSpikes(series("2026-09-19T08:00:00Z", 10, [...values, ...past]));
  assert.equal(spike.from, 100);
  assert.equal(spike.to, 214);
  assert.equal(spike.peak, "2026-09-19T11:10:00.000Z"); // the 20th reading, 10 min apart
});

test("spikes closer than an hour merge and keep the bigger peak", () => {
  // Two climbs 30 minutes apart. One spike comes out, carrying the later, higher crest.
  const spikes = detectSpikes(series("2026-09-19T08:00:00Z", 5, [100, 140, 190, 200, 160, 130, 120, 170, 215, 230, 190, 150]));
  assert.equal(spikes.length, 1);
  assert.equal(spikes[0].from, 100);
  assert.equal(spikes[0].to, 230);
  assert.equal(spikes[0].start, "2026-09-19T08:00:00.000Z");
  assert.equal(spikes[0].peak, "2026-09-19T08:45:00.000Z");
});

test("spikes come back largest rise first", () => {
  // Three separated climbs, deliberately out of size order in time.
  const flat = Array<number>(20).fill(100);
  const climb = (peak: number) => [130, 180, peak, 180, 130];
  const values = [...flat, ...climb(200), ...flat, ...climb(260), ...flat, ...climb(230), ...flat];
  const spikes = detectSpikes(series("2026-09-19T00:00:00Z", 5, values));
  assert.deepEqual(
    spikes.map((s) => s.to),
    [260, 230, 200],
  );
});

test("the window fixture yields exactly the breakfast spike", () => {
  const spikes = detectSpikes(parseClarityCsv(fixture("clarity_window.csv")));
  assert.deepEqual(spikes, [
    { start: "2026-09-19T07:00:00.000Z", peak: "2026-09-19T08:00:00.000Z", from: 96, to: 214 },
  ]);
});

test("downsampling keeps the first point and never grows the series", () => {
  const small = series("2026-09-19T00:00:00Z", 5, Array<number>(10).fill(100));
  assert.equal(downsample(small, 600), small);
  const big = series("2026-09-19T00:00:00Z", 5, Array.from({ length: 1000 }, (_, i) => 100 + (i % 7)));
  const thin = downsample(big, 600);
  assert.equal(thin.length, 500); // step 2
  assert.deepEqual(thin[0], big[0]);
  assert.deepEqual(thin[1], big[2]);
});
