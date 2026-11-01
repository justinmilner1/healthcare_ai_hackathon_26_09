// What a page may say about where the patient was when a rise started (design §2.5, §2.6, §2.7, §7.4).
// Owner: sour. The patient's "biggest rises" table and the chart caption on all three surfaces read it.
//
// The place on a Spike comes from the Timeline export, which §2.5 makes optional and leaves to the patient
// page's own data panel — Sweetie never asks for it (T144). So a patient who shared only Dexcom has a spike
// table whose place column cannot ever say anything, and it used to fill every row with "no matching visit" (T82):
// the matcher's vocabulary (lib/match.ts: a spike *matches* a visit), on the one page written for the
// patient, using the one word — "visit" — that already means their appointment to them (§4.4). It also read
// as a lookup that had come back empty, for data §2.4 and §2.5 told them they need not give.
//
// So the patient's table asks here instead of spelling the rule out: with no place known the column is not
// drawn at all, and the chart caption above it stops promising places too — one predicate, so the caption
// and the table cannot disagree.
//
// The clinician's brief and the printed sheet draw the same distinction one step further in, in their own
// register (T160, T184). "no matching visit" is a true and useful thing to tell a reader who knows what the
// matcher is, so a visit that shared a Timeline keeps it, zero matches included: there the zero is a reading
// taken. A visit that shared no Timeline has had nothing looked up, so no element of those two surfaces
// reports a search — `clinicianPlaceReport` below is that three-way answer, and the tile, the chart caption,
// the card heading and the place cells all read it, which is what stops one of them contradicting another.
//
// T128 is the same question one row further in. A stop the matcher placed but the export never named falls
// through to the coordinates lib/location.ts gave it, and those were chosen for the clinician's surfaces;
// `placeIsUnnamed` and `UNNAMED_PLACE` below are the patient's answer to that case, read by the table and
// by the chart's marker labels through one function.
//
// Pure, and in lib/ rather than in the component, so both shapes can be held to this in a unit test (§12.1).

import { placeLabel } from "./location";
import { countOf, plural } from "./plural";
import type { Spike, Visit } from "./types";

/**
 * Whether any of these spikes was matched to a place (lib/match.ts).
 *
 * This is the whole decision: `false` means the Timeline export is not in this visit — or named nowhere the
 * patient went near a rise — so there is nothing a place column could report but its own absence.
 */
export function anyPlaceKnown(spikes: Spike[]): boolean {
  return spikes.some((s) => Boolean(s.visit));
}

/**
 * Whether any of these spikes was *not* matched to a place — `anyPlaceKnown`'s counterpart, and a different
 * question from its negation (T214).
 *
 * `anyPlaceKnown` is false only when *no* rise has a place; this is true as soon as *one* lacks one. Between
 * them they tell the three shapes of a chart apart, and the middle one is what needed a predicate: a chart
 * whose labels are all places, one whose labels are a mix of places and peak numbers, and one whose labels
 * are all peak numbers.
 *
 * | the listed rises | `anyPlaceKnown` | `anyPlaceMissing` | the labels on the chart |
 * |---|---|---|---|
 * | all matched | `true` | `false` | every one a place |
 * | some matched | `true` | `true` | places and peak numbers |
 * | none matched | `false` | `true` | every one a peak number |
 *
 * `clinicianPlaceReport` answers `matched` for the first two alike — one matched rise is all it asks for —
 * so a caption reading only the report cannot say which labels are in front of the clinician. This is the
 * second bit of that answer, and it is derived here beside the first rather than at the call site, for the
 * reason every other reading of these captions is.
 */
export function anyPlaceMissing(spikes: Spike[]): boolean {
  return spikes.some((s) => !s.visit);
}

/**
 * What the clinician's elements about places are allowed to be about on this visit (T184).
 *
 * `anyPlaceKnown` above answers "did any rise match", which is the right question for which heading a card
 * of matched rises gets and the wrong one for whether a lookup happened at all. T160 settled that for the
 * "Spikes > 180" stat tile by reading `IntakeStatus.hasLocation` instead — is there a Timeline export on
 * this visit — and left the chart caption and the card's place cells still asking the other one. So the
 * brief and the sheet said, four inches apart: `no Timeline data` on the tile, `no place matched any of
 * these rises` under the chart, `no matching visit` down the card. The first is an absent source, the other
 * two a search that came back empty, and a clinician reading them in order cannot tell which happened.
 *
 * Three states, so that none of them can be read as another:
 *
 * | the visit | report | what the surfaces may say |
 * |---|---|---|
 * | a Timeline, some listed rise matched a stop | `matched` | the places, and the peak where a rise has none |
 * | a Timeline, no listed rise matched | `unmatched` | the zero — there it is a reading taken (T160) |
 * | no Timeline export at all | `no-timeline` | nothing about places; the tile owns the absent source |
 *
 * `hasLocation` is asked first on purpose. A matched stop can only have come out of a Timeline, so a visit
 * holding one with `hasLocation` false is a bundle contradicting itself, and the ordering is which half of
 * it the surfaces believe. They believe the field, because it is the one the tile has read since T160 and
 * these four elements agreeing with each other is the whole of this ticket: an ordering that let the card
 * name places the tile beside it says were never shared would be the same bug with the arguments swapped.
 */
