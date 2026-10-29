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
import { countOf } from "./plural";
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
 * Which of lib/match.ts's two branches linked this rise to the stop on it, and by how long (T191).
 *
 * The matcher takes a visit that *overlaps* the rise and a visit that *ended within 30 minutes before* it,
 * picks the closest, and leaves the same `visit` field behind either way — so the field says a place and
 * not a story. The two are different stories: a rise that began during a sit-down meal is the patient still
 * at the table, and a rise that began after the stop is the patient already somewhere else. The clinical
 * reading of one place label depends on which, and §2.6's card has always had it per row ("while there",
 * "left 25 min before"); the caption over the chart asserted the second for every label on it.
 *
 * So the derivation lives here, once, and both elements read it. `null` is a rise the matcher placed
 * nowhere, which is the `NO_MATCH_CELL` case and carries no relation at all.
 *
 * The test is the sign of the gap and not `lib/match.ts`'s `overlaps` predicate, because the gap is what
 * the row already shows: a visit that ends after the rise begins has nothing to count down from, and
 * "while there" is the true thing to say about every one of them. Rounded to the minute before the
 * comparison, so the cell's number and this answer cannot disagree about a stop that ended seconds before.
 */
export type SpikeVisitRelation = { kind: "during" } | { kind: "after"; gapMin: number };

/** The relation between a rise and the stop the matcher put on it, or `null` where it placed none. */
export function spikeVisitRelation(spike: Spike): SpikeVisitRelation | null {
  if (!spike.visit) return null;
  const gapMin = Math.round((Date.parse(spike.start) - Date.parse(spike.visit.end)) / 60000);
  return gapMin > 0 ? { kind: "after", gapMin } : { kind: "during" };
}

/**
 * What the clinician's place cell says after the place name, when the card has room for it
 * (components/SpikeTable.tsx; `compact` drops it on the patient's page and the printed sheet).
 *
 * In this module rather than in the component for the reason `NO_MATCH_CELL` is: it is a string this file
 * is answerable for, and the caption over the card is written off the same relation, so the two cannot come
 * to different conclusions about one match (T191). Empty for a rise with no place, which is the cell that
 * reads `NO_MATCH_CELL` or `UNKNOWN_PLACE` instead and has no suffix to carry.
 */
