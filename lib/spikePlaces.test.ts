import assert from "node:assert/strict";
import test from "node:test";
import { fixture, pinUtcTimeZone } from "./fixtures";
import { detectSpikes, parseClarityCsv } from "./glucose";
import { placeLabel } from "./location";
import { plural } from "./plural";
import { anyPlaceKnown, clinicianChartCaption, clinicianPlaceColumn, clinicianPlaceReport, clinicianSpikeCardHeading, clinicianSpikePlacesHint, markerLabel, matchedPlaceClause, NO_MATCH_CELL, NO_TIMELINE_HINT, patientChartCaption, patientPlaceName, placeIsUnnamed, spikeRelationCell, spikeVisitRelation, UNKNOWN_PLACE, UNNAMED_PLACE } from "./spikePlaces";
import type { Spike, Visit } from "./types";

const somewhere = (name: string): Visit => ({
  start: "2026-09-19T12:00:00Z",
  end: "2026-09-19T12:40:00Z",
  place: name,
  lat: 37.77,
  lng: -122.41,
});

const spike = (visit?: Visit): Spike => ({
  start: "2026-09-19T12:50:00Z",
  peak: "2026-09-19T13:30:00Z",
  from: 107,
  to: 214,
  ...(visit ? { visit } : {}),
});

/** The matcher's vocabulary, which §2.7's page is not written in (T82). */
const MATCHER = /no matching visit|matching|unmatched/i;

/** A visit that shared the Timeline export §2.5 makes optional, and one that did not (T160, T184). */
const SHARED = { hasLocation: true };
const UNSHARED = { hasLocation: false };

/** Any clause that reports a lookup having been run — what no element may say on an UNSHARED visit (T184). */
const SEARCHED = /no place matched|no matching visit|linked to a place|\bplaces?\b/i;

test("a patient who shared no Timeline has no place to report on any rise (T82)", () => {
  // The §12.2 journey patient: Dexcom and WHOOP shared, Timeline declined, five spikes and not one place.
  const spikes = [spike(), spike(), spike(), spike(), spike()];
  assert.equal(anyPlaceKnown(spikes), false);
});

test("one matched place is enough for the column to have something to say", () => {
  assert.equal(anyPlaceKnown([spike(), spike(somewhere("Noe Cafe")), spike()]), true);
});

test("every rise matched is the other end of the same shape", () => {
  assert.equal(anyPlaceKnown([spike(somewhere("Noe Cafe")), spike(somewhere("37.790, -122.401"))]), true);
});

test("no spikes at all is no places known — the table is not drawn either way", () => {
  assert.equal(anyPlaceKnown([]), false);
});

test("the patient's word for a rise with no place borrows nothing from the matcher (T82)", () => {
  assert.doesNotMatch(UNKNOWN_PLACE, MATCHER);
  // "visit" on §2.7's page is the appointment the patient is preparing for (§4.4), never a place they went.
  assert.doesNotMatch(UNKNOWN_PLACE, /visit/i);
  assert.equal(UNKNOWN_PLACE, "not sure");
});

test("the chart caption promises places only when there are places (T82)", () => {
  const withPlace = patientChartCaption([spike(somewhere("Noe Cafe")), spike()]);
  assert.match(withPlace, /where you had just been/);

  const without = patientChartCaption([spike(), spike()]);
  assert.doesNotMatch(without, /where you had just been/);
  assert.doesNotMatch(without, /where/i);
  assert.match(without, /Markers show your biggest rises\./);
});

test("the caption and the column agree, because both read one predicate", () => {
  // Probed on "where" rather than on one of the clauses the caption can take: since T193 the wording of
  // the promise depends on the relations, and a probe naming one clause would quietly stop testing this
  // the moment a week took another. What `anyPlaceKnown` decides is whether a place is promised at all.
  // The two relations whose helpers are declared further down are probed the same way in the T193 block.
  for (const spikes of [[], [spike()], [spike(somewhere("Noe Cafe"))], [spike(), spike(somewhere("Home"))]]) {
    assert.equal(/\bwhere\b/.test(patientChartCaption(spikes)), anyPlaceKnown(spikes), patientChartCaption(spikes));
  }
});

// T99 (§2.6, §7.4): the same question on the clinician's two surfaces, where the caption used to call
// every marker a place and the markers were peak mg/dL.

test("the clinician's caption calls the labels what they are when no place matched (T99)", () => {
  // A visit that shared a Timeline and whose five rises matched no stop in it. T184 narrowed this branch to
  // that visit: it was also the §12.2 journey patient's, who shared no Timeline at all, and there the
  // sentence reported a lookup nobody had run.
  const caption = clinicianChartCaption([spike(), spike(), spike(), spike(), spike()], SHARED, 5);
  assert.match(caption, /peak mg\/dL/);
  assert.doesNotMatch(caption, /the place the patient had just left/);
  // And it agrees with the card beside it, whose stat tile reads 0 on this visit — and, since T157, whose
  // own heading is "Spikes over 180" here rather than a claim about places.
  assert.match(caption, /no place matched/);
});

test("and names the place where one matched, with the number as the other case (T99)", () => {
  const caption = clinicianChartCaption([spike(somewhere("Noe Cafe")), spike()], SHARED, 2);
  assert.match(caption, /the place the patient had just left/);
  assert.match(caption, /peak mg\/dL/);
});

test("neither shape promises that every marker is labeled (T99)", () => {
  // GlucoseChart keeps the marker and drops the label when two would collide, so "labeled with ..." of the
  // markers as a set was never true, even on a visit full of places.
  for (const spikes of [[spike()], [spike(somewhere("Home")), spike(somewhere("Noe Cafe"))]]) {
    const caption = clinicianChartCaption(spikes, SHARED, spikes.length);
    assert.match(caption, /Labels, where they fit,/);
    assert.doesNotMatch(caption, /Red markers are spikes, labeled with/);
  }
  // The empty week is the one input with no such clause to qualify, which is the stronger form of the same
  // statement and T199's: a chart with no marker on it promises no label either.
  assert.doesNotMatch(clinicianChartCaption([], SHARED, 0), /Labels|labeled/);
});

test("the band sentence is the same on the brief and on the printed sheet (T99)", () => {
  // One function is what keeps the two strings in step; both surfaces call it with the same spikes.
  for (const spikes of [[], [spike()], [spike(somewhere("Home"))]]) {
    assert.match(clinicianChartCaption(spikes, SHARED, spikes.length), /^Shaded band is 70\u2013180 mg\/dL\. /);
  }
});

test("the clinician's caption keeps the clinician's register, not the patient's (T99)", () => {
  for (const spikes of [[], [spike(somewhere("Home"))]]) {
    assert.doesNotMatch(clinicianChartCaption(spikes, SHARED, spikes.length), /\byour\b|\byou\b/i);
  }
  // And the patient's page is unchanged by this ticket — its own empty-week sentence is T199's, in §2.7's
  // second person, and carries none of the clinician's register either way.
  assert.equal(patientChartCaption([]), "You had no rises over 180, so the chart shows no markers.");
});

// T128 (§2.7, §6.5): the same question for a stop the matcher placed and the export never named, which
// until now fell through to the coordinates lib/location.ts mints for the clinician's surfaces.

/** A stop the Timeline placed but nothing named: lib/location.ts leaves its own coordinates as the name. */
const unnamed = (lat = 37.7899, lng = -122.4009): Visit => ({
  start: "2026-09-20T16:00:00Z",
  end: "2026-09-21T00:00:00Z",
  place: placeLabel(lat, lng),
  lat,
  lng,
  placeId: "ChIJ_office_demo",
});

