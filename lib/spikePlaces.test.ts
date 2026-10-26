import assert from "node:assert/strict";
import test from "node:test";
import { placeLabel } from "./location";
import { anyPlaceKnown, clinicianChartCaption, clinicianSpikeCardHeading, clinicianSpikePlacesHint, markerLabel, NO_TIMELINE_HINT, patientChartCaption, patientPlaceName, placeIsUnnamed, UNKNOWN_PLACE, UNNAMED_PLACE } from "./spikePlaces";
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
  for (const spikes of [[], [spike()], [spike(somewhere("Noe Cafe"))], [spike(), spike(somewhere("Home"))]]) {
    assert.equal(/where you had just been/.test(patientChartCaption(spikes)), anyPlaceKnown(spikes));
  }
});

// T99 (§2.6, §7.4): the same question on the clinician's two surfaces, where the caption used to call
// every marker a place and the markers were peak mg/dL.

test("the clinician's caption calls the labels what they are when no place matched (T99)", () => {
  // The §12.2 journey visit: Dexcom and WHOOP, no Timeline, five spikes labeled 206, 202, 214, 210, 194.
  const caption = clinicianChartCaption([spike(), spike(), spike(), spike(), spike()], 5);
  assert.match(caption, /peak mg\/dL/);
  assert.doesNotMatch(caption, /the place the patient had just left/);
  // And it agrees with the card beside it, whose stat tile reads 0 on this visit — and, since T157, whose
  // own heading is "Spikes over 180" here rather than a claim about places.
  assert.match(caption, /no place matched/);
});

test("and names the place where one matched, with the number as the other case (T99)", () => {
  const caption = clinicianChartCaption([spike(somewhere("Noe Cafe")), spike()], 2);
  assert.match(caption, /the place the patient had just left/);
  assert.match(caption, /peak mg\/dL/);
});

test("neither shape promises that every marker is labeled (T99)", () => {
  // GlucoseChart keeps the marker and drops the label when two would collide, so "labeled with ..." of the
  // markers as a set was never true, even on a visit full of places.
  for (const spikes of [[], [spike()], [spike(somewhere("Home")), spike(somewhere("Noe Cafe"))]]) {
    const caption = clinicianChartCaption(spikes, spikes.length);
    assert.match(caption, /Labels, where they fit,/);
    assert.doesNotMatch(caption, /Red markers are spikes, labeled with/);
  }
});

test("the band sentence is the same on the brief and on the printed sheet (T99)", () => {
  // One function is what keeps the two strings in step; both surfaces call it with the same spikes.
  for (const spikes of [[], [spike()], [spike(somewhere("Home"))]]) {
    assert.match(clinicianChartCaption(spikes, spikes.length), /^Shaded band is 70\u2013180 mg\/dL\. /);
  }
});

test("the clinician's caption keeps the clinician's register, not the patient's (T99)", () => {
  for (const spikes of [[], [spike(somewhere("Home"))]]) {
    assert.doesNotMatch(clinicianChartCaption(spikes, spikes.length), /\byour\b|\byou\b/i);
  }
  // And the patient's page is unchanged by this ticket.
  assert.equal(patientChartCaption([]), "Markers show your biggest rises.");
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
  const heading = clinicianSpikeCardHeading([spike(), spike(), spike(), spike(), spike()]);
  assert.doesNotMatch(heading, /linked/i, heading);
  assert.doesNotMatch(heading, /place/i, heading);
  // Still the card's own subject: five rises over 180 are what is in it.
  assert.equal(heading, "Spikes over 180");
});

test("and keeps the heading it has always had where a place did match (T157)", () => {
  // The acceptance criterion that is about nothing changing: desktop-provider-sour.png is this visit.
  assert.equal(clinicianSpikeCardHeading([spike(somewhere("Noe Cafe")), spike()]), "Spikes linked to places");
  assert.equal(clinicianSpikeCardHeading([spike(somewhere("Home"))]), "Spikes linked to places");
});

test("claims nothing over an empty card (T157)", () => {
  // SpikeTable's body already reads "No spikes over 180 detected."; naming the threshold above it would
  // read as though some rise had cleared it.
  const heading = clinicianSpikeCardHeading([]);
  assert.equal(heading, "Spikes");
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
    const heading = clinicianSpikeCardHeading(spikes);
    assert.equal(/linked to places/.test(heading), anyPlaceKnown(spikes), heading);
    // And it says the same thing as the caption beside it, which is why both live in this module. The
    // matched caption also carries the words "no place matched" -- of the individual label that has none --
    // so the clause to compare against is the one that speaks about the rises as a set.
    assert.equal(/linked to places/.test(heading), !/no place matched any of these rises/.test(clinicianChartCaption(spikes, spikes.length)), heading);
  }
});