export function spikeRelationCell(spike: Spike): string {
  const relation = spikeVisitRelation(spike);
  if (!relation) return "";
  return relation.kind === "after" ? `left ${relation.gapMin} min before` : "while there";
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
 * The subtitle under the patient's glucose card, which names what the markers on it carry.
 *
 * GlucoseChart labels a marker with its spike's place when there is one and with the peak reading when there
 * is not, so the half-sentence about places is only true in the first case — and a caption promising "where
 * you had just been" above a table with no Where column is the same bug read twice (T82).
 */
export function patientChartCaption(spikes: Spike[]): string {
  return anyPlaceKnown(spikes)
    ? "Markers show your biggest rises and where you had just been, when available."
    : "Markers show your biggest rises.";
}

/** The one sentence about the target band, identical on the brief and on the printed sheet. */
const TARGET_BAND = "Shaded band is 70–180 mg/dL.";

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
 * Where the week holds no more than the card lists there is no cut to disclose, and the sentence is the one
 * it has always been: a caption reading "the 5 largest rises of 5 spikes" would invent the discrepancy
 * T160 and T164 were careful not to invent on the tile.
 */
function markerSentence(shown: number, total: number): string {
  if (total <= shown) return "Red markers are spikes.";
  return `Red markers are the ${shown} largest rises of ${countOf(total, "spike")}.`;
}

/**
 * What the matched caption says a place label is, worded for the relations the labelled rises actually have
 * (T191).
 *
 * The sentence used to be one literal: "the place the patient had just left". That is `spikeVisitRelation`'s
 * `after` branch, asserted over a chart whose labels can be either branch — and on the seeded week it was
 * the wrong one for all three of them, four inches above a Place column reading "while there" three times.
 * The genre is T165's and T184's: two elements of one card reporting different things about one match.
 *
 * Three readings, from the relations present rather than from a count, so the clause is true of whatever
 * mix the week holds:
 *
 * | the labelled rises | the clause |
 * |---|---|
 * | every one began after its stop ended | the place the patient had just left |
 * | every one began while its stop was running | the place the patient was at when the rise began |
 * | some of each | the place the rise was linked to |
 *
 * The mixed reading names the place and stops, which is all criterion 1 asks: the per-row relation in the
 * Place column is the element that says which of the two a given label is, and a caption saying both would
 * be a sentence with two "or"s in it that still left the reader to pair them up. It borrows "linked" from
 * `clinicianSpikeCardHeading`'s own "Spikes linked to places" rather than minting a fourth word for a match.
 *
 * Only ever called on the `matched` report, where at least one rise carries a place — so the set is never
 * empty and there is no fourth branch to write.
 */
export function matchedPlaceClause(spikes: Spike[]): string {
  const kinds = new Set(spikes.map(spikeVisitRelation).map((r) => r?.kind));
  if (!kinds.has("during")) return "the place the patient had just left";
  if (!kinds.has("after")) return "the place the patient was at when the rise began";
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
 * Five things it therefore does not say. Not that a label is a place, unless one is: where a Timeline was
 * shared and nothing matched, the caption names the peak reading and says outright that nothing matched,
 * which is what the card beside it says. Not that a match was tried where no Timeline was shared, which is
 * T184 and the `no-timeline` branch: the sentence stops at what a label is, and the stat tile beside it is
 * the one element that names the source nobody sent (`NO_TIMELINE_HINT`). Not that every marker carries a
 * label: GlucoseChart drops a label that would collide with the one before it, keeping the marker, so the
 * labels are the ones that fit. And not that the markers are the week's rises when they are the largest few
 * of them — `markerSentence` above, which takes the `total` the stat tile shows so that the chart and the
 * tile cannot be counted against each other (T165). And not that the patient had left the place a label
 * names, unless they had: the matcher links a rise to a stop it overlaps as readily as to one that ended
 * just before it, so the clause comes from `matchedPlaceClause` above and the relations the labelled rises
 * actually have, which is the same derivation the Place column under the chart shows per row (T191).
 *
 * `status` is `PatientBundle.status`, the argument order `clinicianSpikePlacesHint` already takes it in.
 */
export function clinicianChartCaption(spikes: Spike[], status: { hasLocation: boolean }, total: number): string {
  const markers = markerSentence(spikes.length, total);
  const labels = "Labels, where they fit,";
  switch (clinicianPlaceReport(spikes, status)) {
    case "matched":
      return `${TARGET_BAND} ${markers} ${labels} give ${matchedPlaceClause(spikes)}, or the peak mg/dL where no place matched.`;
    case "unmatched":
      return `${TARGET_BAND} ${markers} ${labels} give the peak mg/dL: no place matched any of these rises.`;
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
 * from them. Three readings, because the card has three shapes:
 *
 * | the card | heading |
 * |---|---|
 * | some rise matched a place | `Spikes linked to places` |
 * | rises, no place to report against them | `Spikes over 180` |
 * | no rises at all | `Spikes` |
 *
 * The middle one is the card's own subject with the half it cannot deliver dropped, and it covers both of
 * the reports that are not `matched` — it is already silent about places, which is all T184 asks of it.
 * What is under it differs by report, and that is SpikeTable's: with a Timeline shared the `Place` column
 * stays and reads "no matching visit", a true and useful thing to tell a reader who knows what lib/match.ts
 * does (T82); with no Timeline there is no column, because an absence of optional data is not a search that
 * failed. The last reading is a heading over SpikeTable's "No spikes over 180 detected.", which says the
 * state already: naming the threshold above it would read as though some had cleared it.
 */
export function clinicianSpikeCardHeading(spikes: Spike[], status: { hasLocation: boolean }): string {
  if (clinicianPlaceReport(spikes, status) === "matched") return "Spikes linked to places";
  return spikes.length === 0 ? "Spikes" : "Spikes over 180";
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