test("an unnamed stop is the one whose name is the coordinates it was given (T128)", () => {
  assert.equal(placeIsUnnamed(unnamed()), true);
  assert.equal(placeIsUnnamed(somewhere("Office")), false);
  // Southern hemisphere, and a round number, because placeLabel pads both to three decimals.
  assert.equal(placeIsUnnamed({ ...unnamed(-33.8688, 151.2093) }), true);
  assert.equal(placeIsUnnamed({ ...somewhere("Office"), place: "37.790, -122.401" }), true);
});

test("a name that merely contains numbers is still a name", () => {
  for (const name of ["Pier 39", "24 Hour Fitness", "Cafe 1.5", "37.790"]) {
    assert.equal(placeIsUnnamed({ ...somewhere(name) }), false, name);
  }
});

test("the patient's word for an unnamed stop is not the coordinates (T128)", () => {
  assert.equal(patientPlaceName(unnamed()), UNNAMED_PLACE);
  assert.equal(patientPlaceName(somewhere("Pizzeria Delfina")), "Pizzeria Delfina");
  // Not a lat/long, not the matcher's vocabulary, and not the one word that means their appointment (§4.4).
  assert.doesNotMatch(UNNAMED_PLACE, /^-?\d+\.\d{3}, -?\d+\.\d{3}$/);
  assert.doesNotMatch(UNNAMED_PLACE, MATCHER);
  assert.doesNotMatch(UNNAMED_PLACE, /visit/i);
  assert.notEqual(UNNAMED_PLACE, UNKNOWN_PLACE);
  // GlucoseChart trims a marker label over 16 characters; this one is the chart's too, so it has to fit.
  assert.ok(UNNAMED_PLACE.length <= 16, `${UNNAMED_PLACE} is ${UNNAMED_PLACE.length} characters`);
});

test("one predicate behind the chart marker and the Where cell, so they cannot disagree (T128)", () => {
  for (const s of [spike(), spike(unnamed()), spike(somewhere("Gym"))]) {
    const cell = s.visit ? patientPlaceName(s.visit) : UNKNOWN_PLACE;
    const marker = markerLabel(s, { patient: true });
    // The marker names a place exactly when the cell does, and names the same one.
    assert.equal(marker === String(s.to), cell === UNKNOWN_PLACE);
    if (cell !== UNKNOWN_PLACE) assert.equal(marker, cell);
  }
});

test("the clinician's marker label keeps T62's coordinates — both sides of the split (T128)", () => {
  const placed = spike(unnamed());
  assert.equal(markerLabel(placed, { patient: false }), "37.790, -122.401");
  assert.equal(markerLabel(placed, { patient: true }), UNNAMED_PLACE);
  // A named stop reads the same to both, and an unplaced rise is the peak reading to both.
  for (const patient of [true, false]) {
    assert.equal(markerLabel(spike(somewhere("Home")), { patient }), "Home");
    assert.equal(markerLabel(spike(), { patient }), "214");
  }
});

// T157 (§2.6, §7.4): the heading over the card those captions sit beside, which was the one unconditional
// claim left in that row of the brief.

test("the card is not headed with a link no rise in it has (T157)", () => {
  // The §12.2 journey visit again, which is the ordinary one: Dexcom shared, Timeline not (§2.5, T144).
  const heading = clinicianSpikeCardHeading([spike(), spike(), spike(), spike(), spike()], UNSHARED);
  assert.doesNotMatch(heading, /linked/i, heading);
  assert.doesNotMatch(heading, /place/i, heading);
  // Still the card's own subject: five rises over 180 are what is in it.
  assert.equal(heading, "Spikes over 180");
});

test("and keeps the heading it has always had where a place did match (T157)", () => {
  // The acceptance criterion that is about nothing changing: desktop-provider-sour.png is this visit.
  assert.equal(clinicianSpikeCardHeading([spike(somewhere("Noe Cafe")), spike()], SHARED), "Spikes linked to places");
  assert.equal(clinicianSpikeCardHeading([spike(somewhere("Home"))], SHARED), "Spikes linked to places");
});

test("claims nothing over an empty card (T157)", () => {
  // SpikeTable's body already reads "No spikes over 180 detected."; naming the threshold above it would
  // read as though some rise had cleared it.
  const heading = clinicianSpikeCardHeading([], SHARED);
  assert.equal(heading, "Spikes");
  // And the same over an empty card on a visit with no Timeline: there is no third shape (T184).
  assert.equal(clinicianSpikeCardHeading([], UNSHARED), "Spikes");
  assert.doesNotMatch(heading, /linked|180/i, heading);
});

test("the heading, the caption and the rows are one decision (T157)", () => {
  // The property the ticket is actually about: "linked to places" is a claim about the card, so it may be
  // the heading only when `anyPlaceKnown` is true -- the same predicate `clinicianChartCaption` branches on
  // and the same one SpikeTable's rows read. Written as an equivalence so neither side can be changed alone.
  for (const spikes of [
    [],
    [spike()],
    [spike(), spike()],
    [spike(somewhere("Home"))],
    [spike(), spike(somewhere("Noe Cafe"))],
    [spike(somewhere("Noe Cafe")), spike()],
    [spike(somewhere("Home")), spike(somewhere("Noe Cafe"))],
  ]) {
    const heading = clinicianSpikeCardHeading(spikes, SHARED);
    assert.equal(/linked to places/.test(heading), anyPlaceKnown(spikes), heading);
    // And it says the same thing as the caption beside it, which is why both live in this module. The
    // matched caption also carries the words "no place matched" -- of the individual label that has none --
    // so the clause to compare against is the one that speaks about the rises as a set.
    // The empty card is outside that equivalence and always was: it is the one shape with no set of rises
    // for either element to report a lookup against, so the heading is the bare "Spikes" asserted above and
    // the caption is T199's `NO_RISES_TO_MARK` rather than either half of the matched/unmatched split.
    if (spikes.length === 0) {
      assert.equal(clinicianChartCaption(spikes, SHARED, 0), "Shaded band is 70–180 mg/dL. No rises over 180 to mark.");
      continue;
    }
    assert.equal(/linked to places/.test(heading), !/no place matched any of these rises/.test(clinicianChartCaption(spikes, SHARED, spikes.length)), heading);
  }
});

test("the heading never speaks the matcher's vocabulary at the patient (T157)", () => {
  // §2.7 is untouched by this: its card is headed "Your biggest rises" and reads the patient's own
  // functions. This is the assertion that the clinician's heading did not become a third thing the patient
  // page might be tempted to borrow (T82).
  for (const spikes of [[], [spike()], [spike(somewhere("Home"))]]) {
    assert.doesNotMatch(clinicianSpikeCardHeading(spikes, SHARED), MATCHER);
  }
});

// T160 (§2.6, §7.4, §2.5): the stat tile beside that card, which was the last element of the metrics row
// to state something about places without first asking whether any place data exists. Three states, and
// the point of the ticket is that two of them used to read alike.

test("the tile names the missing source rather than counting over it (T160)", () => {
  // The §12.2 journey visit, which §2.5 makes the ordinary one: Dexcom shared, Timeline not (T144). Five
  // rises, no Timeline — so there is no count to report, only the absence, as the Sleep tile reports its own.
  const hint = clinicianSpikePlacesHint([spike(), spike(), spike(), spike(), spike()], UNSHARED, 5);
  assert.equal(hint, NO_TIMELINE_HINT);
  assert.equal(hint, "no Timeline data");
  // Not a number, which is the whole bug: "0 linked to a place" is a measurement over a source nobody read.
  assert.doesNotMatch(hint, /\d/, hint);
  assert.doesNotMatch(hint, /linked/i, hint);
});

