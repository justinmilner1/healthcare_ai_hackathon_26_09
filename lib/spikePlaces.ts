// What a page may say about where the patient was when a rise started (design §2.5, §2.6, §2.7, §7.4).
// Owner: sour. The patient's "biggest rises" table and the chart caption on all three surfaces read it.
//
// The place on a Spike comes from the Timeline export, which §2.5 makes optional and Sweetie's `nextTarget`
// stops offering once the patient declines it. So a patient who shared only Dexcom has a spike table whose
// place column cannot ever say anything, and it used to fill every row with "no matching visit" (T82):
// the matcher's vocabulary (lib/match.ts: a spike *matches* a visit), on the one page written for the
// patient, using the one word — "visit" — that already means their appointment to them (§4.4). It also read
// as a lookup that had come back empty, for data §2.4 and §2.5 told them they need not give.
//
// So the patient's table asks here instead of spelling the rule out: with no place known the column is not
// drawn at all, and the chart caption above it stops promising places too — one predicate, so the caption
// and the table cannot disagree. The clinician's brief and the printed sheet are not this: "no matching
// visit" is a true and useful thing to tell a reader who knows what the matcher is, and they keep it.
//
// T128 is the same question one row further in. A stop the matcher placed but the export never named falls
// through to the coordinates lib/location.ts gave it, and those were chosen for the clinician's surfaces;
// `placeIsUnnamed` and `UNNAMED_PLACE` below are the patient's answer to that case, read by the table and
// by the chart's marker labels through one function.
//
// Pure, and in lib/ rather than in the component, so both shapes can be held to this in a unit test (§12.1).

import { placeLabel } from "./location";
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
 * The caption under the glucose chart on the two clinician surfaces: the brief (§2.6) and the printed
 * one-pager (§7.4). One function, so the two strings cannot drift apart (T99).
 *
 * It used to promise, on both, that the red markers were "labeled with the place the patient had just
 * left". They are labeled with the place when one matched and with the peak mg/dL when none did
 * (components/GlucoseChart.tsx), and §2.5 makes the Timeline export optional — so on the ordinary
 * Dexcom-only visit every label was a number the caption called a place, beside a Spikes card already
 * reading "0 linked to a place".
 *
 * Two things it therefore does not say. Not that a label is a place, unless one is: with no place known
 * anywhere the caption names the peak reading and says outright that nothing matched, which is what the
 * card beside it says. And not that every marker carries a label: GlucoseChart drops a label that would
 * collide with the one before it, keeping the marker, so the labels are the ones that fit.
 */
export function clinicianChartCaption(spikes: Spike[]): string {
  return anyPlaceKnown(spikes)
    ? `${TARGET_BAND} Red markers are spikes. Labels, where they fit, give the place the patient had just left, or the peak mg/dL where no place matched.`
    : `${TARGET_BAND} Red markers are spikes. Labels, where they fit, give the peak mg/dL: no place matched any of these rises.`;
}