test("the heading never speaks the matcher's vocabulary at the patient (T157)", () => {
  // §2.7 is untouched by this: its card is headed "Your biggest rises" and reads the patient's own
  // functions. This is the assertion that the clinician's heading did not become a third thing the patient
  // page might be tempted to borrow (T82).
  for (const spikes of [[], [spike()], [spike(somewhere("Home"))]]) {
    assert.doesNotMatch(clinicianSpikeCardHeading(spikes), MATCHER);
  }
});

// T160 (§2.6, §7.4, §2.5): the stat tile beside that card, which was the last element of the metrics row
// to state something about places without first asking whether any place data exists. Three states, and
// the point of the ticket is that two of them used to read alike.

test("the tile names the missing source rather than counting over it (T160)", () => {
  // The §12.2 journey visit, which §2.5 makes the ordinary one: Dexcom shared, Timeline not (T144). Five
  // rises, no Timeline — so there is no count to report, only the absence, as the Sleep tile reports its own.
  const hint = clinicianSpikePlacesHint([spike(), spike(), spike(), spike(), spike()], { hasLocation: false }, 5);
  assert.equal(hint, NO_TIMELINE_HINT);
  assert.equal(hint, "no Timeline data");
  // Not a number, which is the whole bug: "0 linked to a place" is a measurement over a source nobody read.
  assert.doesNotMatch(hint, /\d/, hint);
  assert.doesNotMatch(hint, /linked/i, hint);
});

test("a Timeline that matched nothing keeps its zero (T160)", () => {
  // The case the ticket is careful about: this patient *did* share the export, so the zero is a reading
  // taken — no rise of theirs started near a stop — and reads differently from never having shared one.
  const hint = clinicianSpikePlacesHint([spike(), spike()], { hasLocation: true }, 2);
  assert.equal(hint, "0 linked to a place");
  assert.notEqual(hint, clinicianSpikePlacesHint([spike(), spike()], { hasLocation: false }, 2));
});

test("and a Timeline that matched some keeps its count (T160)", () => {
  // The acceptance criterion that is about nothing changing: desktop-provider-print.png is this visit.
  assert.equal(
    clinicianSpikePlacesHint([spike(somewhere("Noe Cafe")), spike(somewhere("Home")), spike(unnamed()), spike()], { hasLocation: true }, 4),
    "3 linked to a place",
  );
  assert.equal(clinicianSpikePlacesHint([spike(somewhere("Noe Cafe"))], { hasLocation: true }, 1), "1 linked to a place");
});

test("an empty card still answers about the source, not with a count (T160)", () => {
  // No rises at all: with a Timeline there is a zero to state, without one there is still nothing read.
  assert.equal(clinicianSpikePlacesHint([], { hasLocation: true }, 0), "0 linked to a place");
  assert.equal(clinicianSpikePlacesHint([], { hasLocation: false }, 0), NO_TIMELINE_HINT);
});

test("the tile asks `hasLocation`, never `anyPlaceKnown` (T160)", () => {
  // Written as a property because the two predicates agree on three of the four combinations, and the one
  // they differ on is exactly the case the ticket exists for. `anyPlaceKnown` false with `hasLocation` true
  // is "shared, nothing matched" and must keep its count; false with false is "never shared".
  const unmatched = [spike(), spike(), spike()];
  assert.equal(anyPlaceKnown(unmatched), false);
  assert.match(clinicianSpikePlacesHint(unmatched, { hasLocation: true }, unmatched.length), /^\d+ linked to a place$/);
  assert.equal(clinicianSpikePlacesHint(unmatched, { hasLocation: false }, unmatched.length), NO_TIMELINE_HINT);
});

// T164 (§2.6, §7.4): the tile's value became `PatientBundle.spikeTotal` — every rise in the week — while
// the card under it still lists the top five, so the hint is where a clinician reading "7" over five rows
// finds out why. Nothing about the T160 states above changes when the two agree.

test("the hint says which rows are shown when the tile counts more than the table lists (T164)", () => {
  // The seeded demo week: seven rises, five rows, a Timeline shared and three of the listed five placed.
  const listed = [spike(somewhere("Noe Cafe")), spike(somewhere("Home")), spike(unnamed()), spike(), spike()];
  assert.equal(clinicianSpikePlacesHint(listed, { hasLocation: true }, 7), "top 5 shown · 3 linked to a place");
  // The ordinary §2.5 visit: the same disclosure, over the absence T160 put there instead of a count.
  assert.equal(clinicianSpikePlacesHint(listed, { hasLocation: false }, 7), `top 5 shown · ${NO_TIMELINE_HINT}`);
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
  assert.equal(clinicianSpikePlacesHint(listed, { hasLocation: true }, 3), "1 linked to a place");
  assert.doesNotMatch(clinicianSpikePlacesHint(listed, { hasLocation: true }, 3), /shown/);
  assert.doesNotMatch(clinicianSpikePlacesHint([], { hasLocation: false }, 0), /shown/);
});