test("a Timeline that matched nothing keeps its zero (T160)", () => {
  // The case the ticket is careful about: this patient *did* share the export, so the zero is a reading
  // taken — no rise of theirs started near a stop — and reads differently from never having shared one.
  const hint = clinicianSpikePlacesHint([spike(), spike()], SHARED, 2);
  assert.equal(hint, "0 linked to a place");
  assert.notEqual(hint, clinicianSpikePlacesHint([spike(), spike()], UNSHARED, 2));
});

test("and a Timeline that matched some keeps its count (T160)", () => {
  // The acceptance criterion that is about nothing changing: desktop-provider-print.png is this visit.
  assert.equal(
    clinicianSpikePlacesHint([spike(somewhere("Noe Cafe")), spike(somewhere("Home")), spike(unnamed()), spike()], SHARED, 4),
    "3 linked to a place",
  );
  assert.equal(clinicianSpikePlacesHint([spike(somewhere("Noe Cafe"))], SHARED, 1), "1 linked to a place");
});

test("an empty card still answers about the source, not with a count (T160)", () => {
  // No rises at all: with a Timeline there is a zero to state, without one there is still nothing read.
  assert.equal(clinicianSpikePlacesHint([], SHARED, 0), "0 linked to a place");
  assert.equal(clinicianSpikePlacesHint([], UNSHARED, 0), NO_TIMELINE_HINT);
});

test("the tile asks `hasLocation`, never `anyPlaceKnown` (T160)", () => {
  // Written as a property because the two predicates agree on three of the four combinations, and the one
  // they differ on is exactly the case the ticket exists for. `anyPlaceKnown` false with `hasLocation` true
  // is "shared, nothing matched" and must keep its count; false with false is "never shared".
  const unmatched = [spike(), spike(), spike()];
  assert.equal(anyPlaceKnown(unmatched), false);
  assert.match(clinicianSpikePlacesHint(unmatched, SHARED, unmatched.length), /^\d+ linked to a place$/);
  assert.equal(clinicianSpikePlacesHint(unmatched, UNSHARED, unmatched.length), NO_TIMELINE_HINT);
});

// T164 (§2.6, §7.4): the tile's value became `PatientBundle.spikeTotal` — every rise in the week — while
// the card under it still lists the top five, so the hint is where a clinician reading "7" over five rows
// finds out why. Nothing about the T160 states above changes when the two agree.

test("the hint says which rows are shown when the tile counts more than the table lists (T164)", () => {
  // The seeded demo week: seven rises, five rows, a Timeline shared and three of the listed five placed.
  const listed = [spike(somewhere("Noe Cafe")), spike(somewhere("Home")), spike(unnamed()), spike(), spike()];
  assert.equal(clinicianSpikePlacesHint(listed, SHARED, 7), "top 5 shown · 3 linked to a place");
  // The ordinary §2.5 visit: the same disclosure, over the absence T160 put there instead of a count.
  assert.equal(clinicianSpikePlacesHint(listed, UNSHARED, 7), `top 5 shown · ${NO_TIMELINE_HINT}`);
});

test("the cap disclosure is the only thing it adds: the place hint survives it (T164)", () => {
  // Acceptance criterion 4's second half. Whatever T160 decided for a visit is still in the string, at the
  // end of it, so one change cannot quietly undo the other.
  const listed = [spike(somewhere("Noe Cafe")), spike(), spike(), spike(), spike()];
  for (const hasLocation of [true, false]) {
    const uncapped = clinicianSpikePlacesHint(listed, { hasLocation }, listed.length);
    const capped = clinicianSpikePlacesHint(listed, { hasLocation }, listed.length + 2);
    assert.ok(capped.endsWith(uncapped), `${capped} should still end with ${uncapped}`);
    assert.match(capped, /^top 5 shown · /);
  }
});

test("a card that lists everything it counted says nothing about a cap (T164)", () => {
  // The common visit, and the regression guard: a week with five or fewer rises has no discrepancy to
  // disclose, and a tile reading "top 5 shown" under a complete table would invent one.
  const listed = [spike(somewhere("Noe Cafe")), spike(), spike()];
  assert.equal(clinicianSpikePlacesHint(listed, SHARED, 3), "1 linked to a place");
  assert.doesNotMatch(clinicianSpikePlacesHint(listed, SHARED, 3), /shown/);
  assert.doesNotMatch(clinicianSpikePlacesHint([], UNSHARED, 0), /shown/);
});

test("the place count is scoped by the clause before it, not left to be read as a share of the tile (T164)", () => {
  // Why the cap opens the hint rather than closing it: "3 linked to a place" counts the *listed* rows, so
  // beside a tile reading 7 it would otherwise read as 3 of 7. The disclosure comes first so that by the
  // time the count is read, "top 5" is what it is a count of.
  const hint = clinicianSpikePlacesHint([spike(somewhere("Noe Cafe")), spike(), spike(), spike(), spike()], SHARED, 7);
  assert.ok(hint.indexOf("top 5 shown") < hint.indexOf("linked to a place"), hint);
});

test("the tile and the Sleep tile beside it name an absence the same way (T160)", () => {
  // §2.6's row, read across: the two optional sources, two tiles, one register. "no WHOOP data" is written
  // in the pages; this is the half that is decidable here.
  assert.match(NO_TIMELINE_HINT, /^no \S+ data$/);
});

// T165 (§2.6, §7.4): the chart was the third surface reading T164's cut, and the only one that said nothing
// about it. GlucoseChart gets the top five by rise; the tile above it counts the week. So the caption's
// middle sentence takes the tile's `total` too, and a clinician counting five markers under a tile reading 7
// is told which is which.

test("the caption scopes the markers when the tile counts more rises than the chart draws (T165)", () => {
  // The seeded demo week: seven rises over 180, five of them drawn, a Timeline shared.
  const listed = [spike(somewhere("Noe Cafe")), spike(somewhere("Home")), spike(unnamed()), spike(), spike()];
  const caption = clinicianChartCaption(listed, SHARED, 7);
  assert.match(caption, /Red markers are the 5 largest rises of 7 spikes\./);
  assert.doesNotMatch(caption, /Red markers are spikes\./);
  // The §12.2 journey visit is the same week without the Timeline, so the other branch discloses it too.
  assert.match(clinicianChartCaption([spike(), spike(), spike(), spike(), spike()], UNSHARED, 7), /the 5 largest rises of 7 spikes/);
});

test("a chart that draws every rise the week holds says nothing about a cap (T165, T199)", () => {
  // T165's acceptance criterion 2, which is T160's and T164's guard applied here: with nothing cut there is
  // no discrepancy, and a caption naming one would invent it. That is the property this test was written to
  // protect, it is asserted below at every count, and T199 does not touch it.
  //
  // What the loop also did was read the uncapped sentence as the fixed plural "Red markers are spikes." at
  // nought rises and at one, which is the defect T199 was filed on: the assertion was pinning it. So the
  // sentence is now expected per count — and at nought there is no such sentence to expect, because what
  // the markers are is a claim about an empty set (criterion 5).
  const cases: [Spike[], string | null][] = [
    [[], null],
    [[spike()], "Red marker is a spike."],
    [[spike(), spike(somewhere("Home"))], "Red markers are spikes."],
    [[spike(), spike(), spike(), spike(), spike()], "Red markers are spikes."],
  ];
  for (const [spikes, markers] of cases) {
    const caption = clinicianChartCaption(spikes, SHARED, spikes.length);
    assert.doesNotMatch(caption, /largest|of \d+ spikes/, caption);
    if (markers === null) assert.equal(caption, "Shaded band is 70\u2013180 mg/dL. No rises over 180 to mark.");
    else assert.ok(caption.includes(markers), `${spikes.length} rises: ${caption}`);
  }
});