export type PlaceReport = "matched" | "unmatched" | "no-timeline";

/** The one answer the caption, the heading, the place cells and the tile all read, off `PatientBundle.status`. */
export function clinicianPlaceReport(spikes: Spike[], { hasLocation }: { hasLocation: boolean }): PlaceReport {
  if (!hasLocation) return "no-timeline";
  return anyPlaceKnown(spikes) ? "matched" : "unmatched";
}

/**
 * Whether the clinician's spike card draws a place column at all (components/SpikeTable.tsx, T184).
 *
 * It does for both of the reports that had something to look in, because `NO_MATCH_CELL` below is then the
 * matcher reporting and is worth a clinician's while (T82). It does not where there was nothing to look in:
 * a column of that sentence over a visit with no Timeline export is five rows of a search that never ran,
 * under a stat tile already saying no Timeline was shared. The patient's §2.7 table drops its column on a
 * stricter test of its own — `anyPlaceKnown`, no row with a place to show (T82) — and this is that rule
 * arriving on the clinician's side in the clinician's register.
 */
export function clinicianPlaceColumn(spikes: Spike[], status: { hasLocation: boolean }): boolean {
  return clinicianPlaceReport(spikes, status) !== "no-timeline";
}

/**
 * What the clinician's place cell says for a listed rise the matcher placed nowhere.
 *
 * In this module rather than in the component for the reason `UNKNOWN_PLACE` is: it is one of the strings
 * this file is answerable for, so the test that no element reports a lookup on a visit with no Timeline can
 * read all of them (§12.1). `clinicianPlaceColumn` above is what keeps it off that visit's surfaces.
 */
export const NO_MATCH_CELL = "no matching visit";

/**
 * The patient's word for a rise with no place against it, used only where some *other* row has one.
 *
 * "not sure" is the page admitting it does not know, in the register of the rest of it ("Here's your story",
 * "What you told Sweetie"). It reports no failure and asks nothing of the patient, and it borrows no word
 * from the matcher — least of all "visit", which on this page is the appointment they are preparing for.
 */
export const UNKNOWN_PLACE = "not sure";

/**
 * Whether a place the matcher *did* find is one the Timeline export never named.
 *
 * Google's export carries no place names, so a stop is named only if `placeId` or proximity found it in the
 * practice's hand-labelled list; until then `place` is the stop's own coordinates to three decimals
 * (lib/location.ts, T62). Two clauses because there are two ways to be that: the label T62 mints, compared
 * against the function that mints it, and the shape of one, so a `place` that arrives as coordinates by any
 * other route — a hand label that is itself a lat/long — cannot reach the patient either.
 */
export function placeIsUnnamed(visit: Visit): boolean {
  return visit.place === placeLabel(visit.lat, visit.lng) || COORDINATES.test(visit.place);
}

/** A lat/long pair as lib/location.ts writes one: three decimals each, comma, space. */
const COORDINATES = /^-?\d+\.\d{3}, -?\d+\.\d{3}$/;

/**
 * The patient's word for a stop the export placed but never named (T128).
 *
 * The coordinates are right where T62 put them and wrong here. "Where" on §2.7's page sits under "A simple
 * timeline to help you remember what was happening", and `37.790, -122.401` is the one cell on that page
 * written in the vocabulary of the data: nobody remembers a Sunday evening by its latitude. What anchors
 * the memory is already in the row beside it — "Sun 10:30 PM" — so this says only the part the page does
 * know, in the register of "not sure" above it, and lets the time do the rest.
 *
 * T62's own argument does not carry across: it kept coordinates over "an unnamed place" partly so that
 * three spikes at three different unnamed stops would not read as one place. That is a clinician reasoning
 * about a week of places. The patient is not reading this column as a set — each row is one moment of their
 * own week — and a repeated lat/long is not how any of them would notice they had been somewhere twice.
 *
 * Sixteen characters, which is also the longest label GlucoseChart will draw over a marker without
 * trimming it: the chart and the table say this in one string, so neither can be the surface that still
 * shows coordinates, and neither shows a phrase cut to "a place you we…".
 */
export const UNNAMED_PLACE = "a place you went";

/** What the patient's "biggest rises" table puts in the Where cell for a rise that matched a stop. */
export function patientPlaceName(visit: Visit): string {
  return placeIsUnnamed(visit) ? UNNAMED_PLACE : visit.place;
}

