import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./fixtures";
import { parseClarityCsv, detectSpikes } from "./glucose";
import { labelVisits, parseTimeline, parseVisitsCsv } from "./location";
import { matchSpikesToVisits } from "./match";
import type { Spike, Visit } from "./types";

const place = (name: string, start: string, end: string): Visit => ({ start, end, place: name, lat: 37.77, lng: -122.41 });
const spike = (start: string, peak: string): Spike => ({ start, peak, from: 100, to: 210 });

test("a visit that ended within 30 minutes before the spike matches", () => {
  const s = spike("2026-09-19T12:30:00Z", "2026-09-19T13:15:00Z");
  const [matched] = matchSpikesToVisits([s], [place("Lunch", "2026-09-19T11:50:00Z", "2026-09-19T12:05:00Z")]);
  assert.equal(matched.visit?.place, "Lunch");
});

test("a visit that ended more than 30 minutes before does not match", () => {
  const s = spike("2026-09-19T12:30:00Z", "2026-09-19T13:15:00Z");
  const [matched] = matchSpikesToVisits([s], [place("Earlier", "2026-09-19T11:30:00Z", "2026-09-19T11:55:00Z")]);
  assert.equal(matched.visit, undefined);
  assert.deepEqual(matched, s); // the spike comes back untouched, not reshaped
});

test("a visit overlapping the climb matches", () => {
  const s = spike("2026-09-19T12:30:00Z", "2026-09-19T13:15:00Z");
  const [during] = matchSpikesToVisits([s], [place("Still there", "2026-09-19T12:00:00Z", "2026-09-19T13:00:00Z")]);
  assert.equal(during.visit?.place, "Still there");
  // A visit that starts after the peak is not an overlap.
  const [after] = matchSpikesToVisits([s], [place("Later", "2026-09-19T13:30:00Z", "2026-09-19T14:00:00Z")]);
  assert.equal(after.visit, undefined);
});

test("the closest qualifying visit wins, and an overlap beats a gap", () => {
  const s = spike("2026-09-19T12:30:00Z", "2026-09-19T13:15:00Z");
  const candidates = [
    place("29 minutes before", "2026-09-19T11:30:00Z", "2026-09-19T12:01:00Z"),
    place("5 minutes before", "2026-09-19T12:10:00Z", "2026-09-19T12:25:00Z"),
  ];
  assert.equal(matchSpikesToVisits([s], candidates)[0].visit?.place, "5 minutes before");
  const withOverlap = [...candidates, place("Overlapping", "2026-09-19T12:20:00Z", "2026-09-19T12:40:00Z")];
  assert.equal(matchSpikesToVisits([s], withOverlap)[0].visit?.place, "Overlapping");
});

test("no visits means every spike comes back unmatched, in order", () => {
  const spikes = [spike("2026-09-19T08:00:00Z", "2026-09-19T08:45:00Z"), spike("2026-09-19T12:30:00Z", "2026-09-19T13:15:00Z")];
  assert.deepEqual(matchSpikesToVisits(spikes, []), spikes);
  assert.deepEqual(matchSpikesToVisits([], [place("Lunch", "2026-09-19T12:00:00Z", "2026-09-19T12:30:00Z")]), []);
});

test("the fixtures match the breakfast spike to the cafe the patient had just left", () => {
  const spikes = detectSpikes(parseClarityCsv(fixture("clarity_window.csv")));
  const visits = labelVisits(parseTimeline(fixture("timeline_android.json")), parseVisitsCsv(fixture("visits.csv")));
  const matched = matchSpikesToVisits(spikes, visits);
  assert.equal(matched.length, 1);
  // The cafe visit ends 06:50, the climb starts 07:00: ten minutes, inside the 30-minute window.
  assert.equal(matched[0].visit?.place, "Fixture Cafe");
  assert.equal(matched[0].visit?.end, "2026-09-19T06:50:00.000Z");
});