test("the caption and the tile's hint are scoped by the same two numbers (T165)", () => {
  // Acceptance criterion 1: the chart and the tile cannot be counted against each other, because the same
  // `spikes`/`total` pair decides whether each discloses the cut. One predicate, two surfaces' worth of
  // copy — the shape lib/spikePlaces.ts exists for (T82, T99, T157).
  const listed = [spike(somewhere("Noe Cafe")), spike(), spike(), spike(), spike()];
  for (const total of [5, 6, 7, 28]) {
    const discloses = /largest rises of/.test(clinicianChartCaption(listed, SHARED, total));
    assert.equal(discloses, /shown/.test(clinicianSpikePlacesHint(listed, SHARED, total)), `total ${total}`);
    // And the number it names is the tile's own, not the row count.
    if (discloses) assert.match(clinicianChartCaption(listed, SHARED, total), new RegExp(`of ${total} spikes`));
  }
});

test("the capped caption keeps every promise the uncapped one makes (T165)", () => {
  // Acceptance criterion 3. The sentence about labels is the only thing T99 and T82 put in this string, and
  // the cap disclosure replaces the sentence in front of it rather than any part of that.
  const placed = [spike(somewhere("Noe Cafe")), spike(), spike(), spike(), spike()];
  const unplaced = [spike(), spike(), spike(), spike(), spike()];
  for (const spikes of [placed, unplaced]) {
    const capped = clinicianChartCaption(spikes, SHARED, 7);
    assert.match(capped, /^Shaded band is 70–180 mg\/dL\. /);
    assert.match(capped, /Labels, where they fit,/);
    assert.doesNotMatch(capped, /\byour\b|\byou\b/i);
    // T99: a place only where one matched, and the peak reading as the other case.
    assert.equal(/the place the patient had just left/.test(capped), anyPlaceKnown(spikes));
    assert.match(capped, /peak mg\/dL/);
  }
  assert.match(clinicianChartCaption(unplaced, SHARED, 7), /no place matched any of these rises/);
});

test("the counted noun agrees wherever the cut can fire (T165)", () => {
  // `countOf(total, "spike")` rather than a bare `${total} spikes`, in the words the brief's own overview
  // line uses for the same number. A cut exists only where the week holds more rises than the chart draws,
  // so the number is two or more and the noun is always the plural — asserted rather than reasoned about,
  // because the only thing keeping it that way is `SPIKES_SHOWN` and the slice in lib/bundle.ts.
  for (let shown = 1; shown <= 6; shown++) {
    const caption = clinicianChartCaption(Array.from({ length: shown }, () => spike()), SHARED, shown + 1);
    assert.match(caption, new RegExp(`Red markers are the ${shown} largest rises of ${shown + 1} spikes\\.`));
  }
});

// T184 (§2.5, §2.6, §7.4, §7): the two elements under that tile, which were still asking "did any rise
// match" while the tile had moved on to "was a Timeline ever shared". On the ordinary §2.5 visit the brief
// and the sheet therefore read, within four inches: `no Timeline data`, `no place matched any of these
// rises`, and `no matching visit` five times.

test("the three states are separable, and an absent source is not an empty search (T184)", () => {
  const placed = [spike(somewhere("Noe Cafe")), spike()];
  const unplaced = [spike(), spike(), spike()];
  assert.equal(clinicianPlaceReport(placed, SHARED), "matched");
  assert.equal(clinicianPlaceReport(unplaced, SHARED), "unmatched");
  assert.equal(clinicianPlaceReport(unplaced, UNSHARED), "no-timeline");
  // No rises at all is still a statement about the source, as it is for the tile (T160).
  assert.equal(clinicianPlaceReport([], SHARED), "unmatched");
  assert.equal(clinicianPlaceReport([], UNSHARED), "no-timeline");
  // A matched stop can only have come out of a Timeline, so this bundle contradicts itself, and the
  // surfaces believe the field: it is the one the tile has read since T160, and a card naming places beside
  // a tile saying none were shared is this ticket's bug with the arguments swapped. The tile's own answer
  // on that input is asserted in T164's "the hint says which rows are shown ..." above, unchanged by this.
  assert.equal(clinicianPlaceReport(placed, UNSHARED), "no-timeline");
});

test("no element reports a lookup on a visit that shared no Timeline (T184)", () => {
  // Acceptance criterion 1 and 6's cross product, read down the `hasLocation: false` column: five rises,
  // one rise, none. Every string this module hands those two surfaces, in one assertion each, because the
  // bug was three elements disagreeing rather than any one of them being wrong on its own.
  for (const spikes of [[spike(), spike(), spike(), spike(), spike()], [spike()], []]) {
    const n = spikes.length;
    for (const total of [n, n + 2]) {
      const strings = [
        clinicianChartCaption(spikes, UNSHARED, total),
        clinicianSpikeCardHeading(spikes, UNSHARED),
        clinicianSpikePlacesHint(spikes, UNSHARED, total),
      ];
      for (const line of strings) {
        assert.doesNotMatch(line, SEARCHED, `${n} rises, total ${total}: ${line}`);
        assert.doesNotMatch(line, MATCHER, line);
      }
      // And the cells: the column is not drawn, so `NO_MATCH_CELL` never reaches this visit at all.
      assert.equal(clinicianPlaceColumn(spikes, UNSHARED), false);
      // The caption still says what a label is, and what the markers are when the week holds more (T165).
      assert.match(strings[0], /^Shaded band is 70\u2013180 mg\/dL\. /);
      // Except on the empty week, which has no label to call a number and no marker to call a spike: the
      // band sentence above is the whole of what survives there, and then T199's own (criterion 2).
      if (n === 0) assert.match(strings[0], /No rises over 180 to mark\.$/);
      else assert.match(strings[0], /Labels, where they fit, give the peak mg\/dL\.$/);
      // The tile is the one element that names the absent source, and says it once (§7, the T170 split).
      assert.equal(strings[2].endsWith(NO_TIMELINE_HINT), true, strings[2]);
      assert.doesNotMatch(strings[0], /Timeline/i, strings[0]);
      assert.doesNotMatch(strings[1], /Timeline/i, strings[1]);
    }
  }
});

test("a visit that did share a Timeline keeps every word it had, zero matches included (T184)", () => {
  // Acceptance criterion 2, the direction that must not move: there the zero is a reading taken (T160), so
  // all four elements say exactly what they said before this ticket. Exact strings, because "unchanged" is
  // the claim.
  const unplaced = [spike(), spike(), spike(), spike(), spike()];
  assert.equal(
    clinicianChartCaption(unplaced, SHARED, 7),
    "Shaded band is 70\u2013180 mg/dL. Red markers are the 5 largest rises of 7 spikes. Labels, where they fit, give the peak mg/dL: no place matched any of these rises.",
  );
  assert.equal(clinicianSpikeCardHeading(unplaced, SHARED), "Spikes over 180");
  assert.equal(clinicianSpikePlacesHint(unplaced, SHARED, 7), "top 5 shown · 0 linked to a place");
  assert.equal(clinicianPlaceColumn(unplaced, SHARED), true);
  // And a visit with matches on it, in the seeded demo's *shape* -- three placed rises and two not.
  // Not in its relations, which is a distinction this fixture did not have to make until T191: two of
  // these three began after their stop ended and one began during it, so this is the mixed week and the
  // clause names the place without asserting either relation. It read "the place the patient had just
  // left" here until T191, which was false of the third row.
  //
  // The seeded demo reaches this same clause by a different mix (T192), so the sheet modelled on it
  // agrees with this fixture after all: two of its three placed rises are stops that were running as the
  // readings turned, and the third is Home, which the patient reached ten minutes into the Friday evening
  // climb -- `arrived`, not `during`. Compare docs/screenshots/tickets/t192/desktop-provider-print.png.
  // The T191 copy of that frame reads "the place the patient was at when the rise began" because
  // `arrived` was folded into `during` until T192, and that sentence was false of its third row.
  const placed = [spike(somewhere("Noe Cafe")), spike(somewhere("Home")), spike(unnamed()), spike(), spike()];
  assert.equal(
    clinicianChartCaption(placed, SHARED, 7),
    "Shaded band is 70\u2013180 mg/dL. Red markers are the 5 largest rises of 7 spikes. Labels, where they fit, give the place the rise was linked to, or the peak mg/dL where no place matched.",
  );
  assert.equal(clinicianSpikeCardHeading(placed, SHARED), "Spikes linked to places");
  assert.equal(clinicianSpikePlacesHint(placed, SHARED, 7), "top 5 shown · 3 linked to a place");
  assert.equal(clinicianPlaceColumn(placed, SHARED), true);
});