/**
 * Which story linked this rise to the stop on it, and by how long (T191, T192, T193).
 *
 * The matcher takes a visit that *overlaps* the rise and a visit that *ended within 30 minutes before* it,
 * picks the closest, and leaves the same `visit` field behind either way — so the field says a place and
 * not a story. The stories are different: a rise that began during a sit-down meal is the patient still at
 * the table, and a rise that began after the stop is the patient already somewhere else. The clinical
 * reading of one place label depends on which, and §2.6's card has always had it per row ("while there",
 * "left 25 min before"); the caption over the chart asserted the second for every label on it.
 *
 * So the derivation lives here, once, and every element that says where the patient was reads it: the
 * Place column, the caption over it, the relation word lib/sour.ts hands the model, and — since T193 — the
 * subtitle on the patient's own chart. `null` is a rise the matcher placed nowhere, which is the
 * `NO_MATCH_CELL` case and carries no relation at all.
 *
 * `overlaps` is **two** of those stories and not one, which is T192. It holds when the stop was already
 * running as the readings began to climb — the sit-down meal above — and it holds just as readily when the
 * stop began *after* the rise had started, any time up to the peak: the patient walked in while their
 * glucose was already going up. §7's spike window is up to two hours from start to peak, and
 * `matchSpikesToVisits` scores every overlap at `gap = 0` and keeps the first one it sees, so the stop on a
 * rise need not be the one that was running when it began. Collapsing the two gave the clinician a caption
 * reading "the place the patient was at when the rise began" over a place they reached ten minutes into the
 * climb, and a row reading "while there" beside it — the two agreeing with each other and both false. A
 * rise that began before the patient arrived somewhere did not start with a meal there, which is why the
 * distinction is clinical and not cosmetic.
 *
 * Three kinds, told apart by two gaps rather than by lib/match.ts's predicate, because a gap is what the
 * row already shows:
 *
 * | the stop | kind | the cell |
 * |---|---|---|
 * | ended before the rise began | `after` | `left 25 min before` |
 * | was running when the rise began | `during` | `while there` |
 * | began after the rise had | `arrived` | `arrived 10 min after` |
 *
 * Both gaps are rounded to the minute before they are compared, so a cell's number and this answer cannot
 * disagree about a stop that ended, or began, seconds either side of the rise. A stop that began in the
 * same minute the readings turned is `during`: "while there" is the true thing to say about it, and there
 * is no "arrived 0 min after" to draw.
 */
export type SpikeVisitRelation = { kind: "during" } | { kind: "after"; gapMin: number } | { kind: "arrived"; gapMin: number };

/** The relation between a rise and the stop the matcher put on it, or `null` where it placed none. */
export function spikeVisitRelation(spike: Spike): SpikeVisitRelation | null {
  if (!spike.visit) return null;
  const start = Date.parse(spike.start);
  const sinceStopEnded = Math.round((start - Date.parse(spike.visit.end)) / 60000);
  if (sinceStopEnded > 0) return { kind: "after", gapMin: sinceStopEnded };
  const untilArrival = Math.round((Date.parse(spike.visit.start) - start) / 60000);
  return untilArrival > 0 ? { kind: "arrived", gapMin: untilArrival } : { kind: "during" };
}

/**
 * What the clinician's place cell says after the place name, when the card has room for it
 * (components/SpikeTable.tsx; `compact` drops it on the patient's page and the printed sheet).
 *
 * In this module rather than in the component for the reason `NO_MATCH_CELL` is: it is a string this file
 * is answerable for, and the caption over the card is written off the same relation, so the two cannot come
 * to different conclusions about one match (T191). Empty for a rise with no place, which is the cell that
 * reads `NO_MATCH_CELL` or `UNKNOWN_PLACE` instead and has no suffix to carry.
 *
 * "arrived 10 min after" is the mirror of "left 25 min before" and elides the same three words: both gaps
 * are counted from the minute the readings began to climb, which is the one instant all three cells are
 * about (T192).
 */
export function spikeRelationCell(spike: Spike): string {
  const relation = spikeVisitRelation(spike);
  if (!relation) return "";
  switch (relation.kind) {
    case "after":
      return `left ${relation.gapMin} min before`;
    case "arrived":
      return `arrived ${relation.gapMin} min after`;
    case "during":
      return "while there";
  }
}

/**
 * The label GlucoseChart draws over a spike's marker: the place where there is one, the peak reading where
 * there is not (components/GlucoseChart.tsx picks which markers get a label at all).
 *
 * `patient` is the §2.7 page, and is the whole of the split: the brief and the printed sheet keep the
 * coordinates, which are true and useful to a reader who knows what the matcher is. One function for both,
 * so the marker over a rise and the row under it cannot come to different conclusions about the same
 * spike — the bug T82 and T99 each had to fix once already.
 */
export function markerLabel(spike: Spike, { patient }: { patient: boolean }): string {
  if (!spike.visit) return String(spike.to);
  return patient ? patientPlaceName(spike.visit) : spike.visit.place;
}

