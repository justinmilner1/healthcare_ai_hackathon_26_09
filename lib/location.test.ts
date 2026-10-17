import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./fixtures";
import { labelVisits, parseTimeline, parseVisitsCsv, placeLabel } from "./location";
import type { Visit } from "./types";

const CAFE = { start: "2026-09-19T06:10:00.000Z", end: "2026-09-19T06:50:00.000Z" };
const PIZZERIA = { start: "2026-09-19T19:30:00.000Z", end: "2026-09-19T20:40:00.000Z" };

test("the Android export reads from semanticSegments and the geo: lat/lng form", () => {
  const visits = parseTimeline(fixture("timeline_android.json"));
  assert.deepEqual(
    visits.map((v) => v.placeId),
    ["ChIJ_fixture_cafe", "ChIJ_fixture_office", "ChIJ_fixture_pizzeria"],
  );
  assert.deepEqual(visits[0], {
    ...CAFE,
    place: "37.777, -122.423", // place names are not in the export; the coordinates stand in until labelVisits runs
    lat: 37.7766,
    lng: -122.4231,
    placeId: "ChIJ_fixture_cafe",
  });
});

test("the iOS export reads from a top-level array and the degree-string lat/lng form", () => {
  const visits = parseTimeline(fixture("timeline_ios.json"));
  assert.equal(visits.length, 2);
  assert.deepEqual(visits[0], { ...CAFE, place: "37.777, -122.423", lat: 37.7766, lng: -122.4231, placeId: "ChIJ_fixture_cafe" });
  assert.deepEqual(visits[1], { ...PIZZERIA, place: "37.761, -122.424", lat: 37.7614, lng: -122.4241, placeId: "ChIJ_fixture_pizzeria" });
});

test("both exports agree on the visits they share", () => {
  const android = parseTimeline(fixture("timeline_android.json")).filter((v) => v.placeId !== "ChIJ_fixture_office");
  assert.deepEqual(android, parseTimeline(fixture("timeline_ios.json")));
});

test("segments that are not visits, or have no location, are dropped", () => {
  // The Android fixture holds a WALKING segment and a visit whose topCandidate has no placeLocation.
  const visits = parseTimeline(fixture("timeline_android.json"));
  assert.equal(
    visits.some((v) => v.placeId === "ChIJ_fixture_no_location"),
    false,
  );
  assert.deepEqual(parseTimeline('{"semanticSegments":[]}'), []);
  assert.deepEqual(parseTimeline("[]"), []);
  assert.throws(() => parseTimeline("not json"));
});

test("only the last seven days of the export are kept", () => {
  // The Android fixture's stale visit is a week before the rest, so the default window drops it.
  const visits = parseTimeline(fixture("timeline_android.json"));
  assert.equal(
    visits.some((v) => v.placeId === "ChIJ_fixture_stale"),
    false,
  );
  // Widen the window and it comes back; the window is measured from the latest visit in the file, so a sample
  // file never goes stale.
  const wide = parseTimeline(fixture("timeline_android.json"), { windowMs: 30 * 24 * 60 * 60 * 1000 });
  assert.equal(wide.length, 4);
  assert.equal(wide[0].placeId, "ChIJ_fixture_stale");
  // An explicit `now` moves the cutoff instead.
  const narrow = parseTimeline(fixture("timeline_android.json"), { now: new Date("2026-09-19T12:00:00Z"), windowMs: 4 * 60 * 60 * 1000 });
  assert.deepEqual(
    narrow.map((v) => v.placeId),
    ["ChIJ_fixture_office", "ChIJ_fixture_pizzeria"],
  );
});

test("visits come back in start order", () => {
  const visits = parseTimeline(fixture("timeline_android.json"));
  assert.deepEqual([...visits].sort((a, b) => a.start.localeCompare(b.start)), visits);
});

test("visits.csv gives the hand labels", () => {
  const labelled = parseVisitsCsv(fixture("visits.csv"));
  assert.deepEqual(
    labelled.map((v) => v.place),
    ["Fixture Cafe", "Fixture Office", "Fixture Pizzeria"],
  );
  assert.deepEqual(labelled[0], { ...CAFE, place: "Fixture Cafe", lat: 37.7766, lng: -122.4231 });
  assert.deepEqual(parseVisitsCsv("start,end,place,lat,lng\n"), []);
  assert.deepEqual(parseVisitsCsv("start,end,place,lat,lng\n2026-09-19T06:10:00+00:00,2026-09-19T06:50:00+00:00,,1,2\n"), []);
});

test("labelling names Timeline places by id and by proximity", () => {
  const visits = parseTimeline(fixture("timeline_android.json"));
  const labels = parseVisitsCsv(fixture("visits.csv"));
  assert.deepEqual(
    labelVisits(visits, labels).map((v) => v.place),
    ["Fixture Cafe", "Fixture Office", "Fixture Pizzeria"],
  );
  // With no labels the coordinates stand.
  assert.deepEqual(labelVisits(visits, []), visits);
  // A label 2 km away does not stick; one 50 m away does.
  const far: Visit = { ...CAFE, place: "Somewhere Else", lat: 37.7966, lng: -122.4231 };
  assert.equal(labelVisits([visits[0]], [far])[0].place, "37.777, -122.423");
  const near: Visit = { ...CAFE, place: "Next Door", lat: 37.77705, lng: -122.4231 };
  assert.equal(labelVisits([visits[0]], [near])[0].place, "Next Door");
});

test("an export with no labels at all never shows a place id (T62)", () => {
  // The production case: a patient uploads a Timeline export and nothing else, so labelVisits has nothing
  // to join on. Every place a clinician then reads is coordinates, not Google's internal id.
  for (const file of ["timeline_android.json", "timeline_ios.json"] as const) {
    const visits = labelVisits(parseTimeline(fixture(file)), []);
    assert.ok(visits.length > 0, file);
    for (const v of visits) {
      assert.notEqual(v.place, v.placeId);
      assert.doesNotMatch(v.place, /ChIJ/);
      assert.match(v.place, /^-?\d+\.\d{3}, -?\d+\.\d{3}$/);
      assert.ok(v.placeId, "placeId stays on the visit");
    }
  }
});

test("a Timeline visit stored before T62 is relabelled on its way out (T62)", () => {
  // Rows already in the database hold the id as the name. labelVisits is the one place every stored
  // Timeline visit passes through (lib/bundle.ts), so that is where it stops being an id.
  const stored: Visit = { ...CAFE, place: "ChIJ_fixture_cafe", lat: 37.7766, lng: -122.4231, placeId: "ChIJ_fixture_cafe" };
  assert.equal(labelVisits([stored], [])[0].place, "37.777, -122.423");
  // A hand label still wins over the coordinates.
  const labels = parseVisitsCsv(fixture("visits.csv"));
  assert.equal(labelVisits([stored], labels)[0].place, "Fixture Cafe");
});

test("placeLabel pads to three decimals so a column of them lines up", () => {
  assert.equal(placeLabel(37.7899, -122.4009), "37.790, -122.401");
  assert.equal(placeLabel(37, -122), "37.000, -122.000");
  assert.equal(placeLabel(-33.8688, 151.2093), "-33.869, 151.209");
});