test("the four elements are one decision, over the whole cross product (T184)", () => {
  // The property the ticket is about: `hasLocation` true/false x some rise matched / none matched / no
  // rises. Each element's branch is compared against the shared report rather than against a string of its
  // own, so none of them can be changed alone -- the shape T157 gave the heading and the caption, now with
  // the question the tile asks (§12.1).
  for (const spikes of [
    [],
    [spike()],
    [spike(), spike(), spike()],
    [spike(somewhere("Home"))],
    [spike(), spike(somewhere("Noe Cafe"))],
    [spike(somewhere("Home")), spike(unnamed())],
  ]) {
    for (const status of [SHARED, UNSHARED]) {
      const report = clinicianPlaceReport(spikes, status);
      const caption = clinicianChartCaption(spikes, status, spikes.length);
      const heading = clinicianSpikeCardHeading(spikes, status);
      const hint = clinicianSpikePlacesHint(spikes, status, spikes.length);
      const column = clinicianPlaceColumn(spikes, status);
      const where = `${spikes.length} rises, hasLocation ${status.hasLocation}: ${report}`;
      // "linked to places" is a claim about the card, so only the matched report may make it.
      assert.equal(/linked to places/.test(heading), report === "matched", where);
      // The caption promises a place only there too, and reports an empty lookup only where one was run.
      // Compared against `matchedPlaceClause` rather than against one of the three strings it returns: the
      // literal that used to stand here was the `after` wording, and it was this assertion passing on a
      // mixed week that let T191 through (criterion 2).
      // The two caption halves are about the labels on the markers, so they are a claim the empty week
      // makes neither way: there, whatever the report, the caption is T199's one sentence and the
      // assertions below it carry the row (criterion 2).
      if (spikes.length === 0) {
        assert.equal(caption, "Shaded band is 70–180 mg/dL. No rises over 180 to mark.", where);
      } else {
        assert.equal(caption.includes(matchedPlaceClause(spikes)), report === "matched", where);
        assert.equal(/no place matched any of these rises/.test(caption), report === "unmatched", where);
      }
      // The tile names the source only where it is missing, and counts only where it is not.
      assert.equal(hint.endsWith(NO_TIMELINE_HINT), report === "no-timeline", where);
      assert.equal(/linked to a place/.test(hint), report !== "no-timeline", where);
      // And the column, whose cell is the matcher's sentence, is drawn in exactly the other two states.
      assert.equal(column, report !== "no-timeline", where);
      if (!column) assert.doesNotMatch([caption, heading, hint].join(" "), new RegExp(NO_MATCH_CELL), where);
    }
  }
});

test("the patient's §2.7 copy is untouched by any of it (T184)", () => {
  // Acceptance criterion 4. The patient's table drops its column whenever no row has a place to show,
  // whether or not an export was shared, which is stricter than the clinician's test and reads nothing from
  // the bundle -- so `hasLocation` cannot reach that page through this module.
  const unplaced = [spike(), spike()];
  assert.equal(anyPlaceKnown(unplaced), false);
  assert.equal(patientChartCaption(unplaced), "Markers show your biggest rises.");
  assert.equal(patientChartCaption([spike(somewhere("Noe Cafe")), spike()]), "Markers show your biggest rises and where you had just been, when available.");
  // And the patient's own word for a rise with no place is still not the matcher's (T82).
  assert.doesNotMatch(UNKNOWN_PLACE, new RegExp(NO_MATCH_CELL));
  assert.match(NO_MATCH_CELL, MATCHER);
});

// T191 (§2.6, §7.4, lib/match.ts): the caption's matched branch, which asserted one of the matcher's two
// branches for every label on the chart. On the seeded week every matched row is the other one, so the
// sentence described none of the three places it was captioning, four inches above a Place column that
// told them apart per row.

/** A stop the rise began *during*: still running when the readings started to climb (lib/match.ts `overlaps`). */
const during = (name: string): Visit => ({
  start: "2026-09-19T12:20:00Z",
  end: "2026-09-19T13:10:00Z",
  place: name,
  lat: 37.77,
  lng: -122.41,
});

// T192 (§2.6, §7.4, §7, lib/match.ts): `overlaps` is the other branch twice over. The spike above starts
// at 12:50 and peaks at 13:30, so a stop beginning anywhere in that 40 minutes overlaps it and matches —
// and the patient was somewhere else when the readings turned. Both elements said otherwise, in agreement
// with each other, so T191's cross-product property passed on it.

/** A stop the patient reached `min` minutes into the climb; it matches up to the peak, 40 minutes in. */
const arriving = (name: string, min: number): Visit => ({
  start: new Date(Date.parse("2026-09-19T12:50:00Z") + min * 60000).toISOString(),
  end: "2026-09-19T15:00:00Z",
  place: name,
  lat: 37.77,
  lng: -122.41,
});

test("the relation is the matcher's three readings, told apart by two gaps (T191, T192)", () => {
  // `somewhere` ends at 12:40 and the rise begins at 12:50: the patient had left, by ten minutes.
  assert.deepEqual(spikeVisitRelation(spike(somewhere("Noe Cafe"))), { kind: "after", gapMin: 10 });
  // `during` is still running at 12:50, so there is no gap to count down from.
  assert.deepEqual(spikeVisitRelation(spike(during("Pizzeria Delfina"))), { kind: "during" });
  // T192, at both ends of the window a stop can begin in and still match: one minute into the climb, and
  // at the peak itself, 40 minutes in. Neither is a stop the patient was standing in when it began.
  assert.deepEqual(spikeVisitRelation(spike(arriving("Office", 1))), { kind: "arrived", gapMin: 1 });
  assert.deepEqual(spikeVisitRelation(spike(arriving("Office", 40))), { kind: "arrived", gapMin: 40 });
  // Arriving in the same minute the readings turned is `during`: there is no "arrived 0 min after" to draw.
  assert.deepEqual(spikeVisitRelation(spike(arriving("Office", 0))), { kind: "during" });
  assert.deepEqual(spikeVisitRelation(spike({ ...arriving("Office", 0), start: "2026-09-19T12:50:20Z" })), { kind: "during" });
  // A rise the matcher placed nowhere has no relation at all — that cell reads NO_MATCH_CELL instead.
  assert.equal(spikeVisitRelation(spike()), null);
  // A stop that ended exactly as the rise began is "while there": nothing to say "left 0 min before" about.
  assert.deepEqual(spikeVisitRelation(spike({ ...somewhere("Gym"), end: "2026-09-19T12:50:00Z" })), { kind: "during" });
});