/**
 * What the patient's caption says a marker's label is, worded for the relations the labelled rises actually
 * have (T193). `matchedPlaceClause` above is the same derivation in the clinician's register.
 *
 * The sentence used to be one literal: "where you had just been". That is `spikeVisitRelation`'s `after`
 * branch, asserted for every label on the chart — and on both of the fixtures this page is ever seen with,
 * the seeded demo week and the mixed-places sample, not one labelled rise is that branch. Two began while a
 * stop was still running and one began before the patient arrived at all, so the subtitle asked them to
 * remember leaving three places they had not left.
 *
 * Three clauses, the same split the Place column shows the clinician per row, because each of the two
 * specific ones is a claim about where the patient stood at one minute:
 *
 * | the labelled rises | the clause |
 * |---|---|
 * | every one began after its stop ended | where you had just been |
 * | every one began while its stop was running | where you were at the time |
 * | any other mix, an `arrived` among them included | where you were around then |
 *
 * None of it is the matcher's vocabulary (T82), and none of it is the clinician's: §2.7 is the second
 * person throughout, so "while there" and "the place the rise was linked to" are not the words to reach
 * for. "Around then" is the neutral one — true of a stop they had left, one they were sitting in and one
 * they walked into partway up the climb — and it is what the mixed week gets, because the page has nothing
 * under it that tells the three apart: `compact` drops the relation suffix from the rises table
 * (components/SpikeTable.tsx), so this sentence is the only thing on the screen saying anything about the
 * relation and it may not say more than it knows.
 *
 * Only ever called where some rise carries a place, so the set of kinds is never empty.
 */
function patientPlaceClause(spikes: Spike[]): string {
  const kinds = new Set(spikes.map((s) => spikeVisitRelation(s)?.kind).filter((kind) => kind !== undefined));
  if (kinds.size === 1) {
    if (kinds.has("after")) return "where you had just been";
    if (kinds.has("during")) return "where you were at the time";
  }
  return "where you were around then";
}

/**
 * The subtitle under the patient's glucose card, which names what the markers on it carry.
 *
 * GlucoseChart labels a marker with its spike's place when there is one and with the peak reading when there
 * is not, so the sentence about places is only true in the first case — and a caption promising a place
 * above a table with no Where column is the same bug read twice (T82). `anyPlaceKnown` is therefore still
 * the predicate, the one the table's column reads, so the two cannot disagree about whether this week has
 * places in it at all.
 *
 * What the clause then says about those places is `patientPlaceClause` above and the relations they have
 * (T193). It said "where you had just been" of all of them until then — the one thing the matcher's
 * `endedJustBefore` branch means, over a chart whose labels can be any of three.
 *
 * Two things about the markers themselves it also may not say (T199). Not "rises" in the plural over the
 * one marker a single rise draws, and not that the markers show anything at all where there are none: with
 * no rise over 180 the sentence is `NO_RISES_TO_MARK_PATIENT` above and the place clause does not arise,
 * since a week with no rises has no matched one either. Everything from one rise up keeps the shape it had
 * and takes its agreement from `plural`.
 *
 * And one thing about the labels, which is the state `anyPlaceKnown` cannot see (T204). That predicate
 * answers whether a place is *known* — the question the Where column reads too (T82) — and `, when
 * available` is the hedge for it. Whether the label for a known place was *drawn* is a second question
 * entirely: `lib/markerLabels.ts` drops a label that would collide with a neighbouring label or marker and
 * keeps the bare dot (T23, T197), so a rise this sentence has placed can reach §2.7's chart as a red dot
 * with nothing over it. The mixed-places sample does it at both widths — the `Sun 10:30 PM` rise loses its
 * sixteen-character `a place you went` to the `202` label 44px to its left, and at 375px the `202` goes too
 * — and the patient has nothing on that page to read a bare dot as anything but a rise with no place:
 * `compact` drops the relation suffix from the table (components/SpikeTable.tsx), and the caption above was
 * the only element saying what a label is.
 *
 * The clinician's twin has hedged exactly this since T99, in four words of its own (`Labels, where they
 * fit,` in `clinicianChartCaption` below). This one says it in §2.7's second person rather than borrowing
 * them, and counts the labels it is about rather than fixing their plural — the mistake T200 had to come
 * back for one caption down, where a half-sentence after the comma stayed plural over a single rise. The
 * clause is on the place branch alone, because it is a claim about a label that names a place: where no
 * place is known every label is a peak reading, which this sentence deliberately says nothing about (T199,
 * T204's "not in scope"), and over no rises at all there is no label to describe.
 *
 * The hedge stays unconditional, which is the one thing this caption does *not* share with its clinician
 * twin (T214). There the trailing clause offers a second reading — "or the peak mg/dL where no place
 * matched" — and an offer is empty over a chart whose every label is a place, so it is now on
 * `anyPlaceMissing`. `, when available` offers nothing: it is T204's hedge on whether the label for a
 * placed rise was *drawn*, and `lib/markerLabels.ts` drops a colliding label whatever matched, so a week
 * with every rise placed still reaches §2.7's chart as a red dot with nothing over it. The question it
 * hedges is availability and not matching, it is true at every mix including all-matched, and the
 * patient's register has no second reading to withdraw — so there is nothing here for this ticket to
 * condition.
 */
