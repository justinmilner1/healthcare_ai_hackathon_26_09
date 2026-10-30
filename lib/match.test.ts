import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./fixtures";
import { parseClarityCsv, detectSpikes } from "./glucose";
import { labelVisits, parseTimeline, parseVisitsCsv } from "./location";
import { matchSpikesToVisits } from "./match";
import { spikeVisitRelation } from "./spikePlaces";
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

test("a visit that began after the climb did still overlaps it, to the peak (T192)", () => {
  // The half of `overlaps` the matcher has always accepted and nothing used to name: the patient walked in
  // while their glucose was already going up. Both ends of the window the predicate allows — one minute
  // into the climb, and the peak itself, 45 minutes in — and one minute past it.
  const s = spike("2026-09-19T12:30:00Z", "2026-09-19T13:15:00Z");
  const match = (start: string, end: string) => matchSpikesToVisits([s], [place("Arrived mid-rise", start, end)])[0].visit?.place;
  assert.equal(match("2026-09-19T12:31:00Z", "2026-09-19T14:00:00Z"), "Arrived mid-rise");
  assert.equal(match("2026-09-19T13:15:00Z", "2026-09-19T14:00:00Z"), "Arrived mid-rise");
  assert.equal(match("2026-09-19T13:16:00Z", "2026-09-19T14:00:00Z"), undefined);
  // And the matcher keeps saying nothing about which of the two it is: the field is a place, and
  // lib/spikePlaces.ts `spikeVisitRelation` is the rule that reads it as a story (T191, T192).
  const [matched] = matchSpikesToVisits([s], [place("Arrived mid-rise", "2026-09-19T12:40:00Z", "2026-09-19T14:00:00Z")]);
  assert.deepEqual(spikeVisitRelation(matched), { kind: "arrived", gapMin: 10 });
});

test("an overlap beating a gap can be the stop the patient had not reached yet (T192)", () => {
  // Why the distinction is not pathological: every overlap scores gap 0, so an overlap outranks a visit
  // the patient genuinely had just left, even when the overlap began after the climb was under way.
  const s = spike("2026-09-19T12:30:00Z", "2026-09-19T13:15:00Z");
  const candidates = [place("Left 5 min before", "2026-09-19T12:10:00Z", "2026-09-19T12:25:00Z"), place("Arrived later", "2026-09-19T12:45:00Z", "2026-09-19T15:00:00Z")];
  const [matched] = matchSpikesToVisits([s], candidates);
  assert.equal(matched.visit?.place, "Arrived later");
  assert.deepEqual(spikeVisitRelation(matched), { kind: "arrived", gapMin: 15 });
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

test("the no-match fixture pairs that same rise with three stops it cannot reach (T200)", () => {
  // The other half of that pairing, and the input `clinicianPlaceReport` needs to read `unmatched` at a
  // single rise: a Timeline shared and nothing in it this matcher will link to the one climb
  // `clarity_window.csv` holds. Each of the three stops misses by a different one of the two predicates
  // above, which is what makes the fixture a test of the window rather than of an empty file —
  // data/fixtures/README.md spells the three out, and the rise is 07:00 to 08:00.
  const spikes = detectSpikes(parseClarityCsv(fixture("clarity_window.csv")));
  const visits = labelVisits(parseTimeline(fixture("timeline_no_match.json")), parseVisitsCsv(fixture("visits.csv")));
  assert.equal(spikes.length, 1);
  assert.equal(visits.length, 3, "a Timeline the clinician's surfaces would read as not shared at all");
  const matched = matchSpikesToVisits(spikes, visits);
  assert.deepEqual(matched, spikes, "a stop linked to the rise this fixture exists to leave unlinked");
  assert.equal(matched[0].visit, undefined);
  // The gym is the near miss, and the one that would start matching if `BEFORE_MS` ever grew: it ends
  // 06:00, sixty minutes before the climb. The other two start after the peak.
  assert.deepEqual(
    visits.map((v) => [v.start, v.end]),
    [
      ["2026-09-19T05:00:00.000Z", "2026-09-19T06:00:00.000Z"],
      ["2026-09-19T09:00:00.000Z", "2026-09-19T17:00:00.000Z"],
      ["2026-09-19T19:30:00.000Z", "2026-09-19T20:40:00.000Z"],
    ],
  );
});