test("the cell SpikeTable draws is that relation, in the card's own words (T191, T192)", () => {
  assert.equal(spikeRelationCell(spike(somewhere("Noe Cafe"))), "left 10 min before");
  assert.equal(spikeRelationCell(spike(during("Pizzeria Delfina"))), "while there");
  // T192: the mirror of the first cell, counted from the same minute — and emphatically not "while there",
  // which is what this row read while `overlaps` was one case.
  assert.equal(spikeRelationCell(spike(arriving("Office", 10))), "arrived 10 min after");
  assert.equal(spikeRelationCell(spike(arriving("Office", 40))), "arrived 40 min after");
  // Empty rather than a sentence: the place cell for an unplaced rise has no suffix to carry.
  assert.equal(spikeRelationCell(spike()), "");
});

test("every matched rise an overlap: the caption does not say the patient had left (T191)", () => {
  // The seeded demo week, which is what the ticket was filed on: three placed rises, every one of them a
  // stop still running when the readings began to climb, and a caption telling the clinician otherwise.
  const spikes = [spike(during("Office")), spike(during("Office")), spike(), spike(), spike(during("Home"))];
  const caption = clinicianChartCaption(spikes, SHARED, 7);
  assert.doesNotMatch(caption, /had just left/, caption);
  assert.match(caption, /give the place the patient was at when the rise began/);
  // And the other half of the sentence, which two of those five rises need (T99).
  assert.match(caption, /or the peak mg\/dL where no place matched\./);
});

test("every matched rise an ended-just-before: the caption keeps the words it had (T191)", () => {
  // The direction that must not move. This is the branch the sentence was written for, and it is still
  // the exact string it was before this ticket.
  const spikes = [spike(somewhere("Noe Cafe")), spike(somewhere("Home")), spike()];
  const caption = clinicianChartCaption(spikes, SHARED, 3);
  assert.match(caption, /give the place the patient had just left, or the peak mg\/dL where no place matched\.$/);
});

test("a mix names the place and leaves the relation to the rows (T191)", () => {
  // Criterion 1: being accurate for both cases is enough. The Place column is the element that says which
  // of the two a given label is, per row, so the clause asserts neither.
  const spikes = [spike(during("Pizzeria Delfina")), spike(somewhere("Noe Cafe")), spike()];
  const caption = clinicianChartCaption(spikes, SHARED, 3);
  assert.match(caption, /give the place the rise was linked to, or the peak mg\/dL where no place matched\./);
  assert.doesNotMatch(caption, /had just left|was at when/, caption);
});

test("the caption and the rows cannot contradict each other, on any mix (T191, T192)", () => {
  // Criterion 2, as the property rather than as three examples: for every mix of matches, whatever the
  // caption asserts about the relation has to be true of every row it captions. The caption claims
  // "had just left" only where every row counts a gap down to the rise, and "was at when the rise began"
  // only where every row reads "while there" — and claims nothing either way otherwise.
  //
  // T192 is why the mix is now drawn from three placed kinds and not two. With `arrived` folded into
  // `during` this loop could not reach the case the ticket was filed on: the caption and the row agreed,
  // and both said the patient was somewhere they had not yet reached, so a property about the two matching
  // each other passed on it. The third assertion below is the one that would have caught it.
  const placed = [undefined, somewhere("Noe Cafe"), during("Pizzeria Delfina"), arriving("Office", 10)];
  for (let code = 0; code < 4 ** 4; code++) {
    const spikes = [0, 1, 2, 3].map((i) => spike(placed[Math.floor(code / 4 ** i) % 4]));
    if (!anyPlaceKnown(spikes)) continue;
    const caption = clinicianChartCaption(spikes, SHARED, spikes.length);
    const cells = spikes.map(spikeRelationCell).filter(Boolean);
    const where = `${cells.join(" / ")}: ${caption}`;
    if (/had just left/.test(caption)) assert.ok(cells.every((c) => c.startsWith("left ")), where);
    if (/was at when the rise began/.test(caption)) assert.ok(cells.every((c) => c === "while there"), where);
    // Neither specific clause survives a row the patient arrived at partway up the climb: both are claims
    // about where a person stood when the readings turned, and that row says they were elsewhere (T192).
    if (cells.some((c) => c.startsWith("arrived "))) assert.doesNotMatch(caption, /had just left|was at when the rise began/, where);
    // Whichever clause it took, it is the one the module's own rule returns for these rises.
    assert.ok(caption.includes(matchedPlaceClause(spikes)), where);
    // And it still says the place-less labels are numbers, which is T99's half of the sentence.
    assert.match(caption, /or the peak mg\/dL where no place matched\./, where);
  }
});

test("the shapes of a matched week are three clauses, and nothing else is (T191, T192)", () => {
  // Criterion 5. One rise placed is enough for each shape, because the clause reads the relations present
  // and not a count — so a week of one overlap says the same thing as a week of five.
  assert.equal(matchedPlaceClause([spike(somewhere("Noe Cafe"))]), "the place the patient had just left");
  assert.equal(matchedPlaceClause([spike(during("Office"))]), "the place the patient was at when the rise began");
  assert.equal(matchedPlaceClause([spike(during("Office")), spike(somewhere("Noe Cafe"))]), "the place the rise was linked to");
  // Unplaced rises alongside them change none of the three: they are the half of the sentence after it.
  assert.equal(matchedPlaceClause([spike(), spike(during("Office")), spike()]), "the place the patient was at when the rise began");
  // T192: an `arrived` week takes the neutral clause, and so does any mix holding one. There is no fourth
  // clause — the place is named and the relation is left to the per-row cell, which is T191's own answer
  // for a reading the caption cannot assert over every label.
  for (const spikes of [
    [spike(arriving("Office", 10))],
    [spike(arriving("Office", 1)), spike(arriving("Home", 40))],
    [spike(arriving("Office", 10)), spike(during("Home"))],
    [spike(arriving("Office", 10)), spike(somewhere("Noe Cafe"))],
    [spike(arriving("Office", 10)), spike(during("Home")), spike(somewhere("Noe Cafe")), spike()],
  ]) {
    assert.equal(matchedPlaceClause(spikes), "the place the rise was linked to", spikes.map(spikeRelationCell).join(" / "));
  }
});

test("a stop that began after the rise did: no element says the patient was there (T192)", () => {
  // The ticket's own reproduction. Glucose starts climbing at 12:50, the patient reaches the office at
  // 13:00, the peak is 13:30 — so the stop overlaps and matches, and on `cac155e` the row read "while
  // there" under a caption reading "the place the patient was at when the rise began".
  const office = arriving("Office", 10);
  const matched = spike(office);
  assert.deepEqual(spikeVisitRelation(matched), { kind: "arrived", gapMin: 10 });
  assert.equal(spikeRelationCell(matched), "arrived 10 min after");
  const caption = clinicianChartCaption([matched], SHARED, 1);
  assert.doesNotMatch(caption, /was at when the rise began/, caption);
  assert.doesNotMatch(caption, /had just left/, caption);
  assert.match(caption, /give the place the rise was linked to, or the peak mg\/dL where no place matched\.$/);
  // Criterion 1 is about what is not asserted, and the place itself is still named: the label on the
  // marker and the cell under it are the office, as they were before.
  assert.equal(markerLabel(matched, { patient: false }), "Office");
  assert.equal(clinicianSpikeCardHeading([matched], SHARED), "Spikes linked to places");
});