export function patientChartCaption(spikes: Spike[]): string {
  if (spikes.length === 0) return NO_RISES_TO_MARK_PATIENT;
  const n = spikes.length;
  const markers = `${plural(n, "Marker")} ${plural(n, "shows", "show")} your ${patientRiseNoun(n)}.`;
  if (!anyPlaceKnown(spikes)) return markers;
  const labels = plural(n, "The label that fits says", "The labels that fit say");
  return `${markers} ${labels} ${patientPlaceClause(spikes)}, when available.`;
}

/**
 * What §2.7 calls the rises it is showing the patient, agreeing with how many there are (T203).
 *
 * The two sentences on that page that name them are the caption over the chart and the heading over the
 * table under it, and they name them with the same three words: "your biggest rise" and "Your biggest
 * rises". So the noun phrase is decided once, here, rather than twice — the heading was a literal
 * `"Your biggest rises"` in the JSX while T199 taught the caption to count, and the page then said both
 * things about the same single rise in one frame: "Marker shows your biggest rise." over a chart with one
 * dot, and "Your biggest rises" over a table with one row.
 *
 * Bare of its article so the caption can keep the lower-case "your" its sentence needs and the heading can
 * capitalise its own; `plural` in lib/plural.ts is the agreement, for T198's reason.
 */
function patientRiseNoun(n: number): string {
  return plural(n, "biggest rise", "biggest rises");
}

/**
 * The heading over the patient's rises table, which counts the rows under it (T203).
 *
 * `patientChartCaption` above is the sentence it has to agree with — they are one card apart on §2.7's
 * page, in one frame at either width — so both read `patientRiseNoun` and both count the array they are
 * handed. The page hands each of them `bundle.spikes`, the same array SpikeTable draws its rows from
 * (app/patient/[id]/page.tsx), so there is no count for the two of them to disagree about.
 *
 * No branch at nought, unlike `clinicianSpikeCardHeading`: the clinician's card is on screen for every
 * visit that shared readings and says "No spikes over 180 detected." inside itself, while this one is
 * rendered only where there is a rise to list, and `patientChartCaption` is what §2.7 says instead about a
 * week with none. "Rises" is the right form for nought anyway, which is what `plural` returns for it.
 */
export function patientSpikeCardHeading(spikes: Spike[]): string {
  return `Your ${patientRiseNoun(spikes.length)}`;
}

/** The one sentence about the target band, identical on the brief and on the printed sheet. */
const TARGET_BAND = "Shaded band is 70–180 mg/dL.";

/**
 * What each caption says instead when the chart draws no marker at all (T199).
 *
 * The chart card is on screen for any visit that shared readings — gated on `hasDexcom` on the clinician's
 * two surfaces, on nothing at all on the patient's — so a week that never crossed 180 still gets a chart,
 * and every sentence the captions below are otherwise made of is a claim about a set that is empty: what
 * the red markers are, and what the labels on them give. That is the *well-controlled* week, the best
 * outcome §7 has to report, and it was the one the caption described least accurately; with no rises there
 * is no rises table under it either (app/patient/[id]/page.tsx, components/SpikeTable.tsx), so nothing on
 * the screen contradicted it.
 *
 * Naming the absence rather than falling silent, because the question a reader of a clean trace is left
 * with is whether the markers are missing or the rises are — T82's bug read a third time, a caption
 * promising something the element under it has not got. The threshold is the one the tile and the card
 * heading already use ("Spikes > 180", "No spikes over 180 detected."), in each surface's own register:
 * §2.6 and §7.4 are the clinician's, terse and third-person, and §2.7 is the patient's second person
 * throughout. Neither says anything about the readings staying in range, which is a different claim and
 * can be false of a week with no rise in it — a span spent under 70 clears this threshold too.
 */
const NO_RISES_TO_MARK = "No rises over 180 to mark.";
const NO_RISES_TO_MARK_PATIENT = "You had no rises over 180, so the chart shows no markers.";