test("the place count is scoped by the clause before it, not left to be read as a share of the tile (T164)", () => {
  // Why the cap opens the hint rather than closing it: "3 linked to a place" counts the *listed* rows, so
  // beside a tile reading 7 it would otherwise read as 3 of 7. The disclosure comes first so that by the
  // time the count is read, "top 5" is what it is a count of.
  const hint = clinicianSpikePlacesHint([spike(somewhere("Noe Cafe")), spike(), spike(), spike(), spike()], { hasLocation: true }, 7);
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
  const caption = clinicianChartCaption(listed, 7);
  assert.match(caption, /Red markers are the 5 largest rises of 7 spikes\./);
  assert.doesNotMatch(caption, /Red markers are spikes\./);
  // The §12.2 journey visit is the same week without the Timeline, so the other branch discloses it too.
  assert.match(clinicianChartCaption([spike(), spike(), spike(), spike(), spike()], 7), /the 5 largest rises of 7 spikes/);
});

test("a chart that draws every rise the week holds says nothing about a cap (T165)", () => {
  // Acceptance criterion 2, which is T160's and T164's guard applied here: with nothing cut there is no
  // discrepancy, and a caption naming one would invent it.
  for (const spikes of [[], [spike()], [spike(), spike(somewhere("Home"))], [spike(), spike(), spike(), spike(), spike()]]) {
    const caption = clinicianChartCaption(spikes, spikes.length);
    assert.match(caption, /Red markers are spikes\./);
    assert.doesNotMatch(caption, /largest|of \d+ spikes/);
  }
});

test("the caption and the tile's hint are scoped by the same two numbers (T165)", () => {
  // Acceptance criterion 1: the chart and the tile cannot be counted against each other, because the same
  // `spikes`/`total` pair decides whether each discloses the cut. One predicate, two surfaces' worth of
  // copy — the shape lib/spikePlaces.ts exists for (T82, T99, T157).
  const listed = [spike(somewhere("Noe Cafe")), spike(), spike(), spike(), spike()];
  for (const total of [5, 6, 7, 28]) {
    const discloses = /largest rises of/.test(clinicianChartCaption(listed, total));
    assert.equal(discloses, /shown/.test(clinicianSpikePlacesHint(listed, { hasLocation: true }, total)), `total ${total}`);
    // And the number it names is the tile's own, not the row count.
    if (discloses) assert.match(clinicianChartCaption(listed, total), new RegExp(`of ${total} spikes`));
  }
});

test("the capped caption keeps every promise the uncapped one makes (T165)", () => {
  // Acceptance criterion 3. The sentence about labels is the only thing T99 and T82 put in this string, and
  // the cap disclosure replaces the sentence in front of it rather than any part of that.
  const placed = [spike(somewhere("Noe Cafe")), spike(), spike(), spike(), spike()];
  const unplaced = [spike(), spike(), spike(), spike(), spike()];
  for (const spikes of [placed, unplaced]) {
    const capped = clinicianChartCaption(spikes, 7);
    assert.match(capped, /^Shaded band is 70–180 mg\/dL\. /);
    assert.match(capped, /Labels, where they fit,/);
    assert.doesNotMatch(capped, /\byour\b|\byou\b/i);
    // T99: a place only where one matched, and the peak reading as the other case.
    assert.equal(/the place the patient had just left/.test(capped), anyPlaceKnown(spikes));
    assert.match(capped, /peak mg\/dL/);
  }
  assert.match(clinicianChartCaption(unplaced, 7), /no place matched any of these rises/);
});

test("the counted noun agrees wherever the cut can fire (T165)", () => {
  // `countOf(total, "spike")` rather than a bare `${total} spikes`, in the words the brief's own overview
  // line uses for the same number. A cut exists only where the week holds more rises than the chart draws,
  // so the number is two or more and the noun is always the plural — asserted rather than reasoned about,
  // because the only thing keeping it that way is `SPIKES_SHOWN` and the slice in lib/bundle.ts.
  for (let shown = 1; shown <= 6; shown++) {
    const caption = clinicianChartCaption(Array.from({ length: shown }, () => spike()), shown + 1);
    assert.match(caption, new RegExp(`Red markers are the ${shown} largest rises of ${shown + 1} spikes\\.`));
  }
});