test("the other two branches and the clinician's register are untouched (T191)", () => {
  // Criterion 4: T184's `unmatched` and `no-timeline` strings, and T165's marker count, word for word.
  const unplaced = [spike(), spike(), spike(), spike(), spike()];
  assert.equal(
    clinicianChartCaption(unplaced, SHARED, 7),
    "Shaded band is 70–180 mg/dL. Red markers are the 5 largest rises of 7 spikes. Labels, where they fit, give the peak mg/dL: no place matched any of these rises.",
  );
  assert.equal(
    clinicianChartCaption(unplaced, UNSHARED, 7),
    "Shaded band is 70–180 mg/dL. Red markers are the 5 largest rises of 7 spikes. Labels, where they fit, give the peak mg/dL.",
  );
  // And none of the three new clauses speaks to the patient or borrows the matcher's vocabulary (T82, T99).
  for (const spikes of [[spike(during("Office"))], [spike(somewhere("Home"))], [spike(during("Office")), spike(somewhere("Home"))]]) {
    const caption = clinicianChartCaption(spikes, SHARED, spikes.length);
    assert.doesNotMatch(caption, /\byour\b|\byou\b/i, caption);
    assert.doesNotMatch(caption, new RegExp(NO_MATCH_CELL), caption);
    assert.match(caption, /^Shaded band is 70–180 mg\/dL\. /);
  }
});

// T193 (§2.7, lib/match.ts): the patient's twin of the sentence T191 and T192 fixed on the two clinician
// surfaces. `patientChartCaption` still asserted the matcher's `endedJustBefore` branch — "where you had
// just been" — for every labelled marker on the patient's own chart, and the patient's page is worse placed
// to recover from it than the brief was: `compact` drops the relation suffix from the rises table
// (components/SpikeTable.tsx), so the caption is the only element on that screen saying anything about the
// relation and there is nothing under it to read against it.

test("every matched rise an overlap: the patient is not told they had just been somewhere (T193)", () => {
  // Criterion 1, in the direction the ticket was filed on. Every one of these stops was still running when
  // the readings began to climb, so "where you had just been" asks the patient to remember leaving places
  // they were sitting in — the wrong memory to go looking for, and the memory aid is the whole job of that
  // column (T128).
  const spikes = [spike(during("Office")), spike(during("Office")), spike(), spike(), spike(during("Home"))];
  const caption = patientChartCaption(spikes);
  assert.doesNotMatch(caption, /had just been/, caption);
  assert.equal(caption, "Markers show your biggest rises and where you were at the time, when available.");
});

test("every matched rise an ended-just-before: the patient's caption keeps the words it had (T193)", () => {
  // Criterion 4's other half, and the direction that must not move: this is the branch the sentence was
  // written for, still the exact string §2.7 has shown since T82.
  const spikes = [spike(somewhere("Noe Cafe")), spike(somewhere("Home")), spike()];
  assert.equal(patientChartCaption(spikes), "Markers show your biggest rises and where you had just been, when available.");
});

test("a mix tells the patient only where they were around then (T193)", () => {
  // Criterion 1: being accurate for both cases is enough. Neither specific reading is true of all of these,
  // and unlike the clinician's card there is no per-row suffix on this page to tell them apart — so the
  // clause asserts neither and the page claims no more than it knows.
  for (const spikes of [
    [spike(during("Office")), spike(somewhere("Noe Cafe")), spike()],
    [spike(arriving("Office", 10))],
    [spike(arriving("Office", 10)), spike(during("Home"))],
    [spike(arriving("Office", 10)), spike(somewhere("Noe Cafe"))],
    [spike(arriving("Office", 1)), spike(during("Home")), spike(somewhere("Noe Cafe")), spike()],
  ]) {
    const caption = patientChartCaption(spikes);
    // The clause is the subject here, so it is asserted as the tail rather than inside a whole string: the
    // half in front of it agrees with the number of markers since T199, and one of these mixes is a single
    // placed rise.
    assert.match(caption, /^Markers? shows? your biggest rises? and where you were around then, when available\.$/, spikes.map(spikeRelationCell).join(" / "));
    assert.doesNotMatch(caption, /had just been|at the time/, caption);
  }
});

test("both fixtures this page is ever seen with are that mix (T193)", () => {
  // The ticket's own reproduction, and why neither specific clause reaches a screenshot. The seeded demo
  // week and the mixed-places sample (data/timeline_sample.json over data/dexcom_clarity_sample.csv) place
  // three rises each and have the same shape: two Office stops that were running as the readings turned,
  // and one the patient reached ten minutes into the climb.
  //
  // The issue body reads those three as all-`during` — gaps of -155, -145 and -250 minutes — which is the
  // pre-T192 reading, where `overlaps` was one case and an `arrived` stop counted as one the patient was
  // standing in. It is the mixed clause that is true of them, not "where you were at the time".
  const spikes = [spike(during("Office")), spike(during("Office")), spike(arriving("Home", 10)), spike(), spike()];
  assert.deepEqual(spikes.map((s) => spikeVisitRelation(s)?.kind ?? null), ["during", "during", "arrived", null, null]);
  assert.equal(patientChartCaption(spikes), "Markers show your biggest rises and where you were around then, when available.");
});

test("the patient's caption and the clinician's cannot disagree about one match (T193)", () => {
  // Criterion 2, as the property rather than as three examples: both surfaces read one
  // `spikeVisitRelation`, so for every mix of matches the patient's clause has to be specific in exactly
  // the cases the clinician's is, and about the same relation. This is the assertion that stops §2.7
  // drifting back out of step with §2.6 the next time either sentence is reworded.
  const placed = [undefined, somewhere("Noe Cafe"), during("Pizzeria Delfina"), arriving("Office", 10)];
  for (let code = 0; code < 4 ** 4; code++) {
    const spikes = [0, 1, 2, 3].map((i) => spike(placed[Math.floor(code / 4 ** i) % 4]));
    if (!anyPlaceKnown(spikes)) continue;
    const patient = patientChartCaption(spikes);
    const clinician = matchedPlaceClause(spikes);
    const cells = spikes.map(spikeRelationCell).filter(Boolean);
    const where = `${cells.join(" / ")}: ${patient}`;
    assert.equal(/had just been/.test(patient), clinician === "the place the patient had just left", where);
    assert.equal(/at the time/.test(patient), clinician === "the place the patient was at when the rise began", where);
    assert.equal(/around then/.test(patient), clinician === "the place the rise was linked to", where);
    // And each specific clause is true of every row it captions, which is what the clinician's own
    // cross-product asserts one surface over.
    if (/had just been/.test(patient)) assert.ok(cells.every((c) => c.startsWith("left ")), where);
    if (/at the time/.test(patient)) assert.ok(cells.every((c) => c === "while there"), where);
    // A row the patient walked into partway up the climb leaves no specific reading standing (T192).
    if (cells.some((c) => c.startsWith("arrived "))) assert.doesNotMatch(patient, /had just been|at the time/, where);
  }
});

test("all three clauses keep §2.7's register and borrow nothing from the matcher (T193)", () => {
  // Criterion 3. The second person throughout, and none of the clinician's vocabulary: not "while there",
  // not "linked", and above all not "visit", which on this page is the appointment the patient is
  // preparing for (§4.4). Criterion 4's first half too — the no-places branch is still the bare sentence.
  for (const spikes of [
    [spike(somewhere("Noe Cafe"))],
    [spike(during("Office"))],
    [spike(arriving("Home", 10))],
    [spike(during("Office")), spike(somewhere("Noe Cafe")), spike()],
  ]) {
    const caption = patientChartCaption(spikes);
    assert.match(caption, /^Markers? shows? your biggest rises? and where you /, caption);
    assert.match(caption, /, when available\.$/, caption);
    assert.doesNotMatch(caption, MATCHER, caption);
    assert.doesNotMatch(caption, /visit|linked|while there|mg\/dL/i, caption);
  }
  assert.equal(patientChartCaption([spike(), spike()]), "Markers show your biggest rises.");
  // Criterion 4's second half is now T199's sentence rather than that same string a third time: over no
  // rises at all there is nothing for a marker to show, and §2.7's register is still the second person.
  assert.equal(patientChartCaption([]), "You had no rises over 180, so the chart shows no markers.");
});