/**
 * What the caption says the red markers are, which is a claim about how many of the week's rises are drawn.
 *
 * `GlucoseChart` is handed `PatientBundle.spikes` — the top `SPIKES_SHOWN` by rise — on both clinician
 * surfaces, while the "Spikes > 180" tile a few inches above reads `PatientBundle.spikeTotal`, every rise
 * in the readings (T164). So "Red markers are spikes." was true only while the two agreed: on the seeded
 * demo week it sat under a tile reading 7 over five markers, and the two rises it left out (peaks 199 and
 * 196) were drawn as unlabelled crests inside the shaded band's upper edge. A clinician could count the
 * markers, get five, and have nothing on the surface to say which number was wrong (T165).
 *
 * `clinicianSpikePlacesHint` reconciles the same cut for the card, and this is the choice T165 made for the
 * chart: scope the sentence rather than draw all 28 markers the capped fixture holds. §7 is about numbers a
 * clinician can trust, not about marker density, and the caption is the half of the pair that was false.
 *
 * "largest rises" and not "largest spikes" because `detectSpikes` sorts by rise and the slice is taken off
 * that order — the five drawn are the five biggest climbs, not the five highest peaks. The counted noun is
 * `countOf`'s, so the sentence says "7 spikes" in the words the brief's own overview line uses for the same
 * number.
 *
 * Where the week holds no more than the card lists there is no cut to disclose, and the sentence says
 * nothing about one: a caption reading "the 5 largest rises of 5 spikes" would invent the discrepancy
 * T160 and T164 were careful not to invent on the tile.
 *
 * That uncapped sentence was a fixed plural, and `total <= shown` is as true at one rise as at five (T199).
 * So the visit whose week holds a single rise — e2e/flags.spec.ts's flagged brief, where the tile reads 1
 * and the card lists one row — carried "Red markers are spikes." over one dot. It is T198 one card up and
 * T60's "1 spikes" a third time, so the fix is the same one: the noun, the verb and the complement all
 * agree with the number of markers through `plural`, never through a ternary written here (`lib/plural.ts`
 * opens by saying why). At two and above the string is the one it has always been, which is what keeps
 * every surface asserted on the capped and the multi-rise week unmoved.
 *
 * Never called at zero: a sentence about what the markers are is a claim about a set that is empty there,
 * and the captions below answer that case before they reach this (`NO_RISES_TO_MARK`).
 */
function markerSentence(shown: number, total: number): string {
  if (total <= shown) return `Red ${plural(shown, "marker")} ${plural(shown, "is", "are")} ${plural(shown, "a spike", "spikes")}.`;
  return `Red markers are the ${shown} largest rises of ${countOf(total, "spike")}.`;
}

/**
 * What the matched caption says a place label is, worded for the relations the labelled rises actually have
 * (T191, T192).
 *
 * The sentence used to be one literal: "the place the patient had just left". That is `spikeVisitRelation`'s
 * `after` branch, asserted over a chart whose labels can be any of three — and on the seeded week it was
 * the wrong one for all three of them, four inches above a Place column reading "while there" three times.
 * The genre is T165's and T184's: two elements of one card reporting different things about one match.
 *
 * Each of the two specific clauses is a claim about where a person stood at a specific minute, so each is
 * reserved for a set of labels that is wholly the one relation. Everything else names the place and stops:
 *
 * | the labelled rises | the clause |
 * |---|---|
 * | every one began after its stop ended | the place the patient had just left |
 * | every one began while its stop was running | the place the patient was at when the rise began |
 * | any other mix, an `arrived` among them included | the place the rise was linked to |
 *
 * The last row widening is T192. The middle clause used to cover `arrived` too, because the two were one
 * `during` — and over a stop the patient reached ten minutes into the climb that sentence is simply false,
 * the more so since T191 sharpened it from "the place the patient had just left" into a claim about one
 * minute. There is no fourth clause for an all-`arrived` week: naming the place and asserting no relation
 * is what the mixed reading does, and the per-row cell ("arrived 10 min after") is the element that says
 * which of the three a given label is — the same division of labour T191 settled for the first two.
 *
 * The neutral clause borrows "linked" from `clinicianSpikeCardHeading`'s own "Spikes linked to places"
 * rather than minting a fourth word for a match.
 *
 * Only ever called on the `matched` report, where at least one rise carries a place — so the set of kinds
 * is never empty, and the unplaced rises alongside them, which contribute no kind, are the half of the
 * sentence that comes after this clause.
 */
export function matchedPlaceClause(spikes: Spike[]): string {
  const kinds = new Set(spikes.map((s) => spikeVisitRelation(s)?.kind).filter((kind) => kind !== undefined));
  if (kinds.size === 1) {
    if (kinds.has("after")) return "the place the patient had just left";
    if (kinds.has("during")) return "the place the patient was at when the rise began";
  }
  return "the place the rise was linked to";
}