// T199 (§2.6, §2.7, §7, §7.4): the chart caption counted its own markers wrong in both directions the
// repo had already ruled on. The uncapped marker sentence was a fixed plural and `total <= shown` is as
// true at one rise as at five, so the one-rise visit — e2e/flags.spec.ts's flagged brief, tile reading 1,
// one row in the card, one dot on the chart — read "Red markers are spikes."; and nothing gated either
// caption on there being a marker at all, so a week that never crossed 180 was promised markers and
// labels over a chart that draws neither. T198 is the same bug one card down with the number the other
// way round, and T60's "1 spikes" is where lib/plural.ts came from.

/** Every uncapped count the two captions are read at below, with the caption's own `total`. */
const spikesOf = (n: number): Spike[] => Array.from({ length: n }, () => spike());

test("the clinician's marker sentence agrees with the number of markers drawn (T199)", () => {
  // Acceptance criterion 1, at the three counts criterion 5 names. One rise is the singular throughout —
  // noun, verb and complement — and two is the string the sentence has always been, which is what keeps
  // every surface asserted on a multi-rise week unmoved.
  assert.equal(
    clinicianChartCaption(spikesOf(1), SHARED, 1),
    "Shaded band is 70–180 mg/dL. Red marker is a spike. Labels, where they fit, give the peak mg/dL: no place matched any of these rises.",
  );
  assert.match(clinicianChartCaption(spikesOf(2), SHARED, 2), /Red markers are spikes\./);
  assert.match(clinicianChartCaption(spikesOf(5), SHARED, 5), /Red markers are spikes\./);
  // And the capped branch is not reopened by any of it: T165's wording and T164's `total`, word for word.
  assert.equal(
    clinicianChartCaption(spikesOf(5), SHARED, 7),
    "Shaded band is 70–180 mg/dL. Red markers are the 5 largest rises of 7 spikes. Labels, where they fit, give the peak mg/dL: no place matched any of these rises.",
  );
});

test("with no rise over 180 neither clinician surface claims a marker or a label (T199)", () => {
  // Acceptance criterion 2. The band sentence is true of a chart with nothing on it and stays; what used
  // to follow it was two claims about an empty set — what the red markers are, and what the labels on them
  // give — on the one week §7 has nothing to report, where no rises table contradicts either.
  for (const status of [SHARED, UNSHARED]) {
    const caption = clinicianChartCaption([], status, 0);
    assert.equal(caption, "Shaded band is 70–180 mg/dL. No rises over 180 to mark.");
    assert.doesNotMatch(caption, /markers?\b|Labels|labeled|peak mg\/dL/i, caption);
    // Still the clinician's register and still not the matcher's vocabulary (T82, T99).
    assert.doesNotMatch(caption, /\byour\b|\byou\b/i, caption);
    assert.doesNotMatch(caption, MATCHER, caption);
    assert.doesNotMatch(caption, SEARCHED, caption);
  }
  // §7.4's sheet reads the same string as §2.6's brief because both render this one function, which is
  // what T99 made it for; that the two surfaces really do call it is asserted on screen in
  // e2e/flags.spec.ts, where the sheet's caption is compared with the brief's rather than re-derived.
});

test("the patient's caption counts its markers the same way, in §2.7's voice (T199)", () => {
  // Acceptance criterion 3, on both counts. The marker half agrees; the place clause T193 decides is
  // untouched, which is what the placed pair below reads.
  assert.equal(patientChartCaption(spikesOf(1)), "Marker shows your biggest rise.");
  assert.equal(patientChartCaption(spikesOf(2)), "Markers show your biggest rises.");
  assert.equal(patientChartCaption(spikesOf(5)), "Markers show your biggest rises.");
  assert.equal(
    patientChartCaption([spike(somewhere("Noe Cafe"))]),
    "Marker shows your biggest rise and where you had just been, when available.",
  );
  assert.equal(
    patientChartCaption([spike(somewhere("Noe Cafe")), spike(somewhere("Home"))]),
    "Markers show your biggest rises and where you had just been, when available.",
  );
  // And the empty week, where "Markers show your biggest rises." was not a disagreement about number but a
  // claim about something that is not drawn. Second person, §2.7's threshold, none of the matcher's words.
  const none = patientChartCaption([]);
  assert.equal(none, "You had no rises over 180, so the chart shows no markers.");
  assert.match(none, /\byou\b/i);
  assert.doesNotMatch(none, MATCHER, none);
  assert.doesNotMatch(none, /visit|linked|while there|mg\/dL/i, none);
});

test("neither caption says anything in range about a week with no rise in it (T199)", () => {
  // The claim the two empty-week sentences were careful not to make: a rise over 180 is one threshold and
  // 70–180 is two, so a week spent below 70 has no rise in it either and is the opposite of well
  // controlled. `clarity_window.csv`'s urgent low is that week with one rise added.
  for (const caption of [clinicianChartCaption([], SHARED, 0), patientChartCaption([])]) {
    assert.doesNotMatch(caption, /in range|in target|well controlled|normal/i, caption);
  }
});

test("the agreement in both captions comes from lib/plural.ts (T199)", () => {
  // Acceptance criterion 4, which is T198's criterion 2 for the same reason: a ternary written beside the
  // sentence is how the fixed plural got there, and the rule it would duplicate already has a module and a
  // suite of its own. Read as the property `plural` guarantees and a literal cannot — every count from one
  // up agrees, not just the three a test lists.
  for (let n = 1; n <= 12; n++) {
    const clinician = clinicianChartCaption(spikesOf(n), SHARED, n);
    const patient = patientChartCaption(spikesOf(n));
    assert.ok(clinician.includes(`Red ${plural(n, "marker")} ${plural(n, "is", "are")} ${plural(n, "a spike", "spikes")}.`), clinician);
    assert.ok(patient.startsWith(`${plural(n, "Marker")} ${plural(n, "shows", "show")} your ${plural(n, "biggest rise", "biggest rises")}`), patient);
    // No count reads as the other one's number, which is the failure mode in one assertion.
    assert.doesNotMatch(clinician, n === 1 ? /Red markers/ : /Red marker\b/, clinician);
    assert.doesNotMatch(patient, n === 1 ? /^Markers/ : /^Marker\b/, patient);
  }
});

test("the flat fixture is the week the zero branch is about (T199)", () => {
  // Acceptance criterion 6's fixture, read here as well as in the e2e suite: glucose shared, every reading
  // inside the band, so `detectSpikes` finds nothing and the captions above take their empty branch on a
  // real parsed export rather than on a hand-built `[]`. data/fixtures/README.md describes it.
  pinUtcTimeZone();
  const readings = parseClarityCsv(fixture("clarity_flat.csv"));
  assert.ok(readings.length > 0, "the flat fixture parsed to nothing");
  assert.ok(readings.every((r) => r.mgdl > 70 && r.mgdl < 180), "a reading outside the band in a flat fixture");
  const spikes = detectSpikes(readings);
  assert.deepEqual(spikes, []);
  assert.equal(clinicianChartCaption(spikes, SHARED, spikes.length), "Shaded band is 70–180 mg/dL. No rises over 180 to mark.");
  assert.equal(patientChartCaption(spikes), "You had no rises over 180, so the chart shows no markers.");
});