/**
 * The caption under the glucose chart on the two clinician surfaces: the brief (§2.6) and the printed
 * one-pager (§7.4). One function, so the two strings cannot drift apart (T99).
 *
 * It used to promise, on both, that the red markers were "labeled with the place the patient had just
 * left". They are labeled with the place when one matched and with the peak mg/dL when none did
 * (components/GlucoseChart.tsx), and §2.5 makes the Timeline export optional — so on the ordinary
 * Dexcom-only visit every label was a number the caption called a place, beside a Spikes card already
 * reading "0 linked to a place".
 *
 * What it therefore does not say — a list rather than a count, because every ticket on this caption has
 * added a reading to it. Not that a label is a place, unless one is: where a Timeline was
 * shared and nothing matched, the caption names the peak reading and says outright that nothing matched,
 * which is what the card beside it says. Not that a match was tried where no Timeline was shared, which is
 * T184 and the `no-timeline` branch: the sentence stops at what a label is, and the stat tile beside it is
 * the one element that names the source nobody sent (`NO_TIMELINE_HINT`). Not that every marker carries a
 * label: GlucoseChart drops a label that would collide with the one before it, keeping the marker, so the
 * labels are the ones that fit. And not that the markers are the week's rises when they are the largest few
 * of them — `markerSentence` above, which takes the `total` the stat tile shows so that the chart and the
 * tile cannot be counted against each other (T165). And not that there is more than one marker when the
 * week holds one rise, nor that there are markers and labels at all when it holds none: the plural was
 * fixed in that sentence and the labels clause followed it unconditionally, so both of them described an
 * empty set on the cleanest week the product reports (T199, `NO_RISES_TO_MARK` above). And not, in the
 * `unmatched` clause after the colon, that there is more than one rise on the chart when there is one: T199
 * made the marker half of that sentence agree with the count and left the half after it a fixed plural, so
 * a week with a single unplaced rise read "Red marker is a spike" and "any of these rises" eleven words
 * apart in one caption (T200). The `unmatched` branch is as reachable at one rise as at five — a Timeline
 * shared and no stop inside lib/match.ts's window — so the clause counts the markers it is about, through
 * the same `plural` the sentence in front of it uses. And not that the patient had left the place a label
 * names, nor that they were standing in it when the rise began, unless the labels on the chart are all one
 * or all the other: the matcher links a rise to a stop it overlaps as readily as to one that ended just
 * before it, and an overlap is itself either the stop they were already in or one they walked into partway
 * up the climb (T192). So the clause comes from `matchedPlaceClause` above and the relations the labelled
 * rises actually have, which is the same derivation the Place column under the chart shows per row (T191).
 * And — the symmetric claim to the first on this list, and the last of them to be reached — not that some
 * label is a peak number when every label is a place (T214). `clinicianPlaceReport` answers `matched` as
 * soon as one listed rise carries a stop, so that one branch captions two different charts: labels that are
 * a mix of places and peak numbers, and labels that are all places. The offer of a second reading is true
 * of the mix and describes an empty set on the other, where it sat directly above a card headed "Spike
 * linked to a place" and a tile reading "1 · 1 linked to a place". So it is on `anyPlaceMissing` above,
 * which is the question the labels answer rather than the one the report answers, and the sentence ends at
 * the place clause where every listed rise matched.
 *
 * `status` is `PatientBundle.status`, the argument order `clinicianSpikePlacesHint` already takes it in.
 */
export function clinicianChartCaption(spikes: Spike[], status: { hasLocation: boolean }, total: number): string {
  if (spikes.length === 0) return `${TARGET_BAND} ${NO_RISES_TO_MARK}`;
  const markers = markerSentence(spikes.length, total);
  const labels = "Labels, where they fit,";
  switch (clinicianPlaceReport(spikes, status)) {
    case "matched": {
      // The peak-mg/dL reading is offered only where the chart carries a label of that kind, which is the
      // one thing the report cannot tell (T214).
      const places = `${labels} give ${matchedPlaceClause(spikes)}`;
      return anyPlaceMissing(spikes)
        ? `${TARGET_BAND} ${markers} ${places}, or the peak mg/dL where no place matched.`
        : `${TARGET_BAND} ${markers} ${places}.`;
    }
    case "unmatched":
      return `${TARGET_BAND} ${markers} ${labels} give the peak mg/dL: no place matched ${plural(spikes.length, "this rise", "any of these rises")}.`;
    case "no-timeline":
      return `${TARGET_BAND} ${markers} ${labels} give the peak mg/dL.`;
  }
}

/**
 * The heading over the spike card on the two clinician surfaces: the brief (§2.6) and the printed one-pager
 * (§7.4). One function, for the reason `clinicianChartCaption` above is one (T99, T157).
 *
 * It was the constant "Spikes linked to places" on both, while whether anything is linked is the question
 * this module exists to answer. §2.5 leaves the Timeline export to the patient page's optional data panel
 * and Sweetie never asks for it (T144), so the ordinary visit is Dexcom-only and nothing in that card is
 * linked to anywhere. The brief then said the same thing three ways and contradicted itself once: the stat
 * tile beside the card read "0 linked to a place", the caption under the chart read "no place matched any
 * of these rises", every row of the card read "no matching visit" — and the heading over them claimed the
 * opposite. On paper too, which is the copy a clinician carries into the room.
 *
 * So the heading reads the same `clinicianPlaceReport` the caption does and the rows do, and cannot drift
 * from them. Three readings, because the card has three shapes — and each of them counts the rows under
 * it, which is T213 (the right-hand column was two fixed plurals until then):
 *
 * | the card | heading at one row | at two or more |
 * |---|---|---|
 * | some rise matched a place | `Spike linked to a place` | `Spikes linked to places` |
 * | rises, no place to report against them | `Spike over 180` | `Spikes over 180` |
 * | no rises at all | — | `Spikes` |
 *
 * The middle one is the card's own subject with the half it cannot deliver dropped, and it covers both of
 * the reports that are not `matched` — it is already silent about places, which is all T184 asks of it.
 * What is under it differs by report, and that is SpikeTable's: with a Timeline shared the `Place` column
 * stays and reads "no matching visit", a true and useful thing to tell a reader who knows what lib/match.ts
 * does (T82); with no Timeline there is no column, because an absence of optional data is not a search that
 * failed. The last reading is a heading over SpikeTable's "No spikes over 180 detected.", which says the
 * state already: naming the threshold above it would read as though some had cleared it. It has no
 * one-row column because it is the row count it is about; "Spikes" is what `plural` returns at nought,
 * so the bare heading T157 chose for it is the plural branch and not a literal of its own.
 *
 * Counting at one is the agreement `clinicianChartCaption` above has had since T199 and T200, arriving on
 * the heading directly under it (T213). The two are one card apart on both surfaces and in one frame at
 * either width, and the page hands each of them `bundle.spikes` — the array SpikeTable draws its rows
 * from (app/provider/[id]/sour.tsx, app/provider/visit/[id]/print/page.tsx) — so there is no count for
 * them to disagree about. Until this ticket they disagreed about its grammar instead: the single-rise
 * brief read "Red marker is a spike … no place matched this rise." over a card headed "Spikes over 180",
 * and over a matched single rise the heading said both nouns in the plural at once. That is T203 on the
 * patient's page (`patientSpikeCardHeading` above, whose note named this function as the one that branches
 * at nought without noticing it did not branch at one), read in the clinician's register.
 *
 * Both nouns go through `plural` in lib/plural.ts, never through a literal at the call site, for T198's
 * reason: the place noun is counted as well as the spike noun, because one rise is linked to one place and
 * "Spike linked to places" would be the bug half-fixed.
 */
export function clinicianSpikeCardHeading(spikes: Spike[], status: { hasLocation: boolean }): string {
  const n = spikes.length;
  const spikeNoun = plural(n, "Spike");
  if (clinicianPlaceReport(spikes, status) === "matched") return `${spikeNoun} linked to ${plural(n, "a place", "places")}`;
  return n === 0 ? spikeNoun : `${spikeNoun} over 180`;
}

/**
 * The hint under the "Spikes > 180" stat tile on the two clinician surfaces: the brief (§2.6) and the
 * printed one-pager (§7.4). One function, for the reason `clinicianSpikeCardHeading` above is one (T160).
 *
 * It was the template literal `${n} linked to a place` on both, which made it the last element of that
 * metrics row to say something about places without first asking whether any place data exists. §2.5 leaves
 * the Timeline export to the patient page's optional data panel and Sweetie never asks for it (T144), so the
 * ordinary visit has none — and the row then read:
 *
 * ```
 * Spikes > 180  5 · 0 linked to a place   <- a measured zero, over a source nobody shared
 * Sleep         — · no WHOOP data         <- the same absence, named
 * ```
 *
 * A clinician reading that zero cannot tell which of three things happened: a Timeline was shared and no
 * rise matched a stop, one was shared and the patient went nowhere, or none was ever shared. The tile beside
 * it answers exactly that question about the other optional source, and T82 settled the same point for the
 * patient's §2.7 page: an absence of optional data is not a measurement.
 *
 * So the decision is `IntakeStatus.hasLocation` (lib/bundle.ts: the visit has a Timeline export at all), the
 * exact sibling of the `hasWhoop` the Sleep tile is branched on — and deliberately **not** `anyPlaceKnown`,
 * which answers "did any rise match" and so cannot separate "shared and nothing matched" from "never
 * shared". Only the second was T160's: a visit that shared a Timeline keeps its count, zero included,
 * because there the zero is a reading taken. T184 is the two elements under this tile joining it, so the
 * distinction now has a name and one function behind it — `clinicianPlaceReport` above, which this tile
 * reads for the same answer the caption and the cells read. This is still the only element that names the
 * absent source: the others fall silent about places instead, so the row says it once (the T170 split).
 *
 * T164 put a second sentence in front of that one. The tile's value is `PatientBundle.spikeTotal` — every
 * spike in the readings — while the card under it lists only the top `SPIKES_SHOWN` by rise, so on the
 * seeded demo week a clinician reads **7** over five rows. The hint is where that is reconciled, because it
 * is the one line attached to the number itself: `total` is what the tile shows and `spikes` is what the
 * table shows, and when they differ the hint opens by saying which is which. It opens with the cap rather
 * than closing with it so that the place count, which is a count *of the listed rows*, is already scoped by
 * the time it is read.
 */
export function clinicianSpikePlacesHint(spikes: Spike[], status: { hasLocation: boolean }, total: number): string {
  const places =
    clinicianPlaceReport(spikes, status) === "no-timeline"
      ? NO_TIMELINE_HINT
      : `${spikes.filter((s) => s.visit).length} linked to a place`;
  return total > spikes.length ? `top ${spikes.length} shown · ${places}` : places;
}

/**
 * How the tile names the missing source, in the words the tile beside it uses for its own ("no WHOOP data").
 *
 * "Timeline" is what both clinician surfaces already call this export in their sources line
 * (app/provider/[id]/sour.tsx, app/provider/visit/[id]/print/page.tsx), so the hint borrows no new noun.
 */
export const NO_TIMELINE_HINT = "no Timeline data";
